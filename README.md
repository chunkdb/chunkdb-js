# @chunkdb/client

Official Node.js and TypeScript client for `chunkdb`.

This package is intentionally small:

- one client = one socket
- sequential request/response flow
- no pooling
- no retries or reconnect
- no browser transport

## Features

- `chunk://` and `chunks://` URI support
- Node core `net` / `tls` transport
- `connect`, `connectUri`, and `ChunkClient`
- `auth`, `ping`, `info`, `get`, `set`, `chunk`, `chunkbin`
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

## API

- `connect(options)`
- `connectUri(uri, overrides?)`
- `parseChunkUri(uri)`
- `formatChunkUri(parsed)`
- `ChunkClient`

Methods:

- `connect()`
- `close()`
- `auth(token?)`
- `ping()`
- `info()`
- `get(x, y)`
- `set(x, y, bits)`
- `chunk(cx, cy)`
- `chunkbin(cx, cy)`

## Examples

```ts
import { connect } from "@chunkdb/client";

const client = await connect({
  host: "127.0.0.1",
  port: 4242,
  token: "chunk-token",
});

await client.set(0, 0, "1011001110110011");
console.log(await client.get(0, 0));
console.log(await client.chunkbin(0, 0));
await client.close();
```

## Errors

- `ChunkConnectionError`
- `ChunkTimeoutError`
- `ChunkProtocolError`
- `ChunkServerError`
- `ChunkAuthError`
- `ChunkTlsError`

Server `-ERR ...` responses are surfaced as typed errors.

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
