# Environment authentication

Electron owns the local server's lifetime and credentials. It generates a 192-bit launch
secret, passes it through private bootstrap FD 3, and exposes it to the renderer through
preload IPC. The secret stays in memory and is reused for backend restarts within that
app process; there is no persisted client session or token exchange.

The backend binds to loopback. [Local authentication](../../apps/server/src/auth/local.ts)
checks the launch secret at WebSocket upgrade (`token` query parameter) and on privileged
HTTP requests (`Authorization: Bearer`), using a constant-time comparison. A supplied
Origin must be `t3code://app`, `t3code-dev://app`, or the configured development Vite
origin. Requests without an Origin still require the secret. Authentication grants access
to the local API; there are no per-RPC client scopes.

Legacy auth tables and migrations remain for database compatibility. They do not authorize
requests. [ServerSecretStore](../../apps/server/src/auth/ServerSecretStore.ts) still protects
provider credentials and signs asset/upload grants; those grants are separate from the
launch secret.

## The environment is the filesystem boundary

Projects are organizational boundaries, not filesystem sandboxes.
Authenticated clients can read files the server account can read, including
absolute paths outside a project. This lets clients display artifacts that an
agent writes in a temporary directory. Relative paths and writes still follow
the [workspace path rules](../../apps/server/src/workspace/WorkspaceFileSystem.ts).

Signed asset URLs are bearer credentials. A URL for media on the host grants
access to one canonical file and its device/inode identity, not its containing directory.
[Asset access](../../apps/server/src/assets/AssetAccess.ts) rechecks the opened
file's identity when serving it, so atomic replacement requires a new URL while
editing the same file in place does not. An HTML file authorized this way cannot
load sibling assets; directory-scoped workspace previews are a separate grant.
Clients should share the authored file reference so they do not disclose the
temporary URL's credential.

Host videos can change in place. Their [HTTP
responses](../../apps/server/src/http.ts) omit cache validators because file
metadata cannot prove byte-for-byte identity for `If-Range`. Adding weak
validators would turn native-player seeks into full downloads.
