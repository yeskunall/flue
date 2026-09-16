import { PermissionFlagsBits, Routes } from 'discord-api-types/v10';
import { describe, expect, test } from 'vitest';
import { DiscordReader } from '#/reader.ts';
import type {
  DiscordRestTransport,
  DiscordRestOptions,
} from '#/reader.ts';

const NOW = new Date('2026-08-27T12:00:00.000Z');
const READABLE_CHANNEL_PERMISSIONS = (
  PermissionFlagsBits.ViewChannel | PermissionFlagsBits.ReadMessageHistory
).toString();

function reader(
  get: DiscordRestTransport['get'],
  limits: ConstructorParameters<typeof DiscordReader>[2] = {},
) {
  return new DiscordReader({ get }, '123456789012345678', {
    now: () => NOW,
    ...limits,
  });
}

function queryValue(options: DiscordRestOptions | undefined, key: string): string | null {
  return options?.query?.get(key) ?? null;
}

function withBotPermissions(
  permissions: string,
  get: DiscordRestTransport['get'],
): DiscordRestTransport['get'] {
  return async (route, options) => {
    if (route === Routes.user()) {
      return { id: 'bot-user', username: 'Campfire bot' };
    }
    if (route === Routes.guildMember('123456789012345678', 'bot-user')) {
      return { roles: ['bot-role'], user: { id: 'bot-user', username: 'Campfire bot' } };
    }
    if (route === Routes.guildRoles('123456789012345678')) {
      return [
        {
          id: '123456789012345678',
          name: '@everyone',
          permissions: '0',
          position: 0,
          managed: false,
          color: 0,
          hoist: false,
          mentionable: false,
        },
        {
          id: 'bot-role',
          name: 'Campfire bot',
          permissions,
          position: 1,
          managed: true,
          color: 0,
          hoist: false,
          mentionable: false,
        },
      ];
    }
    return get(route, options);
  };
}

