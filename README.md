# @chunkdb/client

Official Node.js and TypeScript client for [`chunkdb`](https://github.com/chunkdb/chunkdb).

Package: [`@chunkdb/client` on npm](https://www.npmjs.com/package/@chunkdb/client).

Speaks `chunkdb` protocol 2, which chunkdb 2.0 servers serve; see the engine's
[compatibility policy](https://github.com/chunkdb/chunkdb/blob/main/docs/COMPATIBILITY.md).
It does not connect to 1.x servers: use `@chunkdb/client` 1.x with those.

This package is intentionally small:

- `ChunkClient` = one long-lived socket
- sequential request/response per client by default, with opt-in pipelining (`pipelineDepth`); pipelined requests reach the server in call order
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
- per-block extra data: `xget`, `xput`, `xdel`, in `chunkBatch`, and with the chunk state in `getChunkState` / `putChunkState`
- block history: `history`, `chunkHistory`, `rangeHistory` and their iterators, tags on writes, and reads at a past revision or time
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

- Geometry is fixed when a table is created; `setTableOptions` changes `durabilityMode`, `checkpointUpdates`, `checkpointWalBytes`, `walGroupCommitUpdates`, `checkpointCompression`, the extra-data limits (see [Extra Data](#extra-data)) and the history options (see [History](#history)).
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

## Extra Data

A present block can carry one opaque value of 1 or more bits next to its payload, for example an owner, a label or an object's state. Values can differ in length from block to block, and blocks without one cost nothing.

Extra data is a table option, off by default: `extraMaxBlockBits` is the longest value one block can carry, `extraMaxChunkBytes` (default 65536) the most one chunk can hold, counting 8 bytes per value plus its bytes. Turning it on is permanent, and both limits can only be raised. `tableInfo(name)` and `serverInfo().table` report both, `0` for a table without extra data.

```ts
import { connectUri } from "@chunkdb/client";

const admin = await connectUri("chunk://chunk-token@127.0.0.1:4242/");
await admin.createTable("things", { blockBits: 8, extraMaxBlockBits: 4096 });
// On an existing table: await admin.setTableOptions("terrain", { extraMaxBlockBits: 256 });

const things = await admin.table("things");
await things.set(10, 4, "00000101");
await things.xput(10, 4, Buffer.from("chest")); // 40 bits
await things.xput(10, 4, { bitLength: 12, bytes: Uint8Array.from([0xab, 0x0c]) });
console.log(await things.xget(10, 4)); // { bitLength: 12, bytes: <Buffer ab 0c> }

// All values of a chunk, by block index, with its state.
const state = await things.getChunkState(0, 0, { extra: true });
console.log(state.extra.get(4 * 16 + 10)); // block (10, 4) of a 16-block-wide chunk
await things.putChunkState(0, 0, state, { zrle: true });

await things.chunkBatch(0, 0, [{ type: "xput", x: 10, y: 4, bits: "101" }]);
await things.xdel(10, 4);
await Promise.all([things.close(), admin.close()]);
```

- A value belongs to a present block: `xput` on an unset block fails, `unset` deletes the value, `set` keeps it. `xget` returns `null` for a block without a value, and `xdel` of such a block succeeds.
- Bit `n` of a value is `bytes[n >> 3] >> (n & 7) & 1`; padding bits in the last byte are ignored on input and zero on output. `xput` also takes a byte array, using all of its bits. In `chunkBatch`, `{ type: "xput", x, y, bits }` takes `0`/`1` text (character `n` is bit `n`) and `{ type: "xdel", x, y }` removes a value; operations apply in order.
- `getChunkState(cx, cy, { extra: true })` adds `extra`: a `Map` from block index (`localY * chunkWidthBlocks + localX`, local coordinates taken modulo the chunk size, never negative) to value. `putChunkState` with `extra` replaces all of the chunk's values, and each must belong to a block the new state has present; without `extra`, blocks that stay present keep theirs.
- Every change advances the chunk version. `xput` and `xdel` take no `ifVersion`: use `putChunkState` or `chunkBatch` for a conditional write.
- A value over the table's limits, a value for an absent block, or extra data on a table without it fails with a `ChunkServerError` whose `code` is `INVALID_ARGUMENT`, and the connection stays usable. The client checks bit lengths, byte counts and block indexes before sending.
- `get`, `mget`, `getChunk`, `chunkRange` and `chunkRadius` do not return extra data.
- Needs a server whose `serverInfo().capabilities` include `"extra-data"`. One value has at most 134217664 bits, and no table limit lets a chunk hold more than `serverInfo().maxExtraChunkBytes` (16 MiB).
- `putChunk` and `mset` keep the values of blocks that stay present, like `set`.
- `chunkBatch` sends its operations as one text line, so long values count against `serverInfo().maxLineBytes` (64 KiB by default); the client refuses a longer line before sending. Write long values with `xput` or `putChunkState`.

## History

A table with history keeps every change of every block: its revision and commit time, the block before and after (bits and extra data), and an optional tag the writer attached. You can list the changes of a block, a chunk or a rectangle, and read data as it was at a past revision or time.

History is a table option, off by default; `history: true` turns it on for good, and history starts then. `historyMaxAgeMs` and `historyMaxChunkBytes` bound what a chunk keeps (`0`, the default, keeps everything), `historyMaxTagBytes` (1 to 255, default 32) is the longest tag. `tableInfo(name)` and `serverInfo().table` report them with `history`, `historyStart` (the revision history starts at) and `historyStartTimeMs`.

```ts
import { connectUri } from "@chunkdb/client";

const admin = await connectUri("chunk://chunk-token@127.0.0.1:4242/");
await admin.createTable("world", { blockBits: 4, history: true });
// On an existing table: await admin.setTableOptions("terrain", { history: true });

const world = await admin.table("world");
const since = await world.chunkVersion(0, 0);
await world.set(10, 4, "0101", { tag: Buffer.from("job-17") });
await world.set(10, 4, "1111");

// One page of a block's changes, newest first.
const page = await world.history(10, 4, { limit: 20 });
console.log(page.events[0].before, page.events[0].after); // "0101" "1111"

// Every change of a chunk since a version, oldest first, page by page.
for await (const event of world.chunkHistoryEvents(0, 0, { order: "asc", after: since })) {
  console.log(event.revision, event.x, event.y, event.after, event.tag);
}

// Reads as they were at a revision, or at a time with { timeMs }.
console.log(await world.get(10, 4, { at: { revision: page.events[1].revision } })); // "0101"
await Promise.all([world.close(), admin.close()]);
```

- An event is `{ revision, timeMs, x, y, before, after, beforeExtra, afterExtra, tag }`: the bits as `get` returns them (`null` when the block was or is unset), extra data as `xget` returns it or `null`, and the tag's bytes or `null`. Events are ordered by revision, the events of one chunk write by block index; a chunk write's version is its revision.
- `history`, `chunkHistory` and `rangeHistory` (at most 256 chunks) return one page, `{ events, cursor }`: newest first unless `order: "asc"`, at most `limit` events (1 to 1024, default 100). Pass `cursor` back as `after` (ascending) or `before` (descending) for the next page. A page can be short, even empty, and still have a cursor; only `cursor: null` ends the window. `historyEvents`, `chunkHistoryEvents` and `rangeHistoryEvents` follow the cursors for you.
- `after` and `before` (exclusive) take a cursor or a `bigint` revision, such as a chunk version; `since` and `until` (inclusive) bound commit times in ms; `tag` lists only that tag's events.
- `set`, `unset`, `mset`, `putChunk`, `putChunkState`, `chunkBatch`, `xput` and `xdel` take `{ tag }`: 1 to `historyMaxTagBytes` bytes kept with every event of the write. A write that changes nothing records nothing.
- `get`, `getChunk`, `getChunkState`, `chunkRange` and `chunkRadius` take `{ at: { revision } }` (after every mutation at or below it) or `{ at: { timeMs } }` (each chunk after its mutations committed at or before it). Revisions are ordered across the table, commit times only within a chunk.
- A point not settled yet (a revision at or above the next one, a time not in the past) fails with a `ChunkServerError` whose `code` is `OUT_OF_RANGE`. A read before what the table keeps (before history started, or removed by retention) fails with a `ChunkNotRetainedError` whose `start` is the revision history is kept from; newest first, the kept pages come first.
- Retention removes a chunk's oldest history when the server checkpoints the chunk; a chunk that is not written keeps what it has.
- A tag on a table without history or over its limit fails with `INVALID_ARGUMENT`, and the connection stays usable. Needs a server whose `serverInfo().capabilities` include `"history"`; the client checks that, tag lengths (`serverInfo().maxTagBytes`), `limit` (`serverInfo().maxHistoryLimit`), cursors and points before sending.

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
- `encodeExtraSection(extra, blockCount)`, `decodeExtraSection(buffer, blockCount)` — the binary EXTRA section of a chunk's extra data
- `ChunkClient`
- `ChunkPool`

`ChunkClient` methods:

- `connect()`
- `close()`
- `serverInfo(): ChunkHelloInfo | null` — the `HELLO` reply of the current connection: `serverVersion`, `capabilities`, `maxLineBytes`, `maxAreaChunks`, `maxResponseBytes`, `maxScanLimit`, `maxBatchOps`, `maxExtraChunkBytes`, `maxTagBytes`, `maxHistoryLimit`, and `table` (geometry and options, or `null`)
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
- `get(x, y, { at? }): Promise<string | null>` — the block's bits, `null` when unset
- `set(x, y, bits, { tag? })`
- `unset(x, y, { tag? })`
- `mset(blocks: { x, y, bits }[], { tag? })` — batch write, one round-trip; items apply in order and are not atomic as a group (on error, earlier items may already be applied) — use `chunkBatch` for an atomic single-chunk update
- `mget(blocks: { x, y }[]): Promise<Array<string | null>>` — batch read, one round-trip
- `chunkExists(cx, cy)`
- `getChunk(cx, cy, { zrle?, at? }): Promise<Buffer>` — the payload
- `getChunkState(cx, cy, { zrle?, extra?, at? }): Promise<{ exists, payload, presence, extra? }>`
- `putChunk(cx, cy, payload, { ifVersion?, zrle?, tag? }): Promise<{ ok, version }>`
- `putChunkState(cx, cy, { payload, presence, extra? }, { ifVersion?, zrle?, tag? }): Promise<{ ok, version }>`
- `xget(x, y): Promise<{ bitLength, bytes } | null>` — the block's extra data
- `xput(x, y, { bitLength, bytes } | Uint8Array, { tag? })` / `xdel(x, y, { tag? })`
- `chunkScan(limit, cursor?)` — enumerate populated chunks in deterministic
  `(cx, cy)` order; returns `{ coords, nextCursor }`, pass `nextCursor` back
  to continue (limit 1..1024 per page)
- `chunkRange(cx0, cy0, cx1, cy1, { zrle?, at? })` — bounded rectangular
  multi-chunk read (max 256 chunks, 64 MiB response cap); returns
  `{ cx, cy, payload, presence }` for populated chunks only
- `chunkRadius(cx, cy, radiusChunks, { zrle?, at? })` — bounded radius/disc
  multi-chunk read with the same limits and result shape as `chunkRange`
- `chunkVersion(cx, cy): Promise<bigint>` — opaque chunk version token
- `chunkBatch(cx, cy, operations, { ifVersion?, tag? })` — atomic single-chunk batch of `{ type: "set", x, y, bits }`, `{ type: "unset", x, y }`, `{ type: "xput", x, y, bits }` and `{ type: "xdel", x, y }` operations; same `{ ok, version }` result
- `history(x, y, options?)`, `chunkHistory(cx, cy, options?)`, `rangeHistory(cx0, cy0, cx1, cy1, options?): Promise<{ events, cursor }>` — one page of history; options `{ limit?, order?, after?, before?, since?, until?, tag? }`
- `historyEvents(...)`, `chunkHistoryEvents(...)`, `rangeHistoryEvents(...)` — the same arguments; an async iterator over every event of the window
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
- `ChunkNotRetainedError` — `NOT_RETAINED`: a history read before what the table keeps; `start` is the revision history is kept from
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
