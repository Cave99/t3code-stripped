# t3code-stripped

A desktop-only cut of T3 Code: Codex and Claude, the Unsettled/Settled thread sidebar, and the right panel (browser and file explorer). Everything aimed at reaching the app over the network has been removed.

## Quick start

```bash
pnpm install          # ~7s on a warm pnpm store
pnpm dev              # = dev:desktop: Vite renderer + Electron, server runs from source
pnpm build:desktop    # production build, ~33s cold
```

Dev mode no longer builds anything for production first. Electron spawns the server straight from `apps/server/src/bin.ts` using the host `node` (Node 24 type stripping). `scripts/dev-electron.mjs` watches `apps/server/src`, `packages/contracts/src` and `packages/shared/src` and restarts on changes.

## Numbers (before → after)

|                                               | Upstream                                 | Stripped                                                                                                                                  |
| --------------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install`, cold store                    | ~6 min                                   | not re-measured on a cold store                                                                                                           |
| `pnpm install`, warm store, no `node_modules` | ~30s                                     | **7s**                                                                                                                                    |
| Packages resolved                             | 1,877                                    | ~1,005                                                                                                                                    |
| `node_modules` size                           | 4.4 GB                                   | 1.1 GB                                                                                                                                    |
| `build:desktop` (cold)                        | 41s                                      | **33s** (web Vite build is 27s of that)                                                                                                   |
| Dev start                                     | Full server + web production build first | No build step: Vite is ready in about 1s, the server starts from source in about 2s, and the first dependency optimisation takes about 5s |

## What was cut

- **Surfaces:** mobile app, marketing site, relay infra, and the hosted web app.
  - The web app is still the renderer for Electron, but it is no longer shipped or served on its own.
- **Network reach:**
  - Removed: T3 Connect/cloud, Clerk auth, pairing, Tailscale, network exposure (the desktop backend binds to 127.0.0.1 only), SSH environments, WSL, and `dev --share`.
- **Providers:** Cursor, Grok, OpenCode, Pi, Antigravity, and the ACP registry. Only Codex and Claude remain.
- **Forges:** GitLab, Bitbucket, Azure DevOps and Forgejo. Only GitHub remains, and it backs the pull requests view.
- **Features:**
  - Device panel and its MCP tools.
  - Scheduled tasks and their MCP tools. `scheduling/Scheduler.ts` stays because usage-limit recovery uses it.
  - Browser cookie import.
  - Auto-updater and release notes.
  - Server self-update.
  - Server CLI subcommands except `claudeHistory` and `trace`.
- **Packages and dependencies:**
  - Deleted packages: `effect-acp`, `ssh` and `tailscale`.
  - Removed dependencies: `@cursor/sdk`, `@opencode-ai/sdk`, all `@clerk/*`, `electron-updater`, `yauzl`, `three` and the expo/react-native stack.

## What was kept

Git controls, usage, worktrees, the terminal drawer, Snap Shot, the pull requests view (GitHub), agent MCP tools (preview/browser), and dev-port auto-detection.

## What's left

Roughly in priority order:

1. **Run the full test suites and audit the stripped tests.**
   - Tests were removed by a script that matched test blocks against markers.
   - An early version of the script sometimes removed neighbouring tests. That bug was fixed, but the earliest runs weren't all re-checked.
   - Typecheck is clean for server, web, desktop, contracts, client-runtime, shared and scripts.
   - Only the suites touched last were actually run, and they pass: `dev-runner`, `serverSettings` and `settingsScopeNavigation`.
2. **Smoke test `pnpm dev` with a real window.** The pieces were timed one by one, but the Electron window itself wasn't launched here.
3. **Dormant remote code in `packages/client-runtime`.**
   - The relay, SSH and remote environment drivers are still in place.
   - The web app feeds them inert stubs (`apps/web/src/connection/inertRelay.ts`, `platform.ts`), so they can't be reached.
   - Deleting them is the next big simplification.
4. **The server's standalone web mode.**
   - `apps/server` can still serve the built web app over HTTP and has browser auth/session code for that.
   - Desktop only needs the WebSocket API on loopback.
5. **Leftover schema and settings.**
   - `packages/contracts` still has settings schemas for the removed providers.
   - The `enableAgentDeviceAccess` and `enableDeviceSupport` flags are still defined.
   - Removing them needs a settings migration, or tolerant decoding, for existing settings files.
6. **Packaging leftovers.**
   - `scripts/build-desktop-artifact.ts` still references `@napi-rs/keyring`, browser-secret and resource-monitor natives.
7. **Dead code sweep.** Run `pnpm knip:check` and delete what it reports. There are certainly orphaned helpers left.
8. **Legacy sidebar.** `LegacySidebar` is still in the web app next to the current sidebar. Decide whether to keep it.
9. **Docs.** `AGENTS.md`, `README.md`, `CONTRIBUTING.md` and `docs/` still describe upstream (mobile, remote, all providers). Rewrite them for this fork.
10. **Telemetry.** Review what analytics and OTLP tracing are still wired up (`VITE_RELAY_OTLP_*` defines in `apps/web/vite.config.ts`) and decide what stays.
11. **Web build time.** The web Vite build (about 27s) is now most of `build:desktop`. Look at the React Compiler Babel pass and the `@pierre/diffs` worker bundling if it's still too slow.
