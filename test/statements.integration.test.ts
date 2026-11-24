import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ChunkCheckFailedError, ChunkConditionFailedError, ChunkInvalidArgumentError, ChunkNoTableError, ChunkOutOfRangeError, connectPool, connectUri, expr, type ChunkChangeEvent, type ChunkWatch } from "../src/index";
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

test("statements: IF conditions, computed values and WHERE filters", { timeout: 20000 }, async () => {
  const server = await startServer();
  const client = await connectUri(`${server.uri}wallet`);
  const pool = await connectPool({ uri: `${server.uri}wallet`, maxConnections: 1 });
  try {
    await client.createTable("wallet", { columns: [{ name: "coins", type: "u16" }, { name: "kind", type: "u8" }], chunk: { width: 2, height: 2 } });
    await client.setBlock(0, 0, { coins: 5, kind: 1 });
    const version = await client.setBlock(0, 0, { coins: expr("coins + $1") }, { args: [{ column: "coins", value: 3 }] });
    assert.deepEqual(await client.getBlock(0, 0), { coins: 8, kind: 1 });
    await assert.rejects(
      client.setBlock(0, 0, { coins: expr("coins - $1") }, { condition: "coins >= $2", args: [{ column: "coins", value: 10 }, { column: "coins", value: 10 }] }),
      (error: unknown) => error instanceof ChunkConditionFailedError && error.current === version,
    );
    await client.setBlock(0, 0, { kind: 2 }, { condition: "coins = $1", args: [{ column: "coins", value: 8 }] });
    assert.deepEqual(await client.getBlock(0, 0), { coins: 8, kind: 2 });
    await client.setBlock(6, 0, { coins: 1, kind: 4 });
    await assert.rejects(client.setBlock(0, 0, { coins: expr("coins - $1") }, { args: [{ column: "coins", value: 9 }] }), ChunkOutOfRangeError);

    const where = { text: "kind > $1", args: [{ column: "kind", value: 2 }] };
    for (const c of [client, pool]) {
      assert.deepEqual(await c.aggregate({ cx0: 0, cy0: 0, cx1: 3, cy1: 0 }, [{ fn: "count" }, { fn: "sum", column: "coins" }], { where }), { "count(*)": 1n, "sum(coins)": 1n });
      assert.deepEqual(await c.aggregateByChunk({ cx0: 0, cy0: 0, cx1: 3, cy1: 0 }, [{ fn: "count" }], { where }), [{ cx: 3n, cy: 0n, values: [1n] }]);
      const first = await c.scanChunksWithOptions({ limit: 1, where });
      assert.deepEqual([first.chunks, first.more, first.after], [[], true, { cx: 0, cy: 0 }]);
      const next = await c.scanChunksWithOptions({ after: first.after, where, withData: true });
      assert.deepEqual([next.chunks.map(({ cx, cy }) => [cx, cy]), next.more, next.after], [[[3, 0]], false, undefined]);
    }

    await client.transaction(async (tx) => {
      await tx.setBlock(0, 0, { coins: expr("coins + $1") }, { condition: "kind = $2", args: [{ column: "coins", value: 1 }, { column: "kind", value: 2 }] });
    });
    assert.deepEqual(await client.getBlock(0, 0), { coins: 9, kind: 2 });
    await assert.rejects(client.deleteBlock(6, 0, { condition: "kind = $1", args: [{ column: "kind", value: 9 }] }), ChunkConditionFailedError);
    await client.deleteBlock(6, 0, { condition: "kind = $1", args: [{ column: "kind", value: 4 }] });
    assert.equal(await client.getBlock(6, 0), null);
  } finally { await pool.close(); await client.close(); await server.stop(); }
});

