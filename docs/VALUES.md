# Values, chunks and areas

A block is one grid cell with named, typed columns.
A chunk groups a fixed rectangle of blocks; an area selects chunks by rectangle or radius.
Run these snippets inside the [first write and read](../README.md#first-write-and-read) example's `try` block, after creating `world`.

## Values

| Column type | JavaScript value |
|---|---|
| `uN`, `iN` | `number`; reads use `bigint` above 53 bits, writes accept either |
| `bool` | `boolean` |
| `f32`, `f64` | `number`, including `NaN` and infinity |
| `bits(N)` | `ChunkBits.from("101")`, bit 0 first |
| `text(max)` | `string`, limited in UTF-8 bytes |
| `bytes(max)` | `Uint8Array`; reads return `Buffer` |
| `NULL` | `null` |

The client sends values as parameters and rejects values outside their column's range before sending.
An absent block reads as `null`.
A new block fills omitted columns from defaults; updating a block preserves omitted columns.

```ts docs-check
await client.setBlock(10, 4, { id: 23, light: 7 });
console.log(await client.getBlock(10, 4, { columns: ["id"] }));
await client.deleteBlock(10, 4);
console.log(await client.getBlock(10, 4));
```

```output
{ id: 23 }
null
```

## Chunks and conditional writes

A chunk version identifies committed state and orders writes within the same table epoch.
A schema version identifies the table's column layout.
`describe` also reports the table epoch and completed revision; revisions can have gaps.
The revision is null on read-only OPEN when the completed frontier is unavailable; read-write tables report a numeric frontier.

`getChunk` and `getChunkRaw` return `null` for a never-written chunk.
Deleting every block retains an empty form and version until the chunk's disk artifacts and cached state are removed.

A chunk state contains `version`, `schemaVersion`, `width`, `height`, `present` and per-column arrays.
Index `i` represents local coordinates `(i % width, Math.floor(i / width))`.
`setChunk` replaces the entire chunk; it ignores values at absent blocks.
Import `emptyChunk` alongside `connectUri` for this example:

```ts docs-check
const previous = await client.getChunk(0, 0);
const chunk = previous ?? emptyChunk(await client.describe());
chunk.present[0] = true;
chunk.columns.id[0] = 7;
chunk.columns.light[0] = 15;
await client.setChunk(0, 0, chunk, { ifVersion: previous?.version });
console.log(await client.getBlock(0, 0));
```

```output
{ id: 7, light: 15 }
```

A missing chunk has no version, so its first write here is unconditional.
`ifVersion` compares the whole chunk's version for equality.
A mismatch raises `ChunkVersionMismatchError` without changing data.
Do not compare versions with time or assume they are consecutive.

`getChunkRaw`, `setChunkRaw` and `getAreaRaw` transfer binary forms.
A stale raw form raises `ChunkSchemaMismatchError`.

## Areas and scans

Area boxes use inclusive chunk coordinates and return populated chunks only.
`serverInfo()` reports the server's area and response limits.

```ts docs-check
const area = await client.getArea({ cx0: 0, cy0: 0, cx1: 1, cy1: 1 });
console.log(area.map(({ cx, cy }) => [cx, cy]));
console.log((await client.getArea({ cx: 0, cy: 0, radius: 1 })).length);
for await (const { cx, cy } of client.scanAllChunks()) console.log(cx, cy);
```

```output
[ [ 0, 0 ] ]
1
0 0
```

`scanChunks({ after, limit })` returns `{ chunks, more }`.
Pass the last returned coordinate as `after` for the next page.
The client caches schemas and refreshes them after its own schema changes.
A stale-schema typed operation refreshes and retries once.

`describe(table?)` refreshes the schema; `clearSchemaCache(table?)` removes cached layouts.
See [tables](TABLES.md) and the [server chunks reference](https://github.com/chunkdb/chunkdb/blob/main/docs/reference/CHUNKS.md).

## Read metadata

`getBlockWithMetadata` reads the row, chunk version and schema version under one read boundary.
Absent blocks in written chunks keep that chunk's version.

Never-written chunks and transaction-private modified chunks have a null version.
A collected empty chunk also returns null when no committed version remains retained.
`getAreaWithSchema` and `getAreaRawWithSchema` include schema metadata without promising an atomic snapshot across chunks.

```ts docs-check
await client.setBlock(10, 4, { id: 23, light: 7 });
const read = await client.getBlockWithMetadata(10, 4);
console.log(read.row);
console.log(typeof read.version, typeof read.schemaVersion);
```

```output
{ id: 23, light: 7 }
bigint bigint
```

An unknown DESCRIBE type keeps its original name and returns raw bytes for that row column.
Known neighboring columns keep their usual typed values.
Packed chunk forms need every column's width; an unknown type raises `ChunkUnknownColumnTypeError` during typed form decoding.
`getChunkRaw` and `getAreaRaw` retain that undecoded form without knowing the unknown column's width.

`setChunkRaw` requires every column width for its frame-size preflight.
An unknown width raises `ChunkUnknownColumnTypeError`, naming the column and type, before sending SET.
Writing that form requires a client that knows the type.
