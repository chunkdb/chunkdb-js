import test from "node:test";
import assert from "node:assert/strict";

import { connectPool } from "../src/index";
import { startServer } from "./helpers";

test("ChunkPool runs concurrent typed operations against chunkdb_server", async () => {
  const server = await startServer();
  try {
    const pool = await connectPool({ uri: `${server.uri}cells`, maxConnections: 2, minConnections: 1 });
    await pool.createTable("cells", {
      columns: [
        { name: "n", type: "u16" },
        { name: "label", type: "text(8)", nullable: true },
      ],
      chunk: { width: 8, height: 8 },
    });
    await Promise.all(Array.from({ length: 16 }, async (_, i) => await pool.setBlock(i, 0, { n: i, label: `c${i}` })));
    const rows = await Promise.all(Array.from({ length: 16 }, async (_, i) => await pool.getBlock(i, 0)));
    rows.forEach((row, i) => assert.deepEqual(row, { n: i, label: `c${i}` }));
    assert.equal(await pool.getBlock(16, 0), null);

    // A table statement through the pool clears every pooled connection's
    // cached schema.
    await pool.alterTable("cells", { kind: "renameColumn", column: "label", to: "name" });
    const renamed = await Promise.all(Array.from({ length: 6 }, async (_, i) => await pool.getBlock(i, 0)));
    renamed.forEach((row, i) => assert.deepEqual(row, { n: i, name: `c${i}` }));

    const chunks = [];
    for await (const coord of pool.scanAllChunks({ limit: 1 })) {
      chunks.push(coord);
    }
    assert.deepEqual(chunks, [{ cx: 0, cy: 0 }, { cx: 1, cy: 0 }]);
    assert.equal((await pool.getChunk(1, 0)).columns.name[0], "c8");
    assert.equal(await pool.ping(), "PONG");
    await pool.close();
  } finally {
    await server.stop();
  }
});
