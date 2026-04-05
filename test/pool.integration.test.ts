import test from "node:test";
import assert from "node:assert/strict";

import { connectPool } from "../src/index";
import { startServer } from "./helpers";

test("ChunkPool handles concurrent authenticated operations against chunkdb_server", async () => {
  const server = await startServer();
  try {
    const pool = await connectPool({
      uri: server.uri,
      maxConnections: 2,
      minConnections: 1,
    });

    const bitsFor = (index: number) => `${String(index % 2).repeat(8)}${String((index + 1) % 2).repeat(8)}`;

    await Promise.all(
      Array.from({ length: 8 }, async (_, index) => {
        await pool.set(index, 0, bitsFor(index));
      }),
    );

    const blocks = await Promise.all(
      Array.from({ length: 8 }, async (_, index) => await pool.readBlock(index, 0)),
    );

    for (const [index, block] of blocks.entries()) {
      assert.deepEqual(block, {
        exists: true,
        bits: bitsFor(index),
      });
    }

    assert.equal(await pool.ping(), "PONG");
    await pool.close();
  } finally {
    await server.stop();
  }
});
