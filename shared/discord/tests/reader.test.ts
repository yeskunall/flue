import { PermissionFlagsBits, Routes } from "discord-api-types/v10";
import { describe, expect, it } from "vitest";

import { DiscordReader } from "#/reader.ts";
import type { DiscordRestTransport, DiscordRestOptions } from "#/reader.ts";

const NOW = new Date("2026-08-27T12:00:00.000Z");
const READABLE_CHANNEL_PERMISSIONS = (
  PermissionFlagsBits.ViewChannel | PermissionFlagsBits.ReadMessageHistory
).toString();

function reader(
  get: DiscordRestTransport["get"],
  limits: ConstructorParameters<typeof DiscordReader>[2] = {},
) {
  return new DiscordReader({ get }, "123456789012345678", {
    now: () => NOW,
    ...limits,
  });
}

function queryValue(
  options: DiscordRestOptions | undefined,
  key: string,
): string | null {
  return options?.query?.get(key) ?? null;
}

function withBotPermissions(
  permissions: string,
  get: DiscordRestTransport["get"],
): DiscordRestTransport["get"] {
  return async (route, options) => {
    if (route === Routes.user()) {
      return { id: "bot-user", username: "Campfire bot" };
    }
    if (route === Routes.guildMember("123456789012345678", "bot-user")) {
      return {
        roles: ["bot-role"],
        user: { id: "bot-user", username: "Campfire bot" },
      };
    }
    if (route === Routes.guildRoles("123456789012345678")) {
      return [
        {
          color: 0,
          hoist: false,
          id: "123456789012345678",
          managed: false,
          mentionable: false,
          name: "@everyone",
          permissions: "0",
          position: 0,
        },
        {
          color: 0,
          hoist: false,
          id: "bot-role",
          managed: true,
          mentionable: false,
          name: "Campfire bot",
          permissions,
          position: 1,
        },
      ];
    }
    return get(route, options);
  };
}

