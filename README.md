# @chunkdb/client

Official Node.js and TypeScript client for [`chunkdb`](https://github.com/chunkdb/chunkdb).

Package: [`@chunkdb/client` on npm](https://www.npmjs.com/package/@chunkdb/client).

Speaks `chunkdb` protocol 2, which chunkdb 2.0 servers serve; see the engine's
[compatibility policy](https://github.com/chunkdb/chunkdb/blob/main/docs/COMPATIBILITY.md).
It does not connect to 1.x servers: use `@chunkdb/client` 1.x with those.

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
- blocks: `get` (null for an unset block), `set`, `unset`, batch `mset` / `mget`
- binary chunks: `getChunk`, `getChunkState`, `putChunk`, `putChunkState`,
  optionally zrle-compressed on the wire
- world reads: `chunkScan`, `chunkRange`, `chunkRadius`
- optimistic concurrency: `chunkVersion`, conditional `putChunk` /
  `putChunkState` (`ifVersion`), and atomic single-chunk `chunkBatch`
- `walFlush` durability barrier and `metrics` (Prometheus text format)
- tables: `createTable`, `dropTable`, `tables`, `tableInfo`,
  `setTableOptions`, `use`, per-table handles (`client.table(name)`), and the
  table named in the URI path (`chunk://host:4242/terrain`)
- configurable request pipelining (`pipelineDepth`) for high-latency links
- persistent socket reuse for low-concurrency callers and opt-in pooled concurrency for Node services
- typed error classes
- configurable connect and command timeouts
- dual ESM / CommonJS build output

## Install

Requirements:

- Node.js 20 or newer
- a reachable `chunkdb` 2.0 server

```bash
npm install @chunkdb/client
```

## Quick Start

```ts
import { connectUri } from "@chunkdb/client";

const client = await connectUri("chunk://chunk-token@127.0.0.1:4242/");
await client.set(0, 0, "1011001110110011");
console.log(await client.get(0, 0)); // "1011001110110011"
console.log(await client.get(1, 0)); // null: unset
const state = await client.getChunkState(0, 0);
console.log(state.exists, state.payload.length, state.presence.length);
await client.close();
```

Connecting sends `HELLO 2` with the token and table from the URI. The reply is
available as `client.serverInfo()`: the server version, capabilities, limits,
and the table's geometry and options.

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
- `commandTimeoutMs`: maximum time to wait for one command response, including `HELLO`

```ts
const client = await connectUri("chunk://chunk-token@127.0.0.1:4242/", {
  connectTimeoutMs: 2000,
  commandTimeoutMs: 3000,
});
```

## Connection Model

- Reuse one `ChunkClient` for low-concurrency code paths. It keeps one socket open and sends one request at a time.
- Use one shared `ChunkPool` for concurrent Node.js workloads. It keeps several warm `ChunkClient` instances and leases them per operation.
- Single-socket multiplexing is out of scope. Parallelism comes from multiple sockets, not request IDs on one socket.

## Chunks

A chunk's data is binary:

- `payload`: the packed block bits, `ceil(chunkWidthBlocks * chunkHeightBlocks * blockBits / 8)` bytes;
  bit `i` of the chunk is `payload[i >> 3] >> (i & 7) & 1`
- `presence`: one bit per block, set when the block is explicitly present,
  `ceil(chunkWidthBlocks * chunkHeightBlocks / 8)` bytes

The sizes come from the connection's table: `serverInfo().table` after
connecting, or what `use(name)` returns after a switch. The client checks
every chunk it sends or receives against them.

```ts
const version = await client.chunkVersion(0, 0);
const state = await client.getChunkState(0, 0);
state.payload[0] ^= 0xff;
state.presence[0] |= 0x01;

const result = await client.putChunkState(0, 0, state, { ifVersion: version });
if (!result.ok) {
  // Someone else wrote the chunk; result.version is its current version.
}
```

- `getChunk` returns the payload only; an absent chunk reads as zeros, so use
  `getChunkState(...).exists` or `chunkExists` to tell it from an all-zero chunk.
- `putChunk` makes every block present; `putChunkState` writes the presence
  bitmap too, and payload bits of absent blocks are stored as zero.
- `{ zrle: true }` compresses the transfer. Reads are decompressed and
  size-checked; writes are compressed only when that makes them smaller.
  Sparse chunks shrink a lot, dense ones not at all.
- Writes resolve `{ ok, version }`: the chunk's version after the write, or
  with `ok: false` the current version when `ifVersion` did not match.

## Tables

A chunkdb server holds named tables, each with its own geometry and options.
A connection works on one table: the one named by the `table` option or the
URI path, otherwise the server's `default` table. The client names it again in
`HELLO` after every reconnect.

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
- If the server has no `default` table and none is named, the connection has
  no table: chunk methods reject until `use(name)` selects one.
- `use(name)` waits for the requests in flight on the client and holds back
  new ones until it completes, so with `pipelineDepth` above 1 each request
  still runs entirely on the old or the new table.

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

console.log(await pool.mget([{ x: 0, y: 0 }, { x: 1, y: 0 }]));

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
- `serverInfo(): ChunkHelloInfo | null` — the `HELLO` reply of the current
  connection: `serverVersion`, `capabilities`, `maxLineBytes`,
  `maxAreaChunks`, `maxResponseBytes`, `maxScanLimit`, `maxBatchOps`, and
  `table` (geometry and options, or `null`)
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
- `ping()`
- `info()` — runtime statistics of the selected table
- `get(x, y): Promise<string | null>` — the block's bits, `null` when unset
- `set(x, y, bits)`
- `unset(x, y)`
- `mset(blocks: { x, y, bits }[])` — batch write, one round-trip; items apply in order and are not atomic as a group (on error, earlier items may already be applied) — use `chunkBatch` for an atomic single-chunk update
- `mget(blocks: { x, y }[]): Promise<Array<string | null>>` — batch read, one round-trip
- `chunkExists(cx, cy)`
- `getChunk(cx, cy, { zrle? }): Promise<Buffer>` — the payload
- `getChunkState(cx, cy, { zrle? }): Promise<{ exists, payload, presence }>`
- `putChunk(cx, cy, payload, { ifVersion?, zrle? }): Promise<{ ok, version }>`
- `putChunkState(cx, cy, { payload, presence }, { ifVersion?, zrle? }): Promise<{ ok, version }>`
- `chunkScan(limit, cursor?)` — enumerate populated chunks in deterministic
  `(cx, cy)` order; returns `{ coords, nextCursor }`, pass `nextCursor` back
  to continue (limit 1..1024 per page)
- `chunkRange(cx0, cy0, cx1, cy1, { zrle? })` — bounded rectangular
  multi-chunk read (max 256 chunks, 64 MiB response cap); returns
  `{ cx, cy, payload, presence }` for populated chunks only
- `chunkRadius(cx, cy, radiusChunks, { zrle? })` — bounded radius/disc
  multi-chunk read with the same limits and result shape as `chunkRange`
- `chunkVersion(cx, cy): Promise<bigint>` — opaque chunk version token
- `chunkBatch(cx, cy, operations, { ifVersion? })` — atomic single-chunk
  batch of `{ type: "set", x, y, bits }` / `{ type: "unset", x, y }`
  operations; same `{ ok, version }` result
- `walFlush()` — explicit durability barrier: resolves once every previously
  acknowledged write is durable, even when the server runs in `relaxed` mode
- `metrics()` — Prometheus text-format runtime metrics

Chunk versions are opaque tokens: they change on every content mutation and
survive eviction and restart. A write that does not change the chunk keeps
its version. On `ok: false`, re-read, reconcile, and retry with the fresh
version.

`ChunkPool` mirrors the data methods and adds:

- `close()`
- `withClient(fn)`

`info()` returns:

```ts
type ChunkInfo = {
  raw: string;
  values: Record<string, string>;
};
```

`values` contains the parsed `INFO` key/value pairs exactly as reported by the server.

## Errors

- `ChunkConnectionError`
- `ChunkTimeoutError`
- `ChunkProtocolError` — also when the server does not speak protocol 2
  (chunkdb 1.x; with a token, or without one when the server needs none)
- `ChunkServerError`
- `ChunkAuthError` — a wrong (`AUTH_FAILED`) or missing (`AUTH_REQUIRED`) token
- `ChunkTlsError`

Server `-ERR ...` responses are surfaced as typed errors. A wrong token or an
unknown table fails `connect()`.

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
