# @chunkdb/client

Official Node.js and TypeScript client for [`chunkdb`](https://github.com/chunkdb/chunkdb).

Package: [`@chunkdb/client` on npm](https://www.npmjs.com/package/@chunkdb/client).

Speaks `chunkdb` protocol 3: CQL statements with typed values ([CQL](https://github.com/chunkdb/chunkdb/blob/main/docs/CQL.md), [protocol](https://github.com/chunkdb/chunkdb/blob/main/docs/PROTOCOL.md)). It does not connect to servers of earlier protocols; `connect()` then fails with a `ChunkProtocolError` that says so.

## Install

Requirements: Node.js 20 or newer and a reachable `chunkdb` server of protocol 3.

```bash
npm install @chunkdb/client
```

## Quick Start

```ts
import { connectUri } from "@chunkdb/client";

const client = await connectUri("chunk://admin:change-me@127.0.0.1:4242/world");

await client.createTable("world", {
  columns: [
    { name: "id", type: "u10", required: true },
    { name: "light", type: "u4", default: 15 },
    { name: "sign", type: "text(64)", nullable: true },
  ],
  chunk: { width: 16, height: 16 },
});

await client.setBlock(10, 4, { id: 23, sign: "hello" }); // resolves the chunk version
console.log(await client.getBlock(10, 4)); // { id: 23, light: 15, sign: "hello" }
console.log(await client.getBlock(11, 4)); // null: the block is absent
await client.close();
```

Connecting logs in as the URI's user with SCRAM-SHA-256: the password never crosses the network, and the client checks that the server holds the user's verifier. `%XX` escapes let a password hold `:`, `@` or `/`; the `user` and `password` options win over the URI. Without a user the client sends `HELLO 3` alone, which only a server started with `--auth none` accepts. `client.serverInfo()` holds the reply (server version, limits and `serverSignature`).

Every call names its table: the `table` option, else the client's table (the `table` client option, the URI path, or `"default"`).

## Values

| Column type | JavaScript value |
|---|---|
| `uN`, `iN` | `number`; `bigint` for columns of more than 53 bits (`u54`..`u64`, `i54`..`i64`). Writes take either. |
| `bool` | `boolean` |
| `f32`, `f64` | `number` (also `NaN`, `Infinity`) |
| `bits(N)` | `ChunkBits` (`ChunkBits.from("101")`: bit 0 first) |
| `text(max)` | `string`, at most `max` UTF-8 bytes |
| `bytes(max)` | `Uint8Array`; reads return a `Buffer` |
| `NULL` | `null` |

Values travel as parameters, never inside the statement. A value that does not fit its column is refused before anything is sent.

The client caches each table's schema (`DESCRIBE`) to encode and decode values. `describe(table)` refreshes it; table statements the client sends clear it; and when a reply shows the schema changed (another client altered the table), the client refreshes it and retries once.

## Chunks and Areas

```ts
import { ChunkVersionMismatchError } from "@chunkdb/client";

const chunk = await client.getChunk(0, 0); // { version, schemaVersion, width, height, present, columns }
chunk.present[0] = true; // block i is at local (i % width, floor(i / width))
chunk.columns.id[0] = 7;
chunk.columns.light[0] = 15;
try {
  await client.setChunk(0, 0, chunk, { ifVersion: chunk.version });
} catch (error) {
  if (!(error instanceof ChunkVersionMismatchError)) throw error;
  // Someone else wrote the chunk: read it again and retry.
}

const area = await client.getArea({ cx0: -2, cy0: -2, cx1: 2, cy1: 2 }, { columns: ["id"] });
const near = await client.getArea({ cx: 0, cy: 0, radius: 1 });
for await (const { cx, cy } of client.scanAllChunks()) console.log(cx, cy);
```

- `getChunk` of a chunk without blocks returns an empty state with its version, so a conditional `setChunk` creates it only while it is still empty.
- `setChunk` replaces every column of the chunk; build a new state with `emptyChunk(await client.describe(table))`. Values of absent blocks are ignored.
- A chunk form carries the schema version it was encoded for. When another client changed the table's columns, `setChunk` refreshes the schema and encodes the state again once; the server refuses a form of another schema version and changes nothing.
- `getChunkRaw` / `setChunkRaw` / `getAreaRaw` move chunk forms as bytes, for copying chunks without decoding them. `setChunkRaw` of a form read before the table's columns changed rejects with `ChunkSchemaMismatchError`.
- `getArea` returns only chunks with a present block, at most `maxAreaChunks` per call. `scanChunks({ after, limit })` returns one page `{ chunks, more }`.
- Versions are compared only for equality. `ifVersion` on a block write also fails when another block of its chunk changed.

## Transactions

```ts
import { ChunkConflictError } from "@chunkdb/client";

const version = await client.transaction(async (tx) => {
  const from = await tx.getBlock(10, 4);
  const to = await tx.getBlock(300, 7);
  await tx.setBlock(10, 4, { light: (from?.light as number) - 1 });
  await tx.setBlock(300, 7, { light: (to?.light as number) + 1 });
}); // the version of every chunk it wrote, or null when it wrote nothing
```

- Reads inside the callback see one snapshot of the table and the transaction's own writes; writes resolve nothing and apply together at `COMMIT`, or not at all ([transactions](https://github.com/chunkdb/chunkdb/blob/main/docs/TRANSACTIONS.md)).
- `tx` has `getBlock`, `setBlock`, `deleteBlock`, `getChunk`, `setChunk`, `getArea` and their raw forms, without `ifVersion`: `COMMIT` checks every chunk the transaction read or wrote. A transaction covers one table, the one its first call names.
- When another write changed what the transaction read or wrote (`CONFLICT`), nothing of it is applied and the callback runs again after a short random pause, up to `retries` times (`client.transaction(fn, { retries: 5 })` is the default); then it rejects with `ChunkConflictError`. The callback may run more than once, so keep other effects out of it.
- When the callback throws, the transaction is rolled back and the error rejects; it does not run again.
- The transaction holds the client's connection: calls made meanwhile wait until it ends, and calls on the client inside the callback are refused. `pool.transaction(fn)` runs on one pooled connection while other calls use the others.
- A connection that closes rolls the transaction back. When it fails after `COMMIT` was sent, the error says the outcome is unknown.

## Tables

```ts
await client.createTable("land", {
  columns: [{ name: "id", type: "u16" }],
  chunk: { width: 32, height: 32 },
  large: { width: 8, height: 8 },
  options: { durabilityMode: "fsync-wal" },
});
await client.alterTable("land", { kind: "addColumn", column: { name: "depth", type: "i8", nullable: true } });
await client.alterTable("land", { kind: "alterColumnType", column: "depth", type: "i4", using: "clamp" });
await client.alterTable("land", { kind: "renameColumn", column: "depth", to: "level" });
await client.alterTable("land", { kind: "dropColumn", column: "level" });
await client.alterTable("land", { kind: "setOption", option: "checkpointUpdates", value: 64 });
console.log(await client.listTables(), await client.describe("land"));
await client.dropTable("land");
```

## Users

```ts
await client.createUser("bot", "hunter2"); // { managesUsers: true } lets the user manage users
await client.grant("READ", "world", "bot"); // READ, WRITE or ADMIN; "*" is every table
await client.revoke("READ", "world", "bot");
await client.setPassword("bot", "new-password");
await client.setManagesUsers("bot", false);
console.log(await client.listUsers()); // [{ name: "admin", managesUsers: true, grants: { "*": "ADMIN" } }, ...]
await client.dropUser("bot");
```

- The client computes the SCRAM verifier from the password and sends only the verifier; `verifierIterations` (at least 4096, the default) sets its PBKDF2 iterations. `scramVerifier(password, { iterations? })` computes one for `execute("CREATE USER bot VERIFIER $1", [Buffer.from(verifier)])`.
- Users may change their own password; everything else needs `MANAGES USERS`. A client keeps logging in with the password it was given.
- `ADMIN` includes `WRITE`, which includes `READ`; `revoke` takes away the right and those above it. A table the user has no right on reads as absent (`NO_TABLE`).

## API

`connect(options)`, `connectUri(uri, overrides?)` and `connectPool(options)` open connections. `ChunkClient` methods:

- `getBlock(x, y, { table?, columns? }): Promise<ChunkRow | null>`
- `setBlock(x, y, values, { table?, ifVersion? }): Promise<bigint>`, `deleteBlock(x, y, { table?, ifVersion? }): Promise<bigint>`
- `getChunk(cx, cy, { table?, columns? }): Promise<ChunkState>`, `setChunk(cx, cy, state, { table?, ifVersion? }): Promise<bigint>`
- `getChunkRaw(cx, cy, { table?, columns? }): Promise<Buffer>`, `setChunkRaw(cx, cy, form, { table?, ifVersion? }): Promise<bigint>`
- `getArea(area, { table?, columns? })`, `getAreaRaw(area, { table?, columns? })`: `area` is `{ cx0, cy0, cx1, cy1 }` or `{ cx, cy, radius }`
- `scanChunks({ table?, after?, limit? }): Promise<{ chunks, more }>`, `scanAllChunks({ table?, limit? }): AsyncGenerator<{ cx, cy }>`
- `createTable(name, { columns, chunk, large?, options? })`, `alterTable(name, change)`, `dropTable(name)`, `listTables()`
- `describe(table?): Promise<ChunkTableSchema>`, `clearSchemaCache(table?)`
- `createUser(name, password, { managesUsers? })`, `setPassword(name, password)`, `setManagesUsers(name, managesUsers)`, `dropUser(name)`, `grant(right, table, user)`, `revoke(right, table, user)`, `listUsers(): Promise<ChunkUser[]>`
- `transaction(fn, { retries? }): Promise<bigint | null>`: runs `fn(tx)` in a transaction (see Transactions)
- `ping()`, `flushWal()` (resolves once every write acknowledged before is durable), `metrics()` (Prometheus text)
- `execute(statement, parameters?): Promise<ChunkReply>`: one CQL statement with `$1`..`$n` parameter frames (`Uint8Array` or `null`); `encodeParameter(column, value)` encodes a typed value
- `serverInfo()`, `defaultTable()`, `uri()`, `connect()`, `close()`

`ChunkPool` has the same data, table, user and transaction methods, plus `withClient(fn)` and `close()`.

Table options: `durabilityMode` (`"relaxed"`, `"fsync-wal"`, `"fsync-checkpoint"`), `checkpointUpdates`, `checkpointWalBytes`, `walGroupCommitUpdates`, `checkpointCompression` (`"none"`, `"zrle"`) and `varMaxChunkBytes`.

## Connections

- A `ChunkClient` keeps one socket and sends one statement at a time; `pipelineDepth` allows more in flight. Statements reach the server in call order and replies come back in that order.
- A `ChunkPool` leases warm clients per call: `connectPool({ uri, maxConnections, minConnections?, acquireTimeoutMs? })`.
- `connectTimeoutMs` bounds connecting and TLS setup; `commandTimeoutMs` bounds each reply, including `HELLO`. A timeout closes the connection; the next call reconnects.
- TLS: `chunks://` or `tls: true`; `ca`, `cert`, `key`, `tlsServerName`, and `tlsInsecure` (local testing only).
- For a statement with parameters, the server closes the connection after `BAD_REQUEST` (a frame longer than its column holds), `SYNTAX`, `NO_TABLE`, or `INVALID_ARGUMENT` for an unknown column; the client reconnects on the next call.

## Errors

- `ChunkServerError`: an `-ERR` reply, with `serverCode` (`SYNTAX`, `INVALID_ARGUMENT`, `NO_TABLE`, `TABLE_EXISTS`, ...) and `serverMessage`
- `ChunkVersionMismatchError`: an `ifVersion` write found another version and changed nothing; `currentVersion` is the chunk's version
- `ChunkConflictError`: `CONFLICT`, a transaction ended without writing anything; `reason` is `chunk_changed`, `duration`, `history_limit` or `table_changed`, and running it again may succeed
- `ChunkSchemaMismatchError`: a chunk form of another schema version than the table's; nothing changed, and `currentSchemaVersion` is the table's
- `ChunkAuthError`: a wrong password or unknown user (`AUTH_FAILED`), or no user for a server that needs one (`AUTH_REQUIRED`)
- `ChunkPermissionError`: `PERMISSION_DENIED`, the user lacks the right the statement needs; `serverMessage` names it (`WRITE on world`)
- `ChunkProtocolError`: a value or statement refused before sending, a reply the client cannot read, or a server of another protocol
- `ChunkConnectionError`, `ChunkTimeoutError`, `ChunkTlsError`; a server whose SCRAM signature does not match fails `connect()` with a `ChunkConnectionError` saying it could not prove it knows the password
