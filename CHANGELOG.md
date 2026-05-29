# Changelog

All notable changes to this project will be documented in this file.

This client follows [Semantic Versioning](https://semver.org/) and targets the
stable `chunkdb` 1.x protocol; see the engine's
[compatibility policy](https://github.com/chunkdb/chunkdb/blob/main/docs/COMPATIBILITY.md).

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
