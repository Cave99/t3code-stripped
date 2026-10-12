#!/bin/sh
# Installs the offline dev kit into this checkout, so development needs no
# npm, Electron, or Node downloads. Apple Silicon only.
#
#   scripts/devkit/install.sh                 # from the `devkit` branch on origin
#   scripts/devkit/install.sh <kit.zip>       # from a release download
#   scripts/devkit/install.sh --force ...     # install over a lockfile mismatch
#
# Then `source .devkit/env.sh` in each shell and run `pnpm dev`.
set -eu

kit_name=c3-devkit-darwin-arm64.zip
force=false
if [ "${1:-}" = "--force" ]; then
  force=true
  shift
fi

root=$(git rev-parse --show-toplevel)
cd "$root"

if [ "$(uname -s)-$(uname -m)" != "Darwin-arm64" ]; then
  echo "The dev kit is built for Apple Silicon Macs only." >&2
  exit 1
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

if [ $# -gt 0 ]; then
  zip_path=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
else
  echo "Fetching the devkit branch..."
  git fetch --depth=1 origin +refs/heads/devkit:refs/remotes/origin/devkit
  git archive --format=tar origin/devkit | tar -x -C "$work"
  cat "$work/$kit_name".part-* >"$work/$kit_name"
  (cd "$work" && shasum -a 256 -c "$kit_name.sha256" >/dev/null) || {
    echo "The reassembled dev kit does not match its checksum." >&2
    exit 1
  }
  zip_path="$work/$kit_name"
fi

manifest=$(unzip -p "$zip_path" .devkit/manifest)
kit_lockfile=$(printf '%s\n' "$manifest" | sed -n 's/^lockfile_sha256=//p')
local_lockfile=$(shasum -a 256 pnpm-lock.yaml | cut -d' ' -f1)
if [ "$kit_lockfile" != "$local_lockfile" ] && [ "$force" = false ]; then
  echo "This kit was built for a different pnpm-lock.yaml" >&2
  echo "(kit commit $(printf '%s\n' "$manifest" | sed -n 's/^commit=//p'))." >&2
  echo "Check out that commit, wait for a newer kit, or rerun with --force." >&2
  exit 1
fi

echo "Replacing node_modules..."
for dir in node_modules apps/*/node_modules packages/*/node_modules scripts/node_modules oxlint-plugin-t3code/node_modules .devkit; do
  [ -e "$dir" ] && rm -rf "$dir"
done
unzip -q "$zip_path" -d "$root"
xattr -dr com.apple.quarantine .devkit node_modules 2>/dev/null || true

# pnpm's bin shims carry the build machine's absolute paths in NODE_PATH.
build_root=$(printf '%s\n' "$manifest" | sed -n 's/^build_root=//p')
if [ -n "$build_root" ] && [ "$build_root" != "$root" ]; then
  find . -path '*/node_modules/.bin/*' -type f -exec grep -lF "$build_root" {} + 2>/dev/null |
    while IFS= read -r shim; do
      sed -i '' "s|$build_root|$root|g" "$shim"
    done
fi

cat >.devkit/env.sh <<EOF
# Puts the dev kit's Node and pnpm first on PATH. pnpm would otherwise verify
# (and re-link) dependencies before each run, which needs the registry. HTML
# previews use the kit's browser instead of downloading one.
export PATH="$root/.devkit/bin:\$PATH"
export pnpm_config_verify_deps_before_run=false
export pnpm_config_pm_on_fail=ignore
export ELECTRON_SKIP_BINARY_DOWNLOAD=1
export T3CODE_PREVIEW_BROWSER="$root/.devkit/preview-browser/chrome-headless-shell"
EOF

# Git hooks are a convenience; skip them quietly if this fails.
.devkit/bin/node node_modules/vite-plus/bin/vp config --no-agent >/dev/null 2>&1 || true

echo "Dev kit installed (Node $(.devkit/bin/node --version), pnpm $(.devkit/bin/pnpm --version))."
echo "Next: source .devkit/env.sh && pnpm dev"
