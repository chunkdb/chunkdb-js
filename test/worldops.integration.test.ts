import test from "node:test";
import assert from "node:assert/strict";

import { connectPool, connectUri } from "../src/index";
import { startServer } from "./helpers";

const BITS = 16;
const ONES = "1".repeat(BITS);
const CHUNK_BLOCKS = 16 * 16;
const PAYLOAD_BYTES = (CHUNK_BLOCKS * BITS) / 8;
const PRESENCE_BYTES = CHUNK_BLOCKS / 8;

test("chunkScan enumerates populated chunks with cursor continuation", async () => {
  const server = await startServer();
  try {
    const client = await connectUri(server.uri);

    await client.set(0, 0, ONES); // chunk (0,0)
    await client.set(-1, -1, ONES); // chunk (-1,-1)
    await client.set(40, 0, ONES); // chunk (2,0)

    const all = await client.chunkScan(16);
    assert.equal(all.nextCursor, null);
    assert.deepEqual(all.coords, [
      { cx: -1, cy: -1 },
      { cx: 0, cy: 0 },
      { cx: 2, cy: 0 },
    ]);

    const first = await client.chunkScan(2);
    assert.ok(first.nextCursor !== null);
    assert.equal(first.coords.length, 2);
    const rest = await client.chunkScan(2, first.nextCursor!);
    assert.equal(rest.nextCursor, null);
    assert.deepEqual(rest.coords, [{ cx: 2, cy: 0 }]);

    await client.close();
  } finally {
    await server.stop();
  }
});

test("chunkRange returns exact state for populated chunks only", async () => {
  const server = await startServer();
  try {
    const client = await connectUri(server.uri);

    await client.set(0, 0, ONES);
    await client.set(-16, -16, ONES); // chunk (-1,-1)

    const entries = await client.chunkRange(-1, -1, 1, 1);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].cx, -1);
    assert.equal(entries[0].cy, -1);
    assert.equal(entries[0].presence.length, PRESENCE_BYTES);
    assert.equal(entries[0].payload.length, PAYLOAD_BYTES);
    assert.equal(entries[1].cx, 0);
    assert.equal(entries[1].cy, 0);
    assert.equal(entries[1].presence[0], 0b00000001);
    assert.deepEqual(entries[1].payload.subarray(0, 2), Buffer.from([0xff, 0xff]));

    // The ZRLE transfer decodes to the same entries, each as getChunkState
    // returns it.
    assert.deepEqual(await client.chunkRange(-1, -1, 1, 1, { zrle: true }), entries);
    const state = await client.getChunkState(0, 0);
    assert.deepEqual(entries[1].payload, state.payload);
    assert.deepEqual(entries[1].presence, state.presence);

    await client.close();
  } finally {
    await server.stop();
  }
});

test("chunkRadius returns populated chunks within a chunk-space disc", async () => {
  const server = await startServer();
  try {
    const client = await connectUri(server.uri);

    await client.set(0, 0, ONES); // chunk (0,0)
    await client.set(16, 0, ONES); // chunk (1,0)
    await client.set(0, -16, ONES); // chunk (0,-1)
    await client.set(32, 32, ONES); // chunk (2,2) - outside radius 1

    const within = await client.chunkRadius(0, 0, 1);
    const coords = within.map((e) => `${e.cx},${e.cy}`).sort();
    assert.deepEqual(coords, ["0,-1", "0,0", "1,0"]);
    assert.ok(within.every((e) => e.payload.length === PAYLOAD_BYTES));
    assert.deepEqual(await client.chunkRadius(0, 0, 1, { zrle: true }), within);

    await client.close();
  } finally {
    await server.stop();
  }
});

test("ChunkPool mirrors the new world and concurrency operations", async () => {
  const server = await startServer();
  const pool = await connectPool({ uri: server.uri, maxConnections: 2 });
  try {
    await pool.set(0, 0, ONES);

    const version = await pool.chunkVersion(0, 0);
    assert.equal(typeof version, "bigint");

    const range = await pool.chunkRange(0, 0, 0, 0);
    assert.equal(range.length, 1);

    const radius = await pool.chunkRadius(0, 0, 0);
    assert.equal(radius.length, 1);

    const scan = await pool.chunkScan(16);
    assert.deepEqual(scan.coords, [{ cx: 0, cy: 0 }]);

    await pool.walFlush();
    const metrics = await pool.metrics();
    assert.ok(metrics.includes("chunkdb_commands_total"));

    const put = await pool.putChunk(1, 0, Buffer.alloc(PAYLOAD_BYTES, 0x0f), { zrle: true });
    assert.equal(put.ok, true);
    assert.deepEqual(await pool.getChunk(1, 0, { zrle: true }), Buffer.alloc(PAYLOAD_BYTES, 0x0f));
    assert.equal((await pool.getChunkState(1, 0)).exists, true);
    assert.equal(await pool.get(2, 0), null);
    assert.deepEqual(await pool.mget([{ x: 0, y: 0 }]), [ONES]);
  } finally {
    await pool.close();
    await server.stop();
  }
});

test("chunkVersion, putChunkState ifVersion, and chunkBatch enforce versions", async () => {
  const server = await startServer();
  try {
    const client = await connectUri(server.uri);

    await client.set(0, 0, ONES);
    const version = await client.chunkVersion(0, 0);
    assert.ok(version > 0n);

    const state = { payload: Buffer.alloc(PAYLOAD_BYTES), presence: Buffer.alloc(PRESENCE_BYTES, 0xff) };
    const cas = await client.putChunkState(0, 0, state, { ifVersion: version });
    assert.equal(cas.ok, true);
    assert.notEqual(cas.version, version);

    const stale = await client.putChunkState(0, 0, state, { ifVersion: version });
    assert.equal(stale.ok, false);
    assert.equal(stale.version, cas.version);
    // ZRLE upload with a stale version is refused the same way.
    const staleZrle = await client.putChunk(0, 0, state.payload, { ifVersion: version, zrle: true });
    assert.deepEqual(staleZrle, { ok: false, version: cas.version });
    await assert.rejects(client.putChunk(0, 0, state.payload, { ifVersion: -1n }), /unsigned 64-bit/);

    const batch = await client.chunkBatch(
      0,
      0,
      [
        { type: "set", x: 0, y: 0, bits: ONES },
        { type: "unset", x: 1, y: 1 },
      ],
      { ifVersion: cas.version },
    );
    assert.equal(batch.ok, true);
    assert.equal(await client.get(0, 0), ONES);
    assert.equal(await client.get(1, 1), null);

    const staleBatch = await client.chunkBatch(0, 0, [{ type: "unset", x: 0, y: 0 }], {
      ifVersion: cas.version,
    });
    assert.equal(staleBatch.ok, false);
    assert.equal(await client.get(0, 0), ONES);

    await client.close();
  } finally {
    await server.stop();
  }
});

test("walFlush, metrics, and compressed chunk reads work end to end", async () => {
  const server = await startServer();
  try {
    const client = await connectUri(server.uri);

    await client.set(0, 0, ONES);
    await client.walFlush();

    const metrics = await client.metrics();
    assert.ok(metrics.includes("chunkdb_wal_barriers_total 1"));
    assert.ok(metrics.includes("# TYPE chunkdb_command_duration_seconds histogram"));

    assert.deepEqual(await client.getChunk(0, 0, { zrle: true }), await client.getChunk(0, 0));
    assert.deepEqual(await client.getChunkState(0, 0, { zrle: true }), await client.getChunkState(0, 0));

    await client.close();
  } finally {
    await server.stop();
  }
});
