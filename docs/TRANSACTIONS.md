# Update blocks together

A transaction reads one snapshot and publishes all its writes together at commit.
Use it when two block updates must succeed together.
Run this inside the [first write and read](../README.md#first-write-and-read) example's `try` block, after creating `world`:

```ts docs-check
await client.setBlock(10, 4, { id: 23, light: 15 });
const committed = await client.transaction(async (tx) => {
  const row = await tx.getBlock(10, 4);
  await tx.setBlock(10, 4, { light: Number(row?.light ?? 0) - 1 });
  await tx.setBlock(20, 4, { id: 24, light: 1 });
}, { retries: 5 });
console.log(typeof committed);
console.log(await client.getBlock(10, 4));
```

```output
bigint
{ id: 23, light: 14 }
```

A chunk version is an equality token identifying its written state.
The result is the version assigned to written chunks, or `null` when nothing was written.

## Guarantees and limits

- Reads see the snapshot and the transaction's own writes.
- A transaction covers one table, selected by its first call.
- Methods accept `table`, but never `ifVersion`.
- You can use block, chunk and area methods, including raw forms.
- Scans and schema changes run outside transactions.
- Another write in any chunk you read or wrote can cause a conflict.

The connection stays reserved until the transaction ends.
Ordinary calls on that client wait.
Inside the callback, use `tx`; calls on the originating client are refused.
`pool.transaction` reserves one connection and leaves others available.

## If it fails

| Failure | What happens | What you do |
|---|---|---|
| `CONFLICT` | The attempt rolls back and the callback reruns. | Keep external side effects outside the callback. |
| Retry limit | The helper raises `ChunkConflictError`. | Inspect `reason` and retry when appropriate. |
| Callback throws | The attempt rolls back without retrying. | Handle the original error. |
| Disconnect | The attempt rolls back unless commit already reached the server. | Check application state before repeating a possibly committed write. |

`retries` allows 5 additional attempts by default.
A failure after sending `COMMIT` reports an unknown outcome.
See [server transactions](https://github.com/chunkdb/chunkdb/blob/main/docs/TRANSACTIONS.md) for server limits and conflict reasons.
