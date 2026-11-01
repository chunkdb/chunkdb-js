import test from "node:test";
import assert from "node:assert/strict";
import { connect, ChunkClient } from "../src/client";
import { connectPool } from "../src/pool";
import { captureAreaPage, decodeAreaPage, rawAreaReplyOptions } from "../src/area-page";
import { parseReply } from "../src/protocol";
import { parseDescribe } from "../src/schema";
import { encodeSectionedChunk } from "../src/sectioned-chunk";
import { serializeSectionedForm } from "../src/chunk-sections";
import { FAKE_HELLO, startFakeServer } from "./fake-server";

const bulk = (value: string | Buffer): Buffer => { const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value); return Buffer.concat([Buffer.from(`$${bytes.length}\r\n`), bytes, Buffer.from("\r\n")]); };
const integer = (value: bigint | number) => Buffer.from(`:${value}\r\n`);
const array = (...items: Buffer[]) => Buffer.concat([Buffer.from(`*${items.length}\r\n`), ...items]);
const map = (items: Record<string, Buffer>) => Buffer.concat([Buffer.from(`%${Object.keys(items).length}\r\n`), ...Object.entries(items).flatMap(([key, value]) => [bulk(key), value])]);
const nil = Buffer.from("_\r\n"), bool = (value: boolean) => Buffer.from(value ? "#t\r\n" : "#f\r\n");
const hello = (maxBytes = 67108864) => FAKE_HELLO.replace("%8\r\n", "%9\r\n").replace(":67108864\r\n", `:${maxBytes}\r\n`) + "$8\r\nfeatures\r\n*1\r\n$11\r\narea_paging\r\n";

function description(dims = 2, columns = 1, blocks = 1): Buffer {
  const column = (id: number) => map({ id: integer(id), name: bulk(columns === 1 ? "n" : `v${id}`), type: bulk(columns === 1 ? "u8" : "text(1)"), null: bool(columns !== 1), required: bool(false), default: nil });
  return map({ table: bulk("t"), version: integer(1), dims: integer(dims), columns: array(...Array.from({ length: columns }, (_, i) => column(i + 1))),
    chunk: array(integer(blocks), integer(1), ...(dims === 3 ? [integer(1)] : [])), large: array(integer(8), integer(8), ...(dims === 3 ? [integer(8)] : [])),
    options: map({ durability_mode: bulk("relaxed"), checkpoint_updates: integer(256), checkpoint_wal_bytes: integer(1048576), wal_group_commit_updates: integer(8), checkpoint_compression: bulk("none"), var_max_chunk_bytes: integer(1048576), feed_buffer_bytes: integer(67108864), slot_max_bytes: integer(1073741824) }) });
}

const page = (rows: Buffer[], more: boolean, after: bigint[] | null) => map({ chunks: array(...rows), more: bool(more), after: after === null ? nil : array(...after.map(integer)) });
const parsed = (wire: Buffer) => parseReply(wire)!.reply;

test("area page validation retains exact axes, empty-cell progress and terminal cursors", () => {
  const min = -(1n << 63n);
  const request = captureAreaPage({ cx0: min, cy0: 0, cx1: min + 2n, cy1: 0 }, { limit: 2 }, 2);
  const progress = decodeAreaPage(parsed(page([], true, [min + 1n, 0n])), request, 2);
  assert.deepEqual(progress.after, [min + 1n, 0n]);
  const resumed = captureAreaPage({ cx0: min, cy0: 0, cx1: min + 2n, cy1: 0 }, { limit: 2, after: { cx: min + 1n, cy: 0 } }, 2);
  assert.equal(decodeAreaPage(parsed(page([], false, null)), resumed, 2).after, null);
  const complete = captureAreaPage({ cx0: min, cy0: 0, cx1: min + 2n, cy1: 0 }, { after: { cx: min + 2n, cy: 0 } }, 2);
  assert.equal(decodeAreaPage(parsed(page([], false, null)), complete, 2).after, null);
  for (const wire of [page([], true, null), page([], false, [min + 1n, 0n]), page([], true, [min + 2n, 0n]), page([], true, [min, 0n, 0n]), page([], false, null),
    page([array(integer(min + 2n), integer(0), bulk(Buffer.alloc(0)))], true, [min + 1n, 0n])]) {
    assert.throws(() => decodeAreaPage(parsed(wire), request, 2), /GET AREA page/);
  }
  const three = captureAreaPage({ cx: 0, cy: 0, cz: 0, radius: 1 }, { limit: 1 }, 3);
  assert.throws(() => decodeAreaPage(parsed(page([], true, [1n, 0n, 1n])), three, 2), /selector/);
  assert.throws(() => captureAreaPage({ cx: 0, cy: 0, cz: 0, radius: 1 }, { after: { cx: 0, cy: 1, cz: 1 } }, 3), /outside/);
  const wide = captureAreaPage({ cx: min, cy: 0, cz: 0, radius: (1n << 63n) - 1n }, { limit: 1 }, 3);
  assert.deepEqual(decodeAreaPage(parsed(page([], true, [min, -((1n << 63n) - 1n), 0n])), wide, 2).after, [min, -((1n << 63n) - 1n), 0n]);
});

