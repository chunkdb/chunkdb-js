# Named migrations

Run the same ordered list at application startup before serving requests.
Examples use the administrator `client` from the [README](../README.md).

```ts
const steps = [
  { name: "realm_table", statement: "CREATE TABLE realm (id u16) CHUNK 16 x 16" },
  { name: "realm_label", statement: "ALTER TABLE realm ADD COLUMN label text(64) NULL" },
];
console.log(await client.migrate(steps)); // both applied
console.log(await client.migrate(steps)); // both skipped
```

Each result is `{ name, status: "applied" | "skipped" }`.
The server records each step once, including concurrent application starts, and persists its name, exact statement, applying user and time.
Names match `[a-z_][a-z0-9_]*` and take at most 63 bytes.
Statements are single lines without parameters: `CREATE TABLE`, `ALTER TABLE`, `DROP TABLE`, `GRANT`, `REVOKE`, `CREATE SLOT` or `DROP SLOT`.
The helper trims outer spaces and tabs; case and all interior spaces remain part of statement identity.
Keep applied names and text unchanged and add new steps for later changes.

```ts
try {
  await client.migrate([{ name: "realm_table", statement: "CREATE TABLE other (id u16) CHUNK 16 x 16" }]);
} catch (error) {
  if (!(error instanceof ChunkMigrationError)) throw error;
  console.log(error.migration.name, error.index, error.code); // realm_table 0 CONFLICT
}
const ledger = await client.execute("SHOW MIGRATIONS");
console.log(ledger.type); // array
```

Import `ChunkMigrationError` from `@chunkdb/client` for the second example.
The list stops at the first failure; `migration` and zero-based `index` identify it, `results` contains earlier acknowledged steps, and `cause`, `code` and `phase` retain the underlying error.
Earlier steps stay applied; the list is not one transaction and cannot run inside a transaction.
After a lost reply, a step's outcome can be unknown: retry the same named list when the server is available.

Every retry needs the inner statement's rights before the server checks skip/conflict; table removal or permission revocation can therefore refuse a repeat.
`SHOW MIGRATIONS` needs `MANAGES USERS` when authentication is enabled.
The pool has no `migrate` method: use `pool.withClient((client) => client.migrate(steps))`.
See [server named migrations](https://github.com/chunkdb/chunkdb/blob/main/docs/CQL.md#named-migrations) for ledger limits and recovery.
