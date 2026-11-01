import test from "node:test";
import assert from "node:assert/strict";
import type { Socket } from "node:net";
import { connect } from "../src/client";
import { connectPool } from "../src/pool";
import { parseDescribe } from "../src/schema";
import { parseReply } from "../src/protocol";
import { parseFormBlockSpans, parseSectionedForm } from "../src/chunk-sections";
import { encodeSectionedChunk } from "../src/sectioned-chunk";
import { decodeChunkScanPage } from "../src/chunk-scan";
import { ChunkServerError } from "../src/errors";
import { FAKE_HELLO, startFakeServer } from "./fake-server";

const epoch = "a".repeat(32);
const bulk = (value: string | Buffer) => { const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value); return Buffer.concat([Buffer.from(`$${bytes.length}\r\n`), bytes, Buffer.from("\r\n")]); };
const integer = (value: bigint | number) => Buffer.from(`${BigInt(value) > (1n << 63n) - 1n ? "(" : ":"}${value}\r\n`);
const array = (...values: Buffer[]) => Buffer.concat([Buffer.from(`*${values.length}\r\n`), ...values]);
const map = (fields: Record<string, Buffer>) => Buffer.concat([Buffer.from(`%${Object.keys(fields).length}\r\n`), ...Object.entries(fields).flatMap(([name, value]) => [bulk(name), value])]);
const nil = Buffer.from("_\r\n"), bool = (value: boolean) => Buffer.from(value ? "#t\r\n" : "#f\r\n");

function description(dims = 3): Buffer {
  const column = (id: number, name: string, type: string, nullable: boolean, required: boolean, value: Buffer) => map({ id: integer(id), name: bulk(name), type: bulk(type), null: bool(nullable), required: bool(required), default: value });
  return map({ table: bulk("space"), version: integer(7), epoch: bulk(epoch), dims: integer(dims),
    columns: array(column(1, "n", "u8", false, false, integer(0))), chunk_columns: array(column(1, "title", "text(8)", true, true, nil)),
    chunk: dims === 3 ? array(integer(2), integer(2), integer(2)) : array(integer(2), integer(2)),
    large: dims === 3 ? array(integer(8), integer(8), integer(8)) : array(integer(8), integer(8)),
    options: map({ durability_mode: bulk("relaxed"), checkpoint_updates: integer(256), checkpoint_wal_bytes: integer(1048576), wal_group_commit_updates: integer(8),
      checkpoint_compression: bulk("none"), var_max_chunk_bytes: integer(1048576), feed_buffer_bytes: integer(67108864), slot_max_bytes: integer(1073741824) }) });
}

function fixture() {
  const layout = parseDescribe(parseReply(description())!.reply);
  const state = { present: [false, false, false, false, false, true, false, false], columns: { n: [null, null, null, null, null, 9, null, null] }, metadata: { title: "base" } };
  const form = encodeSectionedChunk(layout, state, undefined, { version: 42n, commitTimeMs: 11n });
  return { layout, state, form };
}