test("completed box and Euclidean pages allow populated or empty final rows only with a null cursor", () => {
  for (const dims of [2, 3] as const) for (const around of [false, true]) {
    const area = dims === 2 ? around ? { cx: 0, cy: 0, radius: 1 } : { cx0: 0, cy0: 0, cx1: 1, cy1: 0 }
      : around ? { cx: 0, cy: 0, cz: 0, radius: 1 } : { cx0: 0, cy0: 0, cz0: 0, cx1: 1, cy1: 0, cz1: 0 };
    const limit = around ? dims === 2 ? 5 : 7 : 2;
    const request = captureAreaPage(area, { limit }, dims);
    const point = Array.from({ length: dims }, () => 0n), row = array(...point.map(integer), bulk(Buffer.alloc(0)));
    assert.equal(decodeAreaPage(parsed(page([row], false, null)), request, limit).rows.length, 1);
    assert.equal(decodeAreaPage(parsed(page([], false, null)), request, limit).after, null);
    const last = around ? [1n, 0n, ...(dims === 3 ? [0n] : [])] : [1n, 0n, ...(dims === 3 ? [0n] : [])];
    assert.throws(() => decodeAreaPage(parsed(page([row], false, last)), request, limit), /continuation cursor/);
    assert.throws(() => decodeAreaPage(parsed(page([row], true, last)), request, limit), /remaining cells/);
  }
});

for (const dims of [2, 3] as const) test(`area pages ${dims}D forward exact commands through client, transaction and pool`, async () => {
  const describe = description(dims), layout = parseDescribe(parsed(describe));
  const form = encodeSectionedChunk(layout, { present: [true], columns: { n: [9] } }, undefined, { version: 7n, commitTimeMs: 11n });
  const coord = (x: number) => [BigInt(x), 0n, ...(dims === 3 ? [0n] : [])];
  const server = await startFakeServer(({ line }) => {
    if (line === "HELLO 3") return hello();
    if (line.startsWith("DESCRIBE")) return describe;
    if (line.startsWith("GET AREA")) {
      const after = line.includes(" AFTER ");
      return array(integer(1), page([array(...coord(after ? 3 : 0).map(integer), bulk(form))], !after, after ? null : coord(1)));
    }
    if (line === "COMMIT") return nil;
    return "+OK\r\n";
  });
  const client = await connect({ port: server.port, table: "t" });
  const pool = await connectPool({ port: server.port, table: "t", maxConnections: 1 });
  try {
    if (dims === 2) {
      const area = { cx0: 0n, cy0: 0n, cx1: 3n, cy1: 0n }, after = { cx: 1n, cy: 0n };
      const first = await client.getAreaPage(area, { limit: 2 });
      assert.equal(first.chunks[0].chunk.columns.n[0], 9); assert.deepEqual(first.after, after); assert.equal(first.schemaVersion, 1n);
      const pending = client.getAreaRawPage(area, { after, limit: 2 });
      after.cx = 99n; area.cx1 = 99n;
      const last = await pending;
      assert.equal(server.requests.at(-1)!.line, "GET AREA 0 0 TO 3 0 FROM t COLUMNS n LIMIT 2 AFTER 1 0 WITH SCHEMA");
      assert.deepEqual(last.chunks[0].chunk, form); assert.equal(last.more, false);
      await client.transaction(async (tx) => { assert.equal((await tx.getAreaPage({ cx0: 0, cy0: 0, cx1: 3, cy1: 0 }, { limit: 2 })).more, true); });
      assert.equal((await pool.getAreaRawPage({ cx0: 0, cy0: 0, cx1: 3, cy1: 0 }, { limit: 2 })).chunks.length, 1);
    } else {
      const area = { cx0: 0n, cy0: 0n, cz0: 0n, cx1: 3n, cy1: 0n, cz1: 0n }, after = { cx: 1n, cy: 0n, cz: 0n };
      const first = await client.getAreaPage3D(area, { limit: 2 });
      assert.equal(first.chunks[0].cz, 0n); assert.deepEqual(first.after, after);
      const pending = client.getAreaRawPage3D(area, { after, limit: 2 });
      after.cz = 99n; area.cz1 = 99n;
      const last = await pending;
      assert.equal(server.requests.at(-1)!.line, "GET AREA 0 0 0 TO 3 0 0 FROM t COLUMNS n LIMIT 2 AFTER 1 0 0 WITH SCHEMA");
      assert.deepEqual(last.chunks[0].chunk, form);
      await client.transaction(async (tx) => { assert.equal((await tx.getAreaPage3D({ cx0: 0, cy0: 0, cz0: 0, cx1: 3, cy1: 0, cz1: 0 }, { limit: 2 })).more, true); });
      assert.equal((await pool.getAreaRawPage3D({ cx0: 0, cy0: 0, cz0: 0, cx1: 3, cy1: 0, cz1: 0 }, { limit: 2 })).chunks.length, 1);
    }
    const count = server.requests.length;
    await assert.rejects(client.getAreaPage({ cx0: 0, cy0: 0, cx1: 1, cy1: 0 }, { limit: 0 }), /positive/);
    await assert.rejects(client.getAreaPage3D({ cx: 0, cy: 0, cz: 0, radius: 1 }, { after: { cx: 1, cy: 0, cz: 1 } }), /outside/);
    assert.equal(server.requests.length, count);
  } finally { await pool.close(); await client.close(); await server.close(); }
});

