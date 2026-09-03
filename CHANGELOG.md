# Changelog

All notable changes to this project will be documented in this file.

This client follows [Semantic Versioning](https://semver.org/) and targets the
stable `chunkdb` 1.x protocol; see the engine's
[compatibility policy](https://github.com/chunkdb/chunkdb/blob/main/docs/COMPATIBILITY.md).

## Unreleased

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
