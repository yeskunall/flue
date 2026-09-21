import {
  AuditLogEvent,
  ChannelType,
  GuildScheduledEventStatus,
  PermissionFlagsBits,
  Routes,
} from "discord-api-types/v10";
import type {
  RESTGetAPIAuditLogResult,
  RESTGetAPIChannelMessagesResult,
  RESTGetAPIGuildChannelsResult,
  RESTGetAPIGuildResult,
  RESTGetAPIGuildRolesResult,
  RESTGetAPIGuildScheduledEventsResult,
  RESTGetAPIGuildThreadsResult,
} from "discord-api-types/v10";

import { findMembersByRoles } from "#/members.ts";
import type { MemberRoleFilterInput } from "#/members.ts";
import {
  assessPermissionRisks,
  calculateInactiveChannels,
  calculateMessageActivity,
} from "#/metrics.ts";
import type {
  ChannelMessageScan,
  LatestMessageObservation,
  ObservationPeriod,
} from "#/metrics.ts";

export interface DiscordRestOptions {
  query?: URLSearchParams;
  signal?: AbortSignal;
}

export interface DiscordRestTransport {
  get(route: string, options?: DiscordRestOptions): Promise<unknown>;
}

export interface DiscordReaderOptions {
  now?: () => Date;
  maxLookbackDays?: number;
  maxInactiveDays?: number;
  maxChannels?: number;
  maxMessagesPerChannel?: number;
  maxTotalMessages?: number;
  maxAuditEntries?: number;
  pageSize?: number;
  concurrency?: number;
}

interface ResolvedDiscordReaderOptions {
  now: () => Date;
  maxLookbackDays: number;
  maxInactiveDays: number;
  maxChannels: number;
  maxMessagesPerChannel: number;
  maxTotalMessages: number;
  maxAuditEntries: number;
  pageSize: number;
  concurrency: number;
}

interface UnavailableMetric {
  scope: string;
  reason: string;
  requiredPermissions: string[];
}

interface MessageChannel {
  id: string;
  name: string;
  position: number;
  permissionOverwrites: PermissionOverwrite[];
}

interface PermissionOverwrite {
  id: string;
  type: number;
  allow: string;
  deny: string;
}

interface BotPermissionContext {
  guildId: string;
  userId: string;
  memberRoleIds: Set<string>;
  basePermissions: bigint;
}

interface ChannelScanResult {
  scan: ChannelMessageScan;
  requestCount: number;
  messageLimit: number;
}

const DISCORD_EPOCH = 1_420_070_400_000n;
const MILLISECONDS_PER_DAY = 86_400_000;
const SOURCE = "Discord REST API v10" as const;

const MESSAGE_CHANNEL_TYPES = new Set<number>([
  ChannelType.GuildText,
  ChannelType.GuildVoice,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildStageVoice,
]);

const DEFAULT_OPTIONS: Omit<ResolvedDiscordReaderOptions, "now"> = {
  maxLookbackDays: 30,
  maxInactiveDays: 365,
  maxChannels: 50,
  maxMessagesPerChannel: 500,
  maxTotalMessages: 5_000,
  maxAuditEntries: 300,
  pageSize: 100,
  concurrency: 4,
};

export class DiscordReader {
  readonly #rest: DiscordRestTransport;
  readonly #guildId: string;
  readonly #options: ResolvedDiscordReaderOptions;

