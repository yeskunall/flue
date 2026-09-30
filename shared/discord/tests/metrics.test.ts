import { ChannelType, PermissionFlagsBits } from "discord-api-types/v10";
import { describe, expect, it } from "vitest";

import {
  assessPermissionRisks,
  calculateInactiveChannels,
  calculateMessageActivity,
} from "#/metrics.ts";
import type {
  ChannelMessageScan,
  LatestMessageObservation,
} from "#/metrics.ts";

const PERIOD = {
  end: "2026-08-27T12:00:00.000Z",
  start: "2026-08-20T12:00:00.000Z",
};

describe("calculateMessageActivity", () => {
  it("counts only messages inside the observation period and ranks ties by channel name", () => {
    expect.hasAssertions();
    const scans: ChannelMessageScan[] = [
      {
        channelId: "1",
        channelName: "support",
        messages: [
          { id: "m1", timestamp: "2026-08-27T11:00:00.000Z" },
          { id: "m2", timestamp: "2026-08-21T12:00:00.000Z" },
          { id: "old", timestamp: "2026-08-20T11:59:59.000Z" },
        ],
        status: "complete",
      },
      {
        channelId: "2",
        channelName: "announcements",
        messages: [
          { id: "m3", timestamp: "2026-08-26T12:00:00.000Z" },
          { id: "m4", timestamp: "2026-08-25T12:00:00.000Z" },
        ],
        status: "complete",
      },
    ];

    expect(calculateMessageActivity(scans, PERIOD)).toStrictEqual({
      cappedChannels: [],
      ranking: [
        {
          channelId: "2",
          channelName: "announcements",
          countIsLowerBound: false,
          visibleMessageCount: 2,
        },
        {
          channelId: "1",
          channelName: "support",
          countIsLowerBound: false,
          visibleMessageCount: 2,
        },
      ],
      unavailableChannels: [],
      visibleMessageCount: 4,
    });
  });

  it("marks capped counts as lower bounds and keeps unavailable channels out of the ranking", () => {
    expect.hasAssertions();
    const scans: ChannelMessageScan[] = [
      {
        channelId: "1",
        channelName: "busy",
        messages: [
          { id: "m1", timestamp: "2026-08-27T11:00:00.000Z" },
          { id: "m2", timestamp: "2026-08-27T10:00:00.000Z" },
        ],
        status: "capped",
      },
      {
        channelId: "2",
        channelName: "private",
        messages: [],
        reason: "Missing View Channel or Read Message History permission.",
        status: "unavailable",
      },
    ];

    expect(calculateMessageActivity(scans, PERIOD)).toStrictEqual({
      cappedChannels: ["busy"],
      ranking: [
        {
          channelId: "1",
          channelName: "busy",
          countIsLowerBound: true,
          visibleMessageCount: 2,
        },
      ],
      unavailableChannels: [
        {
          channelId: "2",
          channelName: "private",
          reason: "Missing View Channel or Read Message History permission.",
        },
      ],
      visibleMessageCount: 2,
    });
  });
});

describe("calculateInactiveChannels", () => {
  it("separates inactive, empty, active, and permission-blocked channels", () => {
    expect.hasAssertions();
    const observations: LatestMessageObservation[] = [
      {
        channelId: "1",
        channelName: "active",
        latestVisibleMessageAt: "2026-08-26T12:00:00.000Z",
        status: "available",
      },
      {
        channelId: "2",
        channelName: "old",
        latestVisibleMessageAt: "2026-07-01T12:00:00.000Z",
        status: "available",
      },
      {
        channelId: "3",
        channelName: "empty",
        // No visible message is represented by an explicit null timestamp.
        // oxlint-disable-next-line unicorn/no-null
        latestVisibleMessageAt: null,
        status: "available",
      },
      {
        channelId: "4",
        channelName: "private",
        reason: "Missing View Channel or Read Message History permission.",
        status: "unavailable",
      },
    ];

    expect(
      calculateInactiveChannels(observations, {
        observedAt: "2026-08-27T12:00:00.000Z",
        thresholdDays: 30,
      }),
    ).toStrictEqual({
      activeChannelCount: 1,
      inactive: [
        {
          channelId: "2",
          channelName: "old",
          inactiveForDays: 57,
          latestVisibleMessageAt: "2026-07-01T12:00:00.000Z",
        },
      ],
      noVisibleMessages: [{ channelId: "3", channelName: "empty" }],
      unavailableChannels: [
        {
          channelId: "4",
          channelName: "private",
          reason: "Missing View Channel or Read Message History permission.",
        },
      ],
    });
  });
});

describe("assessPermissionRisks", () => {
  it("flags high-impact assignable roles and everyone channel overrides without alleging abuse", () => {
    expect.hasAssertions();
    const administrator = PermissionFlagsBits.Administrator.toString();
    const mentionEveryone = PermissionFlagsBits.MentionEveryone.toString();
    const manageMessages = PermissionFlagsBits.ManageMessages.toString();

    expect(
      assessPermissionRisks({
        channels: [
          {
            id: "channel",
            name: "general",
            permission_overwrites: [
              {
                allow: manageMessages,
                deny: "0",
                id: "guild",
                type: 0,
              },
            ],
            type: ChannelType.GuildText,
          },
        ],
        guildId: "guild",
        roles: [
          {
            id: "guild",
            managed: false,
            name: "@everyone",
            permissions: mentionEveryone,
          },
          {
            id: "admin",
            managed: false,
            name: "Operations",
            permissions: administrator,
          },
          {
            id: "managed",
            managed: true,
            name: "Managed integration",
            permissions: administrator,
          },
        ],
      }),
    ).toStrictEqual([
      {
        explanation:
          "This assignable role bypasses channel-specific permission checks. Review who can receive it.",
        permission: "Administrator",
        severity: "high",
        subjectId: "admin",
        subjectName: "Operations",
        subjectType: "role",
      },
      {
        explanation:
          "The @everyone channel override grants a high-impact permission to every server member.",
        permission: "ManageMessages",
        severity: "high",
        subjectId: "channel",
        subjectName: "general",
        subjectType: "channel",
      },
      {
        explanation:
          "The @everyone role grants a high-impact permission to every server member.",
        permission: "MentionEveryone",
        severity: "medium",
        subjectId: "guild",
        subjectName: "@everyone",
        subjectType: "role",
      },
    ]);
  });
});
