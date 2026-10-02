import { Routes } from "discord-api-types/v10";
import {
  array,
  boolean,
  check,
  integer,
  isValiError,
  maxLength,
  maxValue,
  minLength,
  minValue,
  nullable,
  number,
  object,
  optional,
  parse,
  picklist,
  pipe,
  regex,
  strictObject,
  string,
  trim,
} from "valibot";
import type { InferInput, InferOutput } from "valibot";

import type { DiscordRestTransport } from "#/reader.ts";

const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_UNAUTHORIZED = 401;
const MAX_MEMBERS_PER_PAGE = 1000;
const MAX_MEMBERS_PER_SCAN = 100_000;
const MEMBER_LOOKUP_TIMEOUT_MS = 120_000;

const roleList = optional(
  pipe(
    // oxlint-disable-next-line unicorn/max-nested-calls
    array(pipe(string(), trim(), minLength(1), maxLength(100))), // oxlint-disable-line no-magic-numbers
    maxLength(25), // oxlint-disable-line no-magic-numbers
  ),
  [],
);
const snowflake = pipe(string(), regex(/^\d{17,20}$/));

const memberRoleFilterSchema = pipe(
  strictObject({
    allOf: roleList,
    anyOf: roleList,
    // oxlint-disable-next-line unicorn/max-nested-calls
    memberType: optional(picklist(["all", "humans", "bots"]), "all"),
    noneOf: roleList,
  }),
  check(
    input => input.allOf.length + input.anyOf.length + input.noneOf.length > 0,
    "Specify at least one role filter. Use @everyone to explicitly select all members.",
  ),
);

type MemberRoleFilterInput = InferInput<typeof memberRoleFilterSchema>;
type MemberRoleFilter = InferOutput<typeof memberRoleFilterSchema>;
interface MemberRole {
  id: string;
  name: string;
}
interface ResolvedMemberRoles {
  allOf: MemberRole[];
  anyOf: MemberRole[];
  noneOf: MemberRole[];
  memberType: MemberRoleFilter["memberType"];
}
interface RoleSelectionIssue {
  role: string;
  reason: "unknown_role" | "ambiguous_role" | "contradictory_roles";
  candidates: MemberRole[];
}
interface MatchedMember {
  id: string;
  username: string;
  displayName: string;
  isBot: boolean;
  roleIds: string[];
}
interface MemberLookupResult {
  source: "Discord REST API v10";
  guildId: string;
  startedAt: string;
  retrievedAt: string;
  status: "complete" | "partial" | "unavailable" | "invalid_filter";
  filter: ResolvedMemberRoles | null;
  roles: MemberRole[];
  scannedMemberCount: number;
  maxMembers: number;
  matchedMemberCount: number | null;
  members: MatchedMember[];
  reason?: string;
  requiredAccess: string[];
  roleSelectionIssues?: RoleSelectionIssue[];
}

// oxlint-disable unicorn/max-nested-calls
const membersSchema = array(
  object({
    nick: optional(nullable(string())),
    roles: array(snowflake),
    user: object({
      bot: optional(boolean(), false),
      global_name: optional(nullable(string())),
      id: snowflake,
      username: string(),
    }),
  }),
);
// oxlint-enable unicorn/max-nested-calls
const rolesSchema = array(object({ id: snowflake, name: string() }));

/** Resolve names once; an unknown excluded role must never silently match everyone. */
const resolveMemberRoles = (
  roles: readonly MemberRole[],
  input: unknown,
): { filter: ResolvedMemberRoles | null; issues: RoleSelectionIssue[] } => {
  const parsed = parse(memberRoleFilterSchema, input);
  const issues: RoleSelectionIssue[] = [];
  const resolve = (references: string[]): MemberRole[] => {
    const selected = new Map<string, MemberRole>();
    for (const reference of references) {
      const mentionId = /^<@&(?<roleId>\d+)>$/.exec(reference)?.groups?.roleId;
      const id = mentionId ?? reference;
      const explicitId =
        mentionId !== undefined || /^\d{17,20}$/.test(reference);
      let candidates = roles.filter(role => role.id === id);
      if (!explicitId && !candidates.length) {
        candidates = roles.filter(role => role.name === reference);
      }
      if (!explicitId && !candidates.length) {
        const name = reference.replace(/^@/, "").toLowerCase();
        candidates = roles.filter(
          role => role.name.replace(/^@/, "").toLowerCase() === name,
        );
      }
      const [role] = candidates;
      if (candidates.length !== 1 || !role) {
        issues.push({
          candidates,
          reason: candidates.length ? "ambiguous_role" : "unknown_role",
          role: reference,
        });
      } else {
        selected.set(role.id, role);
      }
    }
    return [...selected.values()];
  };
  const filter: ResolvedMemberRoles = {
    allOf: resolve(parsed.allOf),
    anyOf: resolve(parsed.anyOf),
    memberType: parsed.memberType,
    noneOf: resolve(parsed.noneOf),
  };
  const excluded = new Set(filter.noneOf.map(role => role.id));
  const contradictions = filter.allOf.filter(role => excluded.has(role.id));
  if (
    filter.anyOf.length
    && filter.anyOf.every(role => excluded.has(role.id))
  ) {
    contradictions.push(...filter.anyOf);
  }
  for (const role of contradictions) {
    issues.push({
      candidates: [role],
      reason: "contradictory_roles",
      role: role.name,
    });
  }
  // An invalid filter must remain explicit in serialized results.
  // oxlint-disable-next-line unicorn/no-null
  return { filter: issues.length ? null : filter, issues };
};

