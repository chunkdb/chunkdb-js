import test from "node:test";
import assert from "node:assert/strict";
import { connectUri } from "../src/index";
import { startServer } from "./helpers";

for (const tls of [false, true]) test(`checked 2D: ${tls ? "TLS" : "plain"} metadata, partial writes, raw copies and transactions`, async () => {
  const server = await startServer({ tls });
  const client = await connectUri(`${server.uri}space`, { tlsInsecure: tls });
  try {
    await client.createTable("space", { columns: [{ name: "n", type: "u8" }], chunk: { width: 2, height: 2 },
      chunkColumns: [{ name: "owner", type: "u8", required: true }, { name: "label", type: "text(16)", nullable: true, default: "seed" }] });
    const initial = await client.setChunkMetadata(0, 0, { owner: 1 }, { ifAbsent: true });
    await client.setBlock(0, 0, { n: 7 }, { ifVersion: initial });
    const state = await client.getChunk(0, 0, { columns: ["n"] });
    assert.ok(state);
    assert.equal(state.metadata?.owner, 1); assert.equal(state.metadata?.label, "seed");
    assert.ok(state.commitTimeMs! > 0n);
    state.columns.n[0] = 9;
    await client.setChunkColumns(0, 0, ["n"], { ...state, metadata: { owner: 99 } });
    await client.transaction(async tx => {
      await tx.setChunkMetadata(0, 0, { label: null });
      await tx.setBlock(0, 0, { n: 10 });
    });
    const changed = await client.getChunk(0, 0);
    assert.ok(changed);
    assert.equal(changed.metadata?.owner, 1); assert.equal(changed.metadata?.label, null);
    assert.equal(changed.columns.n[0], 10);
    await client.setChunk(0, 0, { ...changed, metadata: { owner: 3 } });
    const page = await client.scanChunksWithOptions({ since: 0n, withData: true, columns: ["n"] });
    assert.equal(page.chunks.length, 1); assert.equal(page.chunks[0].chunk?.metadata?.owner, 3);
    assert.notEqual(page.position, null);
    const raw = await client.getChunkRaw(0, 0);
    assert.ok(raw);
    await client.setChunkRaw(1, 0, raw);
    const area = await client.getAreaWithSchema({ cx0: 0, cy0: 0, cx1: 1, cy1: 0 }, { columns: ["n"] });
    assert.equal(area.entries.length, 2); assert.equal(area.entries[1].chunk.metadata?.owner, 3);
  } finally { await client.close(); await server.stop(); }
});
