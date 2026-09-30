// Node-only tests yield the event loop without a wall-clock sleep.
// oxlint-disable-next-line import/no-nodejs-modules
import { setImmediate } from "node:timers/promises";

import { Routes } from "discord-api-types/v10";
import { describe, expect, it, vi } from "vitest";

import {
  findMembersByRoles,
  matchesMemberRoles,
  resolveMemberRoles,
} from "#/members.ts";
import type { MemberLookupResult } from "#/members.ts";
import { DiscordReader } from "#/reader.ts";
import type { DiscordRestTransport } from "#/reader.ts";

const GUILD = "100000000000000001";
const VERIFIED = "100000000000000002";
const STAFF = "100000000000000003";
const MUTED = "100000000000000004";
const NOW = new Date("2026-09-01T12:00:00Z");
const roles = [
  { id: GUILD, name: "@everyone" },
  { id: VERIFIED, name: "Verified" },
  { id: STAFF, name: "Staff" },
  { id: MUTED, name: "Muted" },
];

function member(index: number, roleIds: string[], bot = false) {
  return {
    deaf: false,
    flags: 0,
    joined_at: "2026-01-01T00:00:00Z",
    mute: false,
    nick: index === 1 ? "First member" : null,
    roles: roleIds,
    user: {
      avatar: null,
      bot,
      discriminator: "0",
      global_name: `Member ${index}`,
      id: String(200_000_000_000_000_000n + BigInt(index)),
      username: `member${index}`,
    },
  };
}

function transport(
  getMembers: DiscordRestTransport["get"],
  availableRoles = roles,
): DiscordRestTransport {
  return {
    get: async (route, options) => {
      if (route === Routes.guildRoles(GUILD)) {
        return availableRoles;
      }
      if (route !== Routes.guildMembers(GUILD)) {
        throw new Error(`Unexpected route: ${route}`);
      }
      return getMembers(route, options);
    },
  };
}

describe("member role filters", () => {
  it("resolves exact names, case-insensitive names, role mentions and IDs", () => {
    expect.hasAssertions();
    expect(
      resolveMemberRoles(roles, {
        allOf: [" verified ", `<@&${STAFF}>`],
        anyOf: [VERIFIED, "@Muted"],
      }),
    ).toStrictEqual({
      filter: {
        allOf: [roles[1], roles[2]],
        anyOf: [roles[1], roles[3]],
        memberType: "all",
        noneOf: [],
      },
      issues: [],
    });
  });

  it("does not silently ignore unknown roles in negative filters", () => {
    expect.hasAssertions();
    const result = resolveMemberRoles(roles, { noneOf: ["Verifed"] });
    expect(result.filter).toBeNull();
    expect(result.issues).toStrictEqual([
      { candidates: [], reason: "unknown_role", role: "Verifed" },
    ]);
  });

  it.each(["100000000000000009", "<@&100000000000000009>"])(
    "never substitutes a role name for the explicit identity %s",
    reference => {
      expect.hasAssertions();
      const result = resolveMemberRoles(
        [...roles, { id: "100000000000000008", name: reference }],
        { noneOf: [reference] },
      );
      expect(result.filter).toBeNull();
      expect(result.issues).toStrictEqual([
        { candidates: [], reason: "unknown_role", role: reference },
      ]);
    },
  );

  it("requires an ID for ambiguous names, but accepts a unique exact-case match", () => {
    expect.hasAssertions();
    const duplicates = [
      ...roles,
      { id: "100000000000000005", name: "Verified" },
    ];
    expect(
      resolveMemberRoles(duplicates, { allOf: ["Verified"] }).issues,
    ).toStrictEqual([
      {
        candidates: [roles[1], duplicates[4]],
        reason: "ambiguous_role",
        role: "Verified",
      },
    ]);
    expect(
      resolveMemberRoles(duplicates, { allOf: [VERIFIED] }).filter?.allOf,
    ).toStrictEqual([roles[1]]);
    expect(
      resolveMemberRoles(
        [...roles, { id: "100000000000000006", name: "verified" }],
        {
          allOf: ["Verified"],
        },
      ).filter?.allOf,
    ).toStrictEqual([roles[1]]);
  });

  it("rejects contradictory required and excluded roles", () => {
    expect.hasAssertions();
    const result = resolveMemberRoles(roles, {
      allOf: ["Verified"],
      noneOf: [VERIFIED],
    });
    expect(result.filter).toBeNull();
    expect(result.issues[0]?.reason).toBe("contradictory_roles");
  });

  it.each([
    [{ allOf: ["Verified", "Staff"] }, [VERIFIED, STAFF], false, true],
    [{ allOf: ["Verified", "Staff"] }, [VERIFIED], false, false],
    [{ anyOf: ["Verified", "Staff"] }, [STAFF], false, true],
    [{ anyOf: ["Verified", "Staff"] }, [MUTED], false, false],
    [{ noneOf: ["Verified", "Staff"] }, [MUTED], false, true],
    [{ noneOf: ["Verified", "Staff"] }, [STAFF], false, false],
    [
      { allOf: ["Verified"], anyOf: ["Staff", "Muted"], noneOf: ["Muted"] },
      [VERIFIED, STAFF],
      false,
      true,
    ],
    [
      { allOf: ["Verified"], anyOf: ["Staff", "Muted"], noneOf: ["Muted"] },
      [VERIFIED, MUTED],
      false,
      false,
    ],
    [{ allOf: ["@everyone"] }, [], false, true],
    [{ noneOf: ["@everyone"] }, [VERIFIED], false, false],
    [{ allOf: ["Verified"], memberType: "humans" }, [VERIFIED], true, false],
    [{ allOf: ["Verified"], memberType: "bots" }, [VERIFIED], true, true],
    [{ allOf: ["Verified"], memberType: "bots" }, [VERIFIED], false, false],
  ] as const)(
    "evaluates filter %j against roles %j",
    (input, roleIds, bot, expected) => {
      expect.hasAssertions();
      const { filter } = resolveMemberRoles(roles, input);
      expect(filter).not.toBeNull();
      expect(matchesMemberRoles({ isBot: bot, roleIds }, filter!, GUILD)).toBe(
        expected,
      );
    },
  );
});

