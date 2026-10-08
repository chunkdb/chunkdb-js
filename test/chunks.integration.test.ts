import test from "node:test";
import assert from "node:assert/strict";

import {
  ChunkBits,
  ChunkSchemaMismatchError,
  ChunkVersionMismatchError,
  connectUri,
  emptyChunk,
  type ChunkClient,
  type ChunkCoord,
} from "../src/index";
import { startServer } from "./helpers";

async function createWorld(client: ChunkClient, name = "world"): Promise<void> {
  await client.createTable(name, {
    columns: [
      { name: "id", type: "u10", required: true },
      { name: "temp", type: "i8", nullable: true },
      { name: "mask", type: "bits(3)" },
      { name: "name", type: "text(16)", nullable: true },
      { name: "blob", type: "bytes(8)" },
    ],
    chunk: { width: 4, height: 4 },
  });
}

test("chunks: typed reads and writes, IF VERSION, COLUMNS", async () => {
  const server = await startServer();
  try {
    const client = await connectUri(`${server.uri}world`);
    await createWorld(client);

    // A chunk without blocks reads as an empty state with its version, so
    // a write can create it only while it is still empty.
    const empty = await client.getChunk(2, 2);
    assert.equal(empty.width, 4);
    assert.equal(empty.height, 4);
    assert.ok(empty.present.every((present) => !present));
    assert.deepEqual(Object.keys(empty.columns), ["id", "temp", "mask", "name", "blob"]);

    const state = emptyChunk(await client.describe());
    state.present[0] = true;
    state.columns.id[0] = 3;
    state.columns.temp[0] = -1;
    state.columns.mask[0] = ChunkBits.from("110");
    state.columns.name[0] = "ab";
    state.columns.blob[0] = Buffer.from([0x0d, 0x0a, 0x00]);
    state.present[5] = true;
    state.columns.id[5] = 1023;
    state.columns.temp[5] = null;
    state.columns.mask[5] = ChunkBits.from("001");
    state.columns.name[5] = null;
    state.columns.blob[5] = Buffer.alloc(0);
    const created = await client.setChunk(2, 2, state, { ifVersion: empty.version });
    await assert.rejects(client.setChunk(2, 2, state, { ifVersion: empty.version }), (error: unknown) => {
      assert.ok(error instanceof ChunkVersionMismatchError);
      assert.equal(error.currentVersion, created);
      return true;
    });

    const back = await client.getChunk(2, 2);
    assert.equal(back.version, created);
    assert.deepEqual(back.present, state.present);
    assert.deepEqual(back.columns.id.slice(0, 6), [3, null, null, null, null, 1023]);
    assert.deepEqual(back.columns.temp.slice(0, 6), [-1, null, null, null, null, null]);
    assert.deepEqual(back.columns.name.slice(0, 6), ["ab", null, null, null, null, null]);
    assert.deepEqual(back.columns.blob[0], Buffer.from([0x0d, 0x0a, 0x00]));
    assert.deepEqual(back.columns.blob[5], Buffer.alloc(0));
    assert.equal((back.columns.mask[0] as ChunkBits).toString(), "110");
    // Block 5 of chunk (2, 2) is block (9, 9); block reads see the chunk write.
    assert.deepEqual(await client.getBlock(9, 9, { columns: ["id", "blob"] }), { id: 1023, blob: Buffer.alloc(0) });
    assert.deepEqual(await client.getBlock(8, 8, { columns: ["name"] }), { name: "ab" });

    // A block write changes the chunk; a read-modify-write with the read's
    // version then fails.
    await client.setBlock(10, 8, { id: 7, name: "late" });
    back.columns.id[0] = 4;
    await assert.rejects(client.setChunk(2, 2, back, { ifVersion: back.version }), ChunkVersionMismatchError);
    const fresh = await client.getChunk(2, 2);
    assert.equal(fresh.columns.name[2], "late");
    fresh.columns.id[0] = 4;
    await client.setChunk(2, 2, fresh, { ifVersion: fresh.version });
    assert.deepEqual(await client.getBlock(8, 8, { columns: ["id"] }), { id: 4 });

    // COLUMNS: only the named columns, in the named order.
    const some = await client.getChunk(2, 2, { columns: ["name", "id"] });
    assert.deepEqual(Object.keys(some.columns), ["name", "id"]);
    assert.deepEqual(some.columns.name.slice(0, 3), ["ab", null, "late"]);
    assert.deepEqual(some.columns.id.slice(0, 3), [4, null, 7]);

    // The client checks the state before sending it.
    await assert.rejects(client.setChunk(0, 0, { present: [true], columns: {} }), /16 blocks/);
    await client.close();
  } finally {
    await server.stop();
  }
});

