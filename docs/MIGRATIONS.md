# Apply named setup steps

A migration is a named schema or permissions statement that the server records once.
Run the same ordered list at application startup before serving requests.
Run these snippets inside the [first write and read](../README.md#first-write-and-read) example's `try` block:

```ts docs-check
const steps = [
  { name: "realm_table", statement: "CREATE TABLE realm (id u16) CHUNK 16 x 16" },
  { name: "realm_label", statement: "ALTER TABLE realm ADD COLUMN label text(64) NULL" },
];
console.log(JSON.stringify(await client.migrate(steps)));
console.log(JSON.stringify(await client.migrate(steps)));
```

```output
[{"name":"realm_table","status":"applied"},{"name":"realm_label","status":"applied"}]
[{"name":"realm_table","status":"skipped"},{"name":"realm_label","status":"skipped"}]
```

## Keep steps repeatable

- Keep applied names and statement text unchanged; add new steps for later changes.
- Names match `[a-z_][a-z0-9_]*` and contain at most 63 bytes.
- Statements are single lines without parameters.
- Supported statements are `CREATE TABLE`, `ALTER TABLE`, `DROP TABLE`, `GRANT`, `REVOKE`, `CREATE SLOT` and `DROP SLOT`.

The helper trims outer spaces and tabs.
Case and interior spaces remain part of statement identity.
The server records the exact statement, applying user and time, including concurrent application starts.

## If it fails

Import `ChunkMigrationError` alongside `connectUri` for this example:

```ts docs-check
try {
  await client.migrate([{ name: "realm_table", statement: "CREATE TABLE other (id u16) CHUNK 16 x 16" }]);
} catch (error) {
  if (!(error instanceof ChunkMigrationError)) throw error;
  console.log(error.migration.name, error.index, error.code);
}
console.log((await client.execute("SHOW MIGRATIONS")).type);
```

```output
realm_table 0 MIGRATION_MISMATCH
array
```

| Failure | What you do |
|---|---|
| `ChunkMigrationError` | Inspect `migration`, zero-based `index`, earlier `results` and `cause`. |
| Lost reply | Retry the same named list when the server is available. |
| Permission failure | Restore the inner statement's rights before retrying. |

Earlier steps stay applied; the list is not one transaction and cannot run inside a transaction.
Every retry needs the inner statement's rights, even when the step would skip.
`SHOW MIGRATIONS` requires `MANAGES USERS` with authentication enabled.

The pool has no `migrate` method.
Use `pool.withClient((client) => client.migrate(steps))`.
See the [server migrations reference](https://github.com/chunkdb/chunkdb/blob/main/docs/reference/MIGRATIONS.md) for limits and recovery.
