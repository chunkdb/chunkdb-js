import test from "node:test";
import assert from "node:assert/strict";
import { ChunkInvalidArgumentError, connectUri } from "../src/index";
import { startServer } from "./helpers";

for (const tls of [false, true]) for (const dims of [2, 3] as const) test(`configured area pages ${dims}D over ${tls ? "TLS" : "plain"}`, async () => {
  const server = await startServer({ tls, maxAreaChunks: 2, maxAreaResponseBytes: 256, txnMaxWrittenChunks: 1, txnMaxReadChunks: 2 });
  const client = await connectUri(`${server.uri}space`, { tlsInsecure: tls });
  try {
    assert.equal(client.serverInfo()?.maxAreaChunks, 2);
    assert.equal(client.serverInfo()?.maxResponseBytes, 256);
    assert.equal(client.serverInfo()?.limits?.txn_max_written_chunks, 1);
    assert.equal(client.serverInfo()?.limits?.txn_max_read_chunks, 2);
    await client.createTable("space", { columns: [{ name: "n", type: "u8" }], chunkColumns: [{ name: "tag", type: "u8", default: 7 }], chunk: { width: 1, height: 1, ...(dims === 3 ? { depth: 1 } : {}) } });
    if (dims === 2) {
      await client.setBlock(5, 0, { n: 9 });
      const area = { cx0: 0, cy0: 0, cx1: 5, cy1: 0 };
      const first = await client.getAreaPage(area, { limit: 2 });
      assert.deepEqual(first.chunks, []); assert.equal(first.more, true); assert.deepEqual(first.after, { cx: 1n, cy: 0n });
      const last = await client.getAreaPage(area, { limit: 2, after: { cx: 3n, cy: 0n }, columns: ["n"] });
      assert.equal(last.chunks[0].cx, 5n); assert.equal(last.chunks[0].chunk.columns.n[0], 9); assert.equal(last.chunks[0].chunk.metadata?.tag, 7);
      assert.equal(last.more, false); assert.equal(last.after, null);
      assert.equal((await client.execute('GET AREA 0 0TO 5 0FROM space COLUMNS n LIMIT 1AFTER 4 0WITH SCHEMA')).type, "array");
      assert.equal((await client.execute('GET AREA-1-2 TO 0 0 FROM space LIMIT 1')).type, "map");
      assert.equal((await client.getAreaRawPage(area, { after: { cx: 5, cy: 0 } })).after, null);
      await client.transaction(async (tx) => { assert.equal((await tx.getAreaPage(area, { limit: 2 })).more, true); });
      await client.setBlock(0, 0, { n: 1 }); await client.setBlock(1, 0, { n: 2 });
      const short = await client.getAreaPage(area, { limit: 2 });
      assert.equal(short.chunks.length, 1); assert.deepEqual(short.after, { cx: 0n, cy: 0n }); assert.equal(short.more, true);
      const next = await client.getAreaPage(area, { limit: 2, after: short.after! });
      assert.equal(next.chunks[0].cx, 1n); assert.deepEqual(next.after, { cx: 2n, cy: 0n });
      await assert.rejects(client.getArea(area), /area|chunk/i);
      await assert.rejects(client.getAreaPage(area, { limit: 3 }), /maxAreaChunks/);
    } else {
      await client.setBlock3D(5, 0, 0, { n: 9 });
      const area = { cx0: 0, cy0: 0, cz0: 0, cx1: 5, cy1: 0, cz1: 0 };
      const first = await client.getAreaPage3D(area, { limit: 2 });
      assert.deepEqual(first.chunks, []); assert.equal(first.more, true); assert.deepEqual(first.after, { cx: 1n, cy: 0n, cz: 0n });
      const last = await client.getAreaPage3D(area, { limit: 2, after: { cx: 3n, cy: 0n, cz: 0n }, columns: ["n"] });
      assert.equal(last.chunks[0].cx, 5n); assert.equal(last.chunks[0].cz, 0n); assert.equal(last.chunks[0].chunk.metadata?.tag, 7);
      assert.equal(last.more, false); assert.equal(last.after, null); assert.equal((await client.getAreaRawPage3D(area, { after: { cx: 5, cy: 0, cz: 0 } })).after, null);
      assert.equal((await client.execute('GET AREA 0 0 0TO 5 0 0FROM space COLUMNS n LIMIT 1AFTER 4 0 0WITH SCHEMA')).type, "array");
      assert.equal((await client.execute('GET AREA-1-2-3 TO 0 0 0 FROM space LIMIT 1')).type, "map");
      await client.transaction(async (tx) => { assert.equal((await tx.getAreaPage3D(area, { limit: 2 })).more, true); });
      await client.setBlock3D(0, 0, 0, { n: 1 }); await client.setBlock3D(1, 0, 0, { n: 2 });
      const short = await client.getAreaPage3D(area, { limit: 2 });
      assert.equal(short.chunks.length, 1); assert.deepEqual(short.after, { cx: 0n, cy: 0n, cz: 0n }); assert.equal(short.more, true);
      assert.deepEqual((await client.getAreaPage3D(area, { limit: 2, after: short.after! })).after, { cx: 2n, cy: 0n, cz: 0n });
      await assert.rejects(client.getArea3D(area), /area|chunk/i);
    }
  } finally { await client.close(); await server.stop(); }
});

test("downsampled area pages read section 7 forms", async () => {
  const server = await startServer();
  const client = await connectUri(`${server.uri}terrain`);
  try {
    await client.createTable("terrain", { columns: [{ name: "h", type: "u8" }, { name: "kind", type: "u8", nullable: true }], chunk: { width: 4, height: 4 } });
    for (const [x, y, h] of [[0, 0, 3], [1, 1, 7], [2, 0, 5], [5, 0, 1]]) await client.setBlock(x, y, { h });
    const page = await client.getAreaPage({ cx0: 0, cy0: 0, cx1: 1, cy1: 0 }, { scale: 2, reduction: "MAX", columns: ["h"] });
    assert.equal(page.chunks.length, 2);
    const first = page.chunks[0].chunk;
    assert.deepEqual([first.scale, first.reduction, first.width, first.height], [2, "MAX", 2, 2]);
    assert.deepEqual([first.present, first.columns.h], [[true, true, false, false], [7, 5, null, null]]);
    assert.deepEqual(page.chunks[1].chunk.columns.h, [1, null, null, null]);
    const minimum = await client.getAreaPage({ cx0: 0, cy0: 0, cx1: 0, cy1: 0 }, { scale: 4, reduction: "MIN" });
    assert.deepEqual([minimum.chunks[0].chunk.width, minimum.chunks[0].chunk.columns.h], [1, [3]]);
    await assert.rejects(client.getAreaPage({ cx0: 0, cy0: 0, cx1: 0, cy1: 0 }, { scale: 3, reduction: "MAX" }), ChunkInvalidArgumentError);
    await assert.rejects(client.getAreaPage({ cx0: 0, cy0: 0, cx1: 0, cy1: 0 }, { scale: 0, reduction: "MAX" }), /positive integer/);
    await assert.rejects(client.setChunk(0, 0, first), /downsampled/);
  } finally { await client.close(); await server.stop(); }
});
