# Install C3 Code

Build the desktop app from source. To update it, pull the latest changes and rebuild.

## Requirements

Node 24 and pnpm. You also need an installed, authenticated provider before starting a
thread. You can launch the app and configure providers afterwards.

## Run from source

```bash
pnpm install
pnpm dev
```

`pnpm dev` starts the renderer and Electron, which spawns the server from source. See the
[development runbook](../operations/development.md) for state locations and checks.

## Build a desktop app

```bash
pnpm build:desktop
pnpm dist:desktop:dmg      # macOS; see dist:desktop:linux and dist:desktop:win for the others
```

Artifacts are unsigned by default and land in `release/`. Platform prerequisites are in the
[development runbook](../operations/development.md#desktop-artifacts).

## Providers

Open **Settings → Providers** and enable the provider you want. Installation, login, and
configuration happen on this machine.

| Provider | Install and authenticate                                                                                                                                  |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex    | [Connect with ChatGPT](./providers-codex.md#connect-with-chatgpt), or install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`. |
| Claude   | Install [Claude Code](https://claude.com/product/claude-code), then run `claude auth login`.                                                              |

Provider CLIs must be on the `PATH`. If C3 Code cannot find one, set its **Binary path** in
provider settings, especially when using a version manager. Codex connected through ChatGPT can
use its managed runtime without a `PATH` entry.

C3 Code warns when a provider version has known compatibility problems with your build. Check
**Settings → Providers** for the recommended version or range. An unlisted version is
unverified.

When Homebrew has a newer version of a provider CLI, its provider card shows it with
**Update now**, which runs `brew upgrade`. C3 Code does not query npm or other package
registries, so update other installs the same way you installed them.

Add another provider instance for a separate account or configuration. Each instance can have
its own environment variables, such as API keys or a custom base URL. Mark secret values as
sensitive; after saving, C3 Code does not display their original values.

For provider-specific setup and accounts, see [Codex](./providers-codex.md) and
[Claude](./providers-claude.md).

## Next steps

- [Working with threads](./thread-sidebar.md): start tasks and organize parallel work.
- [Permission modes](./permission-modes.md): choose when agents ask before acting.