test("statements: SHOW STATUS, TABLE STATS and SLOTS fields", { timeout: 15000 }, async () => {
  const server = await startServer();
  const client = await connectUri(`${server.uri}fields`);
  try {
    await client.createTable("fields", { columns: [{ name: "n", type: "u8" }], chunk: { width: 2, height: 2 } });
    await client.setBlock(0, 0, { n: 1 });
    await client.setBlock(4, 0, { n: 1 });
    const status = await client.showStatus();
    assert.equal(status.version, client.serverInfo()?.serverVersion);
    assert.equal(status.readOnly, false);
    assert.equal(typeof status.uptimeMs, "bigint");
    assert.deepEqual(status.fenced, []);
    const table = status.tables.find(({ name }) => name === "fields");
    assert.deepEqual([table?.state, table?.reason], ["ok", null]);
    const stats = await client.tableStats("fields");
    assert.deepEqual([stats.chunks, stats.slots, stats.watches], [2n, 0n, 0n]);
    assert.ok((stats.files ?? 0n) > 0n && (stats.diskBytes ?? 0n) > 0n);
    for (const name of ["app_one", "app_two", "other"]) await client.createSlot("fields", name);
    const slots = await client.listSlots("fields", "app_");
    assert.deepEqual(slots.map(({ name }) => name).sort(), ["app_one", "app_two"]);
    for (const slot of slots) {
      assert.equal(slot.attached, false);
      assert.equal(typeof slot.revision, "bigint");
      assert.equal(typeof slot.lagRevisions, "bigint");
    }
    assert.equal((await client.tableStats("fields")).slots, 3n);
    await assert.rejects(client.listSlots("fields", "bad'name"), /slot name/);
  } finally { await client.close(); await server.stop(); }
});

test("statements: RETURNING, read-only transactions, checks, column attributes and rename", { timeout: 20000 }, async () => {
  const server = await startServer();
  const client = await connectUri(`${server.uri}wallet`);
  try {
    await client.createTable("wallet", { columns: [{ name: "coins", type: "u16" }, { name: "note", type: "text(8)", nullable: true }], chunk: { width: 2, height: 2 } });
    await client.setBlock(0, 0, { coins: 5 });
    const old = await client.setBlockReturning(0, 0, { coins: expr("coins + $1") }, { args: [{ column: "coins", value: 2 }], returning: { old: true, columns: ["coins"] } });
    assert.deepEqual([old.applied, old.rows], [true, [{ x: 0n, y: 0n, values: { coins: 5 } }]]);
    const refused = await client.setBlockReturning(0, 0, { coins: 0 }, { condition: "coins > $1", args: [{ column: "coins", value: 100 }] });
    assert.deepEqual([refused.applied, refused.rows, refused.version], [false, [], old.version]);
    const fresh = await client.setBlockReturning(3, 3, { coins: 1 });
    assert.deepEqual(fresh.rows, [{ x: 3n, y: 3n, values: { coins: 1, note: null } }]);
    const deleted = await client.deleteBlockReturning(3, 3, { returning: { old: true, columns: ["coins"] } });
    assert.deepEqual(deleted.rows[0].values, { coins: 1 });
    await assert.rejects(client.deleteBlockReturning(3, 3), /returning\.old/);

    await client.transaction(async (tx) => { assert.deepEqual(await tx.getBlock(0, 0, { columns: ["coins"] }), { coins: 7 }); }, { readOnly: true });
    await assert.rejects(client.transaction(async (tx) => { await tx.setBlock(0, 0, { coins: 1 }); }, { readOnly: true }), ChunkInvalidArgumentError);

    await client.alterTable("wallet", { kind: "addCheck", name: "coins_cap", condition: "coins <= 100" });
    await assert.rejects(client.setBlock(0, 0, { coins: 101 }), ChunkCheckFailedError);
    await client.alterTable("wallet", { kind: "setDefault", column: "note", value: "none" });
    await client.alterTable("wallet", { kind: "setRequired", column: "coins", required: true });
    const schema = await client.describe("wallet");
    assert.deepEqual([schema.checks?.map(({ name }) => name), schema.columns[1].default, schema.columns[0].required], [["coins_cap"], "none", true]);
    await client.alterTable("wallet", { kind: "dropDefault", column: "note" });
    await client.alterTable("wallet", { kind: "setRequired", column: "coins", required: false });
    await client.alterTable("wallet", { kind: "setNullable", column: "coins", nullable: true });
    await client.alterTable("wallet", { kind: "dropCheck", name: "coins_cap" });
    await client.alterTable("wallet", { kind: "dropCheck", name: "coins_cap", ifExists: true });
    await client.alterTable("wallet", { kind: "renameTable", to: "purse" });
    assert.deepEqual(await client.getBlock(0, 0, { table: "purse", columns: ["coins"] }), { coins: 7 });
    await assert.rejects(client.getBlock(0, 0, { table: "wallet" }), ChunkNoTableError);
  } finally { await client.close(); await server.stop(); }
});
