import { describe, expect, it } from "vitest";

import { createMemberLookupTool } from "#/agents/analyst/tools/members.ts";
import type { MemberLookupResult } from "#/discord";

function lookup(
  status: MemberLookupResult["status"] = "complete",
): MemberLookupResult {
  const role = { id: "100000000000000002", name: "Verified" };
  const members = Array.from({ length: 40 }, (_, index) => ({
    displayName: `Member ${index}`,
    id: String(200000000000000000n + BigInt(index)),
    isBot: false,
    roleIds: [role.id],
    username: `member${index}`,
  }));
  return {
    filter: { allOf: [role], anyOf: [], memberType: "all", noneOf: [] },
    guildId: "100000000000000001",
    matchedMemberCount: status === "unavailable" ? null : 40,
    maxMembers: 100_000,
    members: status === "unavailable" ? [] : members,
    requiredAccess:
      status === "unavailable" ? ["GUILD_MEMBERS (Server Members intent)"] : [],
    retrievedAt: "2026-09-01T12:00:01Z",
    roles: [role],
    scannedMemberCount: status === "unavailable" ? 0 : 40,
    source: "Discord REST API v10",
    startedAt: "2026-09-01T12:00:00Z",
    status,
  };
}

const context = {
  data: {
    allOf: ["Verified"],
    anyOf: [],
    memberType: "all" as const,
    noneOf: [],
  },
  log: { error() {}, info() {}, warn() {} },
  toolCallId: "member-query",
};

describe("Flue member lookup result", () => {
  it("returns the full count and a bounded preview without file-export fields", async () => {
    const tool = createMemberLookupTool({
      getMembersByRoles: async () => lookup(),
    });
    const result = JSON.parse((await tool.run(context)) as string);
    expect(result.members).toBeUndefined();
    expect(result.membersPreview).toHaveLength(25);
    expect(result.membersPreview[24].username).toBe("member24");
    expect(result.previewTruncated).toBe(true);
    expect(result.matchedMemberCount).toBe(40);
    expect(result.matchedCountIsLowerBound).toBe(false);
    expect(result.report).toBeUndefined();
    expect(result.reportError).toBeUndefined();
  });

  it("never presents partial matches as a complete server result", async () => {
    const tool = createMemberLookupTool({
      getMembersByRoles: async () => lookup("partial"),
    });
    const result = JSON.parse((await tool.run(context)) as string);
    expect(result.status).toBe("partial");
    expect(result.matchedCountIsLowerBound).toBe(true);
    expect(result.reportError).toBeUndefined();
  });

  it("returns unavailable rather than zero when member access is denied", async () => {
    const tool = createMemberLookupTool({
      getMembersByRoles: async () => lookup("unavailable"),
    });
    const result = JSON.parse((await tool.run(context)) as string);
    expect(result.status).toBe("unavailable");
    expect(result.matchedMemberCount).toBeNull();
    expect(result.report).toBeUndefined();
    expect(result.requiredAccess).toContain(
      "GUILD_MEMBERS (Server Members intent)",
    );
  });

  it("returns a real zero count when a complete scan finds no matching members", async () => {
    const tool = createMemberLookupTool({
      getMembersByRoles: async () => ({
        ...lookup(),
        matchedMemberCount: 0,
        members: [],
      }),
    });
    const result = JSON.parse((await tool.run(context)) as string);
    expect(result.status).toBe("complete");
    expect(result.matchedMemberCount).toBe(0);
    expect(result.membersPreview).toEqual([]);
    expect(result.report).toBeUndefined();
    expect(result.reportError).toBeUndefined();
    expect(result.previewTruncated).toBe(false);
  });
});
