# Connect and handle errors

`connect(options)` and `connectUri(uri, overrides?)` return an authenticated `ChunkClient`.
With `new ChunkClient(options)`, call `connect()` or let the first operation connect.
Use `user`, `password`, `host`, `port`, `table` and `tls` options to override URI settings.

`uri()` omits the password; `defaultTable()` returns the chosen table, or an empty string when none was selected.
A table operation needs a URI path, connection `table` option or method `table` option.
Without one it fails locally; the client does not select an implicit table.
`serverInfo()` is null until login completes.
A client has one connection, with replies in request order.
`pipelineDepth` defaults to 1 and limits requests in flight.

`helloOptions` sends HELLO WITH options such as `{ client_name: "renderer", statement_timeout_ms: 500 }`.
`serverInfo()` exposes `connectionId`, `features`, applied `options`, `notApplied`, `idleTimeoutMs` and `limits` when the server provides them.

`client_name` is applied; timeout and default-tag options currently return `implementation_pending` rather than changing runtime behavior.
Inspect `notApplied` before relying on an option, including an unknown option's `unknown_option` reason.
`commandTimeoutMs` remains the client's independent reply timeout.

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

Set `helloOptions.statement_timeout_ms` to an integer from 0 through 86400000 to bound server statement execution.
Omission inherits the server default; explicit zero disables that deadline.
This deadline is separate from `commandTimeoutMs`, which bounds the client transport.
The server advertises `statement_timeout` and reports effective milliseconds in `serverInfo().options`.

`showConnections()` returns visible IDs, nullable user and statement text, peer addresses and state.
`cancel(id)` returns false for an idle target or a statement past its decision boundary.
`killConnection(id)` closes the target safely; a self-kill is acknowledged before the connection closes.
IDs are exact uint64 bigint values and are not reused during a server run.
The current user can control the same live user identity; ADMIN on `*` also permits other connections.
Check `serverInfo().features` for `connection_controls` before using these methods against a server without the capability.
The pool exposes the same methods; use `withClient` when actions must originate from one specific connection.
Control an in-flight request from a separate client connection; pooled controls require an available lease and follow the leased client's request ordering.
`CANCELLED` and `TIMEOUT` with `applied=false` report that the statement did not apply.
`RATE_LIMITED` identifies `max_connections` or `statements_per_sec` in `reason` and can include `retryAfterMs`.

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
| `ChunkConflictError` | The transaction helper reruns its callback; inspect `reason`. |
| `ChunkConditionFailedError` | Re-read state before deciding on another conditional write. |
| `ChunkBusyError`, `ChunkDiskFullError`, `ChunkRateLimitedError` | Back off before retrying; inspect `retryAfterMs` when present. |
| `ChunkOutcomeUnknownError` | Reconcile the write's outcome before deciding whether to retry. |
| `ChunkMigrationMismatchError` | Keep the recorded migration name and statement unchanged. |
| `ChunkSlotBusyError` | Release the slot's owner or request an authorized takeover. |
| `ChunkCheckFailedError`, `ChunkCancelledError`, `ChunkStatementTimeoutError`, `ChunkKilledError` | Handle the failure explicitly; these are fatal retry classes. |
| `ChunkUnknownCommandError` | Check command spelling and server capabilities. |
| `ChunkMigrationError` | Inspect the failed step, earlier results and cause. |
| `ChunkServerError` | Inspect `serverCode` and `serverMessage`. |
| `ChunkConnectionError` | Check the endpoint, `code` and `cause`. |
| `ChunkTimeoutError` | Check the endpoint and timeout settings. |
| `ChunkTlsError` | Check certificates and TLS settings. |
| `ChunkProtocolError` | Check request values and server compatibility. |

Server errors expose `retryClass`, decoded leading `keys`, free-text `detail` and typed diagnostic fields.
Classification depends on the code alone; unknown codes are fatal.
Unknown diagnostic keys remain available in `keys`; percent escapes decode whitespace, percent signs and equals signs.

The client retries schema reads once after SCHEMA_MISMATCH, and transactions after CONFLICT within the configured retry limit.
It does not automatically replay writes after OUTCOME_UNKNOWN or backoff errors.

A scalar parameter carries no schema version; a width error remains INVALID_ARGUMENT rather than proving a stale schema.
After a known external schema change, call `clearSchemaCache(table)` before deciding whether to retry that operation.

All derive from `ChunkError`, with `phase` and optional `code`, `command` and `cause` fields.
A server signature mismatch raises `ChunkConnectionError`: the server cannot prove it knows the password.
See the [API reference](API.md) for connection options and helpers.
