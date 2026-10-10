# Connections and errors

`connect(options)` and `connectUri(uri, overrides?)` return an authenticated `ChunkClient`.
`new ChunkClient(options)` constructs a client; call `connect()` or let its first operation connect.
`user`, `password`, `host`, `port`, `table` and `tls` options override the corresponding URI settings.
`uri()` omits the password; `defaultTable()` returns the chosen table and `serverInfo()` is null until login completes.

A client has one socket; calls are sent and replied to in order.
`pipelineDepth` defaults to 1 and allows more requests in flight on that connection.
A pool leases warm clients to independent calls:

Import `connectPool` from `@chunkdb/client` and set `CHUNKDB_URI` to the authenticated URI from the [README](../README.md).

```ts
const pool = await connectPool({
  uri: process.env.CHUNKDB_URI,
  table: "world",
  maxConnections: 4,
  minConnections: 1,
  acquireTimeoutMs: 5000,
});
try {
  await Promise.all([pool.setBlock(2, 0, { id: 2 }), pool.setBlock(3, 0, { id: 3 })]);
  console.log((await pool.getBlock(2, 0))?.id); // 2
} finally {
  await pool.close();
}
```

`pool.withClient(fn)` leases one client for several operations; `pool.transaction(fn)` uses one connection throughout the callback.
Closing a client or pool is final; create a new instance afterward.

`connectTimeoutMs` bounds TCP/TLS connection establishment; `commandTimeoutMs` bounds each reply, including login (both default 5000).
A timeout closes the connection; a later ordinary call reconnects, but a watch ends and must be resumed explicitly.
An operation is not replayed after a connection loss; writes can have an unknown outcome after sending.

Use `chunks://` or `tls: true` for TLS.
`ca`, `cert` and `key` accept PEM strings or Buffers; `tlsServerName` overrides certificate hostname verification.
`tlsInsecure: true` disables certificate verification and is for local tests only.

| Error | Meaning |
|---|---|
| `ChunkAuthError` | `AUTH_REQUIRED` or `AUTH_FAILED`: check user/password |
| `ChunkPermissionError` | required right and table are in `serverMessage` |
| `ChunkVersionMismatchError` | conditional write refused; `currentVersion` is the current chunk version |
| `ChunkSchemaMismatchError` | stale raw chunk form; `currentSchemaVersion` is the current schema version |
| `ChunkConflictError` | transaction conflict, with `reason` |
| `ChunkMigrationError` | migration list stopped, with step/index/earlier results/cause |
| `ChunkServerError` | server reply, with `serverCode` and `serverMessage` |
| `ChunkConnectionError` | transport failure; inspect endpoint, `code` and `cause` |
| `ChunkTimeoutError` | connect or command timeout |
| `ChunkTlsError` | TLS connection/certificate failure |
| `ChunkProtocolError` | invalid request/value/reply or incompatible protocol |

All derive from `ChunkError` and carry `phase`, optional `code`, `command` and `cause`.
A SCRAM server signature mismatch is a `ChunkConnectionError` saying the server could not prove it knows the password.
See [API reference](API.md) for the connection options and lower-level helpers.
