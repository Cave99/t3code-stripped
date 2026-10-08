# Environment authentication

The environment issues its own sessions and enforces their capabilities. In this fork the
desktop app starts the server on loopback and authenticates its renderer with a local bearer
credential; pairing links, relay credentials, and remote access are cut. The server's pairing,
DPoP, and reusable-dev-credential code is still present but unreachable from the shipped app.

## Authority is checked per RPC

A successful socket handshake grants no extra authority:
[every RPC declares a required scope](../../apps/server/src/auth/RpcAuthorization.ts). Bearer
clients obtain short-lived WebSocket tickets through authenticated HTTP so long-lived tokens stay
out of socket URLs.

Desktop restarts forget the previous local bearer token, so its reusable bootstrap grant replaces
earlier sessions for the same subject and method. Revocation and insertion share a
[database transaction](../../apps/server/src/persistence/AuthSessions.ts); a failed replacement
must leave the old credential usable.

## The environment is the filesystem boundary

Projects are organizational boundaries, not filesystem sandboxes.
`orchestration:read` permits reading files the server account can read, including
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
