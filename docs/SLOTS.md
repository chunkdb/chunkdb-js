# Resume with a durable slot

A durable slot retains change history across disconnects and checkpoints.
Create one before producing changes and store each applied position with your consumer output.
Read the [change feed](CHANGE_FEED.md) first for positions and event types.

Run this inside the [first write and read](../README.md#first-write-and-read) example's `try` block, after creating `world`:

```ts docs-check
await client.createSlot("world", "consumer");
const watch = await client.watch("world", { slot: "consumer" });
try {
  await client.setBlock(1, 0, { id: 8, light: 10 });
  while (true) {
    const next = await watch.next();
    if (next.done) throw new Error("watch ended before a change");
    if (next.value.kind !== "change" && next.value.kind !== "resync") continue;
    if (next.value.kind === "resync") throw new Error("rebuild state before continuing");
    console.log(next.value.blocks[0].after);
    // Persist consumer output and next.value.position together before ACK.
    await watch.ack(next.value.position.revision);
    break;
  }
} finally {
  await watch.close();
}
console.log((await client.listSlots("world"))[0].lost);
await client.dropSlot("world", "consumer");
```

```output
{ id: 8, light: 10 }
false
```

## Acknowledgments

`listSlots(table?)` returns `{ table, name, epoch, acked, retainedBytes, lost, filters, lostReason }`.
`filters` contains `area`, `columns`, aligned stable `columnIds`, `noBefore` and `chunks`.
Area coordinates and column IDs are bigint; a dropped column keeps its ID with a null display name.
`lostReason` is null for live slots; known loss reasons are `retention_limit` and `schema_filter`.

`acked` and `retainedBytes` are `bigint`.
`ack` accepts a uint64 revision through the starting position or last application-delivered change, chunks or progress event.
Fully parsed but queued events cannot advance this bound.
Schema, resync, catalog and unknown pushes do not advance it.
Its promise means written to the socket, rather than accepted or durable.

Persist consumer output and its position atomically before acknowledging.
After disconnects, resume from that stored position.
`after` does not acknowledge history.
Acknowledging alone cannot make external output atomic.

`close()` sends `UNWATCH`, waits for acknowledgment and persists accepted slot acknowledgments.
It discards queued acknowledgment rejections while closing.
Breaking out of `for await` also closes the watch.
After a crash, skip changes you already applied using your stored position.

## Filters and deadlines

Pass `area`, `columns`, `noBefore` and `chunks` when creating a slot to persist its filters.
A slot watch inherits omitted filters; explicit filters must match the persisted canonical identity.
`ifNotExists` checks that identity instead of silently replacing filters.
`takeover: true` closes the previous owner's connection.
Taking over your own connection requires READ; taking over another user's connection also requires ADMIN on `*`.

`ackTimeoutMs` requires a slot and positive milliseconds; omission disables the watch deadline.
The deadline starts after the first unacknowledged change or chunks frame finishes writing.
Later mutations do not reset it; progress does not start or extend it.
Acknowledging covered mutations leaves the oldest remaining mutation as the deadline basis.
Expiry closes the owning connection with TIMEOUT and `reason=ack_timeout`.

## If it fails

| Error | What you do |
|---|---|
| `SLOT_BUSY` | Release the other watcher, or use authorized `takeover: true`. |
| `SLOT_LOST` | Rebuild consumer state, drop the lost slot and recreate it before consuming new changes. |
| Rejected acknowledgment | Handle `ChunkServerError` from `next()` with `command === "ACK"`, then call `next()` again. |

Rebuilding consumer state does not clear a slot's persistent lost flag.
Creating and dropping slots requires `ADMIN`; watching requires `READ`.
See the [server resume guide](https://github.com/chunkdb/chunkdb/blob/main/docs/FEED_RESUME.md) for rebuilding state.
