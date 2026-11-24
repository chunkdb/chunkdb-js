# Copy server data

`backup` copies every table on the server, and `restoreTable` restores one table from a copy.
The copy stays on the server's machine.
The server must have `--backup-dir` configured, and the login needs `MANAGES USERS` when authentication is enabled.

Run this inside the [first write and read](../README.md#first-write-and-read) example's `try` block, with an administrator login:

```ts docs-check
const backup = await client.backup("world_snapshot");
const cut = backup.cuts.find(({ table }) => table === "world_js");
const copy = await client.restoreTable("world_js", "world_snapshot", { as: "world_js_copy" });
console.log(copy.table, copy.parentEpoch === cut?.epoch, copy.forkRevision === cut?.revision);
```

```output
world_js_copy true true
```

## Destinations

Choose a new destination name for each copy.
The destination must be absent or empty.
Use a relative name under `--backup-dir` with `/` separators, no absolute paths, backslashes or `..` components.
The result contains `tables`, `files`, `bytes` and `cuts`.

A revision orders committed changes; an epoch identifies the table across dropping and recreating it.
Each cut identifies a table's epoch and revision.
The copy holds a per-table revision cut, preserves migration history, and restores with new data-directory and table identities.
Concurrent backups return `BUSY`.

After a lost reply, check the destination before deciding whether the copy succeeded.

## Restore

`restoreTable(table, backup, { as? })` creates a new table from a completed copy and returns its `table`, `epoch`, `parentEpoch`, `forkRevision`, `files` and `bytes`.
It never replaces a table; use `swapTables` to put the restored table under the live name.
It needs ADMIN on `*` and `MANAGES USERS`.

Restore and verify run on the server host using `chunkdb_restore <backup> <destination>` and `chunkdb_verify --data-dir <backup>`.
There is no client-side restore helper.
A restored slot keeps its name but starts at the restored cut in the new epoch, so consumers must resynchronize.
See the [server backup guide](https://github.com/chunkdb/chunkdb/blob/main/docs/BACKUP.md) for completeness guards, supported sources and restore steps.