test("unsupported area paging fails before DESCRIBE or data requests", async () => {
  const server = await startFakeServer(({ line }) => line === "HELLO 3" ? FAKE_HELLO : "+PONG\r\n");
  const client = await connect({ port: server.port });
  try {
    await assert.rejects(client.getAreaPage({ cx0: 0, cy0: 0, cx1: 0, cy1: 0 }), /area_paging/);
    assert.deepEqual(server.requests.map(({ line }) => line), ["HELLO 3"]);
  } finally { await client.close(); await server.close(); }
});

test("page limit advertisements are checked before DESCRIBE or data requests", async () => {
  for (const wire of [hello(0), hello().replace(":256\r\n", ":0\r\n"), hello() + ""]) {
    const inconsistent = wire === hello() ? wire.replace("%9\r\n", "%10\r\n") + bulk("limits").toString() + map({ max_area_chunks: integer(1) }).toString() : wire;
    const server = await startFakeServer(({ line }) => line === "HELLO 3" ? inconsistent : "+PONG\r\n");
    const client = await connect({ port: server.port });
    try {
      await assert.rejects(client.getAreaPage({ cx0: 0, cy0: 0, cx1: 0, cy1: 0 }), /positive|inconsistent/);
      assert.deepEqual(server.requests.map(({ line }) => line), ["HELLO 3"]);
      await client.ping();
      assert.equal(server.connections, 1);
    } finally { await client.close(); await server.close(); }
  }
});

test("raw area reply shapes preserve clause-named identifiers", () => {
  for (const [statement, shape] of [
    ["GET AREA 0 0 TO 0 0 FROM after COLUMNS limit", "rows"],
    ["GET AREA 0 0 TO 0 0 FROM t COLUMNS n, after WITH SCHEMA", "schemaRows"],
    ["GET AREA 0 0 TO 0 0 FROM t LIMIT 1", "page"],
    ['GET AREA 0 0 TO 0 0 FROM t COLUMNS "limit","after" AFTER 0 0 WITH SCHEMA', "schemaPage"],
    ['GET AREA -1 0TO 1 0FROM"after"COLUMNS"limit",after LIMIT 1AFTER-1 0WITH SCHEMA', "schemaPage"],
    ["GET AREA-1-2 TO 0 0FROM after COLUMNS limit LIMIT 1AFTER-1-2 WITH SCHEMA", "schemaPage"],
  ] as const) assert.equal(rawAreaReplyOptions(statement).shape, shape);
});

