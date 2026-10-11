# Watch block changes

A change feed reports committed block updates as an asynchronous stream.
A revision orders commits; an epoch identifies a table across dropping and recreating it.
Save both as a position when you need to resume.

Run this inside the [first write and read](../README.md#first-write-and-read) example's `try` block, after creating `world`:

```ts docs-check
const watch = await client.watch("world");
try {
  await client.setBlock(0, 0, { id: 7, light: 9 });
  for await (const event of watch) {
    if (event.kind === "resync") throw new Error("rebuild state before continuing");
    if (event.kind !== "change") continue;
    console.log(event.blocks[0].after);
    break;
  }
} finally {
  await watch.close();
}
```

```output
{ id: 7, light: 9 }
```

## Guarantees

- `watch` opens a dedicated connection with the same login and TLS settings.
- Registration finishes before `watch` resolves, so a later update is observable.
- Ordinary client calls keep working while you watch.
- Revisions can have gaps; timestamps do not order commits.
- The client does not reconnect watches or acknowledge changes automatically.

Change events contain `position: { epoch, revision: bigint }`, `commitTimeMs: bigint`, `user`, `schemaVersion` and typed before/after `blocks`.
`user` is null for anonymous writes.
Coordinates are `bigint`, or `{ chunk: bigint, offset: number }` beyond absolute int64 coordinates.

Schema events contain `version`, `dims`, projected `columns` and `chunkColumns`.
Change events also include nullable bytes `tag`, nullable uint64 `txn`, and typed `chunkChanges`.
Progress events report the completed frontier, including quiet or filtered streams.
CHUNKS events carry versioned raw forms, with null forms for deletion.
The decoder recognizes reserved catalog events without exposing a WATCH CATALOG command.
Resync events identify the position from which you must rebuild state, with nullable `parentEpoch` and `forkRevision` lineage.
Unknown push kinds are fully decoded and ignored without consuming an ordinary reply or advancing ACK eligibility.
Use `area` for inclusive chunk coordinates, `columns` for projection, `noBefore` to omit before rows, or `chunks` for raw forms.
Rows follow the schema event's projected column order.
Coordinates can include a third axis when `dims` is 3; entry extensions are ignored after the known prefix.
Close watches separately from their originating client or pool.

## Resume

Save positions with your consumer state and pass `{ after: savedPosition }` when watching again.
Without a slot, retained history depends on active watches; resuming can require rebuilding state.
Follow the [server resume guide](https://github.com/chunkdb/chunkdb/blob/main/docs/FEED_RESUME.md) after a resync event or unavailable schema error.
See [durable slots](SLOTS.md) to retain history across disconnects.
