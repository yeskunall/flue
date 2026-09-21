import { Routes } from "discord-api-types/v10";
import { expect, test } from "vitest";

import { createMemberLookupTool } from "#/agents/analyst/tools/members.ts";
import { DiscordReader } from "#/discord";

test("a 30k-member server returns the full filtered count with a bounded preview and no export", async () => {
  const guildId = "100000000000000001";
  const verified = "100000000000000002";
  const muted = "100000000000000003";
  const baseId = 200000000000000000n;
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
        if (route !== Routes.guildMembers(guildId))
          throw new Error(`Unexpected route: ${route}`);
        expect(options?.query?.get("limit")).toBe("1000");
        memberRequests++;
        const after = options?.query?.get("after");
        const offset = after ? Number(BigInt(after) - baseId) : 0;
        return Array.from(
          { length: Math.min(1_000, 30_001 - offset) },
          (_, index) => {
            const n = offset + index + 1;
            return {
              user: {
                id: String(baseId + BigInt(n)),
                username: `member${n}`,
                global_name: null,
                avatar: null,
                discriminator: "0",
                bot: n % 10 === 0,
              },
              roles: [
                ...(n % 2 === 0 ? [verified] : []),
                ...(n % 6 === 0 ? [muted] : []),
              ],
              nick: null,
              joined_at: "2026-01-01T00:00:00Z",
              flags: 0,
              deaf: false,
              mute: false,
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
        noneOf: ["Muted"],
        memberType: "humans",
      },
      toolCallId: "large-member-query",
      log: { info() {}, warn() {}, error() {} },
    })) as string,
  );
  expect(memberRequests).toBe(31);
  expect(output.status).toBe("complete");
  expect(output.scannedMemberCount).toBe(30_001);
  // 15,000 verified − 5,000 muted − 2,000 remaining bots.
  expect(output.matchedMemberCount).toBe(8_000);
  expect(output.membersPreview).toHaveLength(25);
  expect(output.membersPreview[0].id).toBe("200000000000000002");
  expect(output.members).toBeUndefined();
  expect(output.previewTruncated).toBe(true);
  expect(output.report).toBeUndefined();
  expect(output.reportError).toBeUndefined();
  expect(output.filter.noneOf).toEqual([{ id: muted, name: "Muted" }]);
});
