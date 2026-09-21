## Flue

This pnpm monorepo contains [Flue](https://flueframework.com/) agents and shared
integration code.

### Agents

[Discord](discord/README.md) runs `DiscordAnalyst`, a read-only agent for one
configured Discord server.

### Credentials

Delta runs [`.agents/prepare`](.agents/prepare) in new worktrees to load
credentials from 1Password.

### Shared packages

[`shared/discord`](shared/discord/) contains the Discord REST client, member
filters, and metrics.
