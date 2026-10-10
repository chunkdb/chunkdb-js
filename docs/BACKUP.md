# Backup

`execute` exposes the server's backup command; it copies data on the server, not to the client's machine.
The server must have `--backup-dir` configured, and the login needs `MANAGES USERS` when authentication is enabled.

```ts
const backup = await client.execute("BACKUP TO 'world_snapshot'");
if (backup.type !== "map") throw new Error("expected backup summary");
console.log(backup.entries.length); // 4
```

This example uses the connected administrator `client` from the [README](../README.md).
Choose a new destination name for each copy; the destination must be absent or empty.
Use a relative name under `--backup-dir` with `/` separators, no absolute paths, backslashes or `..` components.
The reply map contains `tables`, `files`, `bytes` and `cuts`; each cut identifies a table's epoch and revision.
The copy holds a per-table revision cut, preserves migration history, and restores with new data-directory and table identities.
Concurrent backups return `BUSY`; do not infer failure or success from a lost reply without checking the destination.

Restore and verify run on the server host using `chunkdb_restore <backup> <destination>` and `chunkdb_verify --data-dir <backup>`.
There is no client-side restore helper.
A restored slot keeps its name but starts at the restored cut in the new epoch, so consumers must resynchronize.
See the [server backup guide](https://github.com/chunkdb/chunkdb/blob/main/docs/BACKUP.md) for completeness guards, supported sources and restore steps.
