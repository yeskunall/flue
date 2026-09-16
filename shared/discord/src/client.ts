import { REST } from '@discordjs/rest';
import type { RouteLike } from '@discordjs/rest';
import { createEnv } from '@t3-oss/env-core';
import * as v from 'valibot';
import { DiscordReader } from '#/reader.ts';

let reader: DiscordReader | undefined;

export function getDiscordReader(): DiscordReader {
  if (reader) return reader;

  const env = createEnv({
    server: {
      DISCORD_BOT_TOKEN: v.pipe(v.string(), v.trim(), v.minLength(1)),
      DISCORD_GUILD_ID: v.pipe(v.string(), v.trim(), v.regex(/^\d{17,20}$/)),
    },
    runtimeEnvStrict: {
      DISCORD_BOT_TOKEN: process.env.DISCORD_BOT_TOKEN,
      DISCORD_GUILD_ID: process.env.DISCORD_GUILD_ID,
    },
    emptyStringAsUndefined: true,
    onValidationError(issues) {
      // Report variable names without logging their values.
      throw new Error(
        `Invalid environment variables: ${issues.map((issue) => issue.path?.[0]).join(', ')}`,
      );
    },
  });
  const rest = new REST({
    version: '10',
    retries: 3,
    globalRequestsPerSecond: 50,
  }).setToken(env.DISCORD_BOT_TOKEN);

  reader = new DiscordReader(
    {
      get: (route, options) => rest.get(route as RouteLike, options),
    },
    env.DISCORD_GUILD_ID,
  );
  return reader;
}
