import test from "node:test";
import assert from "node:assert/strict";
import { ChunkClient, ChunkPool, ChunkProtocolError, parseReply } from "../src/index";
import { aggregateFunctions, aggregateSelector, parseAggregate, parseAggregateRows, parseMigrations, parseTableStats, userLimitsClause } from "../src/statements";
import { filterClause } from "../src/watch";
import { FAKE_HELLO, startFakeServer } from "./fake-server";

const bulk = (text: string) => `$${Buffer.byteLength(text)}\r\n${text}\r\n`;
const map = (fields: Record<string, string>) => `%${Object.keys(fields).length}\r\n${Object.entries(fields).map(([key, value]) => bulk(key) + value).join("")}`;
const parsed = (wire: string) => parseReply(Buffer.from(wire))!.reply;
const EPOCH = "0123456789abcdef0123456789abcdef";

test("AGGREGATE statements cover chunk, box and ball selectors in two and three dimensions", () => {
  assert.equal(aggregateSelector({ chunk: [1, -2] }), "CHUNK 1 -2");
  assert.equal(aggregateSelector({ chunk: [1n, 2, -(1n << 63n)] }), "CHUNK 1 2 -9223372036854775808");
  assert.equal(aggregateSelector({ cx0: 0, cy0: 0, cx1: 1, cy1: 0 }), "AREA 0 0 TO 1 0");
  assert.equal(aggregateSelector({ cx0: 0, cy0: 0, cz0: 0, cx1: 1, cy1: 1, cz1: 2n }), "AREA 0 0 0 TO 1 1 2");
  assert.equal(aggregateSelector({ cx: 0, cy: 1, radius: 2 }), "AREA AROUND 0 1 RADIUS 2");
  assert.equal(aggregateSelector({ cx: 0, cy: 1, cz: 2, radius: 3 }), "AREA AROUND 0 1 2 RADIUS 3");
  assert.throws(() => aggregateSelector({ cx: 0, cy: 0, radius: -1 }), ChunkProtocolError);
  assert.throws(() => aggregateSelector({ chunk: [1] as unknown as [number, number] }), ChunkProtocolError);
  assert.equal(aggregateFunctions([{ fn: "count" }, { fn: "sum", column: "h" }, { fn: "avg", column: "d" }]), "COUNT(*), SUM(h), AVG(d)");
  assert.throws(() => aggregateFunctions([]), ChunkProtocolError);
  assert.throws(() => aggregateFunctions([{ fn: "sum", column: "H;" }]), ChunkProtocolError);
  assert.throws(() => aggregateFunctions([{ fn: "median" } as never]), ChunkProtocolError);
});

test("AGGREGATE replies keep exact integers, doubles and nulls", () => {
  const result = parseAggregate(parsed(map({ "count(*)": ":3\r\n", "sum(u)": "(36893488147419103230\r\n", "avg(d)": ",1.5\r\n", "min(d)": "_\r\n" })), 4);
  assert.deepEqual(result, { "count(*)": 3n, "sum(u)": 36893488147419103230n, "avg(d)": 1.5, "min(d)": null });
  assert.deepEqual(Object.keys(result), ["count(*)", "sum(u)", "avg(d)", "min(d)"]);
  assert.throws(() => parseAggregate(parsed(map({ "count(*)": ":3\r\n" })), 2), ChunkProtocolError);
  assert.throws(() => parseAggregate(parsed(map({ "count(*)": bulk("3") })), 1), ChunkProtocolError);
  assert.throws(() => parseAggregate(parsed("*0\r\n"), 1), ChunkProtocolError);
  const rows = parseAggregateRows(parsed("*2\r\n*4\r\n:0\r\n:0\r\n:2\r\n:17\r\n*5\r\n:1\r\n:0\r\n:-4\r\n:1\r\n_\r\n"), 2);
  assert.deepEqual(rows, [{ cx: 0n, cy: 0n, values: [2n, 17n] }, { cx: 1n, cy: 0n, cz: -4n, values: [1n, null] }]);
  assert.deepEqual(parseAggregateRows(parsed("*0\r\n"), 1), []);
  assert.throws(() => parseAggregateRows(parsed("*1\r\n*2\r\n:0\r\n:0\r\n"), 1), ChunkProtocolError);
  assert.throws(() => parseAggregateRows(parsed("*1\r\n*3\r\n,0.5\r\n:0\r\n:1\r\n"), 1), ChunkProtocolError);
});

test("statement helpers decode stats and migrations and check limits", () => {
  assert.deepEqual(parseTableStats(parsed(map({ epoch: bulk(EPOCH), revision: "_\r\n", dims: ":3\r\n", tombstones: ":2\r\n", retained_deletion_floor: ":18446744073709551615\r\n" }))),
    { epoch: EPOCH, revision: null, dims: 3, tombstones: 2n, retainedDeletionFloor: (1n << 64n) - 1n });
  assert.throws(() => parseTableStats(parsed(map({ epoch: bulk(EPOCH), revision: ":1\r\n", dims: ":4\r\n", tombstones: ":0\r\n", retained_deletion_floor: ":0\r\n" }))), ChunkProtocolError);
  assert.deepEqual(parseMigrations(parsed(`*1\r\n${map({ name: bulk("m1"), applied_ms: ":5\r\n", user: "_\r\n", statement: bulk("DROP TABLE t") })}`)),
    [{ name: "m1", appliedMs: 5n, user: null, statement: "DROP TABLE t" }]);
  assert.throws(() => parseMigrations(parsed(`*1\r\n${map({ name: bulk("m1") })}`)), ChunkProtocolError);
  assert.equal(userLimitsClause({ maxConnections: 4, statementsPerSec: 200 }), "LIMIT max_connections = 4, statements_per_sec = 200");
  assert.equal(userLimitsClause({ statementsPerSec: 0 }), "LIMIT statements_per_sec = 0");
  assert.throws(() => userLimitsClause({}), ChunkProtocolError);
  assert.throws(() => userLimitsClause({ statementsPerSec: 65537 }), ChunkProtocolError);
  assert.throws(() => userLimitsClause({ maxConnections: -1 }), ChunkProtocolError);
});

