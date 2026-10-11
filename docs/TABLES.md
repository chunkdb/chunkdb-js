# Tables

A table defines the columns and chunk dimensions for its blocks.
A block is one grid cell; a chunk groups a fixed rectangle of blocks.
A fresh server starts with no tables.
Create a table before reading or writing its blocks.

Run this inside the [first write and read](../README.md#first-write-and-read) example's `try` block.
Column names use lowercase letters, digits and underscores and start with a letter or underscore.
The server limits column names to 63 bytes and table names to 64 bytes.

Table names start with a lowercase letter.

Reserved Windows device names are forbidden: `con`, `prn`, `aux`, `nul`, `com0`–`com9` and `lpt0`–`lpt9`.
The `table` option on data methods overrides the default table selected at connection time.

```ts docs-check
await client.createTable("land", {
  columns: [{ name: "id", type: "u16" }],
  chunk: { width: 32, height: 32 },
  large: { width: 8, height: 8 },
  options: { durabilityMode: "fsync-wal" },
});
await client.alterTable("land", { kind: "addColumn", column: { name: "depth", type: "i8", nullable: true } });
await client.alterTable("land", { kind: "alterColumnType", column: "depth", type: "i4", using: "clamp" });
await client.alterTable("land", { kind: "renameColumn", column: "depth", to: "level" });
console.log((await client.describe("land")).columns.map(({ name }) => name));
await client.alterTable("land", { kind: "dropColumn", column: "level" });
await client.alterTable("land", { kind: "setOption", option: "checkpointUpdates", value: 64 });
await client.dropTable("land");
```

```output
[ 'id', 'level' ]
```

Columns support `nullable`, `required` and typed `default` values.
A type change without `using` refuses narrowing that loses existing values.
Use `clamp`, `default` or `truncate` where the server permits them.
See [server tables reference](https://github.com/chunkdb/chunkdb/blob/main/docs/reference/TABLES.md) for conversions and schema constraints.

| Option | Values |
|---|---|
| `durabilityMode` | `"relaxed"`, `"fsync-wal"`, `"fsync-checkpoint"` |
| `checkpointUpdates` | update count |
| `checkpointWalBytes` | WAL byte threshold |
| `walGroupCommitUpdates` | group size |
| `checkpointCompression` | `"none"`, `"zrle"` |
| `varMaxChunkBytes` | variable-value byte budget per chunk |
| `feedBufferBytes` | positive byte budget for the table's in-memory feed; server default 64 MiB |
| `slotMaxBytes` | positive retained byte budget for the table's durable slots; server default 1 GiB |

`describe` reports effective feed and slot limits.
Omitted options use the server's configured defaults.

`listTables()` lists tables visible to you.
`describe(table?)` returns their schema, geometry and options.
Schema changes require `ADMIN`; [users](USERS.md) explains table rights.
For repeatable application startup, use [named migrations](MIGRATIONS.md) rather than swallowing `TABLE_EXISTS`.
