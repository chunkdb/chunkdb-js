# API reference

The package exports `ChunkClient`, `connect`, `connectUri`, `ChunkPool`, `connectPool` and the types below from `@chunkdb/client`.
All methods return promises unless stated otherwise.
Start with the [first write and read](../README.md#first-write-and-read) example.

A block is one grid cell; a chunk groups a fixed rectangle of blocks.
A chunk version identifies committed state and orders writes within the same table epoch.

| Client method | Result / purpose |
|---|---|
| `getBlock(x, y, { table?, columns? }?)` | `ChunkRow | null` |
| `getBlockWithMetadata(x, y, readOptions?)` | `{ version: bigint | null, schemaVersion: bigint, row }` |
| `setBlock(x, y, values, { table?, ifVersion? }?)` | written chunk version (`bigint`) |
| `deleteBlock(x, y, { table?, ifVersion? }?)` | written chunk version |
| `getChunk(cx, cy, readOptions?)` | `ChunkState` or `null` |
| `setChunk(cx, cy, state, writeOptions?)` | written chunk version |
| `getChunkRaw(cx, cy, readOptions?)` | `Buffer` or `null` |
| `setChunkRaw(cx, cy, form, writeOptions?)` | written chunk version |
| `getArea(area, readOptions?)` | `ChunkAreaEntry[]` |
| `getAreaRaw(area, readOptions?)` | `ChunkAreaRawEntry[]` |
| `getAreaWithSchema(area, readOptions?)`, `getAreaRawWithSchema(area, readOptions?)` | `{ schemaVersion: bigint, entries }` |
| `scanChunks({ table?, after?, limit? }?)` | `ChunkScanPage`: `{ chunks, more }` |
| `scanAllChunks({ table?, limit? }?)` | async generator of `{ cx, cy }` |
| `createTable(name, definition)` | create schema/geometry/options |
| `alterTable(name, change)`, `dropTable(name)` | change schema/options or drop table |
| `listTables()`, `describe(table?)` | visible names / `ChunkTableSchema` |
| `clearSchemaCache(table?)` | synchronous cache invalidation |
| `createUser(name, password, { managesUsers? }?)` | create user |
| `setPassword(name, password)`, `setManagesUsers(name, value)` | change user |
| `dropUser(name)`, `grant(right, table, user)`, `revoke(right, table, user)` | manage users/rights |
| `listUsers()` | `ChunkUser[]` |
| `transaction(fn, { retries? }?)` | commit version or null |
| `migrate(steps)` | ordered `ChunkMigrationResult[]` |
| `watch(table, watchOptions?)` | `ChunkWatch` async iterator |
| `createSlot(table, name, slotOptions?)`, `dropSlot(table, name)`, `listSlots(table?)` | slot administration / `ChunkSlot[]` |
| `enableFeature(name)`, `showStatus()` | explicit feature activation / protected feature masks; requires ADMIN on `*` |
| `execute(statement, parameters?)` | `ChunkReply` |
| `ping()`, `flushWal()`, `metrics()` | `"PONG"` / durable prior WAL writes / Prometheus text |
| `showConnections()` | `ChunkConnectionInfo[]` with exact bigint IDs |
| `cancel(id)`, `killConnection(id)` | boolean cancellation / termination acknowledgment |
| `connect()`, `close()` | establish / permanently close client |
| `serverInfo()`, `defaultTable()`, `uri()` | synchronous connection information |

`readOptions` is `{ table?, columns? }`.
`writeOptions` is `{ table?, ifVersion?: bigint }`.
`watchOptions` accepts `slot`, `area`, `after`, `columns`, `noBefore`, `chunks`, `ackTimeoutMs` and `takeover`.
`slotOptions` accepts `area`, `columns`, `noBefore`, `chunks` and `ifNotExists`.

See [slots](SLOTS.md) for persisted filter identity.

Schema versions remain numbers within the safe integer range and become bigint above it.
Read metadata methods always return schema versions as bigint.
The transaction and pool expose these metadata methods too.

`ChunkRow` maps column names to `ChunkValue`.
See [values](VALUES.md) for encoding and chunk state.
`ChunkArea` is `{ cx0, cy0, cx1, cy1 }` or `{ cx, cy, radius }`.
`ChunkTableDefinition` is `{ columns, chunk, large?, options? }`.


[Tables](TABLES.md) lists changes and options.

`ChunkTransaction` exposes block, chunk and area operations (including raw forms), with no `ifVersion`.
A position identifies a committed change in a table.
`ChunkPosition` is `{ epoch: string, revision: bigint }`.
The [change feed](CHANGE_FEED.md) describes events.

[Durable slots](SLOTS.md) explains acknowledgments.

The pool exposes the same data, table, user, transaction, watch, slot, raw execute, ping, flush, metrics and schema methods.
It also has `withClient(fn)` and `close()`.
Use a leased client for `migrate`, `serverInfo`, `uri` or `defaultTable`.
[Connections](CONNECTIONS.md) documents `ChunkClientOptions`.


`ChunkPoolOptions` additionally requires `maxConnections` and accepts `minConnections` and `acquireTimeoutMs`.

## Low-level exports

`execute` takes one CQL line and `ChunkParameter[]` (`Uint8Array | null`) in numeric parameter order.
`countParameters(statement)` counts `$digits` occurrences outside quoted literals and identifiers.
The frame count must match that lexical count before a request is sent.
`encodeParameter(column, value)` encodes one typed value.
`encodeStatement(statement, parameters?)` builds its wire request.
`parseReply(buffer)` parses a reply.


`ChunkReply` is a discriminated union of simple, error, integer, double, boolean, null, bulk, array, map and push replies.

Integer replies, including RESP3 big numbers, preserve their exact value as bigint.
Bulk values are Buffers, array/push replies have `items`, and maps have ordered `[key, value]` pairs in `entries`.

`emptyChunk(schema)` creates an absent-block state for a schema.
`ChunkBits`, `formatColumnType` and `parseColumnType` represent or translate typed columns.
`parseChunkUri`, `formatChunkUri` and `tableFromUriPath` handle connection URIs.
`formatChunkUri` includes the supplied password.


Use `client.uri()` when logging an endpoint.

`scramVerifier(password, options?)` derives a verifier for raw user statements.
All public error classes derive from `ChunkError`.
See [connections and errors](CONNECTIONS.md).

See [protocol compatibility](PROTOCOL.md) for extensible decoding and exact feature masks.