test("3D wire methods preserve zero and extreme coordinates across both column domains", async () => {
  const { state, form } = fixture();
  const inTx = new WeakSet<Socket>();
  const server = await startFakeServer(({ line }, socket) => {
    if (line === "HELLO 3") return FAKE_HELLO;
    if (line.startsWith("DESCRIBE")) return description();
    if (line === "BEGIN") { inTx.add(socket); return "+OK\r\n"; }
    if (line === "COMMIT") { inTx.delete(socket); return integer(43); }
    if (line === "ROLLBACK") { inTx.delete(socket); return "+OK\r\n"; }
    if (line.startsWith("GET BLOCK")) return line.includes("WITH VERSION") ? array(integer(9), integer(7), array(integer(3))) : array(integer(3));
    if (line.startsWith("GET CHUNK")) return bulk(form);
    if (line.startsWith("GET AREA")) {
      const rows = array(array(integer(-(1n << 63n)), integer(2), integer(0), bulk(form)));
      return line.includes("WITH SCHEMA") ? array(integer(7), rows) : rows;
    }
    if (line.startsWith("SET") || line.startsWith("DELETE")) return inTx.has(socket) ? nil : integer(8);
    return "+OK\r\n";
  });
  const client = await connect({ port: server.port });
  try {
    await client.getBlock3D(-(1n << 63n), 2, 0, { table: "space" });
    assert.equal(server.requests.at(-1)?.line, "GET BLOCK -9223372036854775808 2 0 FROM space COLUMNS n");
    const metadata = await client.getBlock3DWithMetadata(1, 2, (1n << 63n) - 1n, { table: "space" });
    assert.equal(server.requests.at(-1)?.line, "GET BLOCK 1 2 9223372036854775807 FROM space COLUMNS n WITH VERSION WITH SCHEMA");
    assert.deepEqual(metadata, { version: 9n, schemaVersion: 7n, row: { n: 3 } });
    await client.setBlock3D(1, 2, 0, { n: 4 }, { table: "space", ifVersion: 9n });
    assert.equal(server.requests.at(-1)?.line, "SET BLOCK 1 2 0 IN space n = $1 IF VERSION 9");
    await client.deleteBlock3D(1, 2, -3, { table: "space", ifVersion: 9n });
    assert.equal(server.requests.at(-1)?.line, "DELETE BLOCK 1 2 -3 FROM space IF VERSION 9");
    const chunk = await client.getChunk3D(1, 2, 0, { table: "space" });
    assert.equal(server.requests.at(-1)?.line, "GET CHUNK 1 2 0 FROM space COLUMNS n");
    assert.equal(chunk?.depth, 2);
    assert.deepEqual(chunk?.metadata, { title: "base" });
    assert.deepEqual(await client.getChunkRaw3D(1, 2, 0, { table: "space" }), form);
    await client.setChunk3D(1, 2, 0, state, { table: "space", ifAbsent: true });
    assert.equal(server.requests.at(-1)?.line, "SET CHUNK 1 2 0 IN space $1 IF ABSENT");
    assert.equal(parseSectionedForm(server.requests.at(-1)!.frames[0]!).sections.has(5), true);
    await client.setChunkRaw3D(1, 2, 0, form, { table: "space", ifVersion: 9n });
    assert.equal(server.requests.at(-1)?.line, "SET CHUNK 1 2 0 IN space $1 IF VERSION 9");
    await client.setChunkMetadata3D(1, 2, 0, { title: null }, { table: "space", ifAbsent: true });
    assert.equal(server.requests.at(-1)?.line, "SET CHUNK 1 2 0 IN space META title = $1 IF ABSENT");
    assert.equal(server.requests.at(-1)?.frames[0], null);
    await client.setChunkColumns3D(1, 2, 0, ["n"], { present: state.present, columns: state.columns }, { table: "space", ifVersion: 9n });
    assert.equal(server.requests.at(-1)?.line, "SET CHUNK 1 2 0 IN space COLUMNS n $1 IF VERSION 9");
    const partial = parseSectionedForm(server.requests.at(-1)!.frames[0]!, undefined, true);
    assert.equal(partial.flags, 1);
    assert.equal(partial.sections.has(5), false);
    assert.deepEqual(parseFormBlockSpans(partial, 8)[0].values, Buffer.from([0, 0, 0, 0, 0, 9, 0, 0]));
    const area = await client.getArea3DWithSchema({ cx0: -(1n << 63n), cy0: 0, cz0: 0, cx1: 0, cy1: 2, cz1: 3 }, { table: "space" });
    assert.equal(server.requests.at(-1)?.line, "GET AREA -9223372036854775808 0 0 TO 0 2 3 FROM space COLUMNS n WITH SCHEMA");
    assert.equal(area.schemaVersion, 7n);
    assert.equal(area.entries[0].cx, -(1n << 63n));
    assert.equal(area.entries[0].cz, 0n);
    assert.deepEqual(area.entries[0].chunk.metadata, { title: "base" });
    await client.getAreaRaw3D({ cx: 1, cy: 2, cz: 0, radius: 4 }, { table: "space" });
    assert.equal(server.requests.at(-1)?.line, "GET AREA AROUND 1 2 0 RADIUS 4 FROM space COLUMNS n");
    const before = server.requests.length;
    await assert.rejects(client.setBlock3D(1, 2, undefined as never, { n: 4 }, { table: "space" }), /exact int64/);
    await assert.rejects(client.setBlock3D(Number.MAX_SAFE_INTEGER + 1, 2, 0, { n: 4 }, { table: "space" }), /exact int64/);
    await assert.rejects(client.setBlock3D(1, 2, 1n << 63n, { n: 4 }, { table: "space" }), /exact int64/);
    await assert.rejects(client.setChunk3D(1, 2, 0, state, { table: "space", ifAbsent: true, ifVersion: 1n }), /without ifVersion/);
    await assert.rejects(client.setBlock(1, 2, { n: 4 }, { table: "space", ifAbsent: true }), /chunk write/);
    await assert.rejects(client.setChunkRaw3D(1, 2, 0, Buffer.from([1]), { table: "space" }), /truncated header/);
    assert.equal(server.requests.length, before);
  } finally { await client.close(); await server.close(); }
});

