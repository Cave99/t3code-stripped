#!/bin/sh
# Packs this checkout's installed dependencies into an offline dev kit:
# every workspace node_modules (with Electron's runtime and native modules
# already built), plus the Node and pnpm that installed them, so their
# versions and native ABIs match. Run after `pnpm install` on the platform the
# kit targets. Usage: scripts/devkit/build.sh <output.zip>
set -eu

output=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
root=$(git rev-parse --show-toplevel)
cd "$root"

stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
kit="$stage/.devkit"
mkdir -p "$kit/bin"

# The real binary, not a version-manager shim that may sit on PATH.
cp "$(node -p process.execPath)" "$kit/bin/node"

pnpm_version=$(node -p "require('./package.json').packageManager.split('@')[1]")
curl -fsSL "https://registry.npmjs.org/pnpm/-/pnpm-$pnpm_version.tgz" | tar -xz -C "$stage"
mv "$stage/package" "$kit/pnpm"
cat >"$kit/bin/pnpm" <<'EOF'
#!/bin/sh
bin=$(cd "$(dirname "$0")" && pwd)
exec "$bin/node" "$bin/../pnpm/bin/pnpm.mjs" "$@"
EOF
chmod +x "$kit/bin/pnpm"

lockfile_sha=$(shasum -a 256 pnpm-lock.yaml | cut -d' ' -f1)
cat >"$kit/manifest" <<EOF
commit=$(git rev-parse HEAD)
lockfile_sha256=$lockfile_sha
build_root=$root
node=$(node --version)
pnpm=$pnpm_version
platform=$(uname -s)-$(uname -m)
EOF

module_dirs=""
for dir in node_modules apps/*/node_modules packages/*/node_modules scripts/node_modules oxlint-plugin-t3code/node_modules; do
  [ -d "$dir" ] && module_dirs="$module_dirs $dir"
done

rm -f "$output"
# -y stores symlinks as links: pnpm's layout and Electron.app depend on them.
# shellcheck disable=SC2086
zip -qry "$output" $module_dirs -x '*/.cache/*' '*/.vite/*' '*/.vite-plus/*'
(cd "$stage" && zip -qry "$output" .devkit)

echo "Wrote $output ($(du -h "$output" | cut -f1))"
