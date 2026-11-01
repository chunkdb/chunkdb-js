# @chunkdb/client

[![CI](https://github.com/chunkdb/chunkdb-js/actions/workflows/ci.yml/badge.svg)](https://github.com/chunkdb/chunkdb-js/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40chunkdb%2Fclient)](https://www.npmjs.com/package/@chunkdb/client)

Node.js and TypeScript client for [chunkdb](https://github.com/chunkdb/chunkdb), a database for grids of typed blocks.
A block is one grid cell.
A chunk groups a fixed box of blocks.
Requires Node.js 20 or newer.

## First write and read

Start a fresh server with step 1 of the [server quick start](https://github.com/chunkdb/chunkdb/blob/main/docs/QUICK_START.md#1-start-the-server).
Install the client and a TypeScript runner:

```sh
npm install @chunkdb/client
npm install --save-dev tsx
```

Set `CHUNKDB_URI` to your authenticated connection URI, including the `world` table path.
Percent-encode reserved characters in its password.
```sh
export CHUNKDB_URI='chunk://admin:YOUR_PASSWORD@127.0.0.1:4242/world'
```

Save this as `world.mts` and run `npx tsx world.mts`:

```ts docs-check
import { connectUri } from "@chunkdb/client";

const client = await connectUri(process.env.CHUNKDB_URI!);
try {
  await client.migrate([{
    name: "world_table",
    statement: "CREATE TABLE world (id u16, light u4 DEFAULT 15) CHUNK 16 x 16",
  }]);
  await client.setBlock(10, 4, { id: 23 });
  console.log(await client.getBlock(10, 4));
  console.log(await client.getBlock(11, 4));
} finally {
  await client.close();
}
```

```output
{ id: 23, light: 15 }
null
```

Run it again: the named migration skips the existing table.
A fresh server has no tables.
The URI path selects the default table; a method's `table` option overrides it.

## Guides and reference

- [Connections and errors](https://github.com/chunkdb/chunkdb-js/blob/main/docs/CONNECTIONS.md): login, pools and TLS.
- [Values, chunks and areas](https://github.com/chunkdb/chunkdb-js/blob/main/docs/VALUES.md): typed data and conditional writes.
- [Tables](https://github.com/chunkdb/chunkdb-js/blob/main/docs/TABLES.md) and [migrations](https://github.com/chunkdb/chunkdb-js/blob/main/docs/MIGRATIONS.md): schema setup.
- [Transactions](https://github.com/chunkdb/chunkdb-js/blob/main/docs/TRANSACTIONS.md) and [users](https://github.com/chunkdb/chunkdb-js/blob/main/docs/USERS.md).
- [Change feed](https://github.com/chunkdb/chunkdb-js/blob/main/docs/CHANGE_FEED.md) and [backup](https://github.com/chunkdb/chunkdb-js/blob/main/docs/BACKUP.md).
- [API reference](https://github.com/chunkdb/chunkdb-js/blob/main/docs/API.md) and [server compatibility](https://github.com/chunkdb/chunkdb/blob/main/docs/COMPATIBILITY.md).
- [World example](https://github.com/chunkdb/chunkdb-js/blob/main/examples/world.ts): fill an area, read it and watch an update.
