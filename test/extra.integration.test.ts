import test from "node:test";
import assert from "node:assert/strict";

import { ChunkServerError, connectPool, connectUri, type ChunkClient } from "../src/index";
import { startServer } from "./helpers";

// The test server runs two workers, one per open connection: each test keeps
// at most two connections open at a time.

function serverError(code: string, message?: RegExp) {
  return (error: unknown) =>
    error instanceof ChunkServerError && error.code === code && (message === undefined || message.test(error.serverMessage));
}

function value(bitLength: number, bytes: number[] | Buffer) {
  return { bitLength, bytes: Buffer.from(bytes) };
}

// 4x4 blocks of 4 bits per chunk: block (x, y) has index
// (y mod 4) * 4 + (x mod 4) in chunk (floor(x / 4), floor(y / 4)).
async function createThings(client: ChunkClient, options: { extraMaxChunkBytes?: number } = {}): Promise<void> {
  await client.createTable("things", {
    blockBits: 4,
    chunkWidthBlocks: 4,
    chunkHeightBlocks: 4,
    extraMaxBlockBits: 64,
    ...options,
  });
}

test("extra data: table options, xget/xput/xdel and the block rules", async () => {
  const server = await startServer();
  try {
    const client = await connectUri(server.uri);
    const hello = client.serverInfo()!;
    assert.ok(hello.capabilities.includes("extra-data"));
    assert.equal(hello.maxExtraChunkBytes, 16777216);
    assert.equal(hello.table!.extraMaxBlockBits, 0);
    assert.equal(hello.table!.extraMaxChunkBytes, 0);

    // Tables start without extra data; refused commands keep the connection.
    await client.set(0, 0, "1".repeat(16));
    await assert.rejects(client.xget(0, 0), serverError("INVALID_ARGUMENT", /extra data is not enabled on table 'default'/));
    await assert.rejects(client.xput(0, 0, value(3, [5])), serverError("INVALID_ARGUMENT", /not enabled/));
    await assert.rejects(client.xdel(0, 0), serverError("INVALID_ARGUMENT", /not enabled/));
    await assert.rejects(client.getChunkState(0, 0, { extra: true }), serverError("INVALID_ARGUMENT", /not enabled/));
    await assert.rejects(
      client.chunkBatch(0, 0, [{ type: "xput", x: 0, y: 0, bits: "1" }]),
      serverError("INVALID_ARGUMENT", /not enabled/),
    );
    // The server reads and drops the bytes of a refused CHUNKPUT ... EXTRA.
    const plain = await client.getChunkState(0, 0);
    await assert.rejects(
      client.putChunkState(0, 0, { ...plain, extra: new Map([[0, value(3, [5])]]) }),
      serverError("INVALID_ARGUMENT", /not enabled/),
    );
    assert.equal(await client.ping(), "PONG");

    await createThings(client);
    const info = await client.tableInfo("things");
    assert.equal(info.extraMaxBlockBits, 64);
    assert.equal(info.extraMaxChunkBytes, 65536);
    await client.close();

    const things = await connectUri(server.uri.replace(/\/$/, "/things"));
    assert.equal(things.serverInfo()!.table!.extraMaxBlockBits, 64);

    // A value belongs to a present block.
    await assert.rejects(things.xput(5, -3, value(3, [5])), serverError("INVALID_ARGUMENT"));
    await things.set(5, -3, "1010");
    const before = await things.chunkVersion(1, -1);
    await things.xput(5, -3, value(12, [0xab, 0xfc]));
    // Padding bits are ignored on input and zero on output.
    assert.deepEqual(await things.xget(5, -3), value(12, [0xab, 0x0c]));
    assert.notEqual(await things.chunkVersion(1, -1), before);
    await things.xput(5, -3, Buffer.from("label"));
    assert.deepEqual(await things.xget(5, -3), value(40, Buffer.from("label")));
    assert.equal(await things.xget(6, -3), null);

    await assert.rejects(things.xput(5, -3, value(65, new Array(9).fill(1))), serverError("INVALID_ARGUMENT", /extra_max_block_bits \(64\)/));
    assert.equal(await things.ping(), "PONG");

    // SET keeps the value, UNSET deletes it, XDEL deletes it and succeeds
    // also when there is none.
    await things.set(5, -3, "0000");
    assert.deepEqual(await things.xget(5, -3), value(40, Buffer.from("label")));
    await things.xdel(5, -3);
    assert.equal(await things.xget(5, -3), null);
    const unchanged = await things.chunkVersion(1, -1);
    await things.xdel(5, -3);
    assert.equal(await things.chunkVersion(1, -1), unchanged);
    await things.xput(5, -3, value(1, [1]));
    await things.unset(5, -3);
    await things.set(5, -3, "1111");
    assert.equal(await things.xget(5, -3), null);
    await things.close();
  } finally {
    await server.stop();
  }
});