test("raw area arrays and page chunk arrays enforce cardinality at the header", async () => {
  for (const [statement, header] of [
    ["GET AREA 0 0 TO 0 0 FROM after COLUMNS limit", "*2\r\n"],
    ["GET AREA 0 0 TO 0 0 FROM t COLUMNS n, after WITH SCHEMA", "*2\r\n:1\r\n*2\r\n"],
    ["GET AREA 0 0 TO 0 0 FROM t LIMIT 1", "%3\r\n+chunks\r\n*2\r\n"],
    ['GET AREA 0 0 TO 0 0 FROM t COLUMNS "limit","after" AFTER 0 0 WITH SCHEMA', "*2\r\n:1\r\n%3\r\n+chunks\r\n*2\r\n"],
    ["GET AREA-1-2 TO 0 0FROM after COLUMNS limit LIMIT 1AFTER-1-2 WITH SCHEMA", "*2\r\n:1\r\n%3\r\n+chunks\r\n*2\r\n"],
    ['GET AREA -1 0TO 1 0FROM"after"COLUMNS"limit",after LIMIT 1AFTER-1 0WITH SCHEMA', "*2\r\n:1\r\n%3\r\n+chunks\r\n*2\r\n"],
  ] as const) {
    const server = await startFakeServer(({ line }) => line === "HELLO 3" ? hello().replace(":256\r\n", ":1\r\n") : header);
    const client = await connect({ port: server.port, commandTimeoutMs: 1000 });
    try { await assert.rejects(client.execute(statement), /negotiated limit/); }
    finally { await client.close(); await server.close(); }
  }
});

test("oversized area header poisons the socket before waiting for its absent body", async () => {
  const server = await startFakeServer(({ line }) => {
    if (line === "HELLO 3") return hello(80);
    if (line.startsWith("DESCRIBE")) return description();
    if (line.startsWith("GET AREA")) return "*1\r\n*3\r\n:0\r\n:0\r\n$33554432\r\n";
    return "+PONG\r\n";
  });
  const client = new ChunkClient({ port: server.port, table: "t", commandTimeoutMs: 1000 });
  try {
    await assert.rejects(client.getAreaRaw({ cx0: 0, cy0: 0, cx1: 0, cy1: 0 }), /negotiated limit/);
    await client.ping();
    assert.equal(server.connections, 2);
    assert.equal(server.requests.filter(({ line }) => line.startsWith("GET AREA")).length, 1);
  } finally { await client.close(); await server.close(); }
});

test("typed areas preflight the aggregate dense cells, including unpaged and projected reads", async () => {
  const describe = description(2, 1024, 1024);
  const form = (projected: boolean) => serializeSectionedForm({ version: 1n, schemaVersion: 1n, commitTimeMs: 1n, flags: projected ? 1 : 0, sections: new Map([[1, Buffer.alloc(128)], [6, Buffer.alloc(4)]]) });
  const server = await startFakeServer(({ line }) => {
    if (line === "HELLO 3") return hello();
    if (line.startsWith("DESCRIBE")) return describe;
    if (line === "BEGIN" || line === "ROLLBACK") return "+OK\r\n";
    if (line === "COMMIT") return nil;
    if (line === "PING") return "+PONG\r\n";
    const projected = line.includes("COLUMNS v1 ") || line.endsWith("COLUMNS v1");
    const rows = Array.from({ length: 5 }, (_, i) => array(integer(i), integer(0), bulk(form(projected))));
    const value = line.includes(" LIMIT ") ? page(rows, false, null) : array(...rows);
    return line.includes("WITH SCHEMA") ? array(integer(1), value) : value;
  });
  const client = await connect({ port: server.port, table: "t" });
  try {
    const area = { cx0: 0, cy0: 0, cx1: 4, cy1: 0 };
    await assert.rejects(client.getArea(area), /decoded area/);
    await assert.rejects(client.getAreaWithSchema(area), /decoded area/);
    await assert.rejects(client.getAreaPage(area, { limit: 5 }), /decoded area/);
    assert.equal((await client.getAreaPage(area, { limit: 5, columns: ["v1"] })).chunks.length, 5);
    assert.equal((await client.getAreaRaw(area)).length, 5);
    await client.ping();
    await client.transaction(async (tx) => {
      await assert.rejects(tx.getAreaPage(area, { limit: 5 }), /decoded area/);
      assert.equal((await tx.getAreaPage(area, { limit: 5, columns: ["v1"] })).chunks.length, 5);
    });
    assert.equal(server.connections, 1, "local decode admission must preserve its synchronized socket");
  } finally { await client.close(); await server.close(); }
});

