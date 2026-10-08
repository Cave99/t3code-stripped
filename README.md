<img src="assets/icon.svg" width="64" height="64" alt="">

# t3code-stripped

A desktop-only cut of [T3 Code](https://t3.codes), the minimal GUI for coding agents. It runs
Codex and Claude Code in an Electron app that bundles its own local server.

## Quick start

Requires Node 24 and pnpm.

```bash
pnpm install
pnpm dev              # Vite renderer + Electron; the server runs from source
pnpm build:desktop    # production build
```

## What is different from upstream

- Desktop only: no mobile app, marketing site, or hosted web app.
- No remote access: no T3 Connect, pairing, Tailscale, SSH, or WSL. The backend binds to loopback.
- Providers: Codex and Claude only.
- Forges: GitHub only.
- No device panel, scheduled tasks, browser cookie import, or auto-updater.

Kept: the Unsettled/Settled thread sidebar, the right panel (browser and file explorer), git
controls, usage, worktrees, the terminal drawer, Snap Shot, the GitHub pull requests view, agent
MCP tools, and dev-port detection.

See [STRIPPED.md](STRIPPED.md) for the full list and remaining work,
[AGENTS.md](AGENTS.md) for contributor guidance, and [docs/](docs/) for user, internal, and
operations documentation.

Created in [T3 Code](https://t3.codes).
