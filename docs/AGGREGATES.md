# Count and summarize blocks

`aggregate` counts and summarizes the present blocks of a chunk, an area or a ball on the server.

Run this inside the [first write and read](../README.md#first-write-and-read) example's `try` block, after creating `world_js`:

```ts docs-check
await client.setBlock(0, 0, { id: 7, light: 9 });
await client.setBlock(20, 0, { id: 3, light: 2 });
const area = { cx0: 0, cy0: 0, cx1: 1, cy1: 0 };
console.log(await client.aggregate(area, [{ fn: "count" }, { fn: "sum", column: "id" }, { fn: "avg", column: "light" }]));
console.log(await client.aggregateByChunk(area, [{ fn: "max", column: "id" }]));
```

```output
{ 'count(*)': 2n, 'sum(id)': 10n, 'avg(light)': 5.5 }
[
  { cx: 0n, cy: 0n, values: [ 7n ] },
  { cx: 1n, cy: 0n, values: [ 3n ] }
]
```

## Selectors and functions

A selector is `{ chunk: [cx, cy] }` or `{ chunk: [cx, cy, cz] }`, a box `{ cx0, cy0, cx1, cy1 }` with optional `cz0` and `cz1`, or a ball `{ cx, cy, cz?, radius }`.
A function is `{ fn: "count" }` or `{ fn: "sum" | "min" | "max" | "avg", column }` over an integer or float block column; each function appears at most once.
Pass `{ table }` as the third argument to name another table, and `{ where: { text, args } }` to count only the blocks for which a condition is true, such as `{ text: "light > $1", args: [{ column: "light", value: 2 }] }`; a chunk without a matching block has no row.

## Results

`aggregate` returns an object keyed by each function's lowercase name, such as `count(*)` or `sum(id)`, in request order.
`aggregateByChunk` returns one row per chunk with a present block, in coordinate order, with bigint coordinates and `cz` in a three-dimensional table.
COUNT, integer SUM, MIN and MAX are exact bigints, also outside the int64 range; AVG and float results are numbers.
A function over no value is null.

AGGREGATE has no pages; a selector covers at most `maxAreaChunks` chunk cells, so split a larger area and combine COUNT, SUM, MIN and MAX of the parts.
Inside a transaction, `tx.aggregate` and `tx.aggregateByChunk` read the transaction's snapshot and its own writes.
See the [server AGGREGATE reference](https://github.com/chunkdb/chunkdb/blob/main/docs/reference/AGGREGATE.md) for rounding and errors.
