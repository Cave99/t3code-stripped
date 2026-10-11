# C3 Code (Corporate T3 Code)

C3 Code is an unofficial fork for corporate environments, built from [upstream T3 Code](https://github.com/pingdotgg/t3code): one Electron surface, one local backend, and Codex and Claude Code. The cuts reduce dependencies, connection machinery, and runtime branches so maintenance and performance work focus on that surface.

## What was cut, and why

- **Surfaces:** the mobile app, marketing site, relay infrastructure, and hosted web app. `apps/web` remains only as Electron's renderer; maintaining one surface keeps the fork focused.
- **Network reach:** T3 Connect/cloud, Clerk auth, pairing, Tailscale, tunnels/network exposure, SSH environments, WSL backends, remote editor opening, and `dev --share`. The backend binds to loopback; local-only operation removes remote provisioning and trust machinery.
- **Providers:** Cursor, Grok, OpenCode, Pi, Antigravity, and the ACP registry. Codex and Claude cover the fork's intended use without carrying extra adapters, settings, and dependencies. Cursor remains usable as a local editor.
- **Forges:** GitLab, Bitbucket, Azure DevOps, and Forgejo. GitHub alone backs source-control integration and pull-request review, reducing host-specific branches.
- **Features:** the device panel and its MCP tools, scheduled tasks and their MCP tools, browser cookie import, auto-updater/release notes, server self-update, and server CLI subcommands other than `claudeHistory` and `trace`. These cuts keep device management, recurring automation, and distribution services outside the desktop coding workflow. The internal scheduler remains for usage-limit recovery.
- **Outbound calls:** PostHog product telemetry, CLIProxyAPI usage hubs, Claude reset-credit claims made with the CLI's stored login, npm registry version checks, upstream model-manifest fetches, and stored Bitbucket credentials. The app no longer sends data to analytics or reuses provider credentials outside the official CLIs. CLI-reported usage limits, Codex reset credits, and Homebrew update checks remain. Model metadata comes only from the bundled manifest. Inline HTML previews are a deliberate exception: the first preview downloads a pinned, SHA-256-checked headless Chrome (~120 MB) once from `storage.googleapis.com` and caches it locally. Rendering untrusted agent HTML needs a real browser engine, and bundling one would grow every install for a feature most sessions never touch.
- **Packages and dependencies:** `effect-acp`, `ssh`, and `tailscale` packages; the Expo/React Native stack; `@cursor/sdk`, `@opencode-ai/sdk`, `@clerk/*`, `electron-updater`, `yauzl`, and `three`. Subsequent dead-code sweeps removed orphaned helpers and 14 unused dependency declarations, keeping installation and packaging smaller.

## How the key systems changed

### Connection and authentication

Before, Electron generated a 192-bit launch token and delivered it through bootstrap FD 3. Desktop exchanged it for a bearer session, then the renderer exchanged that bearer for a WebSocket ticket. Browser cookies, pairing grants, DPoP proofs, replay markers, persisted sessions, and per-RPC scopes supported other clients.

Now the launch token directly authenticates WebSocket upgrades through the `token` query parameter and privileged HTTP through `Authorization: Bearer`. The server compares it in constant time and accepts a supplied Origin only for `t3code://app`, `t3code-dev://app`, or the configured development Vite origin. The token stays in memory and the backend binds only to loopback. `ServerSecretStore` remains for provider credentials and signed asset/upload URLs.

### Backend pool and bootstrap

The multi-backend pool is primary-only. WSL startup, distro tracking, secondary registrations, and remote editor opening are gone. Desktop exposes one local environment bootstrap with the primary backend's endpoints and token.

### Client runtime

The relay, SSH, and remote environment drivers and the renderer's inert stubs were deleted. `packages/client-runtime` still owns local connection supervision, RPC sessions, and shared client state; views do not each run reconnect loops.

### Providers

Only Codex and Claude have runtime adapters. Provider IDs remain open strings, and unknown providers get a generic icon and label so stored threads from removed providers still load. This preserves history without enabling those runtimes.

### Standalone web mode

The server no longer serves the built renderer or accepts standalone mode, host, or static-directory CLI options. Bootstrap `mode` and `noBrowser` fields are gone. Electron owns the renderer; Vite supplies it during development and proxies the local backend on the same origin.

### Data compatibility

Persisted event and old raw-provider-event schemas remain decodable. Old auth database tables and migrations remain for existing databases, without the session/pairing runtime. Settings decoding tolerates removed keys in existing `settings.json` files; focused tests cover removed-provider settings and historical provider IDs.

### Tests

Tests for cut features were removed by a script matching test blocks against markers. An early version sometimes removed neighbouring tests; the script was corrected and the suites were subsequently audited and run. The reported remaining failures are two macOS `/var` symlink realpath tests attributed to the environment. Tests for retained behavior and historical data compatibility remain.

## What was kept

Codex and Claude Code, the Unsettled/Settled thread sidebar, the right panel (browser and file explorer), Git controls, usage, worktrees, the terminal drawer, Snap Shot, GitHub pull requests, agent MCP tools (including preview/browser), and dev-port auto-detection.

## Quick start

Requires Node 24 and pnpm.

```bash
pnpm install          # ~7s on a warm pnpm store
pnpm dev              # = dev:desktop: Vite renderer + Electron, server runs from source
pnpm build:desktop    # production build, ~33s cold
```

Development does not prebuild production assets. Electron spawns `apps/server/src/bin.ts` with the host Node's type stripping; source changes in the server, contracts, and shared package restart it.

## Numbers (before → after)

|                                               | Upstream                                 | Stripped                                                                                                                                  |
| --------------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install`, cold store                    | ~6 min                                   | not re-measured on a cold store                                                                                                           |
| `pnpm install`, warm store, no `node_modules` | ~30s                                     | **7s**                                                                                                                                    |
| Packages resolved                             | 1,877                                    | ~1,005                                                                                                                                    |
| `node_modules` size                           | 4.4 GB                                   | 1.1 GB                                                                                                                                    |
| `build:desktop` (cold)                        | 41s                                      | **~33s** (web ~27.7s; React Compiler Babel ~22s of the web build)                                                                         |
| Dev start                                     | Full server + web production build first | No build step: Vite is ready in about 1s, the server starts from source in about 2s, and the first dependency optimisation takes about 5s |

## Remaining cleanup

### Outbound connections still made

- **LiteLLM price table is fetched daily.** `apps/server/src/usage/UsageService.ts` downloads `BerriAI/litellm` prices from `raw.githubusercontent.com` for cost estimates. It is third-party data loaded at runtime; a bundled copy would remove the call.
- **Link favicons go through Google.** `packages/shared/src/favicon.ts` sends every linked domain in chat to `google.com/s2/favicons`, so Google sees what agents are reading. A generic link icon avoids the leak.
- **Open VSX theme search.** Settings theme search downloads third-party theme content from `open-vsx.org`. It is cosmetic; built-in themes may be enough for a locked-down setup.
- **Preview browser can open any URL.** Agents can drive a browser tab to arbitrary sites through MCP. A security review will ask about this; restricting it to loopback dev ports would cover most use.
- **Managed Codex install downloads a binary.** `apps/server/src/provider/CodexInstallation.ts` pulls a pinned, SHA-256-checked release from GitHub. Some companies only allow software from their own channels; requiring an installed `codex` would drop this.

### Behaviour to decide

- **Untargeted provider updates skip the compatibility check** when no installer reports a latest version (everything except Homebrew). This matches the old offline behaviour. Refusing such updates instead would be safer for the MCP update tool.

## Remaining verification

- **Electron window smoke test:** with a copy of real data, the app loads, connects with the launch token, and renders the sidebar and composer. Interactive checks (thread switching, settings, removed-provider threads) are still to do by hand.
- **Cold first dev launch:** the first `pnpm dev` after a fresh Vite dependency optimisation failed to load `main.tsx` (hundreds of `net::ERR_INSUFFICIENT_RESOURCES` from the `t3code-dev://` proxy); a restart loaded fine. It may be specific to the sandboxed shell that launched it, since Chromium could not create its cache directories there. Re-check from a normal terminal.
- **Build time:** investigated and accepted. The web build takes ~27.7s, including ~22s in React Compiler's Babel pass. The compiler stays for runtime performance; no build-time change is planned.
- **Known test failures:** `packages/client-runtime/src/state/pullRequestDiffHttp.test.ts` fails on `main`, and two macOS `/var` realpath tests fail locally. Fix or explain them so a clean test run means something.