test("3D pool and transaction methods retain their connection and statement shape", async () => {
  const { state, form } = fixture();
  const inTx = new WeakSet<Socket>();
  const server = await startFakeServer(({ line }, socket) => {
    if (line === "HELLO 3") return FAKE_HELLO;
    if (line.startsWith("DESCRIBE")) return description();
    if (line === "BEGIN") { inTx.add(socket); return "+OK\r\n"; }
    if (line === "COMMIT") { inTx.delete(socket); return integer(43); }
    if (line === "ROLLBACK") { inTx.delete(socket); return "+OK\r\n"; }
    if (line.startsWith("GET CHUNK")) return bulk(form);
    if (line.startsWith("GET AREA")) return array(integer(7), array());
    if (line.startsWith("GET BLOCK")) return array(integer(9), integer(7), array(integer(3)));
    return inTx.has(socket) ? nil : integer(8);
  });
  const pool = await connectPool({ port: server.port, maxConnections: 2 });
  try {
    await pool.setBlock3D(1, 2, 0, { n: 4 }, { table: "space" });
    assert.equal(server.requests.at(-1)?.line, "SET BLOCK 1 2 0 IN space n = $1");
    await pool.setChunkMetadata3D(1, 2, 0, { title: "base" }, { table: "space" });
    assert.equal(server.requests.at(-1)?.line, "SET CHUNK 1 2 0 IN space META title = $1");
    assert.equal(await pool.transaction(async (tx) => {
      await tx.setBlock3D(3, 4, 0, { n: 4 }, { table: "space" });
      await tx.getBlock3DWithMetadata(3, 4, 0, { table: "space" });
      await tx.setChunkMetadata3D(3, 4, 0, { title: null }, { table: "space" });
      await tx.setChunkColumns3D(3, 4, 0, ["n"], { present: state.present, columns: state.columns }, { table: "space" });
      await tx.getArea3DWithSchema({ cx0: 0, cy0: 0, cz0: 0, cx1: 1, cy1: 1, cz1: 1 }, { table: "space" });
    }), 43n);
    const lines = server.requests.map(({ line }) => line);
    for (const expected of ["BEGIN", "SET BLOCK 3 4 0 IN space n = $1", "SET CHUNK 3 4 0 IN space META title = $1", "SET CHUNK 3 4 0 IN space COLUMNS n $1", "GET AREA 0 0 0 TO 1 1 1 FROM space COLUMNS n WITH SCHEMA", "COMMIT"]) assert.ok(lines.includes(expected), expected);
  } finally { await pool.close(); await server.close(); }
});

