---
name: test-t3-app
description: Verify T3 Code's desktop UI against isolated development state, and seed or inspect that state's SQLite fixtures. Use for real-window verification of user-visible changes and for test data.
---

# Test the desktop app

This fork is an Electron app. The web app is only its renderer: there is no pairing flow and no
standalone browser entry, so the Browser panel and `preview_*` tools cannot drive it. Real-window
verification needs the Electron window itself. Ask the user before using computer use or launching
windows. If they decline, stop at focused tests and typecheck.

## Start the app

Reuse this task's healthy dev process. Otherwise run `pnpm dev` from the repository root and retain
its terminal session. In a worktree it uses the ignored `.t3` state; read the actual ports from the
`[dev-runner]` output. Never run against `~/.t3/userdata` or set `VITE_HTTP_URL` or `VITE_WS_URL`.

Test with meaningful project and thread data. Read
[references/sqlite-fixtures.md](references/sqlite-fixtures.md) only when
inspecting or seeding SQLite. Stop the test server before direct fixture writes.

## Verify and retain

Exercise the affected flow and capture the state that proves it works. Keep the app and state
available while the user inspects or iterates. An assistant turn ending is not teardown. Stop only
processes you started, using retained terminal sessions or captured PIDs, never by pattern.
