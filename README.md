# @chunkdb/client

Official Node.js and TypeScript client for `chunkdb`.

This package is intentionally small:

- `ChunkClient` = one long-lived socket
- sequential request/response flow per client
- opt-in pooling via `ChunkPool`
- no automatic retries or background reconnect loops
- no browser transport

## Features

- `chunk://` and `chunks://` URI support
- Node core `net` / `tls` transport
- `connect`, `connectUri`, `connectPool`, `ChunkClient`, and `ChunkPool`
- `auth`, `ping`, `info`, `get`, `readBlock`, `exists`, `set`, `unset`, `chunkExists`, `readChunk`, `setChunk`, `setChunkState`, `chunk`, `chunkbin`, `chunkbinState`
- persistent socket reuse for low-concurrency callers and opt-in pooled concurrency for Node services
- typed error classes
- configurable connect and command timeouts
- dual ESM / CommonJS build output

## Install

```bash
npm install @chunkdb/client
```

## Quick Start

```ts
import { connectUri } from "@chunkdb/client";

const client = await connectUri("chunk://chunk-token@127.0.0.1:4242/");
console.log(await client.ping());
console.log(await client.readBlock(0, 0));
console.log(await client.readChunk(0, 0));
await client.close();
```

## TLS

```ts
import { connectUri } from "@chunkdb/client";

const client = await connectUri("chunks://chunk-token@127.0.0.1:4242/", {
  tlsInsecure: true,
});

console.log(await client.info());
await client.close();
```

## Timeout Options

- `connectTimeoutMs`: maximum time to establish the socket and complete TLS setup
- `commandTimeoutMs`: maximum time to wait for one command response

```ts
const client = await connectUri("chunk://chunk-token@127.0.0.1:4242/", {
  connectTimeoutMs: 2000,
  commandTimeoutMs: 3000,
});
```

## Connection Model

- Reuse one `ChunkClient` for low-concurrency code paths. It keeps one socket open and sends one request at a time.
- Use one shared `ChunkPool` for concurrent Node.js workloads. It keeps several warm `ChunkClient` instances and leases them per operation.
- True single-socket multiplexing is intentionally out of scope for protocol v1. Parallelism comes from multiple sockets, not request IDs on one socket.

## Pooling

```ts
import { connectPool } from "@chunkdb/client";

const pool = await connectPool({
  uri: "chunk://chunk-token@127.0.0.1:4242/",
  maxConnections: 4,
  minConnections: 1,
  acquireTimeoutMs: 2000,
});

await Promise.all([
  pool.set(0, 0, "1011001110110011"),
  pool.set(1, 0, "0000111100001111"),
]);

console.log(await pool.readBlock(0, 0));

await pool.withClient(async (client) => {
  console.log(await client.ping());
  console.log(await client.info());
});

await pool.close();
```

`ChunkPoolOptions` extends `ChunkClientOptions` and adds:

- `maxConnections`: maximum number of leased/open clients in the pool
- `minConnections`: optional warm connections created by `connectPool`
- `acquireTimeoutMs`: maximum time to wait for a free pooled client

## TLS Options

- `tls: true` or `chunks://...` to enable TLS
- `tlsInsecure: true` to skip certificate verification for local testing only
- `tlsServerName` to force SNI / hostname verification target
- `ca`, `cert`, `key` for custom trust and client certificate material

```ts
const client = await connectUri("chunks://chunk-token@127.0.0.1:4242/", {
  ca: process.env.CHUNKDB_CA_PEM,
  tlsServerName: "chunkdb.local",
});
```

## API

- `connect(options)`
- `connectUri(uri, overrides?)`
- `connectPool(options)`
- `parseChunkUri(uri)`
- `formatChunkUri(parsed)`
- `ChunkClient`
- `ChunkPool`

`ChunkClient` methods:

- `connect()`
- `close()`
- `auth(token?)`
- `ping()`
- `info()`
- `get(x, y)`
- `readBlock(x, y)`
- `exists(x, y)`
- `set(x, y, bits)`
- `unset(x, y)`
- `chunkExists(cx, cy)`
- `readChunk(cx, cy)`
- `setChunk(cx, cy, bits)`
- `setChunkState(cx, cy, { bits, presence })`
- `chunk(cx, cy)`
- `chunkbin(cx, cy)`
- `chunkbinState(cx, cy)`

`ChunkPool` mirrors the same high-level data methods and adds:

- `close()`
- `withClient(fn)`

`readBlock(x, y)` is the preferred high-level read API:

```ts
type ChunkBlockState =
  | { exists: false; bits: null }
  | { exists: true; bits: string };
```

- unset block -> `{ exists: false, bits: null }`
- explicit zero block -> `{ exists: true, bits: "000...0" }`

