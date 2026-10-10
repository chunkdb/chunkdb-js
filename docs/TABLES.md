# Tables

Examples use the connected administrator `client` from the [README](../README.md).
Names use lowercase letters, digits and underscores and start with a letter or underscore.
The `table` option on data methods overrides the default table selected at connection time.

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
console.log((await client.describe("land")).columns.map(({ name }) => name)); // [ 'id', 'level' ]
await client.alterTable("land", { kind: "dropColumn", column: "level" });
await client.alterTable("land", { kind: "setOption", option: "checkpointUpdates", value: 64 });
await client.dropTable("land");
```

Columns support `nullable`, `required` and typed `default` values.
A type change without `using` refuses a narrowing that loses existing values; conversions are `clamp`, `default` or `truncate` where the server permits them.
See [CQL](https://github.com/chunkdb/chunkdb/blob/main/docs/CQL.md) for conversions and schema constraints.

| Option | Values |
|---|---|
| `durabilityMode` | `"relaxed"`, `"fsync-wal"`, `"fsync-checkpoint"` |
| `checkpointUpdates` | update count |
| `checkpointWalBytes` | WAL byte threshold |
| `walGroupCommitUpdates` | group size |
| `checkpointCompression` | `"none"`, `"zrle"` |
| `varMaxChunkBytes` | variable-value byte budget per chunk |

`listTables()` lists tables visible to the current user; `describe(table?)` returns their schema, geometry and options.
Schema changes require `ADMIN`; [users](USERS.md) explains table rights.
For repeatable application startup, use [named migrations](MIGRATIONS.md) rather than swallowing `TABLE_EXISTS`.