describe("DiscordReader server data", () => {
  it("fetches a trusted guild overview with approximate counts and a retrieval timestamp", async () => {
    expect.hasAssertions();
    const discord = reader(async (route, options) => {
      if (route !== Routes.guild("123456789012345678")) {
        throw new Error(`Unexpected route: ${route}`);
      }
      if (queryValue(options, "with_counts") !== "true") {
        throw new Error(
          "The overview request did not ask Discord for approximate counts.",
        );
      }
      return {
        approximate_member_count: 240,
        approximate_presence_count: 37,
        description: "A place to build together",
        features: ["COMMUNITY"],
        icon: null,
        id: "123456789012345678",
        name: "Campfire",
        owner_id: "owner",
        premium_subscription_count: 4,
        premium_tier: 1,
        verification_level: 2,
      };
    });

    await expect(discord.getServerOverview()).resolves.toStrictEqual({
      facts: {
        approximateMemberCount: 240,
        approximatePresenceCount: 37,
        description: "A place to build together",
        features: ["COMMUNITY"],
        id: "123456789012345678",
        name: "Campfire",
        ownerId: "owner",
        premiumSubscriptionCount: 4,
        premiumTier: 1,
        verificationLevel: 2,
      },
      retrievedAt: "2026-08-27T12:00:00.000Z",
      source: "Discord REST API v10",
      unavailable: [],
    });
  });

  it("normalizes channels, categories, roles, active threads, and calculated permission risks", async () => {
    expect.hasAssertions();
    const discord = reader(async route => {
      if (route === Routes.guildChannels("123456789012345678")) {
        return [
          {
            id: "category",
            name: "Community",
            permission_overwrites: [],
            position: 0,
            type: 4,
          },
          {
            id: "general",
            name: "general",
            nsfw: false,
            parent_id: "category",
            permission_overwrites: [],
            position: 1,
            topic: "Say hello",
            type: 0,
          },
        ];
      }
      if (route === Routes.guildRoles("123456789012345678")) {
        return [
          {
            color: 0,
            hoist: false,
            id: "123456789012345678",
            managed: false,
            mentionable: false,
            name: "@everyone",
            permissions: "0",
            position: 0,
          },
        ];
      }
      if (route === Routes.guildActiveThreads("123456789012345678")) {
        return {
          members: [],
          threads: [
            {
              id: "thread",
              member_count: 4,
              message_count: 12,
              name: "Launch notes",
              owner_id: "owner",
              parent_id: "general",
              thread_metadata: {
                archive_timestamp: "2026-08-27T10:00:00.000Z",
                archived: false,
                auto_archive_duration: 1440,
                locked: false,
              },
              type: 11,
            },
          ],
        };
      }
      throw new Error(`Unexpected route: ${route}`);
    });

    await expect(discord.getServerStructure()).resolves.toMatchObject({
      calculations: {
        activeThreadCount: 1,
        categoryCount: 1,
        channelCount: 1,
        permissionRiskIndicators: [],
        roleCount: 1,
      },
      facts: {
        activeThreads: [
          {
            id: "thread",
            memberCount: 4,
            messageCount: 12,
            name: "Launch notes",
            parentId: "general",
          },
        ],
        categories: [{ id: "category", name: "Community", position: 0 }],
        channels: [
          {
            categoryId: "category",
            id: "general",
            name: "general",
            topic: "Say hello",
            type: "GuildText",
          },
        ],
        roles: [
          { id: "123456789012345678", name: "@everyone", permissions: "0" },
        ],
      },
      retrievedAt: "2026-08-27T12:00:00.000Z",
      source: "Discord REST API v10",
      unavailable: [],
    });
  });

  it("uses null rather than zero when server structure is unavailable", async () => {
    expect.hasAssertions();
    const discord = reader(async route => {
      if (
        route === Routes.guildChannels("123456789012345678")
        || route === Routes.guildRoles("123456789012345678")
        || route === Routes.guildActiveThreads("123456789012345678")
      ) {
        throw Object.assign(new Error("Missing Access"), {
          code: 50_001,
          status: 403,
        });
      }
      throw new Error(`Unexpected route: ${route}`);
    });

    await expect(discord.getServerStructure()).resolves.toMatchObject({
      calculations: {
        activeThreadCount: null,
        categoryCount: null,
        channelCount: null,
        roleCount: null,
      },
      facts: {
        activeThreads: null,
        categories: null,
        channels: null,
        roles: null,
      },
      unavailable: [
        { scope: "channels" },
        { scope: "roles" },
        { scope: "active-threads" },
      ],
    });
  });
});

