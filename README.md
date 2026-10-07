# @chunkdb/client

Official Node.js and TypeScript client for [`chunkdb`](https://github.com/chunkdb/chunkdb).

Package: [`@chunkdb/client` on npm](https://www.npmjs.com/package/@chunkdb/client).

Targets the stable `chunkdb` 1.x protocol; see the engine's
[compatibility policy](https://github.com/chunkdb/chunkdb/blob/main/docs/COMPATIBILITY.md).

This package is intentionally small:

- `ChunkClient` = one long-lived socket
- sequential request/response per client by default, with opt-in pipelining (`pipelineDepth`)
- opt-in pooling via `ChunkPool`
- no automatic retries or background reconnect loops
- no browser transport

## Features

- `chunk://` and `chunks://` URI support
- Node core `net` / `tls` transport
- `connect`, `connectUri`, `connectPool`, `ChunkClient`, and `ChunkPool`
- `auth`, `ping`, `info`, `get`, `readBlock`, `exists`, `set`, `unset`, `mset`, `mget`, `chunkExists`, `readChunk`, `setChunk`, `setChunkState`, `chunk`, `chunkbin`, `chunkbinState`
- binary chunk writes (`setChunkBin`, `setChunkBinState`) that take the same
  `Buffer` layouts `chunkbin` / `chunkbinState` return (server 1.3+)
- world reads: `chunkScan`, `chunkRange`, `chunkRadius`
- compressed chunk transfer (`chunkbinCompressed`, `chunkbinStateCompressed`),
  decompressed and size-checked client-side
- optimistic concurrency: `chunkVersion`, `chunkCompareAndSet`, and atomic
  single-chunk `chunkBatch`
- `walFlush` durability barrier and `metrics` (Prometheus text format)
- tables (chunkdb 2.0+): `createTable`, `dropTable`, `tables`, `tableInfo`,
  `setTableOptions`, `use`, per-table handles (`client.table(name)`), and the
  table named in the URI path (`chunk://host:4242/terrain`)
- batch `mset` / `mget` (single round-trip for many blocks) and configurable request pipelining (`pipelineDepth`) for high-latency links
- persistent socket reuse for low-concurrency callers and opt-in pooled concurrency for Node services
- typed error classes
- configurable connect and command timeouts
- dual ESM / CommonJS build output

## Install

Requirements:

- Node.js 20 or newer
- a reachable `chunkdb` 1.x server

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

## Tables

A chunkdb 2.0 server holds named tables, each with its own geometry and
options. A connection works on one table: the one named by the `table` option
or the URI path, otherwise the server's `default` table. The client selects it
again after every reconnect.

```ts
import { connectUri } from "@chunkdb/client";

const admin = await connectUri("chunk://chunk-token@127.0.0.1:4242/");
await admin.createTable("terrain", {
  blockBits: 4,
  chunkWidthBlocks: 32,
  chunkHeightBlocks: 32,
  durabilityMode: "fsync-wal",
});

// A handle is a separate connection on that table.
const terrain = await admin.table("terrain");
await terrain.set(0, 0, "1011");

// Or name the table in the URI.
const sameTable = await connectUri("chunk://chunk-token@127.0.0.1:4242/terrain");
console.log(await sameTable.get(0, 0)); // "1011"

await Promise.all([terrain.close(), sameTable.close(), admin.close()]);
```

- Geometry is fixed when a table is created; `setTableOptions` changes
  `durabilityMode`, `checkpointUpdates`, `checkpointWalBytes`,
  `walGroupCommitUpdates` and `checkpointCompression`.
- A pool works on one table: `connectPool({ uri: "chunk://...:4242/terrain", ... })`.
  Use one pool per table, and do not call `use` on a client from
  `withClient`: the pooled connection would keep that table for later work.
- After `dropTable`, commands from connections on that table fail with a
  `ChunkServerError` whose `code` is `NO_TABLE`, even if a table of the same
  name is created again; `use(name)` selects a table again.

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
- `tableFromUriPath(path)` — the table a URI path names (`null` for `/`)
- `serializeCommand(parts)`, `parseFrame(buffer)`, `parseInfoPayload(buffer)`
- `zrleCompress(buffer)`, `zrleDecompress(buffer, expectedSize)`
- `ChunkClient`
- `ChunkPool`

`ChunkClient` methods:

- `connect()`
- `close()`
- `uri()` — includes the selected table as its path
- `currentTable()` — the table this connection works on
- `tables(): Promise<string[]>`
- `tableInfo(name): Promise<ChunkTableInfo>` — geometry, options and store id
- `use(name): Promise<ChunkTableInfo>` — selects a table for this connection;
  an unknown name fails with `NO_TABLE` and keeps the current one
- `table(name): Promise<ChunkClient>` — a new connected client on `name`
- `createTable(name, { blockBits, chunkWidthBlocks?, chunkHeightBlocks?,
  largeChunkWidthChunks?, largeChunkHeightChunks?, ...options })`
- `setTableOptions(name, options)` / `dropTable(name)`
- `auth(token?)`
- `ping()`
- `info()`
- `get(x, y)`
- `readBlock(x, y)`
- `exists(x, y)`
- `set(x, y, bits)`
- `unset(x, y)`
- `mset(blocks: { x, y, bits }[])` — batch write, one round-trip; items apply in order and are not atomic as a group (on error, earlier items may already be applied) — use `chunkBatch` for an atomic single-chunk update
- `mget(blocks: { x, y }[]): Promise<string[]>` — batch read, one round-trip
- `chunkExists(cx, cy)`
- `readChunk(cx, cy)`
- `setChunk(cx, cy, bits)`
- `setChunkState(cx, cy, { bits, presence })`
- `chunk(cx, cy)`
- `chunkbin(cx, cy)`
- `chunkbinState(cx, cy)`
- `setChunkBin(cx, cy, payload)` / `setChunkBinState(cx, cy, state)` — binary
  writes taking exactly the `Buffer` layouts `chunkbin`/`chunkbinState`
  return, so large geometries round-trip without bit strings (server 1.3+)
- `chunkbinCompressed(cx, cy)` / `chunkbinStateCompressed(cx, cy)` — same
  payloads as `chunkbin`/`chunkbinState`, transferred compressed and
  decompressed client-side
- `chunkScan(limit, cursor?)` — enumerate populated chunks in deterministic
  `(cx, cy)` order; returns `{ coords, nextCursor }`, pass `nextCursor` back
  to continue (limit 1..1024 per page)
- `chunkRange(cx0, cy0, cx1, cy1)` — bounded rectangular multi-chunk read
  (max 256 chunks, 64 MiB response cap); returns `{ cx, cy, bits, presence }`
  for populated chunks only
- `chunkRadius(cx, cy, radiusChunks)` — bounded radius/disc multi-chunk read
  with the same limits and result shape as `chunkRange`
- `chunkVersion(cx, cy): Promise<bigint>` — opaque chunk version token
- `chunkCompareAndSet(cx, cy, expectedVersion, { bits, presence })` —
  conditional full-chunk replace; resolves `{ ok, version }` (on `ok: false`
  the returned version is the current one; state is unchanged)
- `chunkBatch(cx, cy, operations, { ifVersion? })` — atomic single-chunk
  batch of `{ type: "set", x, y, bits }` / `{ type: "unset", x, y }`
  operations; same `{ ok, version }` result
- `walFlush()` — explicit durability barrier: resolves once every previously
  acknowledged write is durable, even when the server runs in `relaxed` mode
- `metrics()` — Prometheus text-format runtime metrics

Chunk versions are opaque: they change on every content mutation and whenever
the server reloads the chunk (eviction or restart), so a stale version can
never silently match after recovery. On `ok: false`, re-read, reconcile, and
retry with the fresh version.

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
- `setChunkBin(cx, cy, payload)` / `setChunkBinState(cx, cy, state)` write those same byte layouts back; the client checks the length against the server geometry before sending

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
