# TODO

Things worth considering next, roughly in priority order. Each says why it matters.

## Outbound connections

- **Model manifest comes from upstream's `main` branch.** `apps/server/src/provider/ModelManifest.ts` fetches `pingdotgg/t3code/main/.../model-manifest.json` hourly. The fork's model list and compatibility warnings change whenever upstream edits that file. Point it at this fork, or rely on the bundled copy only. Turning off **Provider update checks** already stops the fetch.
- **LiteLLM price table is fetched daily.** `apps/server/src/usage/UsageService.ts` downloads `BerriAI/litellm` prices from `raw.githubusercontent.com` for cost estimates. It is third-party data loaded at runtime; a bundled copy would remove the call.
- **Link favicons go through Google.** `packages/shared/src/favicon.ts` sends every linked domain in chat to `google.com/s2/favicons`, so Google sees what agents are reading. A generic link icon avoids the leak.
- **Open VSX theme search.** Settings theme search downloads third-party theme content from `open-vsx.org`. It is cosmetic; built-in themes may be enough for a locked-down setup.
- **Preview browser can open any URL.** Agents can drive a browser tab to arbitrary sites through MCP. A security review will ask about this; restricting it to loopback dev ports would cover most use.
- **Managed Codex install downloads a binary.** `apps/server/src/provider/CodexInstallation.ts` pulls a pinned, SHA-256-checked release from GitHub. Some companies only allow software from their own channels; requiring an installed `codex` would drop this.

## Leftovers from cut features

- **GitLab, Bitbucket, and Azure DevOps branches (~45 files).** URL parsing, Command Palette entries, `glab`/`az` handling, icons, and settings rows remain, though the server only discovers GitHub. Dead code that invites security-review questions and slows changes to source-control code. Big enough for its own PR.
- **Stale secrets in existing installs.** Users who configured a usage hub or Bitbucket tokens still have `usage-limit-source-*` and `bitbucket-*` entries in the server secret store. A one-time cleanup on startup would delete credentials nothing reads.
- **Unused client connection metadata.** The renderer still sends device type, OS, browser, and connection method on the `/ws` URL (`packages/client-runtime/src/authorization/remote.ts`). Only analytics read them, and analytics is gone.
- **Remote-environment Codex sign-in handoff.** `packages/shared/src/codexAuthHandoff.ts` and the desktop callback exist to deliver a ChatGPT sign-in to a remote environment, which this fork no longer has.
- **`t3.codes` strings.** The `t3.json` schema URL and generated project README still point at upstream's site. Harmless, but editors may fetch the schema URL.

## Behaviour to decide

- **Untargeted provider updates skip the compatibility check** when no installer reports a latest version (everything except Homebrew). This matches the old offline behaviour. Refusing such updates instead would be safer for the MCP update tool.

## Verification

- **Manual window check.** Open old threads, Settings, and the Command Palette, and check that threads from removed providers still render. Tests cover it; nobody has looked in the window.
- **Cold first `pnpm dev` launch failed** with `net::ERR_INSUFFICIENT_RESOURCES` and loaded on restart. Re-check from a normal terminal to see whether it was the sandboxed shell.
- **Known test failures.** `packages/client-runtime/src/state/pullRequestDiffHttp.test.ts` fails on `main`, and two macOS `/var` realpath tests fail locally. Fix or explain them so a clean test run means something.
