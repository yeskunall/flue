# Flue

This is a Flue project for Discord bots. Discord is the only integration
implemented so far. The `discord/` workspace holds the Flue app, and
`shared/discord/` holds reusable Discord API code.

The app has one agent, `DiscordAnalyst`, which you run from your terminal.
Flue uses Claude Haiku 4.5 to answer your questions. The agent's tools use a
bot token to read one configured server through Discord REST API v10.

The app is read-only. It cannot post messages, create events, or
moderate members. It has no commands inside Discord, web UI, webhook
endpoints, or background collection.

## Questions you can ask

| Example question                                               | What the agent can report                                                                                        |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| "How many members do we have, and how many are online?"        | Discord's current approximate member and online counts.                                                          |
| "What channels, roles, and active threads do we have?"         | The server's categories, channels, roles, and active threads visible to the bot.                                 |
| "Which channels had the most messages in the last seven days?" | Message counts and channel rankings based on messages the bot can read.                                          |
| "Which channels have been quiet for 30 days?"                  | Each checked channel's latest visible message and whether it is older than the threshold.                        |
| "How many users have Verified but not Muted?"                  | The matching-member count, with details for up to 25 people. Role filters can require or exclude multiple roles. |
| "What events are coming up?"                                   | Upcoming and ongoing scheduled events. Subscriber counts show interest, not attendance.                          |
| "What moderation actions happened this week?"                  | Recent moderation and administrative entries from the audit log.                                                 |
| "Which roles or channel permissions should we review?"         | High-impact permissions on assignable roles and elevated `@everyone` channel overrides.                          |