describe("DiscordReader message scans", () => {
  it("scans only message-capable channels and reports capped counts as lower bounds", async () => {
    expect.hasAssertions();
    const discord = reader(
      withBotPermissions(
        READABLE_CHANNEL_PERMISSIONS,
        async (route, options) => {
          if (route === Routes.guildChannels("123456789012345678")) {
            return [
              {
                id: "text",
                name: "general",
                permission_overwrites: [],
                position: 0,
                type: 0,
              },
              {
                id: "category",
                name: "Community",
                permission_overwrites: [],
                position: 1,
                type: 4,
              },
            ];
          }
          if (route === Routes.channelMessages("text")) {
            const before = queryValue(options, "before");
            if (before === null) {
              return [
                { id: "3", timestamp: "2026-08-27T11:00:00.000Z" },
                { id: "2", timestamp: "2026-08-27T10:00:00.000Z" },
              ];
            }
            if (before === "2") {
              return [
                { id: "1", timestamp: "2026-08-27T09:00:00.000Z" },
                { id: "0", timestamp: "2026-08-19T09:00:00.000Z" },
              ];
            }
          }
          throw new Error(`Unexpected route: ${route}`);
        },
      ),
      {
        maxChannels: 10,
        maxMessagesPerChannel: 3,
        maxTotalMessages: 10,
        pageSize: 2,
      },
    );

    await expect(discord.getMessageActivity(7)).resolves.toMatchObject({
      calculations: {
        cappedChannels: ["general"],
        ranking: [
          {
            channelId: "text",
            channelName: "general",
            countIsLowerBound: true,
            visibleMessageCount: 3,
          },
        ],
        visibleMessageCount: 3,
      },
      observationPeriod: {
        end: "2026-08-27T12:00:00.000Z",
        start: "2026-08-20T12:00:00.000Z",
      },
      scan: {
        eligibleChannelCount: 1,
        maxChannels: 10,
        maxMessagesPerChannel: 3,
        maxTotalMessages: 10,
        scannedChannelCount: 1,
        truncated: true,
      },
      source: "Discord REST API v10",
      unavailable: [],
    });
  });

  it("keeps an unreadable channel unavailable without failing the activity result", async () => {
    expect.hasAssertions();
    const discord = reader(
      withBotPermissions(READABLE_CHANNEL_PERMISSIONS, async route => {
        if (route === Routes.guildChannels("123456789012345678")) {
          return [
            {
              id: "visible",
              name: "visible",
              permission_overwrites: [],
              position: 0,
              type: 0,
            },
            {
              id: "private",
              name: "private",
              permission_overwrites: [],
              position: 1,
              type: 0,
            },
          ];
        }
        if (route === Routes.channelMessages("visible")) {
          return [];
        }
        if (route === Routes.channelMessages("private")) {
          throw Object.assign(new Error("Missing Permissions"), {
            code: 50_013,
            status: 403,
          });
        }
        throw new Error(`Unexpected route: ${route}`);
      }),
    );

    await expect(discord.getMessageActivity(7)).resolves.toMatchObject({
      calculations: {
        unavailableChannels: [
          {
            channelId: "private",
            channelName: "private",
            reason: "Missing View Channel or Read Message History permission.",
          },
        ],
      },
      unavailable: [
        {
          reason: "Missing View Channel or Read Message History permission.",
          requiredPermissions: ["View Channel", "Read Message History"],
          scope: "channel:private",
        },
      ],
    });
  });

  it("does not mistake an empty response for zero activity when Read Message History is missing", async () => {
    expect.hasAssertions();
    const discord = reader(
      withBotPermissions(
        PermissionFlagsBits.ViewChannel.toString(),
        async route => {
          if (route === Routes.guildChannels("123456789012345678")) {
            return [
              {
                id: "history-blocked",
                name: "history-blocked",
                permission_overwrites: [],
                position: 0,
                type: 0,
              },
            ];
          }
          if (route === Routes.channelMessages("history-blocked")) {
            throw new Error(
              "Message history must not be requested without permission.",
            );
          }
          throw new Error(`Unexpected route: ${route}`);
        },
      ),
    );

    await expect(discord.getMessageActivity(7)).resolves.toMatchObject({
      calculations: {
        ranking: [],
        unavailableChannels: [
          {
            channelId: "history-blocked",
            channelName: "history-blocked",
            reason: "Missing Read Message History permission.",
          },
        ],
        visibleMessageCount: 0,
      },
      unavailable: [
        {
          reason: "Missing Read Message History permission.",
          requiredPermissions: ["Read Message History"],
          scope: "channel:history-blocked",
        },
      ],
    });
  });

  it("treats Administrator as granting message-read permissions", async () => {
    expect.hasAssertions();
    let messageRequests = 0;
    const discord = reader(
      withBotPermissions(
        PermissionFlagsBits.Administrator.toString(),
        async route => {
          if (route === Routes.guildChannels("123456789012345678")) {
            return [
              {
                id: "admin-visible",
                name: "admin-visible",
                permission_overwrites: [],
                position: 0,
                type: 0,
              },
            ];
          }
          if (route === Routes.channelMessages("admin-visible")) {
            messageRequests += 1;
            return [{ id: "message", timestamp: "2026-08-27T11:00:00.000Z" }];
          }
          throw new Error(`Unexpected route: ${route}`);
        },
      ),
    );

    const result = await discord.getMessageActivity(7);

    expect(messageRequests).toBe(1);
    expect(result.calculations.ranking).toStrictEqual([
      {
        channelId: "admin-visible",
        channelName: "admin-visible",
        countIsLowerBound: false,
        visibleMessageCount: 1,
      },
    ]);
    expect(result.unavailable).toStrictEqual([]);
  });

  it("allocates the global message budget across concurrent channels", async () => {
    expect.hasAssertions();
    const requestedChannels: string[] = [];
    const discord = reader(
      withBotPermissions(READABLE_CHANNEL_PERMISSIONS, async route => {
        if (route === Routes.guildChannels("123456789012345678")) {
          return [
            {
              id: "empty",
              name: "empty",
              permission_overwrites: [],
              position: 0,
              type: 0,
            },
            {
              id: "active",
              name: "active",
              permission_overwrites: [],
              position: 1,
              type: 0,
            },
          ];
        }
        if (route === Routes.channelMessages("empty")) {
          requestedChannels.push("empty");
          return [];
        }
        if (route === Routes.channelMessages("active")) {
          requestedChannels.push("active");
          return [{ id: "message", timestamp: "2026-08-27T11:00:00.000Z" }];
        }
        throw new Error(`Unexpected route: ${route}`);
      }),
      {
        concurrency: 2,
        maxChannels: 2,
        maxMessagesPerChannel: 2,
        maxTotalMessages: 2,
        pageSize: 2,
      },
    );

    const result = await discord.getMessageActivity(7);

    expect(requestedChannels.toSorted()).toStrictEqual(["active", "empty"]);
    expect(result.calculations.ranking[0]).toMatchObject({
      channelName: "active",
      visibleMessageCount: 1,
    });
    expect(result.scan.scannedChannelCount).toBe(2);
  });

  it("records retrieval completion separately from the observation cutoff", async () => {
    expect.hasAssertions();
    let clockCalls = 0;
    const discord = reader(
      withBotPermissions(READABLE_CHANNEL_PERMISSIONS, async route => {
        if (route === Routes.guildChannels("123456789012345678")) {
          return [];
        }
        throw new Error(`Unexpected route: ${route}`);
      }),
      {
        now: () =>
          clockCalls++ === 0
            ? new Date("2026-08-27T12:00:00.000Z")
            : new Date("2026-08-27T12:00:05.000Z"),
      },
    );

    await expect(discord.getMessageActivity(7)).resolves.toMatchObject({
      observationPeriod: {
        end: "2026-08-27T12:00:00.000Z",
      },
      retrievedAt: "2026-08-27T12:00:05.000Z",
    });
  });

  it("uses one latest visible message per channel to calculate inactivity", async () => {
    expect.hasAssertions();
    const discord = reader(
      withBotPermissions(
        READABLE_CHANNEL_PERMISSIONS,
        async (route, options) => {
          if (route === Routes.guildChannels("123456789012345678")) {
            return [
              {
                id: "old",
                name: "old-news",
                permission_overwrites: [],
                position: 0,
                type: 0,
              },
              {
                id: "private",
                name: "private",
                permission_overwrites: [],
                position: 1,
                type: 0,
              },
            ];
          }
          if (route === Routes.channelMessages("old")) {
            if (queryValue(options, "limit") !== "1") {
              throw new Error("Expected a one-message lookup.");
            }
            return [
              { id: "old-message", timestamp: "2026-06-01T12:00:00.000Z" },
            ];
          }
          if (route === Routes.channelMessages("private")) {
            throw Object.assign(new Error("Missing Access"), {
              code: 50_001,
              status: 403,
            });
          }
          throw new Error(`Unexpected route: ${route}`);
        },
      ),
    );

    await expect(discord.getInactiveChannels(30)).resolves.toMatchObject({
      calculations: {
        inactive: [
          {
            channelId: "old",
            channelName: "old-news",
            inactiveForDays: 87,
            latestVisibleMessageAt: "2026-06-01T12:00:00.000Z",
          },
        ],
        unavailableChannels: [
          {
            channelId: "private",
            channelName: "private",
            reason: "Missing View Channel or Read Message History permission.",
          },
        ],
      },
      observationPeriod: {
        end: "2026-08-27T12:00:00.000Z",
        start: "2026-07-28T12:00:00.000Z",
      },
    });
  });
});

