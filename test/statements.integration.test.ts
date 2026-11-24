import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { connectPool, connectUri, type ChunkChangeEvent, type ChunkWatch } from "../src/index";
import { startServer } from "./helpers";

async function changed(watch: ChunkWatch): Promise<ChunkChangeEvent> {
  while (true) {
    const event = await watch.next();
    assert.equal(event.done, false);
    if (event.value.kind === "resync") throw new Error("watch needs state rebuild");
    if (event.value.kind === "change") return event.value;
  }
}

for (const tls of [false, true]) {
  test(`statements: AGGREGATE maps, BY CHUNK rows and big sums over ${tls ? "TLS" : "plain TCP"}`, { timeout: 20000 }, async () => {
    const server = await startServer({ tls });
    const client = await connectUri(`${server.uri}agg`, { tlsInsecure: tls });
    const pool = await connectPool({ uri: `${server.uri}agg`, tlsInsecure: tls, maxConnections: 2 });
    try {
      await client.createTable("agg", { columns: [{ name: "h", type: "i16" }, { name: "u", type: "u64", nullable: true }, { name: "d", type: "f64", nullable: true }], chunk: { width: 2, height: 2 } });
      const max = (1n << 64n) - 1n;
      await client.setBlock(0, 0, { h: 12, u: max, d: 1.5 });
      await client.setBlock(1, 0, { h: 5, u: max });
      await client.setBlock(2, 0, { h: -3, d: 0.5 });
      const functions = [{ fn: "count" }, { fn: "sum", column: "h" }, { fn: "sum", column: "u" }, { fn: "max", column: "u" }, { fn: "min", column: "h" }, { fn: "avg", column: "d" }] as const;
      for (const c of [client, pool]) {
        const result = await c.aggregate({ cx0: 0, cy0: 0, cx1: 1, cy1: 0 }, functions);
        assert.deepEqual(result, { "count(*)": 3n, "sum(h)": 14n, "sum(u)": 2n * max, "max(u)": max, "min(h)": -3n, "avg(d)": 1 });
        assert.deepEqual(Object.keys(result), ["count(*)", "sum(h)", "sum(u)", "max(u)", "min(h)", "avg(d)"]);
        assert.deepEqual(await c.aggregateByChunk({ cx0: 0, cy0: 0, cx1: 1, cy1: 0 }, [{ fn: "count" }, { fn: "sum", column: "h" }]),
          [{ cx: 0n, cy: 0n, values: [2n, 17n] }, { cx: 1n, cy: 0n, values: [1n, -3n] }]);
        assert.deepEqual(await c.aggregate({ chunk: [5, 5] }, [{ fn: "count" }, { fn: "sum", column: "h" }]), { "count(*)": 0n, "sum(h)": null });
        assert.deepEqual(await c.aggregate({ cx: 0, cy: 0, radius: 1 }, [{ fn: "count" }]), { "count(*)": 3n });
      }
      await client.transaction(async (tx) => {
        await tx.setBlock(3, 0, { h: 1 });
        assert.deepEqual(await tx.aggregate({ chunk: [1, 0] }, [{ fn: "count" }]), { "count(*)": 2n });
        assert.deepEqual(await tx.aggregateByChunk({ chunk: [1, 0] }, [{ fn: "max", column: "h" }]), [{ cx: 1n, cy: 0n, values: [1n] }]);
      });
    } finally { await pool.close(); await client.close(); await server.stop(); }
  });
}

test("statements: three-dimensional AGGREGATE rows carry cz", { timeout: 15000 }, async () => {
  const server = await startServer();
  const client = await connectUri(`${server.uri}cube`);
  try {
    await client.createTable("cube", { columns: [{ name: "n", type: "u8" }], chunk: { width: 2, height: 2, depth: 2 } });
    await client.setBlock3D(0, 0, 2, { n: 4 });
    assert.deepEqual(await client.aggregateByChunk({ cx0: 0, cy0: 0, cz0: 0, cx1: 0, cy1: 0, cz1: 1 }, [{ fn: "sum", column: "n" }]), [{ cx: 0n, cy: 0n, cz: 1n, values: [4n] }]);
    assert.deepEqual(await client.aggregate({ chunk: [0, 0, 1] }, [{ fn: "count" }]), { "count(*)": 1n });
    assert.deepEqual(await client.aggregate({ cx: 0, cy: 0, cz: 0, radius: 1 }, [{ fn: "count" }]), { "count(*)": 1n });
  } finally { await client.close(); await server.stop(); }
});

