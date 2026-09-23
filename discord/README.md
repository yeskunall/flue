## Discord

`DiscordAnalyst` uses Claude Haiku 4.5 and Discord REST API v10 to answer
terminal questions about one configured Discord server.

> [!NOTE]  
> The bot is read-only. It cannot post messages, moderate members, or change
> server settings.

### What the agent can report

| Example question                                               | What the agent checks                                                                                    |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| "How many members do we have, and how many are online?"        | Discord's current approximate member and presence counts.                                                |
| "What channels, roles, and active threads do we have?"         | Categories, channels, roles, and active threads visible to the bot.                                      |
| "Which channels had the most messages in the last seven days?" | Observed message counts among the channels checked.                                                      |
| "Which channels have been quiet for 30 days?"                  | The latest visible message in each checked channel and whether it is older than the threshold.           |
| "How many users have Verified but not Muted?"                  | A matching-member count and details for up to 25 members. Filters can require or exclude multiple roles. |
| "What events are coming up?"                                   | Upcoming and ongoing scheduled events. Subscriber counts indicate interest, not attendance.              |
| "What moderation actions happened this week?"                  | Recent moderation and administrative audit-log entries.                                                  |
| "Which roles or channel permissions should we review?"         | Selected high-impact permissions on non-managed roles and explicit `@everyone` channel allow overrides.  |

Results depend on the bot's permissions and the [limits](#limits).

### Configure

Create `discord/.env` by following the repository's
[setup instructions](../README.md#setup) before running the agent.

#### Discord access

Use a bot installed in the server you want to query. Create or manage the bot in
the [Discord Developer Portal](https://discord.com/developers/applications).
Grant these permissions as needed:

| Permission           | Used for                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------ |
| View Channels        | Channel structure and accessible channels                                                        |
| Read Message History | Message-activity and latest-message checks                                                       |
| Connect              | Reading text chat attached to voice and stage channels, in addition to the two permissions above |
| View Audit Log       | Optional; recent moderation and administrative activity                                          |

The bot does not need Administrator, permission to send messages, or Message
Content intent.

Member-by-role queries also require Server Members Intent, `GUILD_MEMBERS`.
Enable it under Bot > Privileged Gateway Intents in the Developer Portal. You do
not need to reinstall the bot.

Apps visible to fewer than 10,000 unique users can enable the intent without
applying. At or above that threshold, follow Discord's
[intent review requirements](https://docs.discord.com/developers/gateway/getting-started-with-privileged-intent-review).

Without the required intent access, the tool reports member lookups as
unavailable rather than returning a zero count. The other tools do not require
privileged intents.

### Run

```sh
pnpm ask --message "Give me an overview of this server."
```

Run commands from the repository root. Each `ask` starts a new conversation.

Use `ask:continue` for follow-up questions:

```sh
pnpm ask:continue --message "Which channels had the most messages in the last seven days?"
pnpm ask:continue --message "Now show only the top five observed counts."
```

Every `ask:continue` uses the saved `discord-cli` conversation. A plain `ask`
starts a separate conversation.

Answers go to stdout. Progress and errors go to stderr. Use `--json` for
machine-readable output.

### Limits

| Query             | Coverage                                                                                                                         |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Server overview   | Member and presence counts are approximate.                                                                                      |
| Message activity  | 1 to 30 days; up to 50 channels, 500 messages per channel, and 5,000 messages total. Capped counts are lower bounds.             |
| Inactive channels | 1 to 365 days; latest visible message in up to 50 channels.                                                                      |
| Members by role   | Up to 100,000 members, 1,000 per request, with a two-minute limit. Responses include details for up to 25 matches.               |
| Active threads    | Active threads only. `memberCount` is approximate and capped at 50. `messageCount` excludes the first post and deleted messages. |
| Audit log         | 1 to 45 days; up to 300 entries. Discord retains audit logs for roughly 45 days.                                                 |

- Message activity rankings compare the messages fetched from the channels
  checked. A partial scan cannot identify the server's busiest channels.
- Message checks cover text and announcement channels, plus text chat in voice
  and stage channels. They do not read thread, forum, or media-post history.
- Permission findings flag selected permissions on non-managed roles and
  explicit `@everyone` channel overrides. They do not account for role hierarchy
  or show who can assign a role. Treat them as items to review, not a full
  access audit or evidence of abuse.
- The agent cannot report Server Insights, retention, country or device
  statistics, join sources, or deleted messages. It does not read message text,
  download attachments, export conversations, or monitor spam.
- The tools mark denied channel history as unavailable. Other access errors may
  fail the whole query.

### Conversation history

Flue stores conversation history in `discord/node_modules/.cache/flue/run.db` by
default.
