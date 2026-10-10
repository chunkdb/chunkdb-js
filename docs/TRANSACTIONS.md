# Transactions

Examples use the connected `client` and `world` table from the [README](../README.md).
`transaction` gives the callback snapshot reads plus its own writes, and publishes all changes together at commit.

```ts
await client.setBlock(10, 4, { id: 23, light: 15 });
const committed = await client.transaction(async (tx) => {
  const row = await tx.getBlock(10, 4);
  await tx.setBlock(10, 4, { light: Number(row?.light ?? 0) - 1 });
  await tx.setBlock(20, 4, { id: 24, light: 1 });
}, { retries: 5 });
console.log(typeof committed); // bigint
console.log(await client.getBlock(10, 4)); // { id: 23, light: 14 }
```

The result is the version assigned to written chunks, or `null` when no chunks were written.
A transaction covers one table, selected by its first call; its methods accept `table` but never `ifVersion`.
It supports block, chunk and area methods, including raw forms; scan and DDL helpers are outside transactions.
The server checks every chunk read or written at commit, so another block's write in the same chunk can conflict.

`CONFLICT` rolls back the attempt and reruns the callback up to `retries` times (5 by default), then rejects with `ChunkConflictError`.
Keep external side effects out of the callback because it can run several times.
A callback that throws rolls back and is not retried.
The connection is held until the transaction ends; ordinary calls on that client wait, and calls on the client inside the callback are refused: use `tx` there.
`pool.transaction` holds one pooled connection and leaves the others available.
A disconnected attempt rolls back; a failure after sending `COMMIT` reports that the outcome is unknown.
See [server transactions](https://github.com/chunkdb/chunkdb/blob/main/docs/TRANSACTIONS.md) for limits and conflict reasons.
