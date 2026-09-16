import { describe, expect, test } from 'vitest';
import { createMemberLookupTool } from '#/agents/analyst/tools/members.ts';
import type { MemberLookupResult } from '#/discord';

function lookup(status: MemberLookupResult['status'] = 'complete'): MemberLookupResult {
  const role = { id: '100000000000000002', name: 'Verified' };
  const members = Array.from({ length: 40 }, (_, index) => ({
    id: String(200000000000000000n + BigInt(index)),
    username: `member${index}`,
    displayName: `Member ${index}`,
    isBot: false,
    roleIds: [role.id],
  }));
  return {
    source: 'Discord REST API v10',
    guildId: '100000000000000001',
    startedAt: '2026-09-01T12:00:00Z',
    retrievedAt: '2026-09-01T12:00:01Z',
    status,
    filter: { allOf: [role], anyOf: [], noneOf: [], memberType: 'all' },
    roles: [role],
    members: status === 'unavailable' ? [] : members,
    matchedMemberCount: status === 'unavailable' ? null : 40,
    scannedMemberCount: status === 'unavailable' ? 0 : 40,
    maxMembers: 100_000,
    requiredAccess: status === 'unavailable' ? ['GUILD_MEMBERS (Server Members intent)'] : [],
  };
}

const context = {
  toolCallId: 'member-query',
  data: { allOf: ['Verified'], anyOf: [], noneOf: [], memberType: 'all' as const },
  log: { info() {}, warn() {}, error() {} },
};

describe('Flue member lookup result', () => {
  test('returns the full count and a bounded preview without file-export fields', async () => {
    const tool = createMemberLookupTool({ getMembersByRoles: async () => lookup() });
    const result = JSON.parse(await tool.run(context) as string);
    expect(result.members).toBeUndefined();
    expect(result.membersPreview).toHaveLength(25);
    expect(result.membersPreview[24].username).toBe('member24');
    expect(result.previewTruncated).toBe(true);
    expect(result.matchedMemberCount).toBe(40);
    expect(result.matchedCountIsLowerBound).toBe(false);
    expect(result.report).toBeUndefined();
    expect(result.reportError).toBeUndefined();
  });

  test('never presents partial matches as a complete server result', async () => {
    const tool = createMemberLookupTool({ getMembersByRoles: async () => lookup('partial') });
    const result = JSON.parse(await tool.run(context) as string);
    expect(result.status).toBe('partial');
    expect(result.matchedCountIsLowerBound).toBe(true);
    expect(result.reportError).toBeUndefined();
  });

  test('returns unavailable rather than zero when member access is denied', async () => {
    const tool = createMemberLookupTool({ getMembersByRoles: async () => lookup('unavailable') });
    const result = JSON.parse(await tool.run(context) as string);
    expect(result.status).toBe('unavailable');
    expect(result.matchedMemberCount).toBeNull();
    expect(result.report).toBeUndefined();
    expect(result.requiredAccess).toContain('GUILD_MEMBERS (Server Members intent)');
  });

  test('returns a real zero count when a complete scan finds no matching members', async () => {
    const tool = createMemberLookupTool({
      getMembersByRoles: async () => ({ ...lookup(), members: [], matchedMemberCount: 0 }),
    });
    const result = JSON.parse(await tool.run(context) as string);
    expect(result.status).toBe('complete');
    expect(result.matchedMemberCount).toBe(0);
    expect(result.membersPreview).toEqual([]);
    expect(result.report).toBeUndefined();
    expect(result.reportError).toBeUndefined();
    expect(result.previewTruncated).toBe(false);
  });
});
