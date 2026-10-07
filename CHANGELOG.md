# Changelog

All notable changes to this project will be documented in this file.

This client follows [Semantic Versioning](https://semver.org/). Version 1.x
speaks the `chunkdb` 1.x protocol, version 2.x speaks protocol 2 (chunkdb
2.0); see the engine's
[compatibility policy](https://github.com/chunkdb/chunkdb/blob/main/docs/COMPATIBILITY.md).

## Unreleased

### Breaking
- Protocol 2 (chunkdb 2.0). Connecting sends `HELLO 2` with the token and
  table; a 1.x server is refused with a `ChunkProtocolError`. The reply is
  available as `serverInfo()` (server version, capabilities, limits, table
  geometry and options). A wrong or missing token fails `connect()` with
  `ChunkAuthError` (`AUTH_FAILED` / `AUTH_REQUIRED`). Removed: `auth()` and
  the `autoAuth` option
- `get` and `mget` return `null` for an unset block; `readBlock` and
  `exists` are removed
- chunks are binary only. `getChunk` / `getChunkState` replace `chunk`,
  `readChunk`, `chunkbin`, `chunkbinState`, `chunkbinCompressed` and
  `chunkbinStateCompressed`; `putChunk` / `putChunkState` replace
  `setChunk`, `setChunkState`, `setChunkBin`, `setChunkBinState` and
  `chunkCompareAndSet` (`{ ifVersion }`). `ChunkChunkState` and
  `ChunkChunkStateInput` hold `payload` / `presence` buffers. `{ zrle: true }`
  compresses a read or write on the wire. Writes resolve `{ ok, version }`
- `chunkRange` / `chunkRadius` entries hold `payload` / `presence` buffers
  instead of bit strings and take `{ zrle }`
- `parseFrame` returns `{ type: "null" }` for `$-1`, and array items may be
  nulls (`NullFrame`)

### Added
- Tables (chunkdb 2.0+): `createTable`, `dropTable`, `tables`, `tableInfo`,
  `setTableOptions` and `use`; `table(name)` returns a new client on a table;
  the `table` option or the URI path (`chunk://host:4242/terrain`) selects
  the table at connect, and the selection is repeated after a reconnect.
  `ChunkPool` connections use the pool's table. `uri()` includes the selected
  table, `currentTable()` reports it, and `tableFromUriPath` is exported.
  Chunk sizes for binary reads and writes follow the selected table's
  geometry
- Per-block extra data (chunkdb 2.0+): `xget`, `xput` and `xdel`; `chunkBatch` operations `{ type: "xput", x, y, bits }` and `{ type: "xdel", x, y }`; `getChunkState(cx, cy, { extra: true })` adds the chunk's values by block index as `extra`, and `putChunkState` with `extra` replaces them. The table options `extraMaxBlockBits` and `extraMaxChunkBytes` are accepted by `createTable` / `setTableOptions` and reported in `ChunkTableInfo`; `serverInfo().maxExtraChunkBytes` reports the server's cap. `encodeExtraSection` / `decodeExtraSection` are exported, and `ChunkPool` mirrors the new methods
- Block history (chunkdb 2.0+): `history`, `chunkHistory` and `rangeHistory` return pages `{ events, cursor }`, and `historyEvents`, `chunkHistoryEvents` and `rangeHistoryEvents` iterate over every event of a window. `set`, `unset`, `mset`, `putChunk`, `putChunkState`, `chunkBatch`, `xput` and `xdel` take `{ tag }`; `get`, `getChunk`, `getChunkState`, `chunkRange` and `chunkRadius` take `{ at: { revision } }` or `{ at: { timeMs } }`. The table options `history`, `historyMaxAgeMs`, `historyMaxChunkBytes` and `historyMaxTagBytes` are accepted by `createTable` / `setTableOptions` and reported in `ChunkTableInfo` with `historyStart` and `historyStartTimeMs`; `serverInfo()` reports `maxTagBytes` and `maxHistoryLimit`. `NOT_RETAINED` is a `ChunkNotRetainedError` with the `start` revision, and `ChunkPool` mirrors the new methods and options

### Fixed
- a connection whose `AUTH` or table selection failed during `connect` was
  left open behind a client the caller never received; it is closed now
- `chunkBatch` rejects an operation of unknown `type` instead of sending it as `UNSET`
- with `pipelineDepth` above 1, a call could reach the server after a call made later: methods that check the table's sizes first (`putChunk`, `putChunkState`, `xput`) were overtaken by quicker ones, so `putChunk` followed by `get` without awaiting read the old state. Requests now reach the server in call order
- a request line longer than the server's `max_line_bytes` (for example a long `chunkBatch` value) is refused before sending; the server answered `BAD_REQUEST` and closed the connection
- a failed socket write left a rejected promise unhandled, which could end the Node.js process

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
