# Connect and handle errors

`connect(options)` and `connectUri(uri, overrides?)` return an authenticated `ChunkClient`.
With `new ChunkClient(options)`, call `connect()` or let the first operation connect.
Use `user`, `password`, `host`, `port`, `table` and `tls` options to override URI settings.

`uri()` omits the password; `defaultTable()` returns the chosen table.
`serverInfo()` is null until login completes.
A client has one connection, with replies in request order.
`pipelineDepth` defaults to 1 and limits requests in flight.

## Use a pool

A pool lends separate connections to independent calls.
Set `CHUNKDB_URI` as described in the [first write and read](../README.md#first-write-and-read).
Save this as `pool.mts` and run `npx tsx pool.mts`:

```ts docs-check
import { connectPool } from "@chunkdb/client";

const pool = await connectPool({
  uri: process.env.CHUNKDB_URI,
  table: "world",
  maxConnections: 4,
  minConnections: 1,
  acquireTimeoutMs: 5000,
});
try {
  await pool.withClient((client) => client.migrate([{
    name: "world_table",
    statement: "CREATE TABLE world (id u16, light u4 DEFAULT 15) CHUNK 16 x 16",
  }]));
  await Promise.all([pool.setBlock(2, 0, { id: 2 }), pool.setBlock(3, 0, { id: 3 })]);
  console.log((await pool.getBlock(2, 0))?.id);
} finally {
  await pool.close();
}
```

```output
2
```

`pool.withClient(fn)` lends one connection for several operations.
`pool.transaction(fn)` keeps one connection throughout the callback.
Closing a client or pool is final; create a new instance afterward.

## Timeouts and TLS

`connectTimeoutMs` bounds connection establishment; `commandTimeoutMs` bounds each reply, including login.
Both default to 5000 milliseconds.
A timeout closes the connection; a later ordinary call reconnects.
A watch ends and requires explicit resumption.

The client does not replay operations after connection loss.
A sent write can have an unknown outcome.

Use `chunks://` or `tls: true` for TLS.
`ca`, `cert` and `key` accept PEM strings or Buffers.
`tlsServerName` overrides certificate hostname verification.
`tlsInsecure: true` disables certificate verification; use it only for local tests.

## Errors

| Error | Meaning and action |
|---|---|
| `ChunkAuthError` | Check the user and password. |
| `ChunkPermissionError` | Inspect `serverMessage` for the required right and table. |
| `ChunkVersionMismatchError` | Re-read the chunk; `currentVersion` identifies its current state. |
| `ChunkSchemaMismatchError` | Re-read the schema; `currentSchemaVersion` identifies its current layout. |
| `ChunkConflictError` | Retry the transaction; inspect `reason`. |
| `ChunkMigrationError` | Inspect the failed step, earlier results and cause. |
| `ChunkServerError` | Inspect `serverCode` and `serverMessage`. |
| `ChunkConnectionError` | Check the endpoint, `code` and `cause`. |
| `ChunkTimeoutError` | Check the endpoint and timeout settings. |
| `ChunkTlsError` | Check certificates and TLS settings. |
| `ChunkProtocolError` | Check request values and server compatibility. |

All derive from `ChunkError`, with `phase` and optional `code`, `command` and `cause` fields.
A server signature mismatch raises `ChunkConnectionError`: the server cannot prove it knows the password.
See the [API reference](API.md) for connection options and helpers.