  constructor(
    rest: DiscordRestTransport,
    guildId: string,
    options: DiscordReaderOptions = {},
  ) {
    this.#rest = rest;
    this.#guildId = guildId;
    this.#options = {
      now: options.now ?? (() => new Date()),
      maxLookbackDays: positiveInteger(
        options.maxLookbackDays ?? DEFAULT_OPTIONS.maxLookbackDays,
        "maxLookbackDays",
      ),
      maxInactiveDays: positiveInteger(
        options.maxInactiveDays ?? DEFAULT_OPTIONS.maxInactiveDays,
        "maxInactiveDays",
      ),
      maxChannels: positiveInteger(
        options.maxChannels ?? DEFAULT_OPTIONS.maxChannels,
        "maxChannels",
      ),
      maxMessagesPerChannel: positiveInteger(
        options.maxMessagesPerChannel ?? DEFAULT_OPTIONS.maxMessagesPerChannel,
        "maxMessagesPerChannel",
      ),
      maxTotalMessages: positiveInteger(
        options.maxTotalMessages ?? DEFAULT_OPTIONS.maxTotalMessages,
        "maxTotalMessages",
      ),
      maxAuditEntries: positiveInteger(
        options.maxAuditEntries ?? DEFAULT_OPTIONS.maxAuditEntries,
        "maxAuditEntries",
      ),
      pageSize: Math.min(
        100,
        positiveInteger(
          options.pageSize ?? DEFAULT_OPTIONS.pageSize,
          "pageSize",
        ),
      ),
      concurrency: positiveInteger(
        options.concurrency ?? DEFAULT_OPTIONS.concurrency,
        "concurrency",
      ),
    };
  }

  getMembersByRoles(filter: MemberRoleFilterInput, signal?: AbortSignal) {
    return findMembersByRoles(this.#rest, this.#guildId, filter, {
      now: this.#options.now,
      signal,
    });
  }

  async getServerOverview() {
    try {
      const guild = await this.#get<RESTGetAPIGuildResult>(
        Routes.guild(this.#guildId),
        new URLSearchParams({ with_counts: "true" }),
      );
      const value = expectRecord(guild, "guild");
      return {
        source: SOURCE,
        retrievedAt: this.#options.now().toISOString(),
        facts: {
          id: expectString(value.id, "guild.id"),
          name: expectString(value.name, "guild.name"),
          description: optionalNullableString(
            value.description,
            "guild.description",
          ),
          ownerId: expectString(value.owner_id, "guild.owner_id"),
          features: expectStringArray(value.features, "guild.features"),
          verificationLevel: expectNumber(
            value.verification_level,
            "guild.verification_level",
          ),
          premiumTier: expectNumber(value.premium_tier, "guild.premium_tier"),
          premiumSubscriptionCount: optionalNumber(
            value.premium_subscription_count,
            "guild.premium_subscription_count",
          ),
          approximateMemberCount: optionalNumber(
            value.approximate_member_count,
            "guild.approximate_member_count",
          ),
          approximatePresenceCount: optionalNumber(
            value.approximate_presence_count,
            "guild.approximate_presence_count",
          ),
        },
        unavailable: [] as UnavailableMetric[],
      };
    } catch (error) {
      if (!isHiddenOrMissingPermission(error)) throw error;
      return {
        source: SOURCE,
        retrievedAt: this.#options.now().toISOString(),
        facts: null,
        unavailable: [
          {
            scope: "server-overview",
            reason:
              "Discord did not allow this bot to view the configured guild.",
            requiredPermissions: ["Server membership"],
          },
        ] satisfies UnavailableMetric[],
      };
    }
  }

  async getServerStructure() {
    const [channelResult, roleResult, threadResult] = await Promise.all([
      this.#getOptional<RESTGetAPIGuildChannelsResult>(
        Routes.guildChannels(this.#guildId),
        "channels",
        "Discord did not allow this bot to list guild channels.",
        ["View Channel"],
      ),
      this.#getOptional<RESTGetAPIGuildRolesResult>(
        Routes.guildRoles(this.#guildId),
        "roles",
        "Discord did not allow this bot to list guild roles.",
        ["Server membership"],
      ),
      this.#getOptional<RESTGetAPIGuildThreadsResult>(
        Routes.guildActiveThreads(this.#guildId),
        "active-threads",
        "Discord did not allow this bot to list active threads.",
        ["View Channel"],
      ),
    ]);

    const rawChannels = channelResult.data
      ? expectArray(channelResult.data, "guild channels")
      : [];
    const rawRoles = roleResult.data
      ? expectArray(roleResult.data, "guild roles")
      : [];
    const rawThreadList = threadResult.data
      ? expectRecord(threadResult.data, "active thread list")
      : undefined;
    const rawThreads = rawThreadList
      ? expectArray(rawThreadList.threads, "active thread list.threads")
      : [];

    const categories = rawChannels
      .map(channel => expectRecord(channel, "guild channel"))
      .filter(channel => channel.type === ChannelType.GuildCategory)
      .map(category => ({
        id: expectString(category.id, "category.id"),
        name: expectString(category.name, "category.name"),
        position: expectNumber(category.position, "category.position"),
      }))
      .toSorted((left, right) => left.position - right.position);

    const channels = rawChannels
      .map(channel => expectRecord(channel, "guild channel"))
      .filter(channel => channel.type !== ChannelType.GuildCategory)
      .map(channel => ({
        id: expectString(channel.id, "channel.id"),
        name: expectString(channel.name, "channel.name"),
        type: channelTypeName(expectNumber(channel.type, "channel.type")),
        categoryId: optionalNullableString(
          channel.parent_id,
          "channel.parent_id",
        ),
        position: expectNumber(channel.position, "channel.position"),
        topic: optionalNullableString(channel.topic, "channel.topic"),
        nsfw: optionalBoolean(channel.nsfw, "channel.nsfw"),
      }))
      .toSorted(
        (left, right) =>
          left.position - right.position || left.name.localeCompare(right.name),
      );

    const roles = rawRoles
      .map(role => expectRecord(role, "guild role"))
      .map(role => ({
        id: expectString(role.id, "role.id"),
        name: expectString(role.name, "role.name"),
        permissions: expectString(role.permissions, "role.permissions"),
        position: expectNumber(role.position, "role.position"),
        managed: expectBoolean(role.managed, "role.managed"),
        mentionable: expectBoolean(role.mentionable, "role.mentionable"),
      }))
      .toSorted((left, right) => right.position - left.position);

    const activeThreads = rawThreads
      .map(thread => expectRecord(thread, "active thread"))
      .map(thread => ({
        id: expectString(thread.id, "thread.id"),
        name: expectString(thread.name, "thread.name"),
        parentId: optionalNullableString(thread.parent_id, "thread.parent_id"),
        ownerId: optionalString(thread.owner_id, "thread.owner_id"),
        messageCount: optionalNumber(
          thread.message_count,
          "thread.message_count",
        ),
        memberCount: optionalNumber(thread.member_count, "thread.member_count"),
      }))
      .toSorted((left, right) => left.name.localeCompare(right.name));

    const riskChannels = rawChannels.map(channel => {
      const value = expectRecord(channel, "guild channel");
      return {
        id: expectString(value.id, "channel.id"),
        name: expectString(value.name, "channel.name"),
        type: expectNumber(value.type, "channel.type"),
        permission_overwrites: mapPermissionOverwrites(
          value.permission_overwrites,
        ),
      };
    });

    return {
      source: SOURCE,
      retrievedAt: this.#options.now().toISOString(),
      facts: {
        categories: channelResult.data ? categories : null,
        channels: channelResult.data ? channels : null,
        roles: roleResult.data ? roles : null,
        activeThreads: threadResult.data ? activeThreads : null,
      },
      calculations: {
        categoryCount: channelResult.data ? categories.length : null,
        channelCount: channelResult.data ? channels.length : null,
        roleCount: roleResult.data ? roles.length : null,
        activeThreadCount: threadResult.data ? activeThreads.length : null,
        permissionRiskIndicators: assessPermissionRisks({
          guildId: this.#guildId,
          roles,
          channels: riskChannels,
        }),
      },
      unavailable: [
        ...channelResult.unavailable,
        ...roleResult.unavailable,
        ...threadResult.unavailable,
      ],
    };
  }

  async getMessageActivity(days: number) {
    const observationPeriod = this.#periodForDays(
      days,
      this.#options.maxLookbackDays,
      "message activity",
    );
    const [rawChannels, permissionContext] = await Promise.all([
      this.#get<RESTGetAPIGuildChannelsResult>(
        Routes.guildChannels(this.#guildId),
      ),
      this.#getBotPermissionContext(),
    ]);
    const eligibleChannels = this.#messageChannels(rawChannels);
    const channels = eligibleChannels.slice(0, this.#options.maxChannels);
    const plans = channels.map(channel => ({
      channel,
      missingPermission: missingMessagePermission(channel, permissionContext),
      messageLimit: 0,
    }));
    const readablePlans = plans.filter(plan => !plan.missingPermission);
    const messageLimits = allocateMessageLimits(
      readablePlans.length,
      this.#options.maxTotalMessages,
      this.#options.maxMessagesPerChannel,
    );
    readablePlans.forEach((plan, index) => {
      plan.messageLimit = messageLimits[index] ?? 0;
    });

    const scanResults = await mapWithConcurrency(
      plans,
      this.#options.concurrency,
      (plan): Promise<ChannelScanResult> => {
        if (plan.missingPermission) {
          return Promise.resolve({
            scan: {
              ...channelIdentity(plan.channel),
              status: "unavailable",
              messages: [],
              reason: plan.missingPermission,
            },
            requestCount: 0,
            messageLimit: 0,
          });
        }
        return this.#scanChannelMessages(
          plan.channel,
          observationPeriod,
          plan.messageLimit,
        );
      },
    );
    const scans = scanResults.map(result => result.scan);
    const calculations = calculateMessageActivity(scans, observationPeriod);
    const unavailable = calculations.unavailableChannels.map(channel => ({
      scope: `channel:${channel.channelId}`,
      reason: channel.reason,
      requiredPermissions: requiredPermissionsForMessageReason(channel.reason),
    }));
    const scannedChannelCount = scanResults.filter(
      result => result.requestCount > 0,
    ).length;
    const truncated =
      eligibleChannels.length > channels.length
      || calculations.cappedChannels.length > 0
      || scannedChannelCount < readablePlans.length;

    return {
      source: SOURCE,
      retrievedAt: this.#options.now().toISOString(),
      observationPeriod,
      facts: {
        channels: scanResults.map(({ scan, requestCount, messageLimit }) => ({
          id: scan.channelId,
          name: scan.channelName,
          availability: scan.status,
          fetchedMessageCount: scan.messages.length,
          requestCount,
          messageLimit,
        })),
      },
      calculations,
      scan: {
        eligibleChannelCount: eligibleChannels.length,
        selectedChannelCount: channels.length,
        scannedChannelCount,
        maxChannels: this.#options.maxChannels,
        maxMessagesPerChannel: this.#options.maxMessagesPerChannel,
        maxTotalMessages: this.#options.maxTotalMessages,
        truncated,
      },
      unavailable,
    };
  }

  async getInactiveChannels(inactiveDays: number) {
    const observationPeriod = this.#periodForDays(
      inactiveDays,
      this.#options.maxInactiveDays,
      "inactive channels",
    );
    const [rawChannels, permissionContext] = await Promise.all([
      this.#get<RESTGetAPIGuildChannelsResult>(
        Routes.guildChannels(this.#guildId),
      ),
      this.#getBotPermissionContext(),
    ]);
    const eligibleChannels = this.#messageChannels(rawChannels);
    const channels = eligibleChannels.slice(0, this.#options.maxChannels);
    const observations = await mapWithConcurrency(
      channels,
      this.#options.concurrency,
      channel => {
        const missingPermission = missingMessagePermission(
          channel,
          permissionContext,
        );
        if (missingPermission) {
          return Promise.resolve({
            ...channelIdentity(channel),
            status: "unavailable" as const,
            reason: missingPermission,
          });
        }
        return this.#latestVisibleMessage(channel);
      },
    );
    const calculations = calculateInactiveChannels(observations, {
      observedAt: observationPeriod.end,
      thresholdDays: inactiveDays,
    });
    const unavailable = calculations.unavailableChannels.map(channel => ({
      scope: `channel:${channel.channelId}`,
      reason: channel.reason,
      requiredPermissions: requiredPermissionsForMessageReason(channel.reason),
    }));

    return {
      source: SOURCE,
      retrievedAt: this.#options.now().toISOString(),
      observationPeriod,
      facts: {
        latestVisibleMessages: observations,
      },
      calculations,
      scan: {
        eligibleChannelCount: eligibleChannels.length,
        scannedChannelCount: channels.length,
        maxChannels: this.#options.maxChannels,
        truncated: eligibleChannels.length > channels.length,
      },
      unavailable,
    };
  }

  async getUpcomingEvents() {
    const observedAt = this.#options.now().toISOString();
    try {
      const rawEvents = await this.#get<RESTGetAPIGuildScheduledEventsResult>(
        Routes.guildScheduledEvents(this.#guildId),
        new URLSearchParams({ with_user_count: "true" }),
      );
      const events = expectArray(rawEvents, "scheduled events")
        .map(event => expectRecord(event, "scheduled event"))
        .filter(event => {
          const status = expectNumber(event.status, "scheduled event.status");
          return (
            status === GuildScheduledEventStatus.Scheduled
            || status === GuildScheduledEventStatus.Active
          );
        })
        .map(event => {
          const metadata =
            event.entity_metadata === null
            || event.entity_metadata === undefined
              ? undefined
              : expectRecord(
                  event.entity_metadata,
                  "scheduled event.entity_metadata",
                );
          return {
            id: expectString(event.id, "scheduled event.id"),
            name: expectString(event.name, "scheduled event.name"),
            description: optionalNullableString(
              event.description,
              "scheduled event.description",
            ),
            channelId: optionalNullableString(
              event.channel_id,
              "scheduled event.channel_id",
            ),
            scheduledStartTime: expectString(
              event.scheduled_start_time,
              "scheduled event.scheduled_start_time",
            ),
            scheduledEndTime: optionalNullableString(
              event.scheduled_end_time,
              "scheduled event.scheduled_end_time",
            ),
            location: metadata
              ? optionalNullableString(
                  metadata.location,
                  "scheduled event.location",
                )
              : undefined,
            status: scheduledEventStatusName(
              expectNumber(event.status, "scheduled event.status"),
            ),
            interestedUserCount: optionalNumber(
              event.user_count,
              "scheduled event.user_count",
            ),
          };
        })
        .filter(
          event =>
            event.status === "Active"
            || Date.parse(event.scheduledStartTime) >= Date.parse(observedAt),
        )
        .toSorted(
          (left, right) =>
            Date.parse(left.scheduledStartTime)
            - Date.parse(right.scheduledStartTime),
        );

      return {
        source: SOURCE,
        retrievedAt: this.#options.now().toISOString(),
        observedAt,
        facts: { events },
        calculations: { upcomingEventCount: events.length },
        unavailable: [] as UnavailableMetric[],
      };
    } catch (error) {
      if (!isHiddenOrMissingPermission(error)) throw error;
      return {
        source: SOURCE,
        retrievedAt: this.#options.now().toISOString(),
        observedAt,
        facts: { events: null },
        calculations: { upcomingEventCount: null },
        unavailable: [
          {
            scope: "scheduled-events",
            reason:
              "Discord did not allow this bot to view guild scheduled events.",
            requiredPermissions: ["View Channel for event channels"],
          },
        ] satisfies UnavailableMetric[],
      };
    }
  }

  async getRecentAuditLog(days: number) {
    const observationPeriod = this.#periodForDays(days, 45, "audit log");
    const entries: Array<Record<string, unknown>> = [];
    const users = new Map<string, string>();
    let before: string | undefined;
    let reachedPeriodStart = false;

    try {
      while (
        entries.length < this.#options.maxAuditEntries
        && !reachedPeriodStart
      ) {
        const limit = Math.min(
          100,
          this.#options.maxAuditEntries - entries.length,
        );
        const query = new URLSearchParams({ limit: String(limit) });
        if (before) query.set("before", before);
        const page = await this.#get<RESTGetAPIAuditLogResult>(
          Routes.guildAuditLog(this.#guildId),
          query,
        );
        const pageRecord = expectRecord(page, "audit log");
        for (const rawUser of expectArray(
          pageRecord.users ?? [],
          "audit log.users",
        )) {
          const user = expectRecord(rawUser, "audit log user");
          users.set(
            expectString(user.id, "audit log user.id"),
            expectString(user.username, "audit log user.username"),
          );
        }
        const pageEntries = expectArray(
          pageRecord.audit_log_entries,
          "audit log.audit_log_entries",
        ).map(entry => expectRecord(entry, "audit log entry"));
        if (pageEntries.length === 0) break;

        for (const entry of pageEntries) {
          const id = expectString(entry.id, "audit log entry.id");
          const timestamp = snowflakeTimestamp(id);
          if (Date.parse(timestamp) < Date.parse(observationPeriod.start)) {
            reachedPeriodStart = true;
            break;
          }
          entries.push(entry);
          if (entries.length >= this.#options.maxAuditEntries) break;
        }

        const nextBefore = expectString(
          pageEntries.at(-1)?.id,
          "oldest audit log entry.id",
        );
        if (nextBefore === before || pageEntries.length < limit) break;
        before = nextBefore;
      }
    } catch (error) {
      if (!isHiddenOrMissingPermission(error)) throw error;
      return {
        source: SOURCE,
        retrievedAt: this.#options.now().toISOString(),
        observationPeriod,
        facts: { entries: null },
        scan: {
          fetchedEntryCount: 0,
          maxEntries: this.#options.maxAuditEntries,
          truncated: false,
        },
        unavailable: [
          {
            scope: "audit-log",
            reason:
              "Discord did not allow this bot to view the guild audit log.",
            requiredPermissions: ["View Audit Log"],
          },
        ] satisfies UnavailableMetric[],
      };
    }

    const facts = entries.map(entry => {
      const actionType = expectNumber(
        entry.action_type,
        "audit log entry.action_type",
      );
      const userId = optionalNullableString(
        entry.user_id,
        "audit log entry.user_id",
      );
      return {
        id: expectString(entry.id, "audit log entry.id"),
        occurredAt: snowflakeTimestamp(
          expectString(entry.id, "audit log entry.id"),
        ),
        actionType,
        actionName: auditLogActionName(actionType),
        actorId: userId,
        actorUsername: userId ? users.get(userId) : undefined,
        targetId: optionalNullableString(
          entry.target_id,
          "audit log entry.target_id",
        ),
        reason: optionalNullableString(entry.reason, "audit log entry.reason"),
        changeCount: Array.isArray(entry.changes) ? entry.changes.length : 0,
      };
    });
    const truncated =
      entries.length >= this.#options.maxAuditEntries && !reachedPeriodStart;

    return {
      source: SOURCE,
      retrievedAt: this.#options.now().toISOString(),
      observationPeriod,
      facts: { entries: facts },
      calculations: {
        actionCount: facts.length,
        actionsByType: countBy(facts.map(entry => entry.actionName)),
      },
      scan: {
        fetchedEntryCount: facts.length,
        maxEntries: this.#options.maxAuditEntries,
        truncated,
      },
      unavailable: [] as UnavailableMetric[],
    };
  }

  async #get<T>(route: string, query?: URLSearchParams): Promise<T> {
    const result = await this.#rest.get(route, query ? { query } : undefined);
    return result as T;
  }

  async #getOptional<T>(
    route: string,
    scope: string,
    reason: string,
    requiredPermissions: string[],
  ): Promise<{ data: T | undefined; unavailable: UnavailableMetric[] }> {
    try {
      return { data: await this.#get<T>(route), unavailable: [] };
    } catch (error) {
      if (!isHiddenOrMissingPermission(error)) throw error;
      return {
        data: undefined,
        unavailable: [{ scope, reason, requiredPermissions }],
      };
    }
  }

  async #getBotPermissionContext(): Promise<BotPermissionContext> {
    const [rawUser, rawRoles] = await Promise.all([
      this.#get<unknown>(Routes.user()),
      this.#get<RESTGetAPIGuildRolesResult>(Routes.guildRoles(this.#guildId)),
    ]);
    const user = expectRecord(rawUser, "current bot user");
    const userId = expectString(user.id, "current bot user.id");
    const rawMember = await this.#get<unknown>(
      Routes.guildMember(this.#guildId, userId),
    );
    const member = expectRecord(rawMember, "current bot guild member");
    const memberRoleIds = new Set(
      expectStringArray(member.roles, "guild member.roles"),
    );
    const roles = expectArray(rawRoles, "guild roles").map(role =>
      expectRecord(role, "guild role"),
    );
    let basePermissions = 0n;

    for (const role of roles) {
      const roleId = expectString(role.id, "role.id");
      if (roleId === this.#guildId || memberRoleIds.has(roleId)) {
        basePermissions |= BigInt(
          expectString(role.permissions, "role.permissions"),
        );
      }
    }

    return { guildId: this.#guildId, userId, memberRoleIds, basePermissions };
  }

  #periodForDays(
    days: number,
    maximum: number,
    label: string,
  ): ObservationPeriod {
    if (!Number.isInteger(days) || days < 1 || days > maximum) {
      throw new RangeError(
        `${label} days must be an integer between 1 and ${maximum}.`,
      );
    }
    const end = this.#options.now();
    const start = new Date(end.getTime() - days * MILLISECONDS_PER_DAY);
    return { start: start.toISOString(), end: end.toISOString() };
  }

  #messageChannels(
    rawChannels: RESTGetAPIGuildChannelsResult,
  ): MessageChannel[] {
    return expectArray(rawChannels, "guild channels")
      .map(channel => expectRecord(channel, "guild channel"))
      .filter(channel =>
        MESSAGE_CHANNEL_TYPES.has(expectNumber(channel.type, "channel.type")),
      )
      .map(channel => ({
        id: expectString(channel.id, "channel.id"),
        name: expectString(channel.name, "channel.name"),
        position: expectNumber(channel.position, "channel.position"),
        permissionOverwrites: mapPermissionOverwrites(
          channel.permission_overwrites,
        ),
      }))
      .toSorted(
        (left, right) =>
          left.position - right.position || left.name.localeCompare(right.name),
      );
  }

  async #scanChannelMessages(
    channel: MessageChannel,
    period: ObservationPeriod,
    messageLimit: number,
  ): Promise<ChannelScanResult> {
    const messages: Array<{ id: string; timestamp: string }> = [];
    let before: string | undefined;
    let requestCount = 0;

    try {
      while (messages.length < messageLimit) {
        const requestLimit = Math.min(
          this.#options.pageSize,
          messageLimit - messages.length,
        );
        if (requestLimit <= 0) {
          return {
            scan: { ...channelIdentity(channel), status: "capped", messages },
            requestCount,
            messageLimit,
          };
        }

        const query = new URLSearchParams({ limit: String(requestLimit) });
        if (before) query.set("before", before);
        requestCount += 1;
        const page = await this.#get<RESTGetAPIChannelMessagesResult>(
          Routes.channelMessages(channel.id),
          query,
        );

        const rawPage = expectArray(
          page,
          `messages for #${channel.name}`,
        ).slice(0, requestLimit);
        if (rawPage.length === 0) {
          return {
            scan: { ...channelIdentity(channel), status: "complete", messages },
            requestCount,
            messageLimit,
          };
        }

        const mappedPage = rawPage.map(message => {
          const value = expectRecord(message, `message in #${channel.name}`);
          return {
            id: expectString(value.id, "message.id"),
            timestamp: expectString(value.timestamp, "message.timestamp"),
          };
        });
        messages.push(...mappedPage);
        const oldest = mappedPage.at(-1);
        if (
          !oldest
          || Date.parse(oldest.timestamp) <= Date.parse(period.start)
        ) {
          return {
            scan: { ...channelIdentity(channel), status: "complete", messages },
            requestCount,
            messageLimit,
          };
        }
        if (messages.length >= messageLimit) {
          return {
            scan: { ...channelIdentity(channel), status: "capped", messages },
            requestCount,
            messageLimit,
          };
        }
        if (rawPage.length < requestLimit) {
          return {
            scan: { ...channelIdentity(channel), status: "complete", messages },
            requestCount,
            messageLimit,
          };
        }
        if (oldest.id === before) {
          return {
            scan: { ...channelIdentity(channel), status: "capped", messages },
            requestCount,
            messageLimit,
          };
        }
        before = oldest.id;
      }
    } catch (error) {
      if (!isHiddenOrMissingPermission(error)) throw error;
      return {
        scan: {
          ...channelIdentity(channel),
          status: "unavailable",
          messages: [],
          reason: "Missing View Channel or Read Message History permission.",
        },
        requestCount,
        messageLimit,
      };
    }

    return {
      scan: { ...channelIdentity(channel), status: "capped", messages },
      requestCount,
      messageLimit,
    };
  }

  async #latestVisibleMessage(
    channel: MessageChannel,
  ): Promise<LatestMessageObservation> {
    try {
      const page = await this.#get<RESTGetAPIChannelMessagesResult>(
        Routes.channelMessages(channel.id),
        new URLSearchParams({ limit: "1" }),
      );
      const messages = expectArray(page, `latest message for #${channel.name}`);
      const first = messages[0];
      return {
        ...channelIdentity(channel),
        status: "available",
        latestVisibleMessageAt:
          first === undefined
            ? null
            : expectString(
                expectRecord(first, `latest message for #${channel.name}`)
                  .timestamp,
                "message.timestamp",
              ),
      };
    } catch (error) {
      if (!isHiddenOrMissingPermission(error)) throw error;
      return {
        ...channelIdentity(channel),
        status: "unavailable",
        reason: "Missing View Channel or Read Message History permission.",
      };
    }
  }
}

