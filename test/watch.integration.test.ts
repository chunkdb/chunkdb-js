import test from "node:test";
import assert from "node:assert/strict";

import { ChunkBits, ChunkServerError, connectPool, connectUri, type ChunkChangeEvent, type ChunkClient, type ChunkWatch, type ChunkWatchEvent } from "../src/index";
import { startServer, type StartedServer } from "./helpers";

async function next(watch: ChunkWatch): Promise<ChunkWatchEvent> {
  const event = await watch.next();
  assert.equal(event.done, false);
  return event.value;
}

async function changed(watch: ChunkWatch): Promise<ChunkChangeEvent> {
  const event = await next(watch);
  assert.equal(event.kind, "change");
  return event;
}

async function withWorld(fn: (server: StartedServer, client: ChunkClient) => Promise<void>, tls = false, feedLingerMs?: number): Promise<void> {
  const server = await startServer({ tls, feedLingerMs });
  const client = await connectUri(server.uri, { tlsInsecure: tls });
  try {
    await client.createTable("world", { columns: [{ name: "n", type: "u16", required: true }], chunk: { width: 4, height: 4 } });
    await fn(server, client);
  } finally { await client.close(); await server.stop(); }
}

test("WATCH: ordered typed before/after rows, writer identity and deletion", { timeout: 15000 }, async () => {
  await withWorld(async (server, client) => {
    await client.createTable("typed", { columns: [
      { name: "n", type: "u16", required: true },
      { name: "wide", type: "u64", nullable: true },
      { name: "signed", type: "i64", nullable: true },
      { name: "flag", type: "bool", nullable: true },
      { name: "f", type: "f32", nullable: true },
      { name: "d", type: "f64", nullable: true },
      { name: "bits", type: "bits(9)", nullable: true },
      { name: "text", type: "text(32)", nullable: true },
      { name: "bytes", type: "bytes(16)", nullable: true },
    ], chunk: { width: 4, height: 4 } });
    const watch = await client.watch("typed");
    try {
      const values = { n: 7, wide: 18446744073709551615n, signed: -9007199254740993n, flag: true, f: 1.25, d: 1.125,
        bits: ChunkBits.from("101010101"), text: "hello 🌍", bytes: Buffer.from([0, 255, 13, 10]) };
      const first = await client.setBlock(-1, 2, values, { table: "typed" });
      const a = await changed(watch);
      assert.equal(a.position.revision, first);
      assert.ok(a.position.revision > watch.start.revision);
      assert.equal(a.position.epoch, watch.start.epoch);
      assert.equal(a.user, server.user);
      assert.equal(typeof a.commitTimeMs, "bigint");
      assert.ok(a.commitTimeMs > 0n);
      assert.deepEqual(a.blocks, [{ x: -1n, y: 2n, before: null, after: values }]);
      assert.deepEqual(a.blocks[0].after, await client.getBlock(-1, 2, { table: "typed" }));
      const second = await client.setBlock(-1, 2, { n: 8, text: null }, { table: "typed" });
      const b = await changed(watch);
      assert.equal(b.position.revision, second);
      assert.ok(second > first);
      assert.deepEqual(b.blocks[0].before, values);
      assert.deepEqual(b.blocks[0].after, { ...values, n: 8, text: null });
      const third = await client.deleteBlock(-1, 2, { table: "typed" });
      const c = await changed(watch);
      assert.equal(c.position.revision, third);
      assert.deepEqual(c.blocks[0].before, b.blocks[0].after);
      assert.equal(c.blocks[0].after, null);
    } finally { await watch.close(); }
    assert.equal(await client.ping(), "PONG");
  });
});

test("WATCH: inclusive chunk area clips a transaction", { timeout: 15000 }, async () => {
  await withWorld(async (_, client) => {
    const watch = await client.watch("world", { area: { cx0: -1, cy0: 0, cx1: 0, cy1: 0 } });
    try {
      // This standalone revision is outside the subscribed chunks.
      await client.setBlock(8, 8, { n: 9 }, { table: "world" });
      const revision = await client.transaction(async (tx) => {
        await tx.setBlock(-1, 0, { n: 1 }, { table: "world" });
        await tx.setBlock(3, 3, { n: 2 }, { table: "world" });
        await tx.setBlock(4, 0, { n: 3 }, { table: "world" });
      });
      const event = await changed(watch);
      assert.equal(event.position.revision, revision);
      assert.equal(event.blocks.length, 2);
      assert.deepEqual(event.blocks.map(({ x, y }) => [x, y]).sort(), [[-1n, 0n], [3n, 3n]]);
      assert.deepEqual(event.blocks.map(({ after }) => after!.n).sort(), [1, 2]);
    } finally { await watch.close(); }
  });
});

