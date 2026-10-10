# API reference

The package exports `ChunkClient`, `connect`, `connectUri`, `ChunkPool`, `connectPool` and the types below from `@chunkdb/client`.
All methods return promises unless stated otherwise; [examples](../README.md) use a chunkdb 2.x server.

| Client method | Result / purpose |
|---|---|
| `getBlock(x, y, { table?, columns? }?)` | `ChunkRow | null` |
| `setBlock(x, y, values, { table?, ifVersion? }?)` | written chunk version (`bigint`) |
| `deleteBlock(x, y, { table?, ifVersion? }?)` | written chunk version |
| `getChunk(cx, cy, readOptions?)` | `ChunkState` |
| `setChunk(cx, cy, state, writeOptions?)` | written chunk version |
| `getChunkRaw(cx, cy, readOptions?)` | `Buffer` |
| `setChunkRaw(cx, cy, form, writeOptions?)` | written chunk version |
| `getArea(area, readOptions?)` | `ChunkAreaEntry[]` |
| `getAreaRaw(area, readOptions?)` | `ChunkAreaRawEntry[]` |
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
| `watch(table, { slot?, area?, after? }?)` | `ChunkWatch` async iterator |
| `createSlot(table, name)`, `dropSlot(table, name)`, `listSlots(table?)` | slot administration / `ChunkSlot[]` |
| `execute(statement, parameters?)` | `ChunkReply` |
| `ping()`, `flushWal()`, `metrics()` | `"PONG"` / durable prior WAL writes / Prometheus text |
| `connect()`, `close()` | establish / permanently close client |
| `serverInfo()`, `defaultTable()`, `uri()` | synchronous connection information |

`readOptions` is `{ table?, columns? }`; `writeOptions` is `{ table?, ifVersion?: bigint }`.
`ChunkRow` maps column names to `ChunkValue`; see [values](VALUES.md) for encoding and chunk state.
`ChunkArea` is `{ cx0, cy0, cx1, cy1 }` or `{ cx, cy, radius }`.
`ChunkTableDefinition` is `{ columns, chunk, large?, options? }`; [tables](TABLES.md) lists changes and options.
`ChunkTransaction` exposes block, chunk and area operations (including raw forms), with no `ifVersion`.
`ChunkPosition` is `{ epoch: string, revision: bigint }`; [feed](CHANGE_FEED.md) describes events, slots, ACK and close.

The pool exposes the same data, table, user, transaction, watch, slot, raw execute, ping, flush, metrics and schema methods.
It also has `withClient(fn)` and `close()`, but no `migrate`, `serverInfo`, `uri` or `defaultTable`; use a leased client when needed.
[Connections](CONNECTIONS.md) documents `ChunkClientOptions`; `ChunkPoolOptions` additionally requires `maxConnections` and accepts `minConnections` and `acquireTimeoutMs`.

## Low-level exports

`execute` takes one CQL line and `ChunkParameter[]` (`Uint8Array | null`) for `$1` through `$n`.
`encodeParameter(column, value)` encodes one typed value; `encodeStatement(statement, parameters?)` builds its wire request.
`parseReply(buffer)` parses a reply; `ChunkReply` is a discriminated union of simple, error, integer, double, boolean, null, bulk, array, map and push replies.
Bulk values are Buffers, array/push replies have `items`, and maps have ordered `[key, value]` pairs in `entries`.

`emptyChunk(schema)` creates an absent-block state for a schema.
`ChunkBits`, `formatColumnType` and `parseColumnType` represent or translate typed columns.
`parseChunkUri`, `formatChunkUri` and `tableFromUriPath` handle connection URIs; `formatChunkUri` includes the supplied password; use `client.uri()` when logging an endpoint.
`scramVerifier(password, options?)` derives a verifier for raw user statements.
All public error classes are listed in [connections and errors](CONNECTIONS.md); their base is `ChunkError`.
