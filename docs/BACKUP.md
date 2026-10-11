# Copy server data

`execute` exposes the server's backup command.
The copy stays on the server's machine.
The server must have `--backup-dir` configured, and the login needs `MANAGES USERS` when authentication is enabled.

Run this inside the [first write and read](../README.md#first-write-and-read) example's `try` block, with an administrator login:

```ts docs-check
const backup = await client.execute("BACKUP TO 'world_snapshot'");
if (backup.type !== "map") throw new Error("expected backup summary");
console.log(backup.entries.length);
```

```output
4
```

## Destinations

Choose a new destination name for each copy.
The destination must be absent or empty.
Use a relative name under `--backup-dir` with `/` separators, no absolute paths, backslashes or `..` components.
The reply map contains `tables`, `files`, `bytes` and `cuts`.

A revision orders committed changes; an epoch identifies the table across dropping and recreating it.
Each cut identifies a table's epoch and revision.
The copy holds a per-table revision cut, preserves migration history, and restores with new data-directory and table identities.
Concurrent backups return `BUSY`.

After a lost reply, check the destination before deciding whether the copy succeeded.

## Restore

Restore and verify run on the server host using `chunkdb_restore <backup> <destination>` and `chunkdb_verify --data-dir <backup>`.
There is no client-side restore helper.
A restored slot keeps its name but starts at the restored cut in the new epoch, so consumers must resynchronize.
See the [server backup guide](https://github.com/chunkdb/chunkdb/blob/main/docs/BACKUP.md) for completeness guards, supported sources and restore steps.