function channelIdentity(channel: MessageChannel) {
  return { channelId: channel.id, channelName: channel.name };
}

function missingMessagePermission(
  channel: MessageChannel,
  context: BotPermissionContext,
): string | undefined {
  const permissions = effectiveChannelPermissions(channel, context);
  if (!hasPermission(permissions, PermissionFlagsBits.ViewChannel)) {
    return "Missing View Channel permission.";
  }
  if (!hasPermission(permissions, PermissionFlagsBits.ReadMessageHistory)) {
    return "Missing Read Message History permission.";
  }
  return undefined;
}

function effectiveChannelPermissions(
  channel: MessageChannel,
  context: BotPermissionContext,
): bigint {
  if (
    hasPermission(context.basePermissions, PermissionFlagsBits.Administrator)
  ) {
    return context.basePermissions;
  }

  let permissions = context.basePermissions;
  const everyone = channel.permissionOverwrites.find(
    overwrite => overwrite.type === 0 && overwrite.id === context.guildId,
  );
  if (everyone) permissions = applyOverwrite(permissions, everyone);

  let roleAllow = 0n;
  let roleDeny = 0n;
  for (const overwrite of channel.permissionOverwrites) {
    if (
      overwrite.type === 0
      && context.memberRoleIds.has(overwrite.id)
      && overwrite !== everyone
    ) {
      roleAllow |= BigInt(overwrite.allow);
      roleDeny |= BigInt(overwrite.deny);
    }
  }
  permissions = (permissions & ~roleDeny) | roleAllow;

  const member = channel.permissionOverwrites.find(
    overwrite => overwrite.type === 1 && overwrite.id === context.userId,
  );
  if (member) permissions = applyOverwrite(permissions, member);
  return permissions;
}

