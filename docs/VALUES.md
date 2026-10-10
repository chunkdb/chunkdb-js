# Values, chunks and areas

Examples use the connected `client` and `world` table from the [README](../README.md).
Block coordinates are integers; chunk coordinates address whole chunks.

| Column type | JavaScript value |
|---|---|
| `uN`, `iN` | `number`; reads use `bigint` above 53 bits, writes accept either |
| `bool` | `boolean` |
| `f32`, `f64` | `number`, including `NaN` and infinity |
| `bits(N)` | `ChunkBits.from("101")`, bit 0 first |
| `text(max)` | `string`, limited in UTF-8 bytes |
| `bytes(max)` | `Uint8Array`; reads return `Buffer` |
| SQL `NULL` | `null` |

Values are parameters, and the client rejects values that do not fit the column before sending.
An absent block reads as `null`; setting a block fills omitted columns from their defaults and preserves existing values on updates.

```ts
await client.setBlock(10, 4, { id: 23, light: 7 });
console.log(await client.getBlock(10, 4, { columns: ["id"] })); // { id: 23 }
await client.deleteBlock(10, 4);
console.log(await client.getBlock(10, 4)); // null
```

A chunk state contains `version`, `schemaVersion`, `width`, `height`, `present` and per-column arrays.
Index `i` represents local coordinates `(i % width, Math.floor(i / width))`.
`setChunk` replaces the entire chunk; values at absent blocks are ignored.

```ts
const chunk = await client.getChunk(0, 0);
chunk.present[0] = true;
chunk.columns.id[0] = 7;
chunk.columns.light[0] = 15;
await client.setChunk(0, 0, chunk, { ifVersion: chunk.version });
console.log(await client.getBlock(0, 0)); // { id: 7, light: 15 }
```

Conditional writes compare the whole chunk's version for equality and reject with `ChunkVersionMismatchError` without changing anything if it changed.
Do not compare versions with time or assume they are consecutive.
Build a new state with exported `emptyChunk(await client.describe())`.
`getChunkRaw`, `setChunkRaw` and `getAreaRaw` transfer binary forms; a stale raw form rejects with `ChunkSchemaMismatchError`.

```ts
const area = await client.getArea({ cx0: 0, cy0: 0, cx1: 1, cy1: 1 });
console.log(area.map(({ cx, cy }) => [cx, cy])); // [ [ 0, 0 ] ]
const nearby = await client.getArea({ cx: 0, cy: 0, radius: 1 });
console.log(nearby.length); // 1
for await (const { cx, cy } of client.scanAllChunks()) console.log(cx, cy); // 0 0
```

Area boxes are inclusive chunk coordinates and return populated chunks only; calls are bounded by `serverInfo()` limits.
`scanChunks({ after, limit })` returns `{ chunks, more }`; pass the last returned coordinate as `after` for the next page.
The client caches table schemas, refreshes on its own DDL, and retries a stale-schema typed operation once after refreshing.
`describe(table?)` explicitly refreshes the schema; `clearSchemaCache(table?)` drops cached layouts.
See [tables](TABLES.md) and the [server chunk-form reference](https://github.com/chunkdb/chunkdb/blob/main/docs/CQL.md).
