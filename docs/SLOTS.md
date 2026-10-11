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
    if (next.value.kind === "schema") continue;
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

`listSlots(table?)` returns `{ table, name, epoch, acked, retainedBytes, lost }`.
`acked` and `retainedBytes` are `bigint`.
`ack` accepts a uint64 revision through the last returned change or starting position.
Its promise means written to the socket, rather than accepted or durable.

Persist consumer output and its position atomically before acknowledging.
After disconnects, resume from that stored position.
`after` does not acknowledge history.
Acknowledging alone cannot make external output atomic.

`close()` sends `UNWATCH`, waits for acknowledgment and persists accepted slot acknowledgments.
It discards queued acknowledgment rejections while closing.
Breaking out of `for await` also closes the watch.
After a crash, skip changes you already applied using your stored position.

## If it fails

| Error | What you do |
|---|---|
| `BUSY` | Release the other watcher; only one can claim a slot. |
| `SLOT_LOST` | Rebuild consumer state using the server resume guide. |
| Rejected acknowledgment | Handle `ChunkServerError` from `next()` with `command === "ACK"`, then call `next()` again. |

Creating and dropping slots requires `ADMIN`; watching requires `READ`.
See the [server resume guide](https://github.com/chunkdb/chunkdb/blob/main/docs/FEED_RESUME.md) for rebuilding state.