describe("DiscordReader optional resources", () => {
  it("returns upcoming scheduled events as fetched facts", async () => {
    expect.hasAssertions();
    const discord = reader(async (route, options) => {
      if (route !== Routes.guildScheduledEvents("123456789012345678")) {
        throw new Error(`Unexpected route: ${route}`);
      }
      if (queryValue(options, "with_user_count") !== "true") {
        throw new Error("Expected scheduled event user counts.");
      }
      return [
        {
          channel_id: null,
          creator_id: "creator",
          description: "Monthly update",
          entity_id: null,
          entity_metadata: { location: "Online" },
          entity_type: 3,
          guild_id: "123456789012345678",
          id: "event",
          name: "Town hall",
          privacy_level: 2,
          scheduled_end_time: "2026-08-29T18:00:00.000Z",
          scheduled_start_time: "2026-08-29T17:00:00.000Z",
          status: 1,
          user_count: 14,
        },
      ];
    });

    await expect(discord.getUpcomingEvents()).resolves.toMatchObject({
      facts: {
        events: [
          {
            description: "Monthly update",
            id: "event",
            interestedUserCount: 14,
            location: "Online",
            name: "Town hall",
            scheduledEndTime: "2026-08-29T18:00:00.000Z",
            scheduledStartTime: "2026-08-29T17:00:00.000Z",
          },
        ],
      },
      unavailable: [],
    });
  });

  it("uses null rather than zero when scheduled events are unavailable", async () => {
    expect.hasAssertions();
    const discord = reader(async route => {
      if (route === Routes.guildScheduledEvents("123456789012345678")) {
        throw Object.assign(new Error("Missing Access"), {
          code: 50_001,
          status: 403,
        });
      }
      throw new Error(`Unexpected route: ${route}`);
    });

    await expect(discord.getUpcomingEvents()).resolves.toMatchObject({
      calculations: { upcomingEventCount: null },
      facts: { events: null },
      unavailable: [{ scope: "scheduled-events" }],
    });
  });

  it("normalizes recent audit-log actions and actor names", async () => {
    expect.hasAssertions();
    const occurredAt = "2026-08-26T10:00:00.000Z";
    const entryId = (
      (BigInt(Date.parse(occurredAt)) - 1_420_070_400_000n)
      << 22n
    ).toString();
    const discord = reader(async (route, options) => {
      if (route !== Routes.guildAuditLog("123456789012345678")) {
        throw new Error(`Unexpected route: ${route}`);
      }
      if (queryValue(options, "limit") !== "100") {
        throw new Error("Expected the Discord audit-log page limit.");
      }
      return {
        audit_log_entries: [
          {
            action_type: 22,
            changes: [],
            id: entryId,
            reason: "Repeated spam",
            target_id: "member",
            user_id: "moderator",
          },
        ],
        users: [{ id: "moderator", username: "Ada" }],
      };
    });

    await expect(discord.getRecentAuditLog(7)).resolves.toMatchObject({
      calculations: {
        actionCount: 1,
        actionsByType: { MemberBanAdd: 1 },
      },
      facts: {
        entries: [
          {
            actionName: "MemberBanAdd",
            actionType: 22,
            actorId: "moderator",
            actorUsername: "Ada",
            id: entryId,
            occurredAt,
            reason: "Repeated spam",
            targetId: "member",
          },
        ],
      },
      scan: {
        fetchedEntryCount: 1,
        truncated: false,
      },
      unavailable: [],
    });
  });

  it("turns a missing View Audit Log permission into metric-level unavailability", async () => {
    expect.hasAssertions();
    const discord = reader(async route => {
      if (route === Routes.guildAuditLog("123456789012345678")) {
        throw Object.assign(new Error("Missing Permissions"), {
          code: 50_013,
          status: 403,
        });
      }
      throw new Error(`Unexpected route: ${route}`);
    });

    await expect(discord.getRecentAuditLog(7)).resolves.toStrictEqual({
      facts: { entries: null },
      observationPeriod: {
        end: "2026-08-27T12:00:00.000Z",
        start: "2026-08-20T12:00:00.000Z",
      },
      retrievedAt: "2026-08-27T12:00:00.000Z",
      scan: {
        fetchedEntryCount: 0,
        maxEntries: 300,
        truncated: false,
      },
      source: "Discord REST API v10",
      unavailable: [
        {
          reason: "Discord did not allow this bot to view the guild audit log.",
          requiredPermissions: ["View Audit Log"],
          scope: "audit-log",
        },
      ],
    });
  });
});
