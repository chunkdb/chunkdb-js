import test from "node:test";
import assert from "node:assert/strict";
import { ChunkConditionFailedError, ChunkProtocolError, connectPool, connectUri, emptyChunk } from "../src/index";
import { startServer } from "./helpers";

for (const tls of [false, true]) {
  test(`chunk model: ${tls ? "TLS" : "plain"} metadata, partial writes, transactions and tombstone scans`, { timeout: 25000 }, async () => {
    const server = await startServer({ tls });
    const client = await connectUri(`${server.uri}space`, { tlsInsecure: tls });
    try {
      const definition = {
        columns: [{ name: "n", type: "u8" }],
        chunkColumns: [{ name: "owner", type: "u8", required: true }, { name: "label", type: "text(16)", nullable: true, default: "seed" }],
        chunk: { width: 2, height: 2, depth: 2 },
      };
      await client.createTable("space", definition);
      const schema = await client.describe();
      assert.equal(schema.dims, 3);
      assert.equal(await client.getChunk3D(0, 0, 0), null);
      await assert.rejects(client.setBlock3D(0, 0, 0, { n: 7 }), error => Boolean(error && typeof error === "object" && "serverCode" in error && error.serverCode === "INVALID_ARGUMENT"));
      const initial = await client.setChunkMetadata3D(0, 0, 0, { owner: 1, label: "base" }, { ifAbsent: true });
      await client.setBlock3D(0, 0, 0, { n: 7 }, { ifVersion: initial });
      const state = await client.getChunk3D(0, 0, 0, { columns: ["n"] });
      assert.ok(state);
      assert.equal(state.metadata?.owner, 1);
      assert.equal(state.metadata?.label, "base");
      state.columns.n[0] = 9;
      await client.setChunkColumns3D(0, 0, 0, ["n"], { ...state, metadata: { owner: 99 } });
      await client.setChunkMetadata3D(0, 0, 0, { label: null });
      await client.transaction(async tx => {
        await tx.setChunkMetadata3D(0, 0, 0, { owner: 2 });
        await tx.setBlock3D(0, 0, 0, { n: 10 });
      });
      const changed = await client.getChunk3D(0, 0, 0);
      assert.ok(changed);
      assert.equal(changed.metadata?.owner, 2);
      assert.equal(changed.metadata?.label, null);
      assert.equal(changed.columns.n[0], 10);
      const raw = await client.getChunkRaw3D(0, 0, 0);
      assert.equal(raw?.subarray(0, 4).toString(), "CKCF");
      await client.setChunkMetadata3D(1, 0, 0, { owner: 5 });
      const deleted = await client.setChunk3D(1, 0, 0, { ...emptyChunk(schema), metadata: { owner: 0 } });
      const tombstone = await client.getChunk3D(1, 0, 0);
      assert.ok(tombstone);
      assert.equal(tombstone.version, deleted);
      assert.equal(tombstone.metadata?.label, "seed");
      const page = await client.scanChunks3D({ since: 0n, withData: true, columns: ["n"] });
      assert.equal(page.epoch, schema.epoch);
      assert.ok(page.position !== null && page.position >= deleted);
      assert.equal(page.chunks.length, 2);
      assert.deepEqual(page.chunks.map(({ cx, cy, cz }) => [cx, cy, cz]), [[0n, 0n, 0n], [1n, 0n, 0n]]);
      assert.equal(page.chunks[0].deleted, false);
      assert.equal(page.chunks[0].chunk?.metadata?.owner, 2);
      assert.equal(page.chunks[1].deleted, true);
      assert.equal(page.chunks[1].version, deleted);
      assert.equal(page.chunks[1].chunk, null);
      const live = await client.scanChunks3D({ limit: 1 });
      assert.equal(live.chunks.length, 1);
      assert.equal(live.more, false);
      const area = await client.getArea3DWithSchema({ cx0: 0, cy0: 0, cz0: 0, cx1: 1, cy1: 0, cz1: 0 }, { columns: ["n"] });
      assert.equal(area.schemaVersion, BigInt(schema.version));
      assert.equal(area.entries.length, 1);
      assert.equal(area.entries[0].chunk.metadata?.owner, 2);
      const ball = await client.getAreaRaw3DWithSchema({ cx: 0, cy: 0, cz: 0, radius: 1 });
      assert.deepEqual(ball.entries.map(({ cx, cy, cz }) => [cx, cy, cz]), [[0n, 0n, 0n]]);
      await assert.rejects(client.setChunkMetadata3D(0, 0, 0, { owner: 3 }, { ifAbsent: true }), ChunkConditionFailedError);
      await client.setChunkMetadata3D(1, 0, 0, { owner: 6 }, { ifAbsent: true });
      const pool = await connectPool({ uri: `${server.uri}space`, tlsInsecure: tls, maxConnections: 1 });
      try { assert.deepEqual(await pool.getBlock3D(0, 0, 0), { n: 10 }); }
      finally { await pool.close(); }
      await client.dropTable("space");
      await client.createTable("space", definition);
      await assert.rejects(client.scanChunks3D({ epoch: page.epoch }), ChunkProtocolError);
    } finally {
      await client.close();
      await server.stop();
    }
  });
}