const matchesMemberRoles = (
  member: { roleIds: readonly string[]; isBot: boolean },
  filter: ResolvedMemberRoles,
  guildId: string,
): boolean => {
  if (filter.memberType === "humans" && member.isBot) {
    return false;
  }
  if (filter.memberType === "bots" && !member.isBot) {
    return false;
  }
  // Discord omits @everyone from the member's explicit role list.
  const assigned = new Set([guildId, ...member.roleIds]);
  const has = (role: MemberRole) => assigned.has(role.id);
  return (
    filter.allOf.every(has)
    && (!filter.anyOf.length || filter.anyOf.some(has))
    && !filter.noneOf.some(has)
  );
};

interface MemberScanOptions {
  now?: () => Date;
  pageSize?: number;
  maxMembers?: number;
  signal?: AbortSignal;
}

/** A bounded, live roster scan. No caching or changes to Discord. */
const findMembersByRoles = async (
  rest: DiscordRestTransport,
  guildId: string,
  input: unknown,
  options: MemberScanOptions = {},
): Promise<MemberLookupResult> => {
  const parsed = parse(memberRoleFilterSchema, input);
  parse(snowflake, guildId);
  const positiveInteger = pipe(number(), integer(), minValue(1));
  const pageSize = parse(
    pipe(positiveInteger, maxValue(MAX_MEMBERS_PER_PAGE)),
    options.pageSize ?? MAX_MEMBERS_PER_PAGE,
  );
  const maxMembers = parse(
    pipe(positiveInteger, maxValue(MAX_MEMBERS_PER_SCAN)),
    options.maxMembers ?? MAX_MEMBERS_PER_SCAN,
  );
  const now = options.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const timeout = AbortSignal.timeout(MEMBER_LOOKUP_TIMEOUT_MS);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeout])
    : timeout;
  const members: MatchedMember[] = [];
  const seenMembers = new Set<string>();
  let roles: MemberRole[] = [];
  // The result has an explicit null filter until role selection succeeds.
  // oxlint-disable-next-line unicorn/no-null
  let filter: ResolvedMemberRoles | null = null;
  let scannedMemberCount = 0;
  let scope: "roles" | "members" = "roles";

  const finish = (
    status: MemberLookupResult["status"],
    reason?: string,
    requiredAccess: string[] = [],
  ): MemberLookupResult => {
    members.sort((left, right) => compareIds(left.id, right.id));
    return {
      filter,
      guildId,
      // A count we could not determine is null, not zero or an omitted field.
      matchedMemberCount:
        status === "complete" || status === "partial" ? members.length : null, // oxlint-disable-line unicorn/no-null
      maxMembers,
      members,
      reason,
      requiredAccess,
      retrievedAt: now().toISOString(),
      roles,
      scannedMemberCount,
      source: "Discord REST API v10",
      startedAt,
      status,
    };
  };

  try {
    signal.throwIfAborted();
    roles = parse(
      rolesSchema,
      await getWithinDeadline(rest, Routes.guildRoles(guildId), signal),
    );
    const resolved = resolveMemberRoles(roles, parsed);
    ({ filter } = resolved);
    if (!filter) {
      return {
        ...finish(
          "invalid_filter",
          "Clarify unknown, ambiguous, or contradictory roles before searching.",
        ),
        roleSelectionIssues: resolved.issues,
      };
    }

    scope = "members";
    let after: string | undefined = undefined;
    while (scannedMemberCount < maxMembers) {
      signal.throwIfAborted();
      const limit = Math.min(pageSize, maxMembers - scannedMemberCount);
      const query = new URLSearchParams({ limit: String(limit) });
      if (after) {
        query.set("after", after);
      }
      const page = parse(
        membersSchema,
        await getWithinDeadline(
          rest,
          Routes.guildMembers(guildId),
          signal,
          query,
        ),
      );
      const ids = page.map(member => member.user.id);
      const invalidPage =
        page.length > limit
        || new Set(ids).size !== ids.length
        || ids.some(id => after !== undefined && BigInt(id) <= BigInt(after));
      for (const value of page.slice(0, limit)) {
        if (!seenMembers.has(value.user.id)) {
          seenMembers.add(value.user.id);
          scannedMemberCount++;
          const member: MatchedMember = {
            displayName:
              value.nick ?? value.user.global_name ?? value.user.username,
            id: value.user.id,
            isBot: value.user.bot,
            roleIds: value.roles,
            username: value.user.username,
          };
          if (matchesMemberRoles(member, filter, guildId)) {
            members.push(member);
          }
        }
      }
      if (invalidPage) {
        return finish(
          "partial",
          "Discord returned a repeated or invalid member pagination cursor; the list is incomplete.",
        );
      }
      if (page.length < limit) {
        return finish("complete");
      }
      after = ids.reduce((highest, id) =>
        compareIds(id, highest) > 0 ? id : highest,
      );
    }
    return finish(
      "partial",
      `The ${MAX_MEMBERS_PER_SCAN.toLocaleString("en-US")}-member safety limit (or a lower configured limit) was reached; the list is incomplete.`,
    );
  } catch (error) {
    if (options.signal?.aborted) {
      throw error;
    }
    // Never accept malformed rows, but preserve matches from already validated pages.
    if (isValiError(error)) {
      if (!scannedMemberCount) {
        throw error;
      }
      return finish(
        "partial",
        "Discord returned malformed member data; the list is incomplete.",
      );
    }
    const status = scannedMemberCount ? "partial" : "unavailable";
    const httpStatus =
      error && typeof error === "object" && "status" in error
        ? error.status
        : undefined;
    if (httpStatus === HTTP_UNAUTHORIZED) {
      return finish(status, "Discord rejected the bot token.", [
        "Valid Discord bot token",
      ]);
    }
    if (httpStatus === HTTP_FORBIDDEN || httpStatus === HTTP_NOT_FOUND) {
      return scope === "members"
        ? finish(
            status,
            "Discord denied member listing. Enable or obtain approval for Server Members intent, and verify the bot belongs to this server.",
            [
              "GUILD_MEMBERS (Server Members intent)",
              "Bot membership in the configured server",
            ],
          )
        : finish(
            status,
            "Discord did not allow this bot to list roles in the configured server.",
            ["Bot membership in the configured server"],
          );
    }
    return finish(
      status,
      timeout.aborted
        ? "The two-minute member lookup time limit was reached; the list is incomplete."
        : `Discord member lookup failed${typeof httpStatus === "number" ? ` (HTTP ${httpStatus})` : ""}. Retry later; this is not a confirmed permission failure.`,
    );
  }
};

const getWithinDeadline = async (
  rest: DiscordRestTransport,
  route: string,
  signal: AbortSignal,
  query?: URLSearchParams,
): Promise<unknown> => {
  signal.throwIfAborted();
  let onAbort: (() => void) | undefined = undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    // REST honors signal for requests/queues, but not every rate-limit sleep.
    const result = await Promise.race([
      rest.get(route, { query, signal }),
      aborted,
    ]);
    signal.throwIfAborted();
    return result;
  } finally {
    if (onAbort) {
      signal.removeEventListener("abort", onAbort);
    }
  }
};

const compareIds = (left: string, right: string): number =>
  BigInt(left) < BigInt(right) ? -1 : BigInt(left) > BigInt(right) ? 1 : 0; // oxlint-disable-line no-magic-numbers

export {
  findMembersByRoles,
  matchesMemberRoles,
  memberRoleFilterSchema,
  resolveMemberRoles,
};
export type {
  MatchedMember,
  MemberLookupResult,
  MemberRole,
  MemberRoleFilter,
  MemberRoleFilterInput,
  ResolvedMemberRoles,
  RoleSelectionIssue,
};
