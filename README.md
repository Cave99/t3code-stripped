<img src="assets/icon.svg" width="64" height="64" alt="">

# C3 Code (Corporate T3 Code)

**C3 Code is an unofficial fork of [T3 Code](https://github.com/pingdotgg/t3code),
by T3 Tools Inc., adapted for corporate environments. It is not affiliated with or
endorsed by the upstream project.**

An Electron desktop app for Codex and Claude Code, with a bundled local backend.

## What differs from upstream

- Desktop-only and loopback-only: no hosted web app, cloud, remote access, or pairing.
- No product telemetry. Optional, explicitly configured OpenTelemetry exports remain available.
- Codex and Claude only, through their official CLIs; GitHub only for source control integration.
- Bundled model manifest; no runtime model-manifest or npm version fetches, and no auto-updater.

Local operation does not mean offline. Remaining outbound calls include the official provider
CLIs and GitHub integration, daily LiteLLM prices from `raw.githubusercontent.com`, Google link
favicons, Open VSX theme search and downloads, Homebrew update checks, Codex reset credits,
and managed Codex binary downloads from GitHub. The first inline HTML preview downloads a
pinned, SHA-256-checked Chrome from `storage.googleapis.com`; preview tabs can visit arbitrary
URLs. See [STRIPPED.md](STRIPPED.md#remaining-cleanup) for details and remaining work.

## Quick start

Requires Node 24 and pnpm.

```bash
pnpm install
pnpm dev              # Vite renderer + Electron; the server runs from source
pnpm build:desktop    # production build
```

See [STRIPPED.md](STRIPPED.md) for the fork's scope, [AGENTS.md](AGENTS.md) for contributor
guidance, and [docs/](docs/) for user, internal, and operations documentation.

## License

MIT, with the upstream [LICENSE](LICENSE) notice retained: Copyright (c) 2026 T3 Tools Inc.
