## Flue

This pnpm monorepo contains [Flue](https://flueframework.com/) agents and shared
integration code.

### Setup

Run from the original checkout:

```sh
pnpm install
```

Configure credentials from 1Password:

```sh
op inject -i discord/.env.example -o discord/.env
```

Each clone needs its own gitignored `discord/.env`.
[`.delta/linked`](.delta/linked) links it into local Delta worktrees. Cloud
Runners do not receive it.

### Agents

[Discord](discord/README.md) runs `DiscordAnalyst`, a read-only agent for one
configured Discord server.

### Shared packages

[`shared/discord`](shared/discord/) contains the Discord REST client, member
filters, and metrics.