describe('DiscordReader server data', () => {
  test('fetches a trusted guild overview with approximate counts and a retrieval timestamp', async () => {
    const discord = reader(async (route, options) => {
      if (route !== Routes.guild('123456789012345678')) throw new Error(`Unexpected route: ${route}`);
      if (queryValue(options, 'with_counts') !== 'true') {
        throw new Error('The overview request did not ask Discord for approximate counts.');
      }
      return {
        id: '123456789012345678',
        name: 'Campfire',
        description: 'A place to build together',
        icon: null,
        owner_id: 'owner',
        features: ['COMMUNITY'],
        verification_level: 2,
        premium_tier: 1,
        premium_subscription_count: 4,
        approximate_member_count: 240,
        approximate_presence_count: 37,
      };
    });

    await expect(discord.getServerOverview()).resolves.toEqual({
      source: 'Discord REST API v10',
      retrievedAt: '2026-08-27T12:00:00.000Z',
      facts: {
        id: '123456789012345678',
        name: 'Campfire',
        description: 'A place to build together',
        ownerId: 'owner',
        features: ['COMMUNITY'],
        verificationLevel: 2,
        premiumTier: 1,
        premiumSubscriptionCount: 4,
        approximateMemberCount: 240,
        approximatePresenceCount: 37,
      },
      unavailable: [],
    });
  });

  test('normalizes channels, categories, roles, active threads, and calculated permission risks', async () => {
    const discord = reader(async (route) => {
      if (route === Routes.guildChannels('123456789012345678')) {
        return [
          {
            id: 'category',
            type: 4,
            name: 'Community',
            position: 0,
            permission_overwrites: [],
          },
          {
            id: 'general',
            type: 0,
            name: 'general',
            position: 1,
            parent_id: 'category',
            topic: 'Say hello',
            nsfw: false,
            permission_overwrites: [],
          },
        ];
      }
      if (route === Routes.guildRoles('123456789012345678')) {
        return [
          {
            id: '123456789012345678',
            name: '@everyone',
            permissions: '0',
            position: 0,
            managed: false,
            color: 0,
            hoist: false,
            mentionable: false,
          },
        ];
      }
      if (route === Routes.guildActiveThreads('123456789012345678')) {
        return {
          threads: [
            {
              id: 'thread',
              type: 11,
              name: 'Launch notes',
              parent_id: 'general',
              owner_id: 'owner',
              message_count: 12,
              member_count: 4,
              thread_metadata: {
                archived: false,
                auto_archive_duration: 1440,
                archive_timestamp: '2026-08-27T10:00:00.000Z',
                locked: false,
              },
            },
          ],
          members: [],
        };
      }
      throw new Error(`Unexpected route: ${route}`);
    });

    await expect(discord.getServerStructure()).resolves.toMatchObject({
      source: 'Discord REST API v10',
      retrievedAt: '2026-08-27T12:00:00.000Z',
      facts: {
        categories: [{ id: 'category', name: 'Community', position: 0 }],
        channels: [
          {
            id: 'general',
            name: 'general',
            type: 'GuildText',
            categoryId: 'category',
            topic: 'Say hello',
          },
        ],
        roles: [{ id: '123456789012345678', name: '@everyone', permissions: '0' }],
        activeThreads: [
          {
            id: 'thread',
            name: 'Launch notes',
            parentId: 'general',
            messageCount: 12,
            memberCount: 4,
          },
        ],
      },
      calculations: {
        categoryCount: 1,
        channelCount: 1,
        roleCount: 1,
        activeThreadCount: 1,
        permissionRiskIndicators: [],
      },
      unavailable: [],
    });
  });

  test('uses null rather than zero when server structure is unavailable', async () => {
    const discord = reader(async (route) => {
      if (
        route === Routes.guildChannels('123456789012345678') ||
        route === Routes.guildRoles('123456789012345678') ||
        route === Routes.guildActiveThreads('123456789012345678')
      ) {
        throw Object.assign(new Error('Missing Access'), {
          status: 403,
          code: 50_001,
        });
      }
      throw new Error(`Unexpected route: ${route}`);
    });

    await expect(discord.getServerStructure()).resolves.toMatchObject({
      facts: {
        categories: null,
        channels: null,
        roles: null,
        activeThreads: null,
      },
      calculations: {
        categoryCount: null,
        channelCount: null,
        roleCount: null,
        activeThreadCount: null,
      },
      unavailable: [
        { scope: 'channels' },
        { scope: 'roles' },
        { scope: 'active-threads' },
      ],
    });
  });
});