function applyOverwrite(
  permissions: bigint,
  overwrite: PermissionOverwrite,
): bigint {
  return (permissions & ~BigInt(overwrite.deny)) | BigInt(overwrite.allow);
}

function hasPermission(permissions: bigint, permission: bigint): boolean {
  return (
    (permissions & PermissionFlagsBits.Administrator)
      === PermissionFlagsBits.Administrator
    || (permissions & permission) === permission
  );
}

function allocateMessageLimits(
  channelCount: number,
  totalLimit: number,
  perChannelLimit: number,
): number[] {
  if (channelCount === 0) return [];

  const evenLimit = Math.min(
    perChannelLimit,
    Math.floor(totalLimit / channelCount),
  );
  const limits = Array<number>(channelCount).fill(evenLimit);
  let remaining = Math.min(
    totalLimit - evenLimit * channelCount,
    channelCount * (perChannelLimit - evenLimit),
  );

  for (let index = 0; index < limits.length && remaining > 0; index += 1) {
    limits[index] = (limits[index] ?? 0) + 1;
    remaining -= 1;
  }
  return limits;
}

function requiredPermissionsForMessageReason(reason: string): string[] {
  if (reason === "Missing View Channel permission.") return ["View Channel"];
  if (reason === "Missing Read Message History permission.") {
    return ["Read Message History"];
  }
  return ["View Channel", "Read Message History"];
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (nextIndex < values.length) {
        const index = nextIndex;
        nextIndex += 1;
        const value = values[index];
        if (value !== undefined) results[index] = await operation(value);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

function mapPermissionOverwrites(value: unknown) {
  if (value === undefined) return [];
  return expectArray(value, "channel.permission_overwrites").map(overwrite => {
    const record = expectRecord(overwrite, "channel permission overwrite");
    return {
      id: expectString(record.id, "channel permission overwrite.id"),
      type: expectNumber(record.type, "channel permission overwrite.type"),
      allow: expectString(record.allow, "channel permission overwrite.allow"),
      deny: expectString(record.deny, "channel permission overwrite.deny"),
    };
  });
}

function isHiddenOrMissingPermission(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const status = "status" in error ? error.status : undefined;
  const code = "code" in error ? error.code : undefined;
  return (
    status === 403
    || status === 404
    || code === 50_001
    || code === 50_013
    || code === "50001"
    || code === "50013"
  );
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer.`);
  }
  return value;
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Discord returned invalid ${label}.`);
  }
  return value as Record<string, unknown>;
}

function expectArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`Discord returned invalid ${label}.`);
  }
  return value;
}

function expectString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`Discord returned invalid ${label}.`);
  }
  return value;
}

function optionalString(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : expectString(value, label);
}

function optionalNullableString(
  value: unknown,
  label: string,
): string | null | undefined {
  if (value === null || value === undefined) return value;
  return expectString(value, label);
}

function expectNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Discord returned invalid ${label}.`);
  }
  return value;
}

function optionalNumber(value: unknown, label: string): number | undefined {
  return value === undefined ? undefined : expectNumber(value, label);
}

function expectBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`Discord returned invalid ${label}.`);
  }
  return value;
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  return value === undefined ? undefined : expectBoolean(value, label);
}

function expectStringArray(value: unknown, label: string): string[] {
  const items = expectArray(value, label);
  if (items.some(item => typeof item !== "string")) {
    throw new Error(`Discord returned invalid ${label}.`);
  }
  return items as string[];
}

function channelTypeName(type: number): string {
  return ChannelType[type] ?? `Unknown(${type})`;
}

function scheduledEventStatusName(status: number): string {
  return GuildScheduledEventStatus[status] ?? `Unknown(${status})`;
}

function auditLogActionName(action: number): string {
  return AuditLogEvent[action] ?? `Unknown(${action})`;
}

function snowflakeTimestamp(id: string): string {
  const milliseconds = (BigInt(id) >> 22n) + DISCORD_EPOCH;
  return new Date(Number(milliseconds)).toISOString();
}

function countBy(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}