describe("REST member lookup", () => {
  it("the live reader uses its trusted guild and clock for role lookups", async () => {
    expect.hasAssertions();
    const reader = new DiscordReader(
      transport(async () => [member(1, [VERIFIED])]),
      GUILD,
      {
        now: () => NOW,
      },
    );
    const result = await reader.getMembersByRoles({ allOf: ["Verified"] });
    expect(result.guildId).toBe(GUILD);
    expect(result.status).toBe("complete");
    expect(result.members.map(resultMember => resultMember.id)).toStrictEqual([
      "200000000000000001",
    ]);
    expect(result.retrievedAt).toBe("2026-09-01T12:00:00.000Z");
  });

  it("paginates the entire roster and returns all matches with current roles, not just the first page", async () => {
    expect.hasAssertions();
    const queries: string[] = [];
    const result = await findMembersByRoles(
      transport(async (_route, options) => {
        queries.push(options?.query?.toString() ?? "");
        const after = options?.query?.get("after");
        if (!after) {
          return [member(2, [VERIFIED, MUTED]), member(1, [VERIFIED])];
        }
        if (after === member(2, []).user.id) {
          return [member(3, [STAFF]), member(4, [VERIFIED, STAFF])];
        }
        if (after === member(4, []).user.id) {
          return [];
        }
        throw new Error(`Wrong cursor: ${after}`);
      }),
      GUILD,
      { allOf: ["Verified"], noneOf: ["Muted"] },
      {
        now: () => NOW,
        pageSize: 2,
      },
    );

    expect(queries).toStrictEqual([
      "limit=2",
      "limit=2&after=200000000000000002",
      "limit=2&after=200000000000000004",
    ]);
    expect({
      matchedMemberCount: result.matchedMemberCount,
      retrievedAt: result.retrievedAt,
      scannedMemberCount: result.scannedMemberCount,
      status: result.status,
    }).toStrictEqual({
      matchedMemberCount: 2,
      retrievedAt: "2026-09-01T12:00:00.000Z",
      scannedMemberCount: 4,
      status: "complete",
    });
    expect(result.members).toStrictEqual([
      {
        displayName: "First member",
        id: "200000000000000001",
        isBot: false,
        roleIds: [VERIFIED],
        username: "member1",
      },
      {
        displayName: "Member 4",
        id: "200000000000000004",
        isBot: false,
        roleIds: [VERIFIED, STAFF],
        username: "member4",
      },
    ]);
  });

  it("does not confuse an empty matching list with a failed scan", async () => {
    expect.hasAssertions();
    const result = await findMembersByRoles(
      transport(async () => [member(1, [STAFF])]),
      GUILD,
      {
        allOf: ["Verified"],
      },
    );
    expect(result.status).toBe("complete");
    expect(result.scannedMemberCount).toBe(1);
    expect(result.matchedMemberCount).toBe(0);
    expect(result.members).toStrictEqual([]);
  });

  it("stops on invalid role selection before any member request", async () => {
    expect.hasAssertions();
    const result = await findMembersByRoles(
      transport(async () => {
        throw new Error("An unresolved filter must never list members.");
      }),
      GUILD,
      { noneOf: ["Missing role"] },
    );
    expect(result.status).toBe("invalid_filter");
    expect(result.matchedMemberCount).toBeNull();
    expect(result.scannedMemberCount).toBe(0);
    expect(result.roleSelectionIssues?.[0]?.reason).toBe("unknown_role");
  });

  it("reports the Server Members intent requirement rather than zero on a denied list", async () => {
    expect.hasAssertions();
    const result = await findMembersByRoles(
      transport(async () => {
        throw { code: 50_001, status: 403 };
      }),
      GUILD,
      { allOf: ["Verified"] },
    );
    expect(result.status).toBe("unavailable");
    expect(result.matchedMemberCount).toBeNull();
    expect(result.requiredAccess).toContain(
      "GUILD_MEMBERS (Server Members intent)",
    );
    expect(result.reason).toContain("Server Members");
  });

  it("does not blame the member intent when even listing roles is denied", async () => {
    expect.hasAssertions();
    const result = await findMembersByRoles(
      {
        get: async () => {
          throw { status: 403 };
        },
      },
      GUILD,
      {
        allOf: ["Verified"],
      },
    );
    expect(result.status).toBe("unavailable");
    expect(result.matchedMemberCount).toBeNull();
    expect(result.requiredAccess).toStrictEqual([
      "Bot membership in the configured server",
    ]);
  });

  it("labels results partial if a later page is denied", async () => {
    expect.hasAssertions();
    const result = await findMembersByRoles(
      transport(async (_route, options) => {
        if (!options?.query?.has("after")) {
          return [member(1, [VERIFIED])];
        }
        throw { code: 50_001, status: 403 };
      }),
      GUILD,
      { allOf: ["Verified"] },
      { pageSize: 1 },
    );
    expect(result.status).toBe("partial");
    expect(result.matchedMemberCount).toBe(1);
    expect(result.members).toHaveLength(1);
  });

  it("bounds roster scanning and reports a partial result at the cap", async () => {
    expect.hasAssertions();
    const queries: string[] = [];
    const result = await findMembersByRoles(
      transport(async (_route, options) => {
        queries.push(options?.query?.toString() ?? "");
        if (!options?.query?.has("after")) {
          return [member(1, [VERIFIED]), member(2, [VERIFIED])];
        }
        return [member(3, [VERIFIED])];
      }),
      GUILD,
      { allOf: ["Verified"] },
      { maxMembers: 3, pageSize: 2 },
    );
    expect(queries).toStrictEqual([
      "limit=2",
      "limit=1&after=200000000000000002",
    ]);
    expect(result.status).toBe("partial");
    expect(result.scannedMemberCount).toBe(3);
    expect(result.matchedMemberCount).toBe(3);
    expect(result.reason).toContain("limit");
  });

  it("a non-advancing page cannot loop forever or duplicate members", async () => {
    expect.hasAssertions();
    const result = await findMembersByRoles(
      transport(async () => [member(1, [VERIFIED])]),
      GUILD,
      {
        allOf: ["Verified"],
      },
      { pageSize: 1 },
    );
    expect(result.status).toBe("partial");
    expect(result.members).toHaveLength(1);
    expect(result.reason).toContain("cursor");
  });

  it("retains novel matches in a mixed repeated page before stopping partial", async () => {
    expect.hasAssertions();
    const result = await findMembersByRoles(
      transport(async (_route, options) =>
        !options?.query?.has("after")
          ? [member(1, [VERIFIED]), member(2, [VERIFIED])]
          : [member(2, [VERIFIED]), member(3, [VERIFIED])],
      ),
      GUILD,
      { allOf: ["Verified"] },
      { pageSize: 2 },
    );
    expect(result.status).toBe("partial");
    expect(result.scannedMemberCount).toBe(3);
    expect(result.matchedMemberCount).toBe(3);
    expect(result.members.map(value => value.id)).toStrictEqual([
      "200000000000000001",
      "200000000000000002",
      "200000000000000003",
    ]);
  });

  it("operational failures are not described as missing permissions", async () => {
    expect.hasAssertions();
    const result = await findMembersByRoles(
      transport(async () => {
        throw { status: 503 };
      }),
      GUILD,
      { allOf: ["Verified"] },
    );
    expect(result.status).toBe("unavailable");
    expect(result.matchedMemberCount).toBeNull();
    expect(result.requiredAccess).toStrictEqual([]);
    expect(result.reason).toContain("503");
  });

  it("rejects malformed member data rather than assuming someone lacks a role", async () => {
    expect.hasAssertions();
    await expect(
      findMembersByRoles(
        transport(async () => [
          {
            roles: null,
            user: member(1, []).user,
          },
        ]),
        GUILD,
        { noneOf: ["Verified"] },
      ),
    ).rejects.toThrow(/Invalid type/);
  });

  it("keeps validated matches as partial if a later page is malformed", async () => {
    expect.hasAssertions();
    const result = await findMembersByRoles(
      transport(async (_route, options) => {
        if (!options?.query?.has("after")) {
          return [member(1, [VERIFIED])];
        }
        return [{ roles: null, user: member(2, []).user }];
      }),
      GUILD,
      { allOf: ["Verified"] },
      { pageSize: 1 },
    );
    expect(result.status).toBe("partial");
    expect(result.matchedMemberCount).toBe(1);
    expect(result.members.map(value => value.id)).toStrictEqual([
      "200000000000000001",
    ]);
    expect(result.reason).toContain("malformed");
    expect(result.requiredAccess).toStrictEqual([]);
  });

  it("caller cancellation settles without waiting for a REST rate-limit sleep", async () => {
    expect.hasAssertions();
    const controller = new AbortController();
    const started = Promise.withResolvers<void>();
    const response = Promise.withResolvers<unknown>();
    const outcome: { status: string; error?: unknown } = { status: "pending" };
    const lookup = findMembersByRoles(
      transport(async () => {
        started.resolve();
        return response.promise; // Models @discordjs/rest's non-abortable bucket sleep.
      }),
      GUILD,
      { allOf: ["Verified"] },
      { signal: controller.signal },
    ).then(
      () => {
        outcome.status = "resolved";
      },
      error => {
        outcome.status = "rejected";
        outcome.error = error;
      },
    );
    try {
      await started.promise;
      const reason = new Error("Canceled by caller");
      controller.abort(reason);
      await setImmediate();
      expect(outcome.status).toBe("rejected");
      expect(outcome.error).toBe(reason);
    } finally {
      response.resolve([]);
      await lookup;
    }
  });

  it("the time budget returns partial matches even when REST is still rate-limited", async () => {
    expect.hasAssertions();
    const deadline = new AbortController();
    const timeout = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(deadline.signal);
    const started = Promise.withResolvers<void>();
    const response = Promise.withResolvers<unknown>();
    const outcome: { result?: MemberLookupResult; error?: unknown } = {};
    const lookup = findMembersByRoles(
      transport(async (_route, options) => {
        if (!options?.query?.has("after")) {
          return [member(1, [VERIFIED])];
        }
        started.resolve();
        return response.promise;
      }),
      GUILD,
      { allOf: ["Verified"] },
      { pageSize: 1 },
    ).then(
      result => {
        outcome.result = result;
      },
      error => {
        outcome.error = error;
      },
    );
    try {
      await started.promise;
      deadline.abort(new DOMException("Time budget exhausted", "TimeoutError"));
      await setImmediate();
      expect(outcome.error).toBeUndefined();
      expect(outcome.result?.status).toBe("partial");
      expect(outcome.result?.matchedMemberCount).toBe(1);
      expect(outcome.result?.reason).toContain("time limit");
    } finally {
      response.resolve([]);
      await lookup;
      timeout.mockRestore();
    }
  });

  it.each([
    {},
    { allOf: [""] },
    { allOf: Array.from({ length: 26 }, () => "Verified") },
    { allOf: ["Verified"], guildId: "999999999999999999" },
  ])("rejects unsafe input %j without contacting Discord", async input => {
    expect.hasAssertions();
    await expect(
      findMembersByRoles(
        {
          get: async () => {
            throw new Error("Invalid inputs must not contact Discord.");
          },
        },
        GUILD,
        input,
      ),
    ).rejects.toThrow(/^(?:Invalid|Specify)/);
  });
});
