# Values, chunks and areas

A block is one grid cell with named, typed columns.
A chunk groups a fixed box of blocks; an area selects chunks by box or radius.
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
A written chunk with no blocks and baseline metadata retains its empty form and version as a tombstone.
Nonbaseline metadata keeps a chunk populated even when it has no blocks.

A chunk state contains `version`, `schemaVersion`, `width`, `height`, `depth`, `present`, per-block `columns` and a `metadata` row.
The x axis varies fastest, followed by y and z.
`setChunk` replaces both column domains; it ignores block values at absent blocks.
Omitted chunk metadata uses its default, then nullable NULL or the type's zero value.
A REQUIRED chunk column without a default must be supplied on the first write.
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
`ifAbsent: true` writes only when the chunk is unpopulated, including a tombstone, and cannot be combined with `ifVersion`.
Block-level writes do not accept `ifAbsent`.

`setChunkColumns(cx, cy, columns, state, options?)` replaces selected block columns while preserving chunk metadata.
`setChunkMetadata(cx, cy, values, options?)` changes only the named chunk columns and accepts explicit `null` for nullable columns.
The pool and transaction expose both methods.
GET projections always include the complete `metadata` row.
Typed chunk reads admit at most 4194304 block-column cells before allocating dense value arrays.
Select fewer columns or read the raw form when a chunk exceeds that limit.

`getChunkRaw`, `setChunkRaw` and `getAreaRaw` transfer binary forms.
A stale raw form raises `ChunkSchemaMismatchError`.
Raw mutations reject unknown sections or flags before sending.
Read decoding uses the structural hard limit, so lowering the table's variable-value quota does not make retained data unreadable.

## Three dimensions

Use the explicit `getBlock3D`, `getBlock3DWithMetadata`, `setBlock3D`, `deleteBlock3D`, `getChunk3D`, `setChunk3D`, `getChunkRaw3D` and `setChunkRaw3D` methods for three-axis tables.
The pool and transaction expose the same methods, including `setChunkColumns3D` and `setChunkMetadata3D`.
Input axes accept a safe integer `number` or an exact int64 `bigint`; returned three-axis chunk coordinates are always `bigint`.
Explicit z=0 remains a three-axis request.
`getArea3D`, `getAreaRaw3D` and their `WithSchema` variants accept `{ cx0, cy0, cz0, cx1, cy1, cz1 }` or `{ cx, cy, cz, radius }`.
The radius selects a three-dimensional ball.

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
`scanChunksWithOptions({ after, limit, since, withData, columns, epoch })` includes retained versions and optional decoded forms.
`scanChunks3D` provides the same options with three-axis coordinates; `scanAllChunks3D` iterates populated coordinates.
These pages include `epoch`, nullable `position` and `retainedDeletionFloor`.
`since` selects revisions strictly greater than its value and includes retained tombstones; their decoded `chunk` is null and `deleted` is true.
Without data, `deleted` is omitted because the row carries only coordinates and a version.
Pass the saved `epoch` to refuse a drop-and-recreate lifetime change.
A revision below the retained deletion floor fails with `reason=tombstone_history_lost`; rebuild the snapshot before resuming.
The client caches schemas and refreshes them after its own schema changes.
A stale-schema typed operation refreshes and retries once.

`describe(table?)` refreshes the schema; `clearSchemaCache(table?)` removes cached layouts.
See [tables](TABLES.md) and the [server chunks reference](https://github.com/chunkdb/chunkdb/blob/main/docs/reference/CHUNKS.md).

## Read metadata

`getBlockWithMetadata` reads the row, chunk version and schema version under one read boundary.
Absent blocks in written chunks keep that chunk's version.

Never-written chunks and transaction-private modified chunks have a null version.
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
Checked chunk forms preserve unknown column payloads as raw bytes during typed reads.
`getChunkRaw` and `getAreaRaw` retain that undecoded form without knowing the unknown column's width.

Mutations require known column types and reject unknown descriptors before sending SET.
