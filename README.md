# @chunkdb/client

Node.js and TypeScript client for [chunkdb 2.0](https://github.com/chunkdb/chunkdb): tables of chunks containing typed blocks addressed by `(x, y)`.
Requires Node.js 20 or newer and a chunkdb 2.x server; the client speaks CQL protocol 3.

## First write and read

Start a server using the [server quick start](https://github.com/chunkdb/chunkdb/blob/main/docs/QUICK_START.md), then install the client:

```sh
npm install @chunkdb/client
npm install --save-dev tsx
```

Save this as `world.mts`, replace the password with your administrator password, and run `npx tsx world.mts`:

```ts
import { connectUri } from "@chunkdb/client";

const client = await connectUri(process.env.CHUNKDB_URI ??
  "chunk://admin:change-me@127.0.0.1:4242/world");
try {
  await client.migrate([{
    name: "world_table",
    statement: "CREATE TABLE world (id u16, light u4 DEFAULT 15) CHUNK 16 x 16",
  }]);
  await client.setBlock(10, 4, { id: 23 });
  console.log(await client.getBlock(10, 4)); // { id: 23, light: 15 }
  console.log(await client.getBlock(11, 4)); // null
} finally {
  await client.close();
}
```

Run it again: the named migration skips the existing table.
The URI path selects the default table; a method's `table` option overrides it.
Percent-encode reserved characters in the URI password, or pass `user` and `password` options to `connect`.
Use `chunks://` for TLS with certificate verification; see [connections and errors](https://github.com/chunkdb/chunkdb-js/blob/main/docs/CONNECTIONS.md).

`getChunk` and `getChunkRaw` return `null` when a chunk has never been written; a written empty chunk retains its versioned form until its disk artifacts and cached state are removed.

## Examples and reference

The [world example](examples/world.ts) fills an area, reads it and watches an update.
From a checkout, run `npm ci` and `CHUNKDB_URI='chunk://admin:change-me@127.0.0.1:4242/' npm run example:world`.

- [Values, chunks and areas](https://github.com/chunkdb/chunkdb-js/blob/main/docs/VALUES.md): column types, conditional writes, scans and raw forms.
- [Tables](https://github.com/chunkdb/chunkdb-js/blob/main/docs/TABLES.md): schema and table options.
- [Transactions](https://github.com/chunkdb/chunkdb-js/blob/main/docs/TRANSACTIONS.md): snapshot reads and atomic writes.
- [Users](https://github.com/chunkdb/chunkdb-js/blob/main/docs/USERS.md): login, passwords and permissions.
- [Changes and durable slots](https://github.com/chunkdb/chunkdb-js/blob/main/docs/CHANGE_FEED.md): dedicated streams, resuming and ACKs.
- [Backup](https://github.com/chunkdb/chunkdb-js/blob/main/docs/BACKUP.md): server-side copies and restore.
- [Migrations](https://github.com/chunkdb/chunkdb-js/blob/main/docs/MIGRATIONS.md): named startup steps.
- [API reference](https://github.com/chunkdb/chunkdb-js/blob/main/docs/API.md) and [server CQL](https://github.com/chunkdb/chunkdb/blob/main/docs/CQL.md).

Within chunkdb 2.x, protocol and storage changes are additive; breaking server changes wait for 3.0.
See the [server compatibility policy](https://github.com/chunkdb/chunkdb/blob/main/docs/COMPATIBILITY.md) and the client's [changelog](CHANGELOG.md).