test("3D scan retains independent tombstone versions and a nullable completed frontier", async () => {
  const { form } = fixture();
  let mode = 0;
  const page = (rows: Buffer, position: Buffer, floor = 12n) => map({ chunks: rows, more: bool(false), epoch: bulk(epoch), position, retained_deletion_floor: integer(floor) });
  const server = await startFakeServer(({ line }) => {
    if (line === "HELLO 3") return FAKE_HELLO;
    if (line.startsWith("DESCRIBE")) return description();
    if (mode === 0) return page(array(array(integer(-(1n << 63n)), integer(0), integer(0), integer(41), nil), array(integer(-1), integer(2), integer(0), integer(42), bulk(form))), integer(43));
    if (mode === 1) return page(array(array(integer(1), integer(2), integer(0), integer((1n << 64n) - 1n))), nil, 0n);
    const floor = mode === 3 ? "-1" : mode === 4 ? "18446744073709551616" : "18446744073709551614";
    return `-ERR RESYNC_REQUIRED reason=history_lost floor=${floor} current=18446744073709551615 requested history has been compacted\r\n`;
  });
  const client = await connect({ port: server.port });
  try {
    const options = { table: "space", after: { cx: -(1n << 63n), cy: -1n, cz: 0n }, since: 40n, limit: 2, withData: true, columns: ["n"], epoch };
    const result = await client.scanChunks3D(options);
    assert.equal(server.requests.at(-1)?.line, "SCAN CHUNKS FROM space AFTER -9223372036854775808 -1 0 SINCE 40 LIMIT 2 WITH DATA COLUMNS n");
    assert.equal(result.position, 43n);
    assert.equal(result.retainedDeletionFloor, 12n);
    assert.deepEqual(result.chunks[0], { cx: -(1n << 63n), cy: 0n, cz: 0n, version: 41n, deleted: true, chunk: null });
    assert.equal(result.chunks[1].version, 42n);
    assert.equal(result.chunks[1].deleted, false);
    assert.equal(result.chunks[1].cz, 0n);
    assert.deepEqual(result.chunks[1].chunk?.metadata, { title: "base" });
    mode = 1;
    const readonly = await client.scanChunks3D({ table: "space" });
    assert.equal(readonly.position, null);
    assert.equal(readonly.chunks[0].version, (1n << 64n) - 1n);
    assert.equal(Object.hasOwn(readonly.chunks[0], "deleted"), false);
    mode = 2;
    await assert.rejects(client.scanChunks3D(options), (error) => error instanceof ChunkServerError && error.serverCode === "RESYNC_REQUIRED" && error.reason === "history_lost" && error.floor === (1n << 64n) - 2n && error.current === (1n << 64n) - 1n && error.retryClass === "fatal");
    for (const [invalidMode, floor] of [[3, "-1"], [4, "18446744073709551616"]] as const) {
      mode = invalidMode;
      await assert.rejects(client.scanChunks3D(options), (error) => error instanceof ChunkServerError && error.floor === undefined && error.keys.floor === floor);
    }
  } finally { await client.close(); await server.close(); }
});

for (const pooled of [false, true]) test(`3D ${pooled ? "pooled" : "client"} iterator owns its pagination cursor`, async () => {
  let page = 0;
  const server = await startFakeServer(({ line }) => {
    if (line === "HELLO 3") return FAKE_HELLO;
    if (line.startsWith("DESCRIBE")) return description();
    const next = page++;
    return map({ chunks: array(array(integer(next), integer(0), integer(0), integer(next + 1))),
      more: bool(next === 0), epoch: bulk(epoch), position: integer(2), retained_deletion_floor: integer(0) });
  });
  const client = pooled ? await connectPool({ port: server.port, maxConnections: 1 }) : await connect({ port: server.port });
  try {
    const iterator = client.scanAllChunks3D({ table: "space", limit: 1 });
    const first = await iterator.next();
    assert.equal(first.done, false);
    assert.ok(first.value);
    first.value.cx = 99n; first.value.cy = -99n; first.value.cz = 88n;
    const second = await iterator.next();
    assert.equal(server.requests.at(-1)?.line, "SCAN CHUNKS FROM space AFTER 0 0 0 LIMIT 1");
    assert.deepEqual(second, { done: false, value: { cx: 1n, cy: 0n, cz: 0n } });
    assert.equal((await iterator.next()).done, true);
  } finally { await client.close(); await server.close(); }
});

