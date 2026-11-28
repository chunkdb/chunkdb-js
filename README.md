# @chunkdb/client

[![CI](https://github.com/chunkdb/chunkdb-js/actions/workflows/ci.yml/badge.svg)](https://github.com/chunkdb/chunkdb-js/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40chunkdb%2Fclient)](https://www.npmjs.com/package/@chunkdb/client)

Node.js and TypeScript client for [chunkdb](https://github.com/chunkdb/chunkdb), a database for grids of typed blocks.
A block is one grid cell.
A chunk groups a fixed box of blocks.
Requires Node.js 20 or newer.

## First write and read

Start a fresh server with step 1 of the [server quick start](https://github.com/chunkdb/chunkdb/blob/main/docs/QUICK_START.md#1-start-the-server), then install the client and a TypeScript runner:

```sh
npm install @chunkdb/client
npm install --save-dev tsx
```

Set `CHUNKDB_URI` to the administrator login with the `world_js` table path; the Docker server prints its generated password in its log:
```sh
export CHUNKDB_PASSWORD=$(docker logs chunkdb-quickstart 2>/dev/null | sed -n 's/^Generated password: //p')
export CHUNKDB_URI="chunk://admin:$CHUNKDB_PASSWORD@127.0.0.1:4242/world_js"
```

Percent-encode reserved characters in a password you chose yourself.
Save this as `first.mts` and run `npx tsx first.mts`:

```ts docs-check
import { connectUri } from "@chunkdb/client";

const client = await connectUri(process.env.CHUNKDB_URI!);
try {
  await client.migrate([{
    name: "world_js_table",
    statement: "CREATE TABLE world_js (id u16, light u4 DEFAULT 15) CHUNK 16 x 16",
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
The URI path selects the default table; a method's `table` option overrides it.

Concurrent calls on one client pipeline by default. The client sends up to eight requests before their replies arrive and matches replies in order.
Set `pipelineDepth: 1` in the connection options to send one request at a time. `pipelineBytes` bounds the framed request bytes awaiting replies and defaults to 256 MiB.
Transactions run one statement at a time and `watch()` uses a dedicated connection. See [connection options and failure handling](docs/CONNECTIONS.md#pipelining).

## World in five minutes

This program fills a 4 x 4 area, reads it back and watches one change; save it as `world.mts` and run `npx tsx world.mts`:

```ts docs-check
import { connectUri } from "@chunkdb/client";

const client = await connectUri(process.env.CHUNKDB_URI!);
try {
  await client.migrate([{
    name: "world_js_table",
    statement: "CREATE TABLE world_js (id u16, light u4 DEFAULT 15) CHUNK 16 x 16",
  }]);
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) await client.setBlock(x, y, { id: 1, light: x + y });
  const area = await client.getArea({ cx0: 0, cy0: 0, cx1: 0, cy1: 0 });
  console.log("area chunks", area.length, "block 3 3", await client.getBlock(3, 3));
  const watch = await client.watch("world_js");
  try {
    await client.setBlock(0, 0, { id: 2, light: 9 });
    for await (const event of watch) {
      if (event.kind === "resync") throw new Error("rebuild state before continuing");
      if (event.kind === "change") { console.log("change", event.blocks[0].after); break; }
    }
  } finally {
    await watch.close();
  }
} finally {
  await client.close();
}
```

```output
area chunks 1 block 3 3 { id: 1, light: 6 }
change { id: 2, light: 9 }
```

A rerun skips the migration and prints the same lines; the program is also in [examples/world.ts](https://github.com/chunkdb/chunkdb-js/blob/main/examples/world.ts).

## Guides and reference

- [Connections and errors](https://github.com/chunkdb/chunkdb-js/blob/main/docs/CONNECTIONS.md): login, pools, TLS and channel binding.
- [Values, chunks and areas](https://github.com/chunkdb/chunkdb-js/blob/main/docs/VALUES.md): typed data and conditional writes.
- [Tables](https://github.com/chunkdb/chunkdb-js/blob/main/docs/TABLES.md) and [migrations](https://github.com/chunkdb/chunkdb-js/blob/main/docs/MIGRATIONS.md): schema setup.
- [Aggregates](https://github.com/chunkdb/chunkdb-js/blob/main/docs/AGGREGATES.md): COUNT, SUM, MIN, MAX and AVG over chunks and areas.
- [Transactions](https://github.com/chunkdb/chunkdb-js/blob/main/docs/TRANSACTIONS.md) and [users](https://github.com/chunkdb/chunkdb-js/blob/main/docs/USERS.md).
- [Change feed](https://github.com/chunkdb/chunkdb-js/blob/main/docs/CHANGE_FEED.md) and [backup](https://github.com/chunkdb/chunkdb-js/blob/main/docs/BACKUP.md).
- [API reference](https://github.com/chunkdb/chunkdb-js/blob/main/docs/API.md) and [server compatibility](https://github.com/chunkdb/chunkdb/blob/main/docs/COMPATIBILITY.md).