describe('DiscordReader message scans', () => {
  test('scans only message-capable channels and reports capped counts as lower bounds', async () => {
    const discord = reader(
      withBotPermissions(READABLE_CHANNEL_PERMISSIONS, async (route, options) => {
        if (route === Routes.guildChannels('123456789012345678')) {
          return [
            {
              id: 'text',
              type: 0,
              name: 'general',
              position: 0,
              permission_overwrites: [],
            },
            {
              id: 'category',
              type: 4,
              name: 'Community',
              position: 1,
              permission_overwrites: [],
            },
          ];
        }
        if (route === Routes.channelMessages('text')) {
          const before = queryValue(options, 'before');
          if (before === null) {
            return [
              { id: '3', timestamp: '2026-08-27T11:00:00.000Z' },
              { id: '2', timestamp: '2026-08-27T10:00:00.000Z' },
            ];
          }
          if (before === '2') {
            return [
              { id: '1', timestamp: '2026-08-27T09:00:00.000Z' },
              { id: '0', timestamp: '2026-08-19T09:00:00.000Z' },
            ];
          }
        }
        throw new Error(`Unexpected route: ${route}`);
      }),
      {
        maxChannels: 10,
        maxMessagesPerChannel: 3,
        maxTotalMessages: 10,
        pageSize: 2,
      },
    );

    await expect(discord.getMessageActivity(7)).resolves.toMatchObject({
      source: 'Discord REST API v10',
      observationPeriod: {
        start: '2026-08-20T12:00:00.000Z',
        end: '2026-08-27T12:00:00.000Z',
      },
      calculations: {
        visibleMessageCount: 3,
        ranking: [
          {
            channelId: 'text',
            channelName: 'general',
            visibleMessageCount: 3,
            countIsLowerBound: true,
          },
        ],
        cappedChannels: ['general'],
      },
      scan: {
        eligibleChannelCount: 1,
        scannedChannelCount: 1,
        maxChannels: 10,
        maxMessagesPerChannel: 3,
        maxTotalMessages: 10,
        truncated: true,
      },
      unavailable: [],
    });
  });

  test('keeps an unreadable channel unavailable without failing the activity result', async () => {
    const discord = reader(
      withBotPermissions(READABLE_CHANNEL_PERMISSIONS, async (route) => {
        if (route === Routes.guildChannels('123456789012345678')) {
          return [
            {
              id: 'visible',
              type: 0,
              name: 'visible',
              position: 0,
              permission_overwrites: [],
            },
            {
              id: 'private',
              type: 0,
              name: 'private',
              position: 1,
              permission_overwrites: [],
            },
          ];
        }
        if (route === Routes.channelMessages('visible')) return [];
        if (route === Routes.channelMessages('private')) {
          throw Object.assign(new Error('Missing Permissions'), {
            status: 403,
            code: 50_013,
          });
        }
        throw new Error(`Unexpected route: ${route}`);
      }),
    );

    await expect(discord.getMessageActivity(7)).resolves.toMatchObject({
      calculations: {
        unavailableChannels: [
          {
            channelId: 'private',
            channelName: 'private',
            reason: 'Missing View Channel or Read Message History permission.',
          },
        ],
      },
      unavailable: [
        {
          scope: 'channel:private',
          reason: 'Missing View Channel or Read Message History permission.',
          requiredPermissions: ['View Channel', 'Read Message History'],
        },
      ],
    });
  });

  test('does not mistake an empty response for zero activity when Read Message History is missing', async () => {
    const discord = reader(
      withBotPermissions(PermissionFlagsBits.ViewChannel.toString(), async (route) => {
        if (route === Routes.guildChannels('123456789012345678')) {
          return [
            {
              id: 'history-blocked',
              type: 0,
              name: 'history-blocked',
              position: 0,
              permission_overwrites: [],
            },
          ];
        }
        if (route === Routes.channelMessages('history-blocked')) {
          throw new Error('Message history must not be requested without permission.');
        }
        throw new Error(`Unexpected route: ${route}`);
      }),
    );

    await expect(discord.getMessageActivity(7)).resolves.toMatchObject({
      calculations: {
        visibleMessageCount: 0,
        ranking: [],
        unavailableChannels: [
          {
            channelId: 'history-blocked',
            channelName: 'history-blocked',
            reason: 'Missing Read Message History permission.',
          },
        ],
      },
      unavailable: [
        {
          scope: 'channel:history-blocked',
          reason: 'Missing Read Message History permission.',
          requiredPermissions: ['Read Message History'],
        },
      ],
    });
  });

  test('treats Administrator as granting message-read permissions', async () => {
    let messageRequests = 0;
    const discord = reader(
      withBotPermissions(PermissionFlagsBits.Administrator.toString(), async (route) => {
        if (route === Routes.guildChannels('123456789012345678')) {
          return [
            {
              id: 'admin-visible',
              type: 0,
              name: 'admin-visible',
              position: 0,
              permission_overwrites: [],
            },
          ];
        }
        if (route === Routes.channelMessages('admin-visible')) {
          messageRequests += 1;
          return [{ id: 'message', timestamp: '2026-08-27T11:00:00.000Z' }];
        }
        throw new Error(`Unexpected route: ${route}`);
      }),
    );

    const result = await discord.getMessageActivity(7);

    expect(messageRequests).toBe(1);
    expect(result.calculations.ranking).toEqual([
      {
        channelId: 'admin-visible',
        channelName: 'admin-visible',
        visibleMessageCount: 1,
        countIsLowerBound: false,
      },
    ]);
    expect(result.unavailable).toEqual([]);
  });

  test('allocates the global message budget across concurrent channels', async () => {
    const requestedChannels: string[] = [];
    const discord = reader(
      withBotPermissions(READABLE_CHANNEL_PERMISSIONS, async (route) => {
        if (route === Routes.guildChannels('123456789012345678')) {
          return [
            {
              id: 'empty',
              type: 0,
              name: 'empty',
              position: 0,
              permission_overwrites: [],
            },
            {
              id: 'active',
              type: 0,
              name: 'active',
              position: 1,
              permission_overwrites: [],
            },
          ];
        }
        if (route === Routes.channelMessages('empty')) {
          requestedChannels.push('empty');
          return [];
        }
        if (route === Routes.channelMessages('active')) {
          requestedChannels.push('active');
          return [{ id: 'message', timestamp: '2026-08-27T11:00:00.000Z' }];
        }
        throw new Error(`Unexpected route: ${route}`);
      }),
      {
        maxChannels: 2,
        maxMessagesPerChannel: 2,
        maxTotalMessages: 2,
        pageSize: 2,
        concurrency: 2,
      },
    );

    const result = await discord.getMessageActivity(7);

    expect(requestedChannels.toSorted()).toEqual(['active', 'empty']);
    expect(result.calculations.ranking[0]).toMatchObject({
      channelName: 'active',
      visibleMessageCount: 1,
    });
    expect(result.scan.scannedChannelCount).toBe(2);
  });

  test('records retrieval completion separately from the observation cutoff', async () => {
    let clockCalls = 0;
    const discord = reader(
      withBotPermissions(READABLE_CHANNEL_PERMISSIONS, async (route) => {
        if (route === Routes.guildChannels('123456789012345678')) return [];
        throw new Error(`Unexpected route: ${route}`);
      }),
      {
        now: () =>
          clockCalls++ === 0
            ? new Date('2026-08-27T12:00:00.000Z')
            : new Date('2026-08-27T12:00:05.000Z'),
      },
    );

    await expect(discord.getMessageActivity(7)).resolves.toMatchObject({
      retrievedAt: '2026-08-27T12:00:05.000Z',
      observationPeriod: {
        end: '2026-08-27T12:00:00.000Z',
      },
    });
  });

  test('uses one latest visible message per channel to calculate inactivity', async () => {
    const discord = reader(
      withBotPermissions(READABLE_CHANNEL_PERMISSIONS, async (route, options) => {
        if (route === Routes.guildChannels('123456789012345678')) {
          return [
            {
              id: 'old',
              type: 0,
              name: 'old-news',
              position: 0,
              permission_overwrites: [],
            },
            {
              id: 'private',
              type: 0,
              name: 'private',
              position: 1,
              permission_overwrites: [],
            },
          ];
        }
        if (route === Routes.channelMessages('old')) {
          if (queryValue(options, 'limit') !== '1') {
            throw new Error('Expected a one-message lookup.');
          }
          return [{ id: 'old-message', timestamp: '2026-06-01T12:00:00.000Z' }];
        }
        if (route === Routes.channelMessages('private')) {
          throw Object.assign(new Error('Missing Access'), {
            status: 403,
            code: 50_001,
          });
        }
        throw new Error(`Unexpected route: ${route}`);
      }),
    );

    await expect(discord.getInactiveChannels(30)).resolves.toMatchObject({
      observationPeriod: {
        start: '2026-07-28T12:00:00.000Z',
        end: '2026-08-27T12:00:00.000Z',
      },
      calculations: {
        inactive: [
          {
            channelId: 'old',
            channelName: 'old-news',
            latestVisibleMessageAt: '2026-06-01T12:00:00.000Z',
            inactiveForDays: 87,
          },
        ],
        unavailableChannels: [
          {
            channelId: 'private',
            channelName: 'private',
            reason: 'Missing View Channel or Read Message History permission.',
          },
        ],
      },
    });
  });
});

