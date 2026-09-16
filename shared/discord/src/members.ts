import { Routes } from 'discord-api-types/v10';
import * as v from 'valibot';
import type { DiscordRestTransport } from '#/reader.ts';

const snowflake = v.pipe(v.string(), v.regex(/^\d{17,20}$/));
const roleList = v.optional(
  v.pipe(
    v.array(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(100))),
    v.maxLength(25),
  ),
  [],
);

export const memberRoleFilterSchema = v.pipe(
  v.strictObject({
    allOf: roleList,
    anyOf: roleList,
    noneOf: roleList,
    memberType: v.optional(v.picklist(['all', 'humans', 'bots']), 'all'),
  }),
  v.check(
    (input) => input.allOf.length + input.anyOf.length + input.noneOf.length > 0,
    'Specify at least one role filter. Use @everyone to explicitly select all members.',
  ),
);

export type MemberRoleFilterInput = v.InferInput<typeof memberRoleFilterSchema>;
export type MemberRoleFilter = v.InferOutput<typeof memberRoleFilterSchema>;
export interface MemberRole { id: string; name: string }
export interface ResolvedMemberRoles {
  allOf: MemberRole[];
  anyOf: MemberRole[];
  noneOf: MemberRole[];
  memberType: MemberRoleFilter['memberType'];
}
export interface RoleSelectionIssue {
  role: string;
  reason: 'unknown_role' | 'ambiguous_role' | 'contradictory_roles';
  candidates: MemberRole[];
}
export interface MatchedMember {
  id: string;
  username: string;
  displayName: string;
  isBot: boolean;
  roleIds: string[];
}
export interface MemberLookupResult {
  source: 'Discord REST API v10';
  guildId: string;
  startedAt: string;
  retrievedAt: string;
  status: 'complete' | 'partial' | 'unavailable' | 'invalid_filter';
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

const rolesSchema = v.array(v.object({ id: snowflake, name: v.string() }));
const membersSchema = v.array(v.object({
  user: v.object({
    id: snowflake,
    username: v.string(),
    global_name: v.optional(v.nullable(v.string())),
    bot: v.optional(v.boolean(), false),
  }),
  nick: v.optional(v.nullable(v.string())),
  roles: v.array(snowflake),
}));

/** Resolve names once; an unknown excluded role must never silently match everyone. */
export function resolveMemberRoles(
  roles: readonly MemberRole[],
  input: unknown,
): { filter: ResolvedMemberRoles | null; issues: RoleSelectionIssue[] } {
  const parsed = v.parse(memberRoleFilterSchema, input);
  const issues: RoleSelectionIssue[] = [];
  function resolve(references: string[]): MemberRole[] {
    const selected = new Map<string, MemberRole>();
    for (const reference of references) {
      const mentionId = /^<@&(\d+)>$/.exec(reference)?.[1];
      const id = mentionId ?? reference;
      const explicitId = mentionId !== undefined || /^\d{17,20}$/.test(reference);
      let candidates = roles.filter((role) => role.id === id);
      if (!explicitId && !candidates.length) {
        candidates = roles.filter((role) => role.name === reference);
      }
      if (!explicitId && !candidates.length) {
        const name = reference.replace(/^@/, '').toLowerCase();
        candidates = roles.filter((role) => role.name.replace(/^@/, '').toLowerCase() === name);
      }
      const role = candidates[0];
      if (candidates.length !== 1 || !role) {
        issues.push({
          role: reference,
          reason: candidates.length ? 'ambiguous_role' : 'unknown_role',
          candidates,
        });
      } else {
        selected.set(role.id, role);
      }
    }
    return [...selected.values()];
  }
  const filter: ResolvedMemberRoles = {
    allOf: resolve(parsed.allOf),
    anyOf: resolve(parsed.anyOf),
    noneOf: resolve(parsed.noneOf),
    memberType: parsed.memberType,
  };
  const excluded = new Set(filter.noneOf.map((role) => role.id));
  const contradictions = filter.allOf.filter((role) => excluded.has(role.id));
  if (filter.anyOf.length && filter.anyOf.every((role) => excluded.has(role.id))) {
    contradictions.push(...filter.anyOf);
  }
  for (const role of contradictions) {
    issues.push({ role: role.name, reason: 'contradictory_roles', candidates: [role] });
  }
  return { filter: issues.length ? null : filter, issues };
}

export function matchesMemberRoles(
  member: { roleIds: readonly string[]; isBot: boolean },
  filter: ResolvedMemberRoles,
  guildId: string,
): boolean {
  if (filter.memberType === 'humans' && member.isBot) return false;
  if (filter.memberType === 'bots' && !member.isBot) return false;
  // Discord omits @everyone from the member's explicit role list.
  const assigned = new Set([guildId, ...member.roleIds]);
  const has = (role: MemberRole) => assigned.has(role.id);
  return filter.allOf.every(has) &&
    (!filter.anyOf.length || filter.anyOf.some(has)) &&
    !filter.noneOf.some(has);
}

interface MemberScanOptions {
  now?: () => Date;
  pageSize?: number;
  maxMembers?: number;
  signal?: AbortSignal;
}

/** A bounded, live roster scan. No caching or changes to Discord. */
export async function findMembersByRoles(
  rest: DiscordRestTransport,
  guildId: string,
  input: unknown,
  options: MemberScanOptions = {},
): Promise<MemberLookupResult> {
  const parsed = v.parse(memberRoleFilterSchema, input);
  v.parse(snowflake, guildId);
  const positiveInteger = v.pipe(v.number(), v.integer(), v.minValue(1));
  const pageSize = v.parse(v.pipe(positiveInteger, v.maxValue(1_000)), options.pageSize ?? 1_000);
  const maxMembers = v.parse(v.pipe(positiveInteger, v.maxValue(100_000)), options.maxMembers ?? 100_000);
  const now = options.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const timeout = AbortSignal.timeout(120_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const members: MatchedMember[] = [];
  const seenMembers = new Set<string>();
  let roles: MemberRole[] = [];
  let filter: ResolvedMemberRoles | null = null;
  let scannedMemberCount = 0;
  let scope: 'roles' | 'members' = 'roles';

  function finish(
    status: MemberLookupResult['status'],
    reason?: string,
    requiredAccess: string[] = [],
  ): MemberLookupResult {
    members.sort((left, right) => compareIds(left.id, right.id));
    return {
      source: 'Discord REST API v10',
      guildId,
      startedAt,
      retrievedAt: now().toISOString(),
      status,
      filter,
      roles,
      scannedMemberCount,
      maxMembers,
      matchedMemberCount: status === 'complete' || status === 'partial' ? members.length : null,
      members,
      reason,
      requiredAccess,
    };
  }

  try {
    signal.throwIfAborted();
    roles = v.parse(rolesSchema, await getWithinDeadline(rest, Routes.guildRoles(guildId), signal));
    const resolved = resolveMemberRoles(roles, parsed);
    filter = resolved.filter;
    if (!filter) {
      return {
        ...finish('invalid_filter', 'Clarify unknown, ambiguous, or contradictory roles before searching.'),
        roleSelectionIssues: resolved.issues,
      };
    }

    scope = 'members';
    let after: string | undefined;
    while (scannedMemberCount < maxMembers) {
      signal.throwIfAborted();
      const limit = Math.min(pageSize, maxMembers - scannedMemberCount);
      const query = new URLSearchParams({ limit: String(limit) });
      if (after) query.set('after', after);
      const page = v.parse(membersSchema, await getWithinDeadline(rest, Routes.guildMembers(guildId), signal, query));
      const ids = page.map((member) => member.user.id);
      const invalidPage = page.length > limit ||
        new Set(ids).size !== ids.length ||
        ids.some((id) => after !== undefined && BigInt(id) <= BigInt(after));
      for (const value of page.slice(0, limit)) {
        if (seenMembers.has(value.user.id)) continue;
        seenMembers.add(value.user.id);
        scannedMemberCount++;
        const member: MatchedMember = {
          id: value.user.id,
          username: value.user.username,
          displayName: value.nick ?? value.user.global_name ?? value.user.username,
          isBot: value.user.bot,
          roleIds: value.roles,
        };
        if (matchesMemberRoles(member, filter, guildId)) members.push(member);
      }
      if (invalidPage) {
        return finish('partial', 'Discord returned a repeated or invalid member pagination cursor; the list is incomplete.');
      }
      if (page.length < limit) return finish('complete');
      after = ids.reduce((highest, id) => compareIds(id, highest) > 0 ? id : highest);
    }
    return finish('partial', 'The 100,000-member safety limit (or a lower configured limit) was reached; the list is incomplete.');
  } catch (error) {
    if (options.signal?.aborted) throw error;
    // Never accept malformed rows, but preserve matches from already validated pages.
    if (v.isValiError(error)) {
      if (!scannedMemberCount) throw error;
      return finish('partial', 'Discord returned malformed member data; the list is incomplete.');
    }
    const status = scannedMemberCount ? 'partial' : 'unavailable';
    const httpStatus = error && typeof error === 'object' && 'status' in error ? error.status : undefined;
    if (httpStatus === 401) {
      return finish(status, 'Discord rejected the bot token.', ['Valid Discord bot token']);
    }
    if (httpStatus === 403 || httpStatus === 404) {
      return scope === 'members'
        ? finish(status, 'Discord denied member listing. Enable or obtain approval for Server Members intent, and verify the bot belongs to this server.', [
          'GUILD_MEMBERS (Server Members intent)',
          'Bot membership in the configured server',
        ])
        : finish(status, 'Discord did not allow this bot to list roles in the configured server.', [
          'Bot membership in the configured server',
        ]);
    }
    return finish(status, timeout.aborted
      ? 'The two-minute member lookup time limit was reached; the list is incomplete.'
      : `Discord member lookup failed${typeof httpStatus === 'number' ? ` (HTTP ${httpStatus})` : ''}. Retry later; this is not a confirmed permission failure.`);
  }
}

async function getWithinDeadline(
  rest: DiscordRestTransport,
  route: string,
  signal: AbortSignal,
  query?: URLSearchParams,
): Promise<unknown> {
  signal.throwIfAborted();
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    // REST honors signal for requests/queues, but not every rate-limit sleep.
    const result = await Promise.race([rest.get(route, { query, signal }), aborted]);
    signal.throwIfAborted();
    return result;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

function compareIds(left: string, right: string): number {
  return BigInt(left) < BigInt(right) ? -1 : BigInt(left) > BigInt(right) ? 1 : 0;
}
