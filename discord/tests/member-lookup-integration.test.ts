import { Routes } from "discord-api-types/v10";
import { describe, expect, it } from "vitest";

import createMemberLookupTool from "#/agents/analyst/tools/members.ts";
import { DiscordReader } from "#/discord";

describe("member lookup integration", () => {
  it("a 30k-member server returns the full filtered count with a bounded preview and no export", async () => {
    expect.hasAssertions();
    const guildId = "100000000000000001";
    const verified = "100000000000000002";
    const muted = "100000000000000003";
    const baseId = 200_000_000_000_000_000n;
    let memberRequests = 0;
    const reader = new DiscordReader(
      {
        get: async (route, options) => {
          if (route === Routes.guildRoles(guildId)) {
            return [
              { id: guildId, name: "@everyone" },
              { id: verified, name: "Verified" },
              { id: muted, name: "Muted" },
            ];
          }
          if (route !== Routes.guildMembers(guildId)) {
            throw new Error(`Unexpected route: ${route}`);
          }
          expect(options?.query?.get("limit")).toBe("1000");
          memberRequests++;
          const after = options?.query?.get("after");
          const offset = after ? Number(BigInt(after) - baseId) : 0;
          return Array.from(
            { length: Math.min(1000, 30_001 - offset) },
            (_, index) => {
              const n = offset + index + 1;
              return {
                deaf: false,
                flags: 0,
                joined_at: "2026-01-01T00:00:00Z",
                mute: false,
                nick: null,
                roles: [
                  ...(n % 2 === 0 ? [verified] : []),
                  ...(n % 6 === 0 ? [muted] : []),
                ],
                user: {
                  avatar: null,
                  bot: n % 10 === 0,
                  discriminator: "0",
                  global_name: null,
                  id: String(baseId + BigInt(n)),
                  username: `member${n}`,
                },
              };
            },
          ).toReversed();
        },
      },
      guildId,
    );
    const tool = createMemberLookupTool(reader);
    const output = JSON.parse(
      (await tool.run({
        data: {
          allOf: ["Verified"],
          anyOf: [],
          memberType: "humans",
          noneOf: ["Muted"],
        },
        log: { error() {}, info() {}, warn() {} },
        toolCallId: "large-member-query",
      })) as string,
    );
    expect(memberRequests).toBe(31);
    // 15,000 verified − 5,000 muted − 2,000 remaining bots.
    expect({
      matchedMemberCount: output.matchedMemberCount,
      scannedMemberCount: output.scannedMemberCount,
      status: output.status,
    }).toStrictEqual({
      matchedMemberCount: 8000,
      scannedMemberCount: 30_001,
      status: "complete",
    });
    expect({
      firstMemberId: output.membersPreview[0].id,
      previewLength: output.membersPreview.length,
      previewTruncated: output.previewTruncated,
    }).toStrictEqual({
      firstMemberId: "200000000000000002",
      previewLength: 25,
      previewTruncated: true,
    });
    expect({
      members: output.members,
      report: output.report,
      reportError: output.reportError,
    }).toStrictEqual({
      members: undefined,
      report: undefined,
      reportError: undefined,
    });
    expect(output.filter.noneOf).toStrictEqual([{ id: muted, name: "Muted" }]);
  });
});
