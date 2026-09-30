import { REST } from "@discordjs/rest";
import type { RouteLike } from "@discordjs/rest";
import { createEnv } from "@t3-oss/env-core";
import { minLength, pipe, regex, string, trim } from "valibot";

import { DiscordReader } from "#/reader.ts";

let reader: DiscordReader | undefined;

export function getDiscordReader(): DiscordReader {
  if (reader) {
    return reader;
  }

  const env = createEnv({
    emptyStringAsUndefined: true,
    onValidationError(issues) {
      // Report variable names without logging their values.
      throw new Error(
        `Invalid environment variables: ${issues.map(issue => issue.path?.[0]).join(", ")}`,
      );
    },
    runtimeEnvStrict: {
      DISCORD_BOT_TOKEN: process.env.DISCORD_BOT_TOKEN,
      DISCORD_GUILD_ID: process.env.DISCORD_GUILD_ID,
    },
    server: {
      DISCORD_BOT_TOKEN: pipe(string(), trim(), minLength(1)),
      DISCORD_GUILD_ID: pipe(string(), trim(), regex(/^\d{17,20}$/)),
    },
  });
  const rest = new REST({
    globalRequestsPerSecond: 50,
    retries: 3,
    version: "10",
  }).setToken(env.DISCORD_BOT_TOKEN);

  reader = new DiscordReader(
    {
      get: (route, options) => rest.get(route as RouteLike, options),
    },
    env.DISCORD_GUILD_ID,
  );
  return reader;
}