test("WATCH takes several areas in two or three dimensions", () => {
  assert.equal(filterClause({ areas: [{ cx0: 0, cy0: 0, cx1: 1, cy1: 1 }, { cx0: 5, cy0: -2, cx1: 6, cy1: -1 }] }), " AREA 0 0 TO 1 1, AREA 5 -2 TO 6 -1");
  assert.equal(filterClause({ areas3D: [{ cx0: 0, cy0: 0, cz0: 0, cx1: 1, cy1: 1, cz1: 1 }, { cx0: 2, cy0: 2, cz0: 2, cx1: 2, cy1: 2, cz1: 2 }], chunks: true }),
    " AREA 0 0 0 TO 1 1 1, AREA 2 2 2 TO 2 2 2 CHUNKS");
  assert.equal(filterClause({ area: { cx0: 0, cy0: 0, cx1: 1, cy1: 1 } }), " AREA 0 0 TO 1 1");
  assert.throws(() => filterClause({ areas: [] }), ChunkProtocolError);
  assert.throws(() => filterClause({ areas: Array.from({ length: 65 }, () => ({ cx0: 0, cy0: 0, cx1: 0, cy1: 0 })) }), ChunkProtocolError);
  assert.throws(() => filterClause({ area: { cx0: 0, cy0: 0, cx1: 0, cy1: 0 }, areas: [{ cx0: 0, cy0: 0, cx1: 0, cy1: 0 }] }), ChunkProtocolError);
  assert.throws(() => filterClause({ areas: [{ cx0: 1, cy0: 0, cx1: 0, cy1: 0 }] }), ChunkProtocolError);
});

test("client and pool send the statement helpers and decode their replies", async () => {
  const server = await startFakeServer(({ line }) => {
    switch (line) {
      case "HELLO 3": return FAKE_HELLO;
      case "AGGREGATE AREA 0 0 TO 1 0 FROM t COUNT(*), SUM(h)": return map({ "count(*)": ":3\r\n", "sum(h)": ":14\r\n" });
      case "AGGREGATE CHUNK 0 0 FROM t COUNT(*) BY CHUNK": return "*1\r\n*3\r\n:0\r\n:0\r\n:2\r\n";
      case "SHOW TABLE STATS t": return map({ epoch: bulk(EPOCH), revision: ":7\r\n", dims: ":2\r\n", tombstones: ":1\r\n", retained_deletion_floor: ":0\r\n" });
      case "COMPACT TOMBSTONES t BEFORE 7": return ":7\r\n";
      case "RECOVER TABLE t": case "SWAP TABLES t, u": case "RELOAD TLS": case "ALTER USER bot LIMIT max_connections = 4": return "+OK\r\n";
      case "BACKUP TO 'snap'": return map({ tables: ":1\r\n", files: ":2\r\n", bytes: ":3\r\n", cuts: `*1\r\n${map({ table: bulk("t"), epoch: bulk(EPOCH), revision: ":7\r\n" })}` });
      case "RESTORE TABLE t FROM 'snap' AS t2": return map({ table: bulk("t2"), epoch: bulk(EPOCH), parent_epoch: bulk(EPOCH), fork_revision: ":7\r\n", files: ":2\r\n", bytes: ":3\r\n" });
      case "SHOW MIGRATIONS": return "*0\r\n";
      default: throw new Error(`unexpected ${line}`);
    }
  });
  const client = new ChunkClient({ port: server.port, table: "t" });
  const pool = new ChunkPool({ port: server.port, table: "t", maxConnections: 1 });
  try {
    for (const c of [client, pool]) {
      assert.deepEqual(await c.aggregate({ cx0: 0, cy0: 0, cx1: 1, cy1: 0 }, [{ fn: "count" }, { fn: "sum", column: "h" }]), { "count(*)": 3n, "sum(h)": 14n });
      assert.deepEqual(await c.aggregateByChunk({ chunk: [0, 0] }, [{ fn: "count" }]), [{ cx: 0n, cy: 0n, values: [2n] }]);
      assert.deepEqual(await c.tableStats("t"), { epoch: EPOCH, revision: 7n, dims: 2, tombstones: 1n, retainedDeletionFloor: 0n });
      assert.equal(await c.compactTombstones("t", 7n), 7n);
      await c.recoverTable("t");
      await c.swapTables("t", "u");
      await c.reloadTls();
      await c.setUserLimits("bot", { maxConnections: 4 });
      assert.deepEqual(await c.backup("snap"), { tables: 1n, files: 2n, bytes: 3n, cuts: [{ table: "t", epoch: EPOCH, revision: 7n }] });
      assert.deepEqual(await c.restoreTable("t", "snap", { as: "t2" }), { table: "t2", epoch: EPOCH, parentEpoch: EPOCH, forkRevision: 7n, files: 2n, bytes: 3n });
      assert.deepEqual(await c.listMigrations(), []);
    }
    await assert.rejects(client.compactTombstones("t", -1n), ChunkProtocolError);
    await assert.rejects(client.backup("a\nb"), ChunkProtocolError);
  } finally {
    await client.close();
    await pool.close();
    await server.close();
  }
});
