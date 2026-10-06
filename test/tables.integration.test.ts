import test from "node:test";
import assert from "node:assert/strict";

import { ChunkServerError, connectPool, connectUri } from "../src/index";
import { startServer } from "./helpers";

function serverError(code: string) {
  return (error: unknown) => error instanceof ChunkServerError && error.code === code;
}

test("tables: create, select, use their geometry, change options, drop", async () => {
  const server = await startServer();
  try {
    const client = await connectUri(server.uri);
    assert.equal(client.currentTable(), "default");
    assert.deepEqual(await client.tables(), ["default"]);

    await client.createTable("terrain", {
      blockBits: 4,
      chunkWidthBlocks: 8,
      chunkHeightBlocks: 2,
      durabilityMode: "fsync-wal",
    });
    await assert.rejects(client.createTable("terrain", { blockBits: 4 }), serverError("TABLE_EXISTS"));
    await assert.rejects(client.createTable("Bad", { blockBits: 4 }), serverError("INVALID_ARGUMENT"));
    assert.deepEqual(await client.tables(), ["default", "terrain"]);

    const info = await client.tableInfo("terrain");
    assert.equal(info.name, "terrain");
    assert.equal(info.blockBits, 4);
    assert.equal(info.chunkWidthBlocks, 8);
    assert.equal(info.chunkHeightBlocks, 2);
    assert.equal(info.largeChunkWidthChunks, 8);
    assert.equal(info.durabilityMode, "fsync-wal");
    assert.equal(info.storeId.length, 32);

    // A handle is its own connection on the table.
    const terrain = await client.table("terrain");
    assert.equal(terrain.currentTable(), "terrain");
    await terrain.set(1, 1, "1010");
    await client.set(1, 1, "1111000011110000");
    assert.equal(await terrain.get(1, 1), "1010");
    assert.equal(await client.get(1, 1), "1111000011110000");

    // Binary chunk sizes follow the table's geometry: 8x2 blocks of 4 bits.
    const payload = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
    await terrain.setChunkBin(3, 3, payload);
    assert.deepEqual(await terrain.chunkbin(3, 3), payload);
    const state = await terrain.chunkbinState(3, 3);
    assert.equal(state.length, 8 + 2);

    // use() switches this connection.
    const used = await client.use("terrain");
    assert.equal(used.blockBits, 4);
    assert.equal(client.currentTable(), "terrain");
    assert.equal(await client.get(1, 1), "1010");
    assert.match(client.uri(), /\/terrain$/);
    await assert.rejects(client.use("missing"), serverError("NO_TABLE"));
    assert.equal(client.currentTable(), "terrain");
    assert.equal((await client.info()).values.table, "terrain");

    await client.setTableOptions("terrain", { checkpointUpdates: 3, checkpointCompression: "zrle" });
    const changed = await client.tableInfo("terrain");
    assert.equal(changed.checkpointUpdates, 3);
    assert.equal(changed.checkpointCompression, "zrle");
    assert.equal(await terrain.get(1, 1), "1010");

    // A drop reaches every connection on the table.
    await client.use("default");
    await client.dropTable("terrain");
    await assert.rejects(terrain.get(1, 1), serverError("NO_TABLE"));
    assert.deepEqual(await client.tables(), ["default"]);

    await terrain.close();
    await client.close();
  } finally {
    await server.stop();
  }
});

test("tables: the URI path selects the table, also for a pool", async () => {
  // The test server runs two workers, one per open connection: keep at most
  // two connections open at a time.
  const server = await startServer();
  try {
    const admin = await connectUri(server.uri);
    await admin.createTable("sky", { blockBits: 2, chunkWidthBlocks: 4, chunkHeightBlocks: 4 });
    await admin.close();

    const uri = server.uri.replace(/\/$/, "/sky");
    const client = await connectUri(uri);
    assert.equal(client.currentTable(), "sky");
    await client.set(0, 0, "11");
    await client.close();

    const pool = await connectPool({ uri, maxConnections: 2, minConnections: 2 });
    await Promise.all([pool.set(1, 0, "01"), pool.set(2, 0, "10")]);
    assert.equal(await pool.get(0, 0), "11");
    assert.equal(await pool.get(2, 0), "10");
    await pool.close();

    const onDefault = await connectUri(server.uri);
    assert.equal(await onDefault.get(0, 0), "0".repeat(16));
    await onDefault.close();

    await assert.rejects(connectUri(server.uri.replace(/\/$/, "/missing")), serverError("NO_TABLE"));
    await assert.rejects(connectUri(server.uri.replace(/\/$/, "/missing")), serverError("NO_TABLE"));
    // The failed handshakes closed their sockets: both workers are free.
    const first = await connectUri(server.uri);
    const second = await connectUri(server.uri);
    assert.equal(await second.ping(), "PONG");
    await first.close();
    await second.close();
  } finally {
    await server.stop();
  }
});
