# Install C3 Code

## macOS download

Download the DMG for your Mac from the
[latest release](https://github.com/Cave99/t3code-stripped/releases/latest): `arm64` for Apple
Silicon, `x64` for Intel. Open it and drag C3 Code to Applications. The app is self-contained:
Node, pnpm, and Electron are not needed. To update, install a newer release over it.

Releases are not notarized by Apple, so macOS blocks the first launch. Clear the download
quarantine once after copying the app:

```bash
xattr -dr com.apple.quarantine "/Applications/C3 Code.app"
```

Alternatively, try to open it once, then choose **Open Anyway** in **System Settings → Privacy &
Security**. Some managed Macs disallow both; ask IT to allow the app.

You still need an installed, authenticated provider before starting a thread; see
[Providers](#providers).

## Run from source

Requires Node 24 and pnpm.

```bash
pnpm install
pnpm dev
```

`pnpm dev` starts the renderer and Electron, which spawns the server from source. See the
[development runbook](../operations/development.md) for state locations and checks.

On an Apple Silicon Mac that cannot install npm packages or Electron, use the
[offline dev kit](../operations/development.md#offline-dev-kit) instead of `pnpm install`.

## Build a desktop app

```bash
pnpm build:desktop
pnpm dist:desktop:dmg      # macOS; see dist:desktop:linux and dist:desktop:win for the others
```

Artifacts land in `release/`; macOS builds are signed ad hoc. Pushing a `c3-v*` tag builds and
publishes the macOS release. Platform prerequisites are in the
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
