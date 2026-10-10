# Development

## First checkout

The checkout requires Node 24 and pnpm. From the repository root:

```sh
pnpm install
pnpm dev
```

`pnpm dev` (the same as `pnpm dev:desktop`) starts the Vite renderer and Electron. Electron spawns
the server straight from `apps/server/src/bin.ts` with the host `node`, so nothing is built first.
`apps/desktop/scripts/dev-electron.mjs` watches `apps/server/src`, `packages/contracts/src`, and
`packages/shared/src` and restarts on changes. `pnpm dev:server` and `pnpm dev:web` start those
processes separately; the web app is only the Electron renderer and is not served on its own.

### State and ports

Linked worktrees default to their own `.t3/userdata`, even when `T3CODE_HOME` is set. The main
checkout defaults to `~/.t3/dev/userdata`. An explicit `--home-dir` wins in both cases, for example
`pnpm dev -- --home-dir /tmp/t3code-dev`. Never run a development server against the live
`~/.t3/userdata`. See [test data](../../AGENTS.md#test-data) for copying a consistent database
snapshot.

Read ports from the `[dev-runner]` output. Worktrees derive stable preferences from their paths,
but occupied ports can shift them. `T3CODE_PORT_OFFSET` or `T3CODE_DEV_INSTANCE` can select a
different preference when needed.

## Checks

Run checks for the files and packages you changed:

```sh
pnpm exec vp test run <files>
pnpm exec vp lint <files>
pnpm --filter <package> typecheck
```

There is no CI in this checkout; run the focused checks for what you touched.

### Unused code

`pnpm knip:check` checks unused files and dependencies across the repo, then
unused runtime exports in `apps/server`, `apps/desktop`, `apps/web`, and every internal package under
`packages/`.
Exported types and Effect schemas are allowed without consumers. The schema preprocessor
recognizes schema types, including aliases and schema classes; functions that create or decode
schemas remain checked. Canonical Effect service construction APIs stay exported with an explicit
`@public` annotation, which Knip recognizes. Completely unused files remain checked too.
Named exports in web UI component modules are kept as complete component sets. Knip ignores
unused exports in `apps/web/src/components/ui/*.tsx`, while still reporting an entire unused file.
Use `pnpm knip --workspace apps/web` to audit one workspace, including exports.
Review callers before deleting code; knip can also report development scripts and test fixtures.
Runtime-discovered entrypoints and dependency exceptions belong in [knip.jsonc](../../knip.jsonc).

## Desktop artifacts

Local artifact builds are unsigned by default and write to `release/`:

```sh
pnpm dist:desktop:dmg
pnpm dist:desktop:linux
pnpm dist:desktop:win
```

DMGs default to the host architecture. Use `--arch` to choose another target and `--keep-stage`
to retain packaging files for inspection. Run `pnpm dist:desktop:artifact --help` for other
options.

### Linux AppImage prerequisites

Build Linux artifacts on Linux. Install Rust, C/C++ build tools, and ImageMagick.
Electron also needs a system keyring for protected secret storage.

Ubuntu and Debian:

```sh
sudo apt-get update
sudo apt-get install cargo rustc build-essential libsecret-1-0 imagemagick
```

Fedora:

```sh
sudo dnf install rust cargo gcc gcc-c++ make libsecret ImageMagick
```

Arch Linux:

```sh
sudo pacman -S rust base-devel libsecret imagemagick
```

The C toolchain is also needed for Linux desktop development.

### macOS DMG prerequisites

Install the Xcode Command Line Tools with `xcode-select --install` and install Rust.
For a cross-architecture or universal build, add the requested Rust targets:

```sh
rustup target add aarch64-apple-darwin x86_64-apple-darwin
```

### Windows installer prerequisites

Install Rust, Python 3, and Visual Studio Build Tools with **Desktop development with C++**.
Include the Windows SDK and the MSVC build tools and Spectre-mitigated libraries for the target
architecture. Add its Rust target:

```powershell
rustup target add x86_64-pc-windows-msvc
# For an ARM64 installer:
rustup target add aarch64-pc-windows-msvc
```

NSIS is downloaded by electron-builder.

### Signing

Add `--signed` after configuring the platform signing credentials; see
[`scripts/build-desktop-artifact.ts`](../../scripts/build-desktop-artifact.ts) and
[`scripts/sign-macos.ts`](../../scripts/sign-macos.ts) for the environment variables they read.
This fork has no release workflow, auto-updater, or published artifacts.
