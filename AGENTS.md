# C3 Code (Corporate T3 Code)

C3 Code is an unofficial fork of [T3 Code](https://github.com/pingdotgg/t3code) adapted for corporate environments: desktop-only, loopback-only, Codex and Claude only, GitHub only, and minimal outbound calls. An Electron app bundles a local Node WebSocket server that wraps the Codex and Claude Code CLIs. Read [STRIPPED.md](STRIPPED.md) first: it lists what this fork kept, what it cut, and what cleanup remains.

You can think of it as an open source "bring-your-own-subscription" alternative to apps like Claude Desktop and the Codex app.

## What matters

1. **Performance without compromise.** Audit changes for regressions, often caused by sending too much data over the websocket, css animations causing gpu spikes, and lists that are hard to render. Make sure all changes are considerate of performance impact.
2. **One surface, done well.** The web app is only the Electron renderer. It is not shipped or served on its own. Do not add mobile, hosted-web, or remote-access code paths; they were cut on purpose.
3. **Local only.** The backend binds to loopback. Do not reintroduce network exposure, pairing, tunnels, SSH, or WSL.

## A note from Theo

I like ambitious ideas, simple systems, and software that feels obvious. Do not preserve complexity just because it already exists. Do not introduce machinery because it looks architecturally impressive. Understand the real constraint, then fight for the smallest model that makes the correct behavior unsurprising.

Channel both "measure twice, cut once" and "yagni". Fight scope creep. Try to honor the dev's intent in both a minimal and realistic fashion.

The rest of this document is meant to help you navigate the codebase and make changes effectively. Think of these instructions less as "hard rules", more as "good defaults". The developer's preferences should be able to override anything here.

Of note: contributions often come from C3 Code itself. Be careful about accessing data, killing dev servers, and other things that may damage the C3 Code instance the contributor is using.

## A small glossary

- **you** means the agent reading this file and changing C3 Code.
- **we, us, and maintainers** mean the people building this fork. These are who you are talking to now.
- **user** means the person using C3 Code to direct coding agents.
- **agent** means the coding agent a user runs inside C3 Code. Depending on context, that may also include you.
- **provider** means the agent runtime C3 Code talks to: Codex or Claude.
- **client** means the Electron renderer.
- **environment** means the one running local server and the machine, filesystem, provider credentials, and state it owns.
- **project** means an environment-local workspace record rooted at a directory.
- **thread** means the durable conversation and work history for a project.
- **turn** means one user-to-agent cycle, including follow-up work such as checkpointing.
- **T3 home** means the base data directory. Runtime state normally lives below its userdata directory.

## The ways to hurt yourself

1. **Killing by pattern.** Never `pkill -f`, `pgrep | kill`, or `kill` a PID you found by matching a name, path, or worktree string. Your own agent process has this worktree's path in its argv, and this machine may run several other dev servers at once. Kill only a PID you captured at spawn, or the owner of your port after confirming its cwd is your worktree.
2. **Writing to the live install.** `~/.t3/userdata` is the developer's real C3 Code database, in use while you work. Reading it and copying from it are fine, and a good way to get real test data (see Test data). Never start a server against it, never open it read-write, never clean it up.
3. **Reintroducing origins.** Never set `VITE_HTTP_URL` or `VITE_WS_URL`. Dev is single-origin and Vite proxies the backend.

## Hit every entry point

The most common defect in this repo is a change that works on the path you tested and is missing everywhere else. Before calling frontend work done, walk this list and say which entries applied:

- **Entry points.** A behavior reachable from the chat view is usually also reachable from Settings, the command palette, and a keybinding. Fixing one is not fixing the feature.
- **Providers.** Codex and Claude each have an adapter. Provider-shaped features need a decision per adapter, even if the decision is "not supported here".
- **Agents.** A capability a user can trigger is usually one an agent should reach through MCP tools. That only works when it is a service method, not handler code.
- **Contracts.** Anything crossing the wire is typed in `packages/contracts`. Change the schema and the server, renderer, and desktop all follow.
- **Reverse states.** If you added a way in, add the way out and the way to see it. Snooze needs unsnooze. Close needs reopen. A one-way door is a bug.
- **Docs.** Check whether the change makes existing guidance inaccurate. Apply the [documentation rules](#documentation) before adding anything.

## Dev workflow

- `pnpm install` installs. Node 24 is required.
- `pnpm dev` (the same as `pnpm dev:desktop`) starts the Vite renderer and Electron. Electron spawns the server from `apps/server/src/bin.ts` with the host `node`, so there is no prebuild. `scripts/dev-electron.mjs` restarts it when `apps/server/src`, `packages/contracts/src`, or `packages/shared/src` change.
- `pnpm build:desktop` makes a production build.
- In a worktree, state defaults to that worktree's gitignored `.t3`, which deliberately outranks an ambient `T3CODE_HOME` so you cannot land on shared state by accident. An explicit `--home-dir` still wins. Read the real ports from the `[dev-runner]` line, since occupied ports shift.
- Stop what you started, by the PID you tracked. See rule 1 above.

See the [development runbook](docs/operations/development.md) for details.

## Test data

An empty database is a bad test. Seed your worktree's `.t3` with a copy of real data instead of pointing at live state:

- Copy from `~/.t3/userdata` (the developer's real data, the most realistic test set) or `~/.t3/dev`. Worktree state lives at `<worktree>/.t3/userdata`.
- Snapshot the database with `VACUUM INTO`, which is safe even while a server has the source open and yields one consistent file:

  ```bash
  mkdir -p .t3/userdata
  rm -f .t3/userdata/state.sqlite*  # VACUUM INTO refuses to overwrite
  bun -e "new (require('bun:sqlite').Database)(process.env.HOME + '/.t3/userdata/state.sqlite', { readonly: true }).run(\"VACUUM INTO '.t3/userdata/state.sqlite'\")"
  ```

  A plain `cp` is only safe when no server has the source open, and must bring the `-wal` and `-shm` siblings along. A live file copy is a corrupt copy.

- Bring `secrets` and `settings.json` only if the flow under test needs them.
- Copy in, never symlink. Data flows one way: into your sandbox, never back out.

## Verifying

- Smallest proof that the change works. `pnpm exec vp test run <files>` for the tests you touched, targeted lint and typecheck (`pnpm --filter <package> typecheck`) for the scope you changed.
- Test meaningful logic or observable behavior. Do not render components to static markup to assert props or attributes, or add tests that merely assert callback wiring or mirror the implementation.
- **Do not run repo-wide checks.** No `pnpm lint`, `pnpm test`, or `pnpm typecheck` across the repo unless asked.
- Backend behavior changes ship with focused tests for that behavior.
- The server is event-sourced and its async flows emit typed receipts. Wait on receipts and worker drains, never on sleeps or polling. A test that needs a timeout to pass is wrong.
- Real-window verification means the Electron window; see the `test-t3-app` skill. Ask permission before doing computer use or launching windows. Do not verify with browsers or computer use unless the user explicitly agrees or requests it.

## Pull requests

- Never make a PR unless the developer explicitly asks you to do so.
- Conventional commit titles, plain language: `fix(web): new threads no longer spike CPU`.
- Body: the problem in a sentence or two, then how you fixed it. End with the model and harness that did the work.
- UI changes need before/after images. Motion or timing needs a short video.
- Upload PR evidence to GitHub. Never commit PR-only screenshots or assets.
- One concern per PR. If the description says "also", split it.

## Documentation

Most code changes do not need an internal documentation change. Agents can read the code.

- `docs/internals/` is for architectural decisions and their reasons, constraints that span components, and implementation traps that are hard to discover from the source. Before adding a paragraph, ask what a maintainer would get wrong without it. If reading the relevant code answers the question, leave it out.
- Do not document every feature, enumerate fields or methods, narrate control flow, maintain file catalogs, or append PR summaries. Types, tests, and code already record the implementation. The glossary defines shared vocabulary; it is not a feature index.
- Keep a local implementation explanation in a nearby code comment. Use an internal doc when the reasoning crosses boundaries or needs context the code cannot carry well. Link to the relevant source instead of copying it.
- When a documented decision or constraint changes, rewrite or remove the affected text. Do not append another account of the new behavior. A new internal page needs a distinct, durable reason to exist.
- `docs/user/` helps users accomplish tasks. Give each major feature a concise section explaining what it does, how to start, and anything unintuitive. A settings path is useful; descriptions of visible buttons, icons, layouts, animations, or every UI state are not.
- Keep user docs in the shipped product's voice, without implementation details or contributor tooling. Update the relevant feature section when how to use it changes. A UI tweak does not need a documentation entry, and a new control does not need its own page.
- `docs/operations/` holds maintainer setup and debugging procedures.

## Plans and work artifacts

- Do not commit implementation plans, research notes, or agent scratch files. Keep temporary working material outside the worktree. `.plans/` is gitignored only as a safety net for legacy tooling.
- A merged PR is the implementation record; do not preserve a second checklist in the repository.

## How it works

The renderer sends typed WebSocket requests to the local server. The server turns them into _commands_, a pure _decider_ turns commands into persisted _events_, and a _projector_ derives the read model the UI renders. Provider CLIs run as subprocesses; per-provider _adapters_ translate their native protocols into orchestration events. Side effects run in queue-backed _reactors_ that emit _receipts_ when milestones land. Each turn ends with a _checkpoint_, a hidden git ref, so the app can diff and restore.

Full glossary with file links: `docs/internals/glossary.md`

## Where code lives

- `apps/server` - WebSocket, orchestration, providers, checkpointing. Effect-heavy: read [Effect services](docs/internals/effect-services.md) before adding server code.
- `apps/web` - React/Vite UI, the Electron renderer. `apps/desktop` is the Electron shell.
- `packages/contracts` - Effect/Schema contracts plus small derived helpers. No heavy runtime logic.
- `packages/shared` - shared runtime utils, subpath exports, no barrel.
- `packages/client-runtime` - client connection and state code used by the renderer.
- `packages/effect-codex-app-server` - Codex app-server protocol client.

## Taste

- Complexity belongs at the adapter boundary. Orchestration stays pure, UI stays dumb.
- Server features are services; transports stay thin. A `ws.ts` RPC handler, HTTP route, or MCP tool decodes input, calls one service method, and maps errors. See [Effect services](docs/internals/effect-services.md).
- `apps/web/src/components/ui` exports own their look. Pick a `variant` or `size`; do not restyle one with `className`. If none fits and the look is a generic concept, add a variant to the component; a look that belongs to one feature stays in that feature's own component, not in `components/ui`. Layout classes (width, flex, margin, position) belong on the parent. `shadcn/no-restyle` fails lint on violations.
- Inferred types over annotations. `any` is the enemy.
- Comments describe how a thing is used, and move when the code moves. To be used mostly to describe functions, not to annotate every line of behavior.
- Our users drive agents all day and notice a dropped frame, a lying spinner, and a stale label. No continuously repainting animations; they peg the GPU on high-refresh displays.
- If a rule here fights the task in front of you, say so loudly and get a human sign-off before breaking it.

## Additional tips

- Security is important, but should not be over-indexed on, especially for dev mode/maintainer-only features.
