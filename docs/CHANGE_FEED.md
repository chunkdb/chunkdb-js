# Changes and durable slots

Examples use `client` and `world` from the [README](../README.md).
`watch` opens a dedicated connection with the same login and TLS settings; ordinary client calls keep working.
It resolves after registration, so an update issued afterward is observable.

```ts
const watch = await client.watch("world");
try {
  await client.setBlock(0, 0, { id: 7, light: 9 });
  for await (const event of watch) {
    if (event.kind === "resync") throw new Error("rebuild state before continuing");
    if (event.kind === "schema") continue;
    console.log(event.blocks[0].after); // { id: 7, light: 9 }
    break;
  }
} finally {
  await watch.close();
}
```

Change events have `position: { epoch, revision: bigint }`, `commitTimeMs: bigint`, applying `user` (null for anonymous writes), `schemaVersion` and typed before/after `blocks`.
Coordinates are `bigint`, or `{ chunk: bigint, offset: number }` beyond absolute int64 coordinates.
Schema events have `version` and `columns`; resync events name the frontier to rebuild from.
Revisions order commits and may have gaps; timestamps do not order commits.
`{ area: { cx0, cy0, cx1, cy1 } }` filters by inclusive chunk coordinates.

Save positions with the consumer state and pass `{ after: savedPosition }` to resume.
Without a slot, retained history depends on active watches, and resuming may require resync.
For resync, keep consuming and buffering while another connection re-reads all state, including deletions; apply buffered changes only above each read chunk's version, then persist the rebuilt state and frontier together.
An unavailable old schema raises `ChunkProtocolError` and requires rebuilding state.

## Durable slots

Create a slot before producing changes; it retains history across disconnects and checkpoints.
Creating/dropping requires `ADMIN`, watching requires `READ`, and only one watcher can claim a slot (`BUSY`).

```ts
await client.createSlot("world", "consumer");
const watch = await client.watch("world", { slot: "consumer" });
try {
  await client.setBlock(1, 0, { id: 8, light: 10 });
  const next = await watch.next();
  if (next.done || next.value.kind !== "change") throw new Error("expected a change");
  console.log(next.value.blocks[0].after); // { id: 8, light: 10 }
  // Persist consumer output and next.value.position together before ACK.
  await watch.ack(next.value.position.revision);
} finally {
  await watch.close();
}
console.log((await client.listSlots("world"))[0].lost); // false
await client.dropSlot("world", "consumer");
```

`listSlots(table?)` returns `{ table, name, epoch, acked, retainedBytes, lost }`; `acked` and `retainedBytes` are `bigint`.
`ack` accepts a uint64 revision through the last returned change or starting position; its promise means written to the socket, not accepted or durable.
Rejected ACKs appear in `next()` as `ChunkServerError` with `command === "ACK"`; after handling a rejection, another `next()` can continue the stream.
`close()` sends `UNWATCH`, waits for its acknowledgment and persists accepted slot ACKs; it discards queued ACK rejections while closing.
Breaking out of `for await` also closes the watch.
Close watches separately from the originating client or pool.

`after` does not acknowledge history, and ACK alone cannot make external output atomic.
Store output and its position atomically in your own system, then ACK; resume from that stored position after disconnects.
If retention limits mark the slot lost (`SLOT_LOST`), rebuild state, drop the lost slot and create it again.
The client does not reconnect a watch or acknowledge automatically.
See [server feed and slot durability](https://github.com/chunkdb/chunkdb/blob/main/docs/CHANGE_FEED.md).