test("WATCH: default linger resumes changes after the last watch closes", { timeout: 15000 }, async () => {
  await withWorld(async (_, client) => {
    let watch = await client.watch("world");
    try {
      await client.setBlock(0, 0, { n: 1 }, { table: "world" });
      const first = await changed(watch);
      await watch.close();
      const revision = await client.setBlock(0, 0, { n: 2 }, { table: "world" });
      watch = await client.watch("world", { after: first.position });
      assert.deepEqual(watch.start, first.position);
      const resumed = await changed(watch);
      assert.equal(resumed.position.revision, revision);
      assert.deepEqual(resumed.blocks[0].before, { n: 1 });
      assert.deepEqual(resumed.blocks[0].after, { n: 2 });
    } finally { await watch.close(); }
  });
});

test("WATCH: unknown epoch and a released feed require resync", { timeout: 15000 }, async () => {
  await withWorld(async (_, client) => {
    await client.setBlock(0, 0, { n: 1 }, { table: "world" });
    const watch = await client.watch("world", { after: { epoch: "0".repeat(32), revision: 0n } });
    let frontier;
    try {
      const event = await next(watch);
      assert.equal(event.kind, "resync");
      frontier = event.position;
      assert.equal(watch.start.epoch, "0".repeat(32));
      assert.notEqual(event.position.epoch, watch.start.epoch);
      assert.deepEqual(await client.getBlock(0, 0, { table: "world" }), { n: 1 });
      await client.setBlock(0, 0, { n: 2 }, { table: "world" });
      const later = await changed(watch);
      assert.ok(later.position.revision > frontier.revision);
      assert.deepEqual(later.blocks[0].after, { n: 2 });
      frontier = later.position;
    } finally { await watch.close(); }
    await client.setBlock(0, 0, { n: 3 }, { table: "world" });
    const reopened = await client.watch("world", { after: frontier });
    try { assert.equal((await next(reopened)).kind, "resync"); }
    finally { await reopened.close(); }
  }, false, 0);
});

test("WATCH: schema event precedes rows using new columns", { timeout: 15000 }, async () => {
  await withWorld(async (_, client) => {
    const watch = await client.watch("world");
    try {
      await client.alterTable("world", { kind: "addColumn", column: { name: "wide", type: "u64", nullable: true } });
      const schema = await next(watch);
      assert.equal(schema.kind, "schema");
      assert.deepEqual(schema.columns.map(({ name, typeName }) => [name, typeName]), [["n", "u16"], ["wide", "u64"]]);
      await client.setBlock(0, 0, { n: 7, wide: 9007199254740993n }, { table: "world" });
      const event = await changed(watch);
      assert.equal(event.schemaVersion, schema.version);
      assert.ok(event.position.revision > schema.position.revision);
      assert.deepEqual(event.blocks[0].after, { n: 7, wide: 9007199254740993n });
    } finally { await watch.close(); }
  });
});

test("WATCH: TLS authenticates dedicated sockets and pool remains usable after close", { timeout: 15000 }, async () => {
  await withWorld(async (server, client) => {
    const pool = await connectPool({ uri: server.uri, tlsInsecure: true, maxConnections: 1 });
    try {
      const watch = await pool.watch("world");
      try {
        const revision = await client.setBlock(0, 0, { n: 7 }, { table: "world" });
        const event = await changed(watch);
        assert.equal(event.position.revision, revision);
        assert.equal(event.user, server.user);
        assert.deepEqual(event.blocks[0].after, { n: 7 });
        assert.equal(await pool.ping(), "PONG");
      } finally { await watch.close(); }
      assert.equal(await pool.ping(), "PONG");
    } finally { await pool.close(); }
  }, true);
});

test("WATCH: dropped table ends iteration with NO_TABLE", { timeout: 15000 }, async () => {
  await withWorld(async (_, client) => {
    const watch = await client.watch("world");
    try {
      const pending = watch.next();
      await client.dropTable("world");
      await assert.rejects(pending, (error: unknown) => error instanceof ChunkServerError && error.serverCode === "NO_TABLE");
    } finally { await watch.close(); }
    assert.equal(await client.ping(), "PONG");
  });
});