These answers depend on the bot's access and the
[scan limits](#limits-and-unavailable-data). The agent is instructed to fetch
fresh data for each answer about the server, include retrieval times, and
distinguish Discord's data from its own calculations.

It cannot answer questions about Server Insights, retention, country or
device statistics, join sources, deleted messages, or history that Discord
no longer exposes. It does not summarize message content or monitor spam.

## Setup

Use Node.js 24 LTS, at least version 24.14.0, and pnpm 11.25.0. You'll also
need an Anthropic API key. Run the commands below from the repository root.

### 1. Add a Discord bot

Create an application and bot in the
[Discord Developer Portal](https://discord.com/developers/applications), then
install it in your server. Under **Bot**, select **Reset Token** and copy
the token. Discord only shows it once. Keep it out of source control.
[Discord's token instructions](https://support-dev.discord.com/hc/en-us/articles/6470840524311-Why-can-t-I-copy-my-bot-s-token)
explain how to get a replacement if you lose it.

Grant only the permissions needed for the data you want:

| Permission           | Used for                                                |
| -------------------- | ------------------------------------------------------- |
| View Channels        | Seeing channel structure and accessible channels        |
| Read Message History | Message activity and latest-message checks              |
| View Audit Log       | Optional; recent moderation and administrative activity |

You don't need `Administrator`, message-send permissions, webhooks, or a
Gateway connection. Message Content intent isn't needed either. Activity
counts use message IDs and timestamps, not message text.

To look up members by role, you also need Server Members intent,
`GUILD_MEMBERS`. In the Developer Portal, open **Bot**, find **Privileged
Gateway Intents**, and enable **Server Members Intent**. This is an
application setting, not a role permission. You don't need to reinvite the
bot.

If Discord asks you to apply for access, follow its
[privileged-intent review guide](https://docs.discord.com/developers/gateway/getting-started-with-privileged-intent-review)
before relying on member lookups. The
[member-list REST endpoint](https://docs.discord.com/developers/resources/guild#list-guild-members)
requires this intent even without a Gateway connection. The other tools work
without it.

### 2. Set your credentials

For a new checkout, copy the example file. If you already have `discord/.env`,
edit it instead of replacing it.

```sh
cp discord/.env.example discord/.env
```

Set all three values in `discord/.env`:

```dotenv
DISCORD_BOT_TOKEN=your_bot_token
DISCORD_GUILD_ID=the_server_id
ANTHROPIC_API_KEY=your_anthropic_key
```

`DISCORD_GUILD_ID` is the Discord Server ID. Open **User Settings**, then
**Advanced**, and enable **Developer Mode**. Right-click the server icon and
select **Copy Server ID**. For desktop and mobile instructions, see
[Where can I find my User/Server/Message ID?](https://support.discord.com/hc/en-us/articles/206346498-Where-can-I-find-my-User-Server-Message-ID).

Every question uses this server. The agent cannot choose a different one.

### 3. Install and run

```sh
pnpm install
pnpm ask --message "Give me an overview of this server."
```

Use a normal `pnpm install`. A production-only install leaves out development
dependencies, including the Flue CLI needed by `pnpm ask`.

The root commands run inside the `discord/` workspace, where Flue loads `.env`
and runs the TypeScript agent directly. You don't need to build the app or
start a web server.

## Ask questions

Each `ask` starts a new conversation. To ask follow-up questions, use
`ask:continue` for both messages:

```sh
pnpm ask:continue --message "Which channels had the most messages in the last seven days?"
pnpm ask:continue --message "Now show only the top five."
```

Every `ask:continue` uses the same saved conversation, `discord-cli`. It
doesn't pick up your most recent `ask`.

Flue writes the answer to stdout. Progress and errors go to stderr. Add
`--json` for a machine-readable result, or pipe the Markdown answer to `glow`:

```sh
pnpm --silent ask --message "Give me an overview of this server." 2>/dev/null | glow -
```

The redirection hides errors as well as progress. Omit `2>/dev/null` when
troubleshooting.

See the
[Flue `run` command reference](https://flueframework.com/docs/cli/run/) for all
options.

### Find members by role

Describe the roles you want to include or exclude:

```sh
pnpm --silent ask --message "How many users have the Verified role?"
pnpm --silent ask --message "List users with both Verified and Staff, but without Muted."
pnpm --silent ask --message "Give me humans with either Verified or Staff, excluding Muted."
pnpm --silent ask --message "List everyone without either Verified or Staff."
```

Use your server's role names, IDs, or Discord role mentions. If a name is
unknown or belongs to more than one role, the agent asks you to clarify.
The lookup includes humans and bots unless you ask for only one. Use
`@everyone` to select everyone, including members with no explicit roles.

The `get_members_by_roles` tool accepts three groups:

- `allOf` requires every listed role.
- `anyOf` requires at least one listed role when the group is nonempty.
- `noneOf` excludes anyone with any listed role.

A member must satisfy every group. For example,
`allOf: ["Verified"], noneOf: ["Muted"]` means Verified but not Muted.

The agent gets the matching count and details for up to 25 members, along
with the filter, role definitions, and how much of the server was checked.
A completed scan that finds 30,000 matches reports a count of 30,000. The
25-person preview doesn't change that count. When more than 25 people match,
the preview is marked as truncated. There is no file export or next-page
option.

A lookup reads up to 100,000 members, 1,000 per request, with a two-minute
limit. If it stops early, the count is incomplete and there may be more
matches. If Discord denies access, the result is unavailable, not zero.

Roles can change while the lookup runs. Results describe what the bot saw
between the reported start and end times. They don't show when someone
received a role.

## Limits and unavailable data

The bot can only report on data it has permission to read. The tools report
missing channel or audit-log access as unavailable.

Message activity queries accept periods of 1 to 30 days. A scan checks at
most 50 channels, 500 messages per channel, and 5,000 messages in total. The
total allowance is split across readable channels, so some channels get
fewer than 500. Counts that hit a limit are lower bounds. The real number
may be higher.

Inactivity checks accept thresholds of 1 to 365 days. They check the latest
visible message in each of up to 50 channels. They report channels with no
visible messages separately from channels the bot cannot read.

Both checks cover text and announcement channels, plus text chat in voice
and stage channels. They don't read message histories from threads, forums,
or media posts, including archived threads. The agent can list active
threads, but it does not scan their messages.

Audit-log queries accept periods of 1 to 45 days and return up to the 300
most recent entries within that period. Discord retains audit logs for
roughly 45 days. If a query hits the entry limit, the result is incomplete
even if Discord still has older entries.

Permission findings point out settings worth checking; they don't prove
abuse or replace a full access review.

`@discordjs/rest` handles Discord's rate limits and retries. The app fetches
data only when asked. It does not maintain a separate history of server
activity.

## Data and conversation history

Flue sends your questions and tool results to Anthropic. Member previews
include IDs, usernames, display names, bot status, and role IDs. Other tool
results can include channel topics, event descriptions, and audit-log
details. Your saved conversations can contain these results too.

Flue stores conversation history in `discord/node_modules/.cache/flue/run.db`.
Deleting that workspace's `node_modules` deletes its history too. Back up
the database first if you want to keep it.

## Development

Install and check the whole workspace from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
```

GitHub Actions runs these checks for pull requests and pushes to `main`.
Formatting and lint warnings both fail the checks. TypeScript checks source and
tests across both workspaces using the root `tsconfig.json`; tests use fake
Discord responses and never contact Discord.

Run `pnpm format` to apply Oxfmt's canonical formatting and import sorting.
Imports through `#/` are treated as internal, while side-effect imports retain
their order. Oxfmt also normalizes `package.json` keys. The shared editor and
formatter policy uses two spaces, double quotes, semicolons, LF line endings,
and an 80-column target.

Run `pnpm lint:fix` for Oxlint's safe fixes only. Suggestions and dangerous
fixes are intentionally excluded; manually resolve anything that remains.
The `valid-expect` rule allows two arguments because Vitest accepts an optional
failure message.

Oxlint enables the `correctness` and `suspicious` categories across its
TypeScript, Unicorn, Oxc, import, and Vitest plugins. It adds focused rules from
the
[reference ESLint configuration](https://github.com/yeskunall/astro-umami/blob/854a3751e8209b00843b60bc1f4838b744d02878/eslint.config.ts)
when enabling an entire additional category would introduce unrelated policy.
Option-sensitive rules spell out compatibility settings instead of relying on
Oxlint defaults.

Oxfmt replaces the reference's `@stylistic/eslint-plugin` rules; that plugin is
an ESLint style plugin, not Stylelint, so this repository does not add CSS
tooling. The tools are not perfectly rule-for-rule compatible: Oxfmt has no
exact setting for every Stylistic layout choice, and Oxlint relies on its parser
for the unsupported ESLint `no-octal` check. Oxfmt's output is the source of
truth where the style engines differ. Type-aware linting is not enabled.

The `perf`, `style`, `pedantic`, `restriction`, and `nursery` categories aren't
enabled wholesale. Discord pagination must fetch pages in order, and its worker
loops deliberately limit concurrency. Don't parallelize those awaits to satisfy
a lint rule.

### Layout and responsibilities

The `discord/` app is the private `@repo/discord-app` package. It follows Flue's
[multi-agent layout](https://flueframework.com/docs/guide/project-layout/#example-multi-agent-codebase):

```text
discord/
├── src/agents/analyst/
│   ├── agent.ts        # Model, instructions, and tools for DiscordAnalyst
│   └── tools/          # Flue tool definitions
└── tests/
shared/discord/
├── src/
│   ├── client.ts       # Optional environment-configured bot client
│   └── …               # Discord reads, role filtering, permissions, and metrics
└── tests/
package.json            # Commands that run from the repository root
pnpm-workspace.yaml     # Workspace packages and pinned dependency catalog
pnpm-lock.yaml
tsconfig.json           # Compiler settings for all workspaces
```

Put agent instructions and Flue tool definitions in `discord/`. The current
[agent](discord/src/agents/analyst/agent.ts#L34) registers its
[tools](discord/src/agents/analyst/tools/discord.ts#L16) there.

`shared/discord` is the private `@repo/discord` package and doesn't depend on
Flue. Keep reusable API calls, pagination, role filtering, and calculations
here. Its optional [client](shared/discord/src/client.ts#L9) entry point
validates the Discord environment variables on first use and reuses one
configured reader per process. The calling app loads `.env` files, not the
shared package.

Agents can share this client through their Flue tools. For a different
configuration, pass a connection and server ID to `DiscordReader`.
Additional agents can live in `discord/src/agents/`. Another reusable
integration can have its own package under `shared/`.

`flue run` names the agent file explicitly, so it doesn't scan an agents
directory. This CLI uses Flue's defaults and needs no `app.ts`,
`flue.config.ts`, `db.ts`, or Vite configuration.

### Imports

Use `#/` for project imports. In the Flue app:

```ts
import { useDiscordTools } from "#/agents/analyst/tools/discord.ts";
import { getDiscordReader } from "#/discord/client";
```

Each package maps `#/*` to its own `src/` directory in `package.json`.
The Flue app also maps `#/discord` and `#/discord/*` to the shared package,
which is linked through `workspace:*`. Local file imports keep their `.ts`
extension; shared imports use the package's exported names.

These are native Node import mappings, also understood by TypeScript,
Vitest, and the Flue CLI. Node requires import-map names to
[start with `#`](https://github.com/nodejs/node/blob/71b8b174857e25106d39b61a9e6f30d927da8b01/doc/api/packages.md#L536-L541);
[`#/` became available in Node 24.14](https://github.com/nodejs/node/blob/71b8b174857e25106d39b61a9e6f30d927da8b01/doc/api/packages.md#L524-L534).
No alias plugin or build step is needed.

Keep type imports in their own `import type` declaration. `pnpm lint`
reports inline `type` markers as warnings through Oxlint.

### Dependencies

External dependency versions are pinned in the root `pnpm-workspace.yaml`.
Package manifests use `catalog:` to refer to those versions, and
`workspace:*` for local packages. The workspace keeps the seven-day release
cooldown and saves exact versions.