`get(x, y)` is kept for backward-compatible low-level reads and still returns the configured zero-bit payload when a block is unset.
Use `exists(x, y)` only when you specifically want the lower-level protocol-style check.

Chunk-level presence uses the same pattern:

- `chunkExists(cx, cy)` tells you whether the chunk is explicitly present
- `readChunk(cx, cy)` is the preferred high-level chunk read API and returns:

```ts
type ChunkChunkState = {
  exists: boolean;
  bits: string;
  presence: string;
};
```

- absent chunk -> `{ exists: false, bits: "000...0", presence: "000...0" }`
- explicit zero chunk -> `{ exists: true, bits: "000...0", presence: "111...1" }`
- `chunk(cx, cy)` is kept for backward-compatible low-level chunk reads and still returns the configured zero-bit payload for an absent chunk
- `setChunk(cx, cy, bits)` explicitly replaces the full chunk payload, including an all-zero chunk
- `setChunkState(cx, cy, { bits, presence })` writes mixed present/absent block state in one request
- `chunkbinState(cx, cy)` returns `[payload_bytes][presence_bytes]` for exact chunk-state transfer

`info()` returns:

```ts
type ChunkInfo = {
  raw: string;
  values: Record<string, string>;
};
```

`values` contains the parsed `INFO` key/value pairs exactly as reported by the server.

## Examples

```ts
import { connect } from "@chunkdb/client";

const client = await connect({
  host: "127.0.0.1",
  port: 4242,
  token: "chunk-token",
});

await client.set(0, 0, "1011001110110011");
console.log(await client.readBlock(0, 0));
await client.unset(0, 0);
console.log(await client.readBlock(0, 0));
const zeroChunk = await client.chunk(0, 0);
await client.setChunk(0, 0, zeroChunk);
console.log(await client.chunkExists(0, 0));
const emptyState = await client.readChunk(0, 0);
console.log(emptyState);
const blockBits = zeroChunk.length / emptyState.presence.length;
await client.setChunkState(1, 0, {
  bits: `${"1".repeat(blockBits)}${zeroChunk.slice(blockBits)}`,
  presence: `1${"0".repeat(emptyState.presence.length - 1)}`,
});
console.log(await client.chunkbinState(1, 0));
await client.close();
```

```ts
import { connectPool } from "@chunkdb/client";

const pool = await connectPool({
  uri: "chunk://chunk-token@127.0.0.1:4242/",
  maxConnections: 4,
  minConnections: 1,
});

const writes = Array.from({ length: 8 }, (_, x) =>
  pool.set(x, 0, x % 2 === 0 ? "1011001110110011" : "0000111100001111"),
);

await Promise.all(writes);
console.log(await Promise.all([pool.readBlock(0, 0), pool.readBlock(1, 0)]));

await pool.close();
```

## Errors

- `ChunkConnectionError`
- `ChunkTimeoutError`
- `ChunkProtocolError`
- `ChunkServerError`
- `ChunkAuthError`
- `ChunkTlsError`

Server `-ERR ...` responses are surfaced as typed errors.

```ts
import { ChunkAuthError, ChunkServerError, connectUri } from "@chunkdb/client";

try {
  const client = await connectUri("chunk://wrong-token@127.0.0.1:4242/");
  await client.ping();
} catch (error) {
  if (error instanceof ChunkAuthError) {
    console.error("auth failed", error.serverCode, error.serverMessage);
  } else if (error instanceof ChunkServerError) {
    console.error("server error", error.serverCode, error.serverMessage);
  } else {
    throw error;
  }
}
```

## Local Development

```bash
npm install
npm run build
npm test
npm pack --dry-run
```

Integration tests expect a sibling `chunkdb` repository with built server binaries at:

- `../chunkdb/build-quick/chunkdb_server`
- `../chunkdb/build-quick-tls/chunkdb_server`

Override paths when needed with:

- `CHUNKDB_REPO_ROOT`
- `CHUNKDB_SERVER_BIN`
- `CHUNKDB_SERVER_BIN_TLS`

## Releasing

Releases are tag-driven and publish to npm only when a matching version tag is pushed.

Requirements:

- GitHub Actions secret: `NPM_TOKEN`
- `package.json` version must exactly match the pushed tag without the `v` prefix

Release flow:

```bash
npm version <patch|minor|major> --no-git-tag-version
VERSION=$(node -p "require('./package.json').version")
git add package.json package-lock.json
git commit -m "chore(release): bump version to ${VERSION}"
git push origin main
git tag "v${VERSION}"
git push origin "v${VERSION}"
```

On the tag push, GitHub Actions will:

- fail immediately if the tag does not match `package.json`
- build the current `chunkdb` `main` server binaries needed for integration tests
- run `npm run build`, `npm test`, and `npm pack`
- publish the exact tested tarball to npm as a public package
