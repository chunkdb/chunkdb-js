# Changelog

All notable changes to this project will be documented in this file.

This client follows [Semantic Versioning](https://semver.org/). Version 1.x
speaks the `chunkdb` 1.x protocol; the next major version speaks protocol 3
(CQL); see the engine's
[compatibility policy](https://github.com/chunkdb/chunkdb/blob/main/docs/COMPATIBILITY.md).

## Unreleased

### Breaking
- Protocol 3 (CQL) only. Connecting sends `HELLO 3`; a server of an earlier
  protocol fails `connect()` with a `ChunkProtocolError` that says so.
  `serverInfo()` returns the reply: server version, `maxLineBytes`,
  `maxParameters`, `maxAreaChunks`, `maxResponseBytes`, `maxScanLimit`,
  `serverSignature`
- Users replace the token: the client logs in with a user and password
  (SCRAM-SHA-256) from the URI (`chunk://user:password@host:4242/`,
  percent-decoded) or the `user` and `password` options, and checks the
  server's signature. The `token` option and `ParsedChunkUri.token` are
  removed; `ParsedChunkUri` has `user` and `password`, and `uri()` leaves the
  password out. A wrong password, an unknown user (`AUTH_FAILED`) or a missing
  login (`AUTH_REQUIRED`) fails `connect()` with `ChunkAuthError`
- Every call names its table (`table` option), defaulting to the client's
  table: the `table` client option, the URI path, or `default`
- Removed the 1.x and protocol 2 API: `get`, `set`, `unset`, `mget`, `mset`,
  `getChunk` / `getChunkState` / `putChunk` / `putChunkState` on bit
  payloads, `chunkExists`, `chunkVersion`, `chunkBatch`, `chunkScan`,
  `chunkRange`, `chunkRadius`, `info`, `walFlush`, `tables`, `tableInfo`,
  `use`, `table(name)`, `setTableOptions`, `currentTable`, zrle transfers
  (`zrleCompress`, `zrleDecompress`), bit-string block values,
  `serializeCommand`, `parseFrame`, `parseInfoPayload` and their types
- Conditional writes reject with `ChunkVersionMismatchError` (with
  `currentVersion`) instead of resolving `{ ok: false }`

### Added
- `ChunkClient.watch` and `ChunkPool.watch`: dedicated, authenticated WATCH
  streams with typed change, schema and resync events, exact positions,
  versioned schema decoding and acknowledged `UNWATCH` on close
- Transactions: `transaction(async (tx) => { ... }, { retries? })` on
  `ChunkClient` and `ChunkPool` runs the callback between `BEGIN` and
  `COMMIT` and resolves the commit version (null when nothing was written).
  `tx` has the block, chunk and area methods without `ifVersion`; its reads
  see one snapshot and its writes apply together. A `CONFLICT` runs the
  callback again, up to `retries` times (5 by default), then rejects with the
  new `ChunkConflictError` (`reason`); a callback that throws rolls back. The
  transaction holds the client's connection until it ends
- Users API on `ChunkClient` and `ChunkPool`: `createUser`, `setPassword`,
  `setManagesUsers`, `dropUser`, `grant`, `revoke`, `listUsers`; passwords
  are sent only as SCRAM verifiers (`verifierIterations`, at least 4096).
  `scramVerifier(password)` computes a verifier
- `ChunkPermissionError` for `PERMISSION_DENIED`
- Typed blocks: `getBlock`, `setBlock`, `deleteBlock`, with values by column
  type (`number` / `bigint`, `boolean`, `ChunkBits`, `string`, `Uint8Array`,
  `null`) sent as parameters and checked before sending; writes resolve the
  chunk version and take `ifVersion`
- Chunks: `getChunk` decodes the chunk form by the table's schema
  (version, schema version, presence, per-column values), `setChunk`
  encodes every column for the cached schema version and, on
  `SCHEMA_MISMATCH`, refreshes the schema and encodes again once;
  `getChunkRaw` / `setChunkRaw` move the form as bytes (`setChunkRaw` rejects
  a form of another schema version with `ChunkSchemaMismatchError`);
  `emptyChunk(schema)`
- Areas and scans: `getArea` / `getAreaRaw` (box or radius),
  `scanChunks` pages and the `scanAllChunks` iterator
- Tables: `createTable` (columns, chunk and large sizes, options),
  `alterTable` (add, drop, rename, change type, set option), `dropTable`,
  `listTables`, `describe`
- A per-client schema cache, refreshed by `describe`, cleared by table
  statements the client sends, and refreshed once (with one retry) when a
  reply shows the table changed
- `flushWal`, `metrics`, and `execute(statement, parameters)` with the RESP3
  reply types (`parseReply`, `encodeStatement`, `encodeParameter`,
  `parseColumnType`, `formatColumnType`)

### Fixed
- a connection whose `HELLO` failed during `connect` was left open behind a
  client the caller never received; it is closed now
- a command timeout closes the connection at once, so the next call
  reconnects instead of writing to the closed socket

## 1.2.0 - 2026-09-03

### Added
- `setChunkBin(cx, cy, payload)` and `setChunkBinState(cx, cy, state)`:
  binary chunk writes over the new `CHUNKSETBIN` command (chunkdb server
  1.3+), taking exactly the byte layouts `chunkbin` / `chunkbinState` return.
  Payload lengths are validated against the server geometry before sending.
  `ChunkPool` mirrors both

## 1.1.0 - 2026-07-18

### Added
- `chunkScan(limit, cursor?)`, `chunkRange(cx0, cy0, cx1, cy1)`, and
  `chunkRadius(cx, cy, radiusChunks)` for world streaming (paginated
  populated-chunk enumeration plus bounded rectangular and radius reads)
- `chunkVersion(cx, cy)`, `chunkCompareAndSet(...)`, and `chunkBatch(...)`
  for optimistic concurrency on a single chunk
- `walFlush()` explicit durability barrier
- `metrics()` Prometheus text-format runtime metrics
- `chunkbinCompressed(cx, cy)` / `chunkbinStateCompressed(cx, cy)` using the
  server's `zrle` codec, plus exported `zrleCompress`/`zrleDecompress`
- `ChunkPool` now mirrors every new `ChunkClient` operation (world reads,
  concurrency primitives, compressed reads, `walFlush`, `metrics`)

Requires a `chunkdb` server that implements these additive commands; all
existing methods keep working against older 1.x servers.

## 1.0.0

First stable release of `@chunkdb/client`, aligned with stable `chunkdb` 1.0.0.

### Added
- `mset(blocks)` / `mget(blocks)` — batch multi-block write/read in a single
  round-trip (protocol `MSET`/`MGET` with `*N` array reply)
- request pipelining: `pipelineDepth` client option allows multiple in-flight
  requests per connection (default `1`); `mset`/`mget` also exposed on the pool
- `ArrayFrame` protocol frame type and `*N` array parsing

### Changed
- internal pending-request model reworked from a single in-flight slot to a FIFO
  queue to support pipelining

### Fixed
- reject command parts containing CR/LF before serialization (request-injection
  guard)

## 0.1.0

- first publishable `@chunkdb/client` package
- TypeScript-first Node.js client using core `net` / `tls`
- URI parsing and formatting for `chunk://` and `chunks://`
- `connect`, `connectUri`, and `ChunkClient`
- `auth`, `ping`, `info`, `get`, `set`, `chunk`, `chunkbin`
- typed error classes
- dual ESM / CommonJS build output
- unit and integration tests