for (const mode of ["client", "pool", "transaction"] as const) for (const defect of ["cursor", "envelope", "form"] as const) test(`semantic area ${defect} failure closes ${mode} socket without committing`, async () => {
  let peerClosed!: () => void;
  const closed = new Promise<void>((resolve) => { peerClosed = resolve; });
  let staged = 0, applied = 0;
  const server = await startFakeServer(({ line }, socket) => {
    if (line === "HELLO 3") return hello();
    if (line.startsWith("DESCRIBE")) return description();
    if (line === "BEGIN" || line === "ROLLBACK") return "+OK\r\n";
    if (line.startsWith("SET BLOCK")) { staged += 1; return nil; }
    if (line === "COMMIT") { applied += staged; return nil; }
    if (line.startsWith("GET BLOCK")) return array(integer(1));
    if (line.startsWith("GET AREA")) {
      socket.once("close", peerClosed);
      if (defect === "envelope") return array(integer(1));
      return array(integer(1), defect === "cursor" ? page([], true, null) : page([array(integer(0), integer(0), bulk(Buffer.from("invalid form")))], false, null));
    }
    return "+PONG\r\n";
  });
  const owner = mode === "pool" ? await connectPool({ port: server.port, table: "t", maxConnections: 1 }) : await connect({ port: server.port, table: "t" });
  try {
    const area = { cx0: 0, cy0: 0, cx1: 1, cy1: 0 };
    if (mode === "transaction") {
      await assert.rejects(owner.transaction(async (tx) => {
        await tx.setBlock(0, 0, { n: 1 });
        await assert.rejects(tx.getAreaPage(area, { limit: 2 }), /GET AREA|chunk form/);
        await assert.rejects(tx.getBlock(0, 0), /GET AREA|chunk form/);
      }), /GET AREA|chunk form/);
      assert.equal(staged, 1); assert.equal(applied, 0);
      assert.equal(server.requests.some(({ line }) => line === "COMMIT" || line.startsWith("GET BLOCK")), false);
    } else await assert.rejects(owner.getAreaPage(area, { limit: 2 }), /GET AREA|chunk form/);
    const prior = server.connections;
    await owner.ping();
    assert.equal(server.connections, prior + 1, "the malformed reply socket must not be reused");
    await closed;
  } finally { await owner.close(); await server.close(); }
});

test("a legitimate area schema refresh preserves its connection", async () => {
  let revision = 1;
  const server = await startFakeServer(({ line }) => {
    if (line === "HELLO 3") return hello();
    if (line.startsWith("DESCRIBE")) return description().toString().replace("$7\r\nversion\r\n:1\r\n", `$7\r\nversion\r\n:${revision}\r\n`);
    if (line.startsWith("GET AREA")) { revision = 2; return array(integer(2), page([], false, null)); }
    return "+PONG\r\n";
  });
  const client = await connect({ port: server.port, table: "t" });
  try {
    const result = await client.getAreaPage({ cx0: 0, cy0: 0, cx1: 0, cy1: 0 });
    assert.equal(result.schemaVersion, 2n); assert.equal(server.connections, 1);
    assert.equal(server.requests.filter(({ line }) => line.startsWith("DESCRIBE")).length, 2);
  } finally { await client.close(); await server.close(); }
});

test("pooled area pages copy selector, cursor and projection before waiting for a lease", async () => {
  const describe = description(), layout = parseDescribe(parsed(describe));
  const form = encodeSectionedChunk(layout, { present: [true], columns: { n: [9] } });
  const server = await startFakeServer(({ line }) => line === "HELLO 3" ? hello() : line.startsWith("DESCRIBE") ? describe
    : array(integer(1), page([array(integer(3), integer(0), bulk(form))], false, null)));
  const pool = await connectPool({ port: server.port, table: "t", maxConnections: 1 });
  let acquired!: () => void, release!: () => void;
  const held = new Promise<void>((resolve) => { acquired = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const lease = pool.withClient(async () => { acquired(); await gate; });
  try {
    await held;
    const area = { cx0: 0, cy0: 0, cx1: 3, cy1: 0 }, after = { cx: 1, cy: 0 }, columns = ["n"];
    const pending = pool.getAreaPage(area, { limit: 2, after, columns });
    area.cx1 = 99; after.cx = 99; columns[0] = "missing";
    release(); await lease;
    assert.equal((await pending).chunks[0].cx, 3n);
    assert.equal(server.requests.at(-1)!.line, "GET AREA 0 0 TO 3 0 FROM t COLUMNS n LIMIT 2 AFTER 1 0 WITH SCHEMA");
  } finally { release(); await lease; await pool.close(); await server.close(); }
});