test("scan decoder refuses stalled cursors, changed lifetimes and broken entry contracts", () => {
  const { layout } = fixture();
  const base = (rows: Buffer, more = false, lifetime = epoch, floor = 2n, position = integer(5)) => parseReply(map({ chunks: rows, more: bool(more), epoch: bulk(lifetime), retained_deletion_floor: integer(floor), position }))!.reply;
  const row = array(integer(1), integer(2), integer(0), integer(4));
  const options = { dims: 3 as const, since: 3n, withData: false, indexes: [0] };
  assert.throws(() => decodeChunkScanPage(layout, base(array(row)), { ...options, after: [1n, 2n, 0n] }), /advance/);
  assert.throws(() => decodeChunkScanPage(layout, base(array(row), false, "b".repeat(32)), options), /epoch changed/);
  assert.throws(() => decodeChunkScanPage(layout, base(array(row), false, epoch, 4n), options), /retained deletion floor/);
  assert.throws(() => decodeChunkScanPage(layout, base(array(), true), options), /empty scan page/);
  assert.throws(() => decodeChunkScanPage(layout, base(array(array(integer(1), integer(2), integer(4)))), options), /arity/);
  assert.throws(() => decodeChunkScanPage(layout, base(array(array(integer(1), integer(2), integer(0), integer(3)))), options), /revision/);
  assert.throws(() => decodeChunkScanPage(layout, base(array(row), false, epoch, 2n, bulk("bad")), options), /frontier/);
  assert.throws(() => decodeChunkScanPage(layout, base(array(array(integer(1), integer(2), integer(0), integer(4), nil))), { ...options, since: undefined, withData: true }), /ordinary scan/);
});

test("3D WATCH and slot filters retain all six bounds and reject ambiguous arity", async () => {
  const server = await startFakeServer(({ line }) => {
    if (line === "HELLO 3") return FAKE_HELLO;
    if (line.startsWith("DESCRIBE")) return description();
    if (line.startsWith("WATCH")) return `+OK ${epoch} 0\r\n`;
    return "+OK\r\n";
  });
  const client = await connect({ port: server.port });
  try {
    const area3D = { cx0: -1, cy0: -2, cz0: 0, cx1: 3, cy1: 4, cz1: 0 };
    await client.createSlot("space", "reader", { area3D, columns: ["n"], noBefore: true, chunks: true });
    assert.equal(server.requests.at(-1)?.line, "CREATE SLOT 'reader' ON space AREA -1 -2 0 TO 3 4 0 COLUMNS n NO BEFORE CHUNKS");
    const watch = await client.watch("space", { area3D, columns: ["n"], chunks: true });
    assert.equal(server.requests.at(-1)?.line, "WATCH space AREA -1 -2 0 TO 3 4 0 COLUMNS n CHUNKS");
    await watch.close();
    const before = server.requests.length;
    await assert.rejects(client.watch("space", { area: { cx0: 0, cy0: 0, cx1: 1, cy1: 1 }, area3D }), /either two or three/);
    await assert.rejects(client.createSlot("space", "bad", { area3D: { ...area3D, cz0: 1, cz1: 0 } }), /reversed/);
    assert.equal(server.requests.length, before);
  } finally { await client.close(); await server.close(); }
});

test("typed chunk requests defer growth-aware lowered quotas to the server", async () => {
  const server = await startFakeServer(({ line }) => {
    if (line === "HELLO 3") return FAKE_HELLO;
    if (line.startsWith("DESCRIBE")) {
      return map({ table: bulk("space"), version: integer(7), epoch: bulk(epoch), dims: integer(3),
        chunk: array(integer(1), integer(1), integer(1)), large: array(integer(1), integer(1), integer(1)),
        columns: array(map({ id: integer(1), name: bulk("n"), type: bulk("text(1024)"), null: bool(false), required: bool(false), default: bulk("") })),
        chunk_columns: array(map({ id: integer(1), name: bulk("title"), type: bulk("text(1024)"), null: bool(true), required: bool(false), default: nil })),
        options: map({ durability_mode: bulk("relaxed"), checkpoint_updates: integer(256), checkpoint_wal_bytes: integer(1048576), wal_group_commit_updates: integer(8),
          checkpoint_compression: bulk("none"), var_max_chunk_bytes: integer(13), feed_buffer_bytes: integer(67108864), slot_max_bytes: integer(1073741824) }) });
    }
    return integer(8);
  });
  const client = await connect({ port: server.port });
  const state = { present: [true], columns: { n: ["x".repeat(512)] }, metadata: { title: "y".repeat(512) } };
  try {
    await client.setChunk3D(0, 0, 0, state, { table: "space" });
    assert.ok(server.requests.at(-1)!.frames[0]!.length > 1024);
    await client.setChunkColumns3D(0, 0, 0, ["n"], state, { table: "space" });
    assert.ok(server.requests.at(-1)!.frames[0]!.length > 512);
    assert.equal((await client.describe("space")).options.varMaxChunkBytes, 13);
  } finally { await client.close(); await server.close(); }
});