test("statements: WATCH with several areas keeps changes inside any of them", { timeout: 15000 }, async () => {
  const server = await startServer();
  const client = await connectUri(`${server.uri}world`);
  try {
    await client.createTable("world", { columns: [{ name: "n", type: "u8" }], chunk: { width: 2, height: 2 } });
    const watch = await client.watch("world", { areas: [{ cx0: 0, cy0: 0, cx1: 0, cy1: 0 }, { cx0: 5, cy0: 5, cx1: 5, cy1: 5 }] });
    try {
      await client.setBlock(0, 0, { n: 1 });
      await client.setBlock(4, 0, { n: 2 });
      const last = await client.setBlock(10, 10, { n: 3 });
      assert.deepEqual((await changed(watch)).blocks.map(({ x, y }) => [x, y]), [[0n, 0n]]);
      const second = await changed(watch);
      assert.equal(second.position.revision, last);
      assert.deepEqual(second.blocks.map(({ x, y }) => [x, y]), [[10n, 10n]]);
    } finally { await watch.close(); }
  } finally { await client.close(); await server.stop(); }
});

test("statements: table stats, tombstone compaction, swap, recover refusal, limits and migrations", { timeout: 15000 }, async () => {
  const server = await startServer();
  const client = await connectUri(server.uri);
  try {
    await client.createTable("a", { columns: [{ name: "n", type: "u8" }], chunk: { width: 2, height: 2 } });
    await client.createTable("b", { columns: [{ name: "label", type: "u16" }], chunk: { width: 2, height: 2 } });
    await client.setBlock(0, 0, { n: 1 }, { table: "a" });
    const deleted = await client.deleteBlock(0, 0, { table: "a" });
    const stats = await client.tableStats("a");
    assert.match(stats.epoch, /^[0-9a-f]{32}$/);
    assert.equal(stats.dims, 2);
    assert.ok(stats.revision !== null && stats.revision >= deleted);
    const floor = await client.compactTombstones("a", deleted + 1n);
    assert.ok(floor <= deleted + 1n);
    const compacted = await client.tableStats("a");
    assert.equal(compacted.tombstones, 0n);
    assert.equal(compacted.retainedDeletionFloor, floor);

    assert.equal((await client.describe("a")).columns[0].name, "n");
    await client.swapTables("a", "b");
    assert.equal((await client.describe("a")).columns[0].name, "label");
    assert.equal((await client.describe("b")).columns[0].name, "n");
    await assert.rejects(client.recoverTable("a"), /not fenced/);

    await client.createUser("bot", "bot password 1");
    await client.setUserLimits("bot", { maxConnections: 4, statementsPerSec: 200 });
    await client.setUserLimits("bot", { statementsPerSec: 0 });

    await client.migrate([{ name: "m1", statement: "CREATE TABLE mt (a u8)" }]);
    const migrations = await client.listMigrations();
    assert.equal(migrations.length, 1);
    assert.equal(migrations[0].name, "m1");
    assert.equal(migrations[0].user, server.user);
    assert.equal(migrations[0].statement, "CREATE TABLE mt (a u8)");
    assert.ok(migrations[0].appliedMs > 0n);
  } finally { await client.close(); await server.stop(); }
});

test("statements: BACKUP TO, RESTORE TABLE and RELOAD TLS", { timeout: 20000 }, async () => {
  const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), "chunkdb-node-statements-"));
  const server = await startServer({ tls: true, backupDir });
  const client = await connectUri(server.uri, { tlsInsecure: true });
  const pool = await connectPool({ uri: server.uri, tlsInsecure: true, maxConnections: 1 });
  try {
    await client.createTable("world", { columns: [{ name: "n", type: "u8" }], chunk: { width: 2, height: 2 } });
    const revision = await client.setBlock(1, 1, { n: 9 }, { table: "world" });
    const backup = await client.backup("snap");
    assert.equal(backup.tables, 1n);
    assert.ok(backup.files > 0n && backup.bytes > 0n);
    assert.equal(backup.cuts.length, 1);
    assert.equal(backup.cuts[0].table, "world");
    assert.ok(backup.cuts[0].revision >= revision);
    const restored = await pool.restoreTable("world", "snap", { as: "copy" });
    assert.equal(restored.table, "copy");
    assert.equal(restored.parentEpoch, backup.cuts[0].epoch);
    assert.equal(restored.forkRevision, backup.cuts[0].revision);
    assert.deepEqual(await client.getBlock(1, 1, { table: "copy" }), { n: 9 });
    await client.reloadTls();
    await pool.reloadTls();
  } finally { await pool.close(); await client.close(); await server.stop(); fs.rmSync(backupDir, { recursive: true, force: true }); }
});