test("raw chunk forms copy chunks between places and tables", async () => {
  const server = await startServer();
  try {
    const client = await connectUri(`${server.uri}world`);
    await createWorld(client);
    await createWorld(client, "copy");
    await client.setBlock(0, 0, { id: 3, name: "ab", blob: Buffer.from("\r\n") });
    await client.setBlock(1, 0, { id: 4, temp: -1, mask: ChunkBits.from("111") });

    const raw = await client.getChunkRaw(0, 0);
    assert.equal(raw.readBigUInt64LE(0), (await client.getChunk(0, 0)).version);
    // The version in a written form is not read.
    raw.writeBigUInt64LE(0x7fn, 0);
    await client.setChunkRaw(1, 1, raw);
    await client.setChunkRaw(-3, 5, raw, { table: "copy" });
    for (const [x, y, table] of [[4, 4, "world"], [-12, 20, "copy"]] as const) {
      assert.deepEqual(await client.getBlock(x, y, { table }), {
        id: 3,
        temp: null,
        mask: ChunkBits.from("000"),
        name: "ab",
        blob: Buffer.from("\r\n"),
      });
      assert.deepEqual(await client.getBlock(x + 1, y, { table, columns: ["id", "temp", "mask"] }), {
        id: 4,
        temp: -1,
        mask: ChunkBits.from("111"),
      });
    }
    // A COLUMNS form holds the named sections only.
    const idOnly = await client.getChunkRaw(0, 0, { columns: ["id"] });
    assert.equal(idOnly.length, 16 + 2 + 20);
    // A form longer than the table takes is refused before sending.
    await assert.rejects(client.setChunkRaw(0, 0, Buffer.alloc(2 * 1024 * 1024)), /takes at most/);
    assert.equal(await client.ping(), "PONG");
    await client.close();
  } finally {
    await server.stop();
  }
});

test("areas and chunk scans", async () => {
  const server = await startServer();
  try {
    const client = await connectUri(`${server.uri}world`);
    await createWorld(client);
    // Chunks (0, 0), (2, -1), (-1, 2) and (1, 0).
    for (const [x, y] of [[0, 0], [9, -1], [-1, 9], [5, 0]]) {
      await client.setBlock(x, y, { id: x + 100, name: `b${x}` });
    }

    const box = await client.getArea({ cx0: -1, cy0: -1, cx1: 2, cy1: 0 }, { columns: ["id"] });
    assert.deepEqual(box.map(({ cx, cy }) => [cx, cy]), [[0, 0], [1, 0], [2, -1]]);
    assert.deepEqual(Object.keys(box[2].chunk.columns), ["id"]);
    assert.equal(box[2].chunk.columns.id[4 * 3 + 1], 109);
    const around = await client.getArea({ cx: 0, cy: 0, radius: 1 });
    assert.deepEqual(around.map(({ cx, cy }) => [cx, cy]), [[0, 0], [1, 0]]);
    assert.equal(around[1].chunk.columns.name[1], "b5");
    const raw = await client.getAreaRaw({ cx0: 0, cy0: 0, cx1: 0, cy1: 0 });
    assert.deepEqual(raw.map(({ cx, cy }) => [cx, cy]), [[0, 0]]);
    assert.deepEqual(raw[0].chunk, await client.getChunkRaw(0, 0));
    assert.deepEqual(await client.getArea({ cx0: 5, cy0: 5, cx1: 6, cy1: 6 }), []);

    const all = await client.scanChunks();
    assert.equal(all.more, false);
    const key = (coord: ChunkCoord) => `${coord.cx},${coord.cy}`;
    assert.deepEqual(all.chunks.map(key).sort(), ["-1,2", "0,0", "1,0", "2,-1"]);
    const first = await client.scanChunks({ limit: 3 });
    assert.equal(first.more, true);
    const rest = await client.scanChunks({ limit: 3, after: first.chunks[2] });
    assert.equal(rest.more, false);
    assert.deepEqual([...first.chunks, ...rest.chunks], all.chunks);
    const walked: ChunkCoord[] = [];
    for await (const coord of client.scanAllChunks({ limit: 1 })) {
      walked.push(coord);
    }
    assert.deepEqual(walked, all.chunks);
    await assert.rejects(client.scanChunks({ limit: 1025 }), /LIMIT must be between 1 and 1024/);
    await client.close();
  } finally {
    await server.stop();
  }
});

test("a chunk form of another schema version: setChunk re-encodes, setChunkRaw rejects", async () => {
  const server = await startServer();
  try {
    const admin = await connectUri(server.uri);
    await createWorld(admin);
    const client = await connectUri(`${server.uri}world`);
    await client.setBlock(0, 0, { id: 3, name: "ab", blob: Buffer.from("x") });
    const state = await client.getChunk(0, 0);
    assert.equal(state.schemaVersion, 1);
    const raw = await client.getChunkRaw(0, 0);
    assert.equal(raw.readBigUInt64LE(8), 1n);

    // Another client widens a column: the cached schema is version 1, the
    // table's version 2. setChunk refreshes it and encodes the values again.
    await admin.alterTable("world", { kind: "alterColumnType", column: "temp", type: "i16" });
    state.columns.temp[0] = -1;
    state.columns.id[0] = 5;
    await client.setChunk(0, 0, state);
    assert.deepEqual(await client.getBlock(0, 0, { columns: ["id", "temp", "name"] }), { id: 5, temp: -1, name: "ab" });
    assert.equal((await client.getChunk(0, 0)).schemaVersion, 2);

    // A raw form keeps the schema version it was read at.
    await assert.rejects(client.setChunkRaw(1, 1, raw), (error: unknown) => {
      assert.ok(error instanceof ChunkSchemaMismatchError);
      assert.equal(error.serverCode, "SCHEMA_MISMATCH");
      assert.equal(error.currentSchemaVersion, 2n);
      return true;
    });
    assert.equal(await client.getBlock(4, 4), null);
    assert.equal(await client.ping(), "PONG");
    await Promise.all([admin.close(), client.close()]);
  } finally {
    await server.stop();
  }
});