test("extra data: chunk state reads and writes carry the values", async () => {
  const server = await startServer();
  try {
    const admin = await connectUri(server.uri);
    await createThings(admin);
    await admin.close();
    const client = await connectUri(server.uri.replace(/\/$/, "/things"));

    // Chunk (-1, -1): block (-1, -1) has index 15, block (-4, -1) index 12.
    await client.mset([
      { x: -1, y: -1, bits: "1000" },
      { x: -4, y: -1, bits: "0100" },
    ]);
    await client.xput(-1, -1, value(12, [0xab, 0x0c]));
    await client.xput(-4, -1, value(3, [0x05]));

    const state = await client.getChunkState(-1, -1, { extra: true });
    assert.equal(state.exists, true);
    assert.deepEqual([...state.extra.keys()], [12, 15]);
    assert.deepEqual(state.extra.get(15), value(12, [0xab, 0x0c]));
    assert.deepEqual(state.extra.get(12), value(3, [0x05]));
    assert.deepEqual(await client.getChunkState(-1, -1, { extra: true, zrle: true }), state);
    const { extra: _, ...plain } = state;
    assert.deepEqual(await client.getChunkState(-1, -1), plain);
    assert.equal((await client.getChunkState(9, 9, { extra: true })).extra.size, 0);

    // Writing back what was read changes nothing, so the version stays.
    const version = await client.chunkVersion(-1, -1);
    assert.deepEqual(await client.putChunkState(-1, -1, state), { ok: true, version });

    // With extra, the values are replaced as a whole.
    const replaced = await client.putChunkState(-1, -1, { ...state, extra: new Map([[12, value(16, [1, 2])]]) });
    assert.equal(replaced.ok, true);
    assert.equal(await client.xget(-1, -1), null);
    assert.deepEqual(await client.xget(-4, -1), value(16, [1, 2]));

    // Without extra, blocks that stay present keep theirs, the others lose
    // them. Presence bit 12 is bit 4 of byte 1, bit 15 bit 7.
    await client.xput(-1, -1, value(2, [3]));
    const onlyLast = { payload: state.payload, presence: Buffer.from([0x00, 0x80]) };
    await client.putChunkState(-1, -1, onlyLast);
    assert.deepEqual(await client.xget(-1, -1), value(2, [3]));
    assert.equal(await client.get(-4, -1), null);
    assert.equal(await client.xget(-4, -1), null);

    // A value for a block the new state has absent is refused.
    await assert.rejects(
      client.putChunkState(-1, -1, { ...onlyLast, extra: new Map([[12, value(1, [1])]]) }),
      serverError("INVALID_ARGUMENT"),
    );
    assert.equal(await client.ping(), "PONG");

    // ZRLE and IF work with EXTRA.
    const current = await client.chunkVersion(-1, -1);
    const sparse = { payload: Buffer.alloc(8), presence: onlyLast.presence, extra: new Map([[15, value(64, new Array(8).fill(0))]]) };
    assert.deepEqual(await client.putChunkState(-1, -1, sparse, { ifVersion: current - 1n, zrle: true }), {
      ok: false,
      version: current,
    });
    assert.equal((await client.putChunkState(-1, -1, sparse, { ifVersion: current, zrle: true })).ok, true);
    assert.deepEqual(await client.xget(-1, -1), value(64, new Array(8).fill(0)));

    // CHUNKBATCH applies XPUT and XDEL in order with SET and UNSET.
    await client.chunkBatch(-1, -1, [
      { type: "set", x: -4, y: -1, bits: "1111" },
      { type: "xput", x: -4, y: -1, bits: "101" },
      { type: "xdel", x: -1, y: -1 },
    ]);
    assert.deepEqual(await client.xget(-4, -1), value(3, [0x05]));
    assert.equal(await client.xget(-1, -1), null);
    // A batch whose XPUT targets an unset block fails as a whole.
    await assert.rejects(
      client.chunkBatch(-1, -1, [
        { type: "xdel", x: -4, y: -1 },
        { type: "xput", x: -3, y: -1, bits: "1" },
      ]),
      serverError("INVALID_ARGUMENT"),
    );
    assert.deepEqual(await client.xget(-4, -1), value(3, [0x05]));
    await client.close();
  } finally {
    await server.stop();
  }
});