describe('DiscordReader optional resources', () => {
  test('returns upcoming scheduled events as fetched facts', async () => {
    const discord = reader(async (route, options) => {
      if (route !== Routes.guildScheduledEvents('123456789012345678')) {
        throw new Error(`Unexpected route: ${route}`);
      }
      if (queryValue(options, 'with_user_count') !== 'true') {
        throw new Error('Expected scheduled event user counts.');
      }
      return [
        {
          id: 'event',
          guild_id: '123456789012345678',
          channel_id: null,
          creator_id: 'creator',
          name: 'Town hall',
          description: 'Monthly update',
          scheduled_start_time: '2026-08-29T17:00:00.000Z',
          scheduled_end_time: '2026-08-29T18:00:00.000Z',
          privacy_level: 2,
          status: 1,
          entity_type: 3,
          entity_id: null,
          entity_metadata: { location: 'Online' },
          user_count: 14,
        },
      ];
    });

    await expect(discord.getUpcomingEvents()).resolves.toMatchObject({
      facts: {
        events: [
          {
            id: 'event',
            name: 'Town hall',
            description: 'Monthly update',
            scheduledStartTime: '2026-08-29T17:00:00.000Z',
            scheduledEndTime: '2026-08-29T18:00:00.000Z',
            location: 'Online',
            interestedUserCount: 14,
          },
        ],
      },
      unavailable: [],
    });
  });

  test('uses null rather than zero when scheduled events are unavailable', async () => {
    const discord = reader(async (route) => {
      if (route === Routes.guildScheduledEvents('123456789012345678')) {
        throw Object.assign(new Error('Missing Access'), {
          status: 403,
          code: 50_001,
        });
      }
      throw new Error(`Unexpected route: ${route}`);
    });

    await expect(discord.getUpcomingEvents()).resolves.toMatchObject({
      facts: { events: null },
      calculations: { upcomingEventCount: null },
      unavailable: [{ scope: 'scheduled-events' }],
    });
  });

  test('normalizes recent audit-log actions and actor names', async () => {
    const occurredAt = '2026-08-26T10:00:00.000Z';
    const entryId = (
      (BigInt(Date.parse(occurredAt)) - 1_420_070_400_000n) <<
      22n
    ).toString();
    const discord = reader(async (route, options) => {
      if (route !== Routes.guildAuditLog('123456789012345678')) {
        throw new Error(`Unexpected route: ${route}`);
      }
      if (queryValue(options, 'limit') !== '100') {
        throw new Error('Expected the Discord audit-log page limit.');
      }
      return {
        audit_log_entries: [
          {
            id: entryId,
            action_type: 22,
            user_id: 'moderator',
            target_id: 'member',
            reason: 'Repeated spam',
            changes: [],
          },
        ],
        users: [{ id: 'moderator', username: 'Ada' }],
      };
    });

    await expect(discord.getRecentAuditLog(7)).resolves.toMatchObject({
      facts: {
        entries: [
          {
            id: entryId,
            occurredAt,
            actionType: 22,
            actionName: 'MemberBanAdd',
            actorId: 'moderator',
            actorUsername: 'Ada',
            targetId: 'member',
            reason: 'Repeated spam',
          },
        ],
      },
      calculations: {
        actionCount: 1,
        actionsByType: { MemberBanAdd: 1 },
      },
      scan: {
        fetchedEntryCount: 1,
        truncated: false,
      },
      unavailable: [],
    });
  });

  test('turns a missing View Audit Log permission into metric-level unavailability', async () => {
    const discord = reader(async (route) => {
      if (route === Routes.guildAuditLog('123456789012345678')) {
        throw Object.assign(new Error('Missing Permissions'), { status: 403, code: 50_013 });
      }
      throw new Error(`Unexpected route: ${route}`);
    });

    await expect(discord.getRecentAuditLog(7)).resolves.toEqual({
      source: 'Discord REST API v10',
      retrievedAt: '2026-08-27T12:00:00.000Z',
      observationPeriod: {
        start: '2026-08-20T12:00:00.000Z',
        end: '2026-08-27T12:00:00.000Z',
      },
      facts: { entries: null },
      scan: {
        fetchedEntryCount: 0,
        maxEntries: 300,
        truncated: false,
      },
      unavailable: [
        {
          scope: 'audit-log',
          reason: 'Discord did not allow this bot to view the guild audit log.',
          requiredPermissions: ['View Audit Log'],
        },
      ],
    });
  });
});
