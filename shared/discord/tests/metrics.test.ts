import { ChannelType, PermissionFlagsBits } from 'discord-api-types/v10';
import { describe, expect, test } from 'vitest';
import {
  assessPermissionRisks,
  calculateInactiveChannels,
  calculateMessageActivity,
} from '#/metrics.ts';
import type {
  ChannelMessageScan,
  LatestMessageObservation,
} from '#/metrics.ts';

const PERIOD = {
  start: '2026-08-20T12:00:00.000Z',
  end: '2026-08-27T12:00:00.000Z',
};

describe('calculateMessageActivity', () => {
  test('counts only messages inside the observation period and ranks ties by channel name', () => {
    const scans: ChannelMessageScan[] = [
      {
        channelId: '1',
        channelName: 'support',
        status: 'complete',
        messages: [
          { id: 'm1', timestamp: '2026-08-27T11:00:00.000Z' },
          { id: 'm2', timestamp: '2026-08-21T12:00:00.000Z' },
          { id: 'old', timestamp: '2026-08-20T11:59:59.000Z' },
        ],
      },
      {
        channelId: '2',
        channelName: 'announcements',
        status: 'complete',
        messages: [
          { id: 'm3', timestamp: '2026-08-26T12:00:00.000Z' },
          { id: 'm4', timestamp: '2026-08-25T12:00:00.000Z' },
        ],
      },
    ];

    expect(calculateMessageActivity(scans, PERIOD)).toEqual({
      visibleMessageCount: 4,
      ranking: [
        {
          channelId: '2',
          channelName: 'announcements',
          visibleMessageCount: 2,
          countIsLowerBound: false,
        },
        {
          channelId: '1',
          channelName: 'support',
          visibleMessageCount: 2,
          countIsLowerBound: false,
        },
      ],
      cappedChannels: [],
      unavailableChannels: [],
    });
  });

  test('marks capped counts as lower bounds and keeps unavailable channels out of the ranking', () => {
    const scans: ChannelMessageScan[] = [
      {
        channelId: '1',
        channelName: 'busy',
        status: 'capped',
        messages: [
          { id: 'm1', timestamp: '2026-08-27T11:00:00.000Z' },
          { id: 'm2', timestamp: '2026-08-27T10:00:00.000Z' },
        ],
      },
      {
        channelId: '2',
        channelName: 'private',
        status: 'unavailable',
        messages: [],
        reason: 'Missing View Channel or Read Message History permission.',
      },
    ];

    expect(calculateMessageActivity(scans, PERIOD)).toEqual({
      visibleMessageCount: 2,
      ranking: [
        {
          channelId: '1',
          channelName: 'busy',
          visibleMessageCount: 2,
          countIsLowerBound: true,
        },
      ],
      cappedChannels: ['busy'],
      unavailableChannels: [
        {
          channelId: '2',
          channelName: 'private',
          reason: 'Missing View Channel or Read Message History permission.',
        },
      ],
    });
  });
});

describe('calculateInactiveChannels', () => {
  test('separates inactive, empty, active, and permission-blocked channels', () => {
    const observations: LatestMessageObservation[] = [
      {
        channelId: '1',
        channelName: 'active',
        status: 'available',
        latestVisibleMessageAt: '2026-08-26T12:00:00.000Z',
      },
      {
        channelId: '2',
        channelName: 'old',
        status: 'available',
        latestVisibleMessageAt: '2026-07-01T12:00:00.000Z',
      },
      {
        channelId: '3',
        channelName: 'empty',
        status: 'available',
        latestVisibleMessageAt: null,
      },
      {
        channelId: '4',
        channelName: 'private',
        status: 'unavailable',
        reason: 'Missing View Channel or Read Message History permission.',
      },
    ];

    expect(
      calculateInactiveChannels(observations, {
        observedAt: '2026-08-27T12:00:00.000Z',
        thresholdDays: 30,
      }),
    ).toEqual({
      inactive: [
        {
          channelId: '2',
          channelName: 'old',
          latestVisibleMessageAt: '2026-07-01T12:00:00.000Z',
          inactiveForDays: 57,
        },
      ],
      noVisibleMessages: [{ channelId: '3', channelName: 'empty' }],
      activeChannelCount: 1,
      unavailableChannels: [
        {
          channelId: '4',
          channelName: 'private',
          reason: 'Missing View Channel or Read Message History permission.',
        },
      ],
    });
  });
});

describe('assessPermissionRisks', () => {
  test('flags high-impact assignable roles and everyone channel overrides without alleging abuse', () => {
    const administrator = PermissionFlagsBits.Administrator.toString();
    const mentionEveryone = PermissionFlagsBits.MentionEveryone.toString();
    const manageMessages = PermissionFlagsBits.ManageMessages.toString();

    expect(
      assessPermissionRisks({
        guildId: 'guild',
        roles: [
          {
            id: 'guild',
            name: '@everyone',
            permissions: mentionEveryone,
            managed: false,
          },
          {
            id: 'admin',
            name: 'Operations',
            permissions: administrator,
            managed: false,
          },
          {
            id: 'managed',
            name: 'Managed integration',
            permissions: administrator,
            managed: true,
          },
        ],
        channels: [
          {
            id: 'channel',
            name: 'general',
            type: ChannelType.GuildText,
            permission_overwrites: [
              {
                id: 'guild',
                type: 0,
                allow: manageMessages,
                deny: '0',
              },
            ],
          },
        ],
      }),
    ).toEqual([
      {
        severity: 'high',
        subjectType: 'role',
        subjectId: 'admin',
        subjectName: 'Operations',
        permission: 'Administrator',
        explanation:
          'This assignable role bypasses channel-specific permission checks. Review who can receive it.',
      },
      {
        severity: 'high',
        subjectType: 'channel',
        subjectId: 'channel',
        subjectName: 'general',
        permission: 'ManageMessages',
        explanation:
          'The @everyone channel override grants a high-impact permission to every server member.',
      },
      {
        severity: 'medium',
        subjectType: 'role',
        subjectId: 'guild',
        subjectName: '@everyone',
        permission: 'MentionEveryone',
        explanation:
          'The @everyone role grants a high-impact permission to every server member.',
      },
    ]);
  });
});