test("extra data: limits only grow, and reads are bounded by the server's cap", async () => {
  const server = await startServer();
  try {
    const admin = await connectUri(server.uri);
    await createThings(admin, { extraMaxChunkBytes: 1024 });
    await assert.rejects(admin.setTableOptions("things", { extraMaxBlockBits: 32 }), serverError("INVALID_ARGUMENT", /only be raised/));
    await assert.rejects(admin.setTableOptions("things", { extraMaxBlockBits: 0 }), serverError("INVALID_ARGUMENT", /cannot be disabled/));

    // The reader saw extra_max_chunk_bytes 1024; another connection raises
    // it and stores a larger value, which the reader still reads.
    const reader = await connectUri(server.uri.replace(/\/$/, "/things"));
    assert.equal(reader.serverInfo()!.table!.extraMaxChunkBytes, 1024);
    await admin.setTableOptions("things", { extraMaxBlockBits: 800_000, extraMaxChunkBytes: 1_048_576 });
    await admin.use("things");
    await admin.set(1, 1, "0001");
    const large = Buffer.alloc(100_000, 0x5a);
    await admin.xput(1, 1, large);

    for (const zrle of [false, true]) {
      const state = await reader.getChunkState(0, 0, { extra: true, zrle });
      assert.deepEqual(state.extra.get(5), value(800_000, large));
    }
    assert.deepEqual(await reader.xget(1, 1), value(800_000, large));
    await reader.close();
    await admin.close();
  } finally {
    await server.stop();
  }
});

test("extra data: a pool and a pipelined client", async () => {
  const server = await startServer();
  try {
    const admin = await connectUri(server.uri);
    await createThings(admin);
    await admin.close();
    const uri = server.uri.replace(/\/$/, "/things");

    const pool = await connectPool({ uri, maxConnections: 2 });
    await pool.set(0, 0, "0001");
    await pool.xput(0, 0, value(7, [0x7f]));
    assert.deepEqual(await pool.xget(0, 0), value(7, [0x7f]));
    const state = await pool.getChunkState(0, 0, { extra: true });
    assert.deepEqual([...state.extra.keys()], [0]);
    await pool.xdel(0, 0);
    assert.equal(await pool.xget(0, 0), null);
    await pool.close();

    const client = await connectUri(uri, { pipelineDepth: 8 });
    const blocks = Array.from({ length: 32 }, (_, i) => ({ x: i, y: -i, bits: "1001" }));
    await client.mset(blocks);
    await Promise.all(blocks.map(async ({ x, y }, i) => await client.xput(x, y, value(i + 1, Buffer.alloc(Math.ceil((i + 1) / 8), 1)))));
    const values = await Promise.all(blocks.map(async ({ x, y }) => await client.xget(x, y)));
    for (const [i, read] of values.entries()) {
      assert.deepEqual(read, value(i + 1, Buffer.alloc(Math.ceil((i + 1) / 8), 1)));
    }
    await client.close();
  } finally {
    await server.stop();
  }
});

test("extra data: pipelined requests reach the server in call order", async () => {
  const server = await startServer();
  try {
    const admin = await connectUri(server.uri);
    await createThings(admin);
    await admin.close();
    const client = await connectUri(server.uri.replace(/\/$/, "/things"), { pipelineDepth: 4 });
    const bytes = (await client.getChunk(0, 0)).length;
    for (let i = 0; i < 20; i++) {
      // Each pair is called without awaiting the first: the read sees the write.
      const fill = i % 2 === 0 ? 0xff : 0x00;
      const [, bits] = await Promise.all([client.putChunk(0, 0, Buffer.alloc(bytes, fill)), client.get(0, 0)]);
      assert.equal(bits, fill === 0xff ? "1111" : "0000");
      const [, read] = await Promise.all([client.xput(0, 0, value(8, [i])), client.xget(0, 0)]);
      assert.deepEqual(read, value(8, [i]));
      const [, gone] = await Promise.all([client.xdel(0, 0), client.xget(0, 0)]);
      assert.equal(gone, null);
    }
    // Character n of batch bits is bit n: "110" is 0x03.
    await client.chunkBatch(0, 0, [{ type: "xput", x: 1, y: 0, bits: "110" }]);
    assert.deepEqual(await client.xget(1, 0), value(3, [0x03]));
    await client.close();
  } finally {
    await server.stop();
  }
});
