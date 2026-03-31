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

## Timeout Options

- `connectTimeoutMs`: maximum time to establish the socket and complete TLS setup
- `commandTimeoutMs`: maximum time to wait for one command response

```ts
const client = await connectUri("chunk://chunk-token@127.0.0.1:4242/", {
  connectTimeoutMs: 2000,
  commandTimeoutMs: 3000,
});
```

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
