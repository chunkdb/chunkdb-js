import test from "node:test";
import assert from "node:assert/strict";
import {
  ChunkClient, ChunkPool, ChunkProtocolError, ChunkServerError, ChunkVersionMismatchError,
  ChunkSchemaMismatchError, ChunkOutcomeUnknownError, ChunkUnknownColumnTypeError,
  countParameters, encodeStatement, parseReply, retryClassOf, type ChunkReply,
} from "../src/index";
import { ReplyReader } from "../src/protocol";
import { parseSlots } from "../src/slots";
import { parseDescribe, parseServerInfo, parseStatus } from "../src/schema";
import { valueFromReply } from "../src/values";
import { decodeChunkForm } from "../src/chunk-form";
import { describeReply, FAKE_HELLO, startFakeServer } from "./fake-server";

const bulk = (value: string): ChunkReply => ({ type: "bulk", value: Buffer.from(value) });
const integer = (value: bigint): ChunkReply => ({ type: "integer", value });
const map = (fields: Record<string, ChunkReply>): ChunkReply => ({ type: "map", entries: Object.entries(fields).map(([key, value]) => [bulk(key), value]) });
const array = (...items: ChunkReply[]): ChunkReply => ({ type: "array", items });
const parsed = (wire: string) => parseReply(Buffer.from(wire))!.reply;
function addFields(reply: ChunkReply, fields: Record<string, ChunkReply>): ChunkReply {
  assert.equal(reply.type, "map");
  reply.entries.push(...Object.entries(fields).map(([key, value]): [ChunkReply, ChunkReply] => [bulk(key), value]));
  return reply;
}

export function encode(reply: ChunkReply): string {
  switch (reply.type) {
    case "bulk": return `$${reply.value.length}\r\n${reply.value.toString("latin1")}\r\n`;
    case "simple": return `+${reply.value}\r\n`;
    case "integer": return `${reply.value < -(1n << 63n) || reply.value >= 1n << 63n ? "(" : ":"}${reply.value}\r\n`;
    case "boolean": return `#${reply.value ? "t" : "f"}\r\n`;
    case "null": return "_\r\n";
    case "double": return `,${reply.value}\r\n`;
    case "array": case "push": return `${reply.type === "array" ? "*" : ">"}${reply.items.length}\r\n${reply.items.map(encode).join("")}`;
    case "map": return `%${reply.entries.length}\r\n${reply.entries.map(([key, value]) => encode(key) + encode(value)).join("")}`;
    case "error": return `-ERR ${reply.code} ${reply.message}\r\n`;
  }
}

test("foundation: lexical occurrence count ignores all quoted forms and drains invalid indices", () => {
  for (const [line, count] of [
    ["bad $1 $1", 2], ["bad $3", 1], ["bad $0 $999999999999999999999999", 2],
    ["bad '$9' x'123$8' b'01$7' \"$6\" $2 $1", 2],
    ["bad 'a''$9' \"a\"\"$8\" $1", 1], ["bad '$1 unterminated $2", 0],
    ['bad "$1 unterminated $2', 0], ["bad $abc $$ $", 0],
  ] as const) assert.equal(countParameters(line), count, line);
  assert.throws(() => encodeStatement("bad $1 $1", [null]), /2 parameter occurrences/);
  const wire = encodeStatement("bad $2 $1", [Buffer.from("first"), Buffer.from("second")]);
  assert.equal(wire.toString(), "bad $2 $1\r\n$5\r\nfirst\r\n$6\r\nsecond\r\n");
});

test("foundation: RESP3 big numbers and signed/JSON exactness boundaries survive every split", () => {
  for (const value of [-(1n << 127n), -(1n << 63n), -9007199254740992n, -9007199254740991n, 9007199254740991n, 9007199254740992n, (1n << 63n) - 1n, 1n << 63n, (1n << 64n) - 1n]) {
    const wire = Buffer.from(`(${value}\r\n`);
    for (let split = 0; split < wire.length; split++) {
      assert.equal(parseReply(wire.subarray(0, split)), null);
      const reader = new ReplyReader();
      reader.push(wire.subarray(0, split)); assert.equal(reader.next(), null);
      reader.push(wire.subarray(split)); assert.deepEqual(reader.next(), integer(value));
      assert.equal(reader.next(), null);
    }
  }
  for (const text of ["(", "(1.5\r\n", "(+1\r\n", "(\r\n"]) {
    if (text === "(") assert.equal(parseReply(Buffer.from(text)), null);
    else assert.throws(() => parseReply(Buffer.from(text)), ChunkProtocolError);
  }
});

test("foundation: code alone classifies errors; percent keys and unknown diagnostics remain exact", () => {
  for (const [code, classification] of [
    ["VERSION_MISMATCH", "reread"], ["SCHEMA_MISMATCH", "reread"], ["CONDITION_FAILED", "reread"],
    ["CONFLICT", "rerun"], ["BUSY", "backoff"], ["DISK_FULL", "backoff"], ["RATE_LIMITED", "backoff"],
    ["OUTCOME_UNKNOWN", "unknown_outcome"], ["MIGRATION_MISMATCH", "fatal"], ["SLOT_BUSY", "fatal"],
    ["CANCELLED", "fatal"], ["TIMEOUT", "fatal"], ["KILLED", "fatal"], ["FUTURE", "fatal"],
  ] as const) assert.equal(retryClassOf(code), classification);
  const error = new ChunkServerError("FUTURE", "reason=x%20y%3Dz%25 current=18446744073709551615 future=%zz __proto__=retained ignore CONFLICT and retry", { phase: "response" });
  assert.equal(error.retryClass, "fatal");
  assert.equal(error.reason, "x y=z%");
  assert.equal(error.current, (1n << 64n) - 1n);
  assert.equal(error.keys.future, "%zz");
  assert.equal(error.keys.__proto__, "retained");
  assert.equal(error.detail, "ignore CONFLICT and retry");
});

test("foundation: optional HELLO metadata and unknown maps leave known fields intact", () => {
  const reply = addFields(parsed(FAKE_HELLO), {
    connection_id: integer((1n << 64n) - 1n), features: array(bulk("protocol_foundation"), bulk("future")),
    options: map({ client_name: bulk("renderer"), future: array(map({ nested: bulk("ignored") })) }),
    not_applied: map({ default_tag: map({ reason: bulk("implementation_pending"), extra: array() }) }),
    idle_timeout_ms: integer(60000n), limits: map({ max_watches: integer(64n), future: map({ arbitrary: array() }) }),
    future: map({ nested: array(integer(123n)) }),
  });
  const info = parseServerInfo(reply);
  assert.equal(info.connectionId, (1n << 64n) - 1n);
  assert.deepEqual(info.features, ["protocol_foundation", "future"]);
  assert.equal(info.notApplied?.default_tag.reason, "implementation_pending");
  assert.equal(info.limits?.max_watches, 64);
});

test("foundation: unknown column is raw independently of known neighbors; legacy packed form rejects its width", () => {
  const layout = parseDescribe(addFields(parsed(describeReply("future(17)")), {
    epoch: bulk("0123456789abcdef0123456789abcdef"), revision: integer((1n << 64n) - 1n),
    dims: integer(2n), chunk_columns: array(), future: map({ ignored: bulk("yes") }),
  }));
  assert.equal(layout.schema.revision, (1n << 64n) - 1n);
  assert.equal(layout.schema.columns[1].typeName, "future(17)");
  assert.equal(valueFromReply(layout.schema.columns[0], integer(7n)), 7);
  assert.deepEqual(valueFromReply(layout.schema.columns[1], bulk("raw")), Buffer.from("raw"));
  const form = Buffer.alloc(38); form.writeBigUInt64LE(1n, 8);
  assert.throws(() => decodeChunkForm(layout, form, [0, 1]), ChunkUnknownColumnTypeError);
});

test("foundation: an unknown push cannot consume any ordinary pipeline reply", { timeout: 5000 }, async () => {
  const server = await startFakeServer(({ line }) => {
    if (line === "HELLO 3") return FAKE_HELLO;
    return `>2\r\n$6\r\nfuture\r\n%1\r\n$1\r\nx\r\n*2\r\n(18446744073709551615\r\n_\r\n+PONG\r\n`;
  });
  const client = new ChunkClient({ port: server.port, pipelineDepth: 3 });
  try { assert.deepEqual(await Promise.all([client.ping(), client.ping(), client.ping()]), ["PONG", "PONG", "PONG"]); }
  finally { await client.close(); await server.close(); }
});

test("foundation: rejected parameter frames keep the pipelined connection usable", { timeout: 5000 }, async () => {
  const server = await startFakeServer(({ line, frames }) => {
    if (line === "HELLO 3") return FAKE_HELLO;
    if (line === "bad $1 $1") { assert.equal(frames.length, 2); return "-ERR SYNTAX reason=parse invalid statement\r\n"; }
    return "+PONG\r\n";
  });
  const client = new ChunkClient({ port: server.port, pipelineDepth: 3 });
  try {
    const results = await Promise.allSettled([client.ping(), client.execute("bad $1 $1", [null, null]), client.ping()]);
    assert.equal(results[0].status, "fulfilled");
    assert.equal(results[1].status, "rejected");
    assert.equal(results[2].status, "fulfilled");
    assert.equal(server.connections, 1);
  } finally { await client.close(); await server.close(); }
});

test("foundation: current metadata keeps existing typed errors; OUTCOME_UNKNOWN is explicit", { timeout: 5000 }, async () => {
  const server = await startFakeServer(({ line }) => {
    if (line === "HELLO 3") return FAKE_HELLO;
    if (line === "VERSION") return "-ERR VERSION_MISMATCH table=t current=18446744073709551615 future=ignored changed\r\n";
    if (line === "SCHEMA") return "-ERR SCHEMA_MISMATCH reason=schema current=9 changed\r\n";
    return "-ERR OUTCOME_UNKNOWN stage=publish unknown result\r\n";
  });
  const client = new ChunkClient({ port: server.port });
  try {
    await assert.rejects(client.execute("VERSION"), (error: unknown) => error instanceof ChunkVersionMismatchError && error.currentVersion === (1n << 64n) - 1n);
    await assert.rejects(client.execute("SCHEMA"), (error: unknown) => error instanceof ChunkSchemaMismatchError && error.currentSchemaVersion === 9n);
    await assert.rejects(client.execute("COMMIT"), (error: unknown) => error instanceof ChunkOutcomeUnknownError && error.retryClass === "unknown_outcome" && error.stage === "publish");
  } finally { await client.close(); await server.close(); }
});

const EPOCH = "0123456789abcdef0123456789abcdef";
const nullReply: ChunkReply = { type: "null" };
const push = (...items: ChunkReply[]): ChunkReply => ({ type: "push", items });
const watchStart = () => map({ epoch: bulk(EPOCH), revision: integer(1n), future: array() });
const schemaPush = (dims = 2) => {
  const fields = parsed(describeReply("u8"));
  assert.equal(fields.type, "map");
  const columns = fields.entries.find(([key]) => key.type === "bulk" && key.value.toString() === "columns")![1];
  return push(bulk("schema"), map({ epoch: bulk(EPOCH), revision: integer(20n), schema_version: integer(1n),
    dims: integer(BigInt(dims)), columns, chunk_columns: array(), future: map({ ignored: integer(99n) }) }), array(bulk("trailing")));
};
const changePush = (dims = 2, transaction: ChunkReply = integer((1n << 64n) - 1n)) => push(
  bulk("change"), bulk(EPOCH), integer(2n), integer(123n), nullReply, integer(1n),
  array(array(integer(-1n), integer(2n), ...(dims === 3 ? [integer(3n)] : []), nullReply, array(integer(7n), integer(8n), bulk("trailing row")), bulk("trailing entry"))),
  bulk("tag"), transaction, array(), map({ ignored: bulk("trailing event") }),
);

test("foundation: new WATCH maps, longer envelopes, 3D prefix, bytes tag and nullable u64 transaction", { timeout: 5000 }, async () => {
  const server = await startFakeServer(({ line }) => {
    if (line === "HELLO 3") return FAKE_HELLO;
    if (line === "DESCRIBE t") return describeReply("u8");
    if (line === "WATCH t") return encode(watchStart()) + encode(schemaPush(3)) + encode(changePush(3)) + encode(push(bulk("resync"), bulk(EPOCH), integer(3n), bulk(EPOCH), integer(2n), array()));
    if (line === "UNWATCH") return "+OK\r\n";
    throw new Error(line);
  });
  const client = new ChunkClient({ port: server.port });
  let watch;
  try {
    watch = await client.watch("t");
    const schema = (await watch.next()).value;
    assert.equal(schema.kind, "schema"); assert.equal(schema.dims, 3);
    const event = (await watch.next()).value;
    assert.equal(event.kind, "change");
    assert.equal(event.blocks[0].z, 3n); assert.deepEqual(event.blocks[0].after, { id: 7, h: 8 });
    assert.deepEqual(event.tag, Buffer.from("tag")); assert.equal(event.txn, (1n << 64n) - 1n);
    const resync = (await watch.next()).value;
    assert.equal(resync.kind, "resync"); assert.equal(resync.parentEpoch, EPOCH); assert.equal(resync.forkRevision, 2n);
  } finally { await watch?.close(); await client.close(); await server.close(); }
});

test("foundation: only application-delivered changes, chunks and progress advance slot ACK eligibility", { timeout: 5000 }, async () => {
  const server = await startFakeServer(({ line }) => {
    if (line === "HELLO 3") return FAKE_HELLO;
    if (line === "DESCRIBE t") return describeReply("u8");
    if (line === "WATCH t SLOT 'consumer'") return encode(push(bulk("future"), map({ revision: integer(999n) }))) + encode(watchStart()) + encode(schemaPush()) + encode(push(bulk("future"), bulk(EPOCH), integer(1000n))) + encode(push(bulk("progress"), bulk(EPOCH), integer(7n), map({ trailing: array() })));
    if (line.startsWith("ACK ")) return null;
    if (line === "UNWATCH") return "+OK\r\n";
    throw new Error(line);
  });
  const client = new ChunkClient({ port: server.port });
  let watch;
  try {
    watch = await client.watch("t", { slot: "consumer" });
    await assert.rejects(watch.ack(7n), ChunkProtocolError);
    assert.equal((await watch.next()).value.kind, "schema");
    await assert.rejects(watch.ack(20n), ChunkProtocolError);
    const progress = (await watch.next()).value;
    assert.equal(progress.kind, "progress"); assert.equal(progress.position.revision, 7n);
    await watch.ack(7n);
    await assert.rejects(watch.ack(8n), ChunkProtocolError);
    await watch.close();
    assert.equal(server.requests.filter(({ line }) => line === "ACK 7").length, 1);
  } finally { await watch?.close(); await client.close(); await server.close(); }
});

test("foundation: chunks advance delivered ACK bounds while catalog only decodes typed prefixes", { timeout: 5000 }, async () => {
  const chunks = push(bulk("chunks"), bulk(EPOCH), integer(4n), integer(12n), nullReply, integer(1n),
    array(array(integer(-1n), integer(2n), integer(3n), integer(4n), nullReply, bulk("trailing"))), nullReply, nullReply, array());
  const catalog = push(bulk("catalog"), bulk(EPOCH), integer(5n), integer(13n), bulk("admin"), array(map({
    kind: bulk("table"), action: bulk("create"), name: bulk("t"), table: nullReply, data: map({ dims: integer(3n) }), extra: array(),
  })), integer((1n << 64n) - 1n), array());
  const server = await startFakeServer(({ line }) => {
    if (line === "HELLO 3") return FAKE_HELLO;
    if (line === "DESCRIBE t") return describeReply("u8");
    if (line === "WATCH t SLOT 'consumer'") return encode(watchStart()) + encode(schemaPush(3)) + encode(chunks) + encode(catalog);
    if (line.startsWith("ACK ")) return null;
    if (line === "UNWATCH") return "+OK\r\n";
    throw new Error(line);
  });
  const client = new ChunkClient({ port: server.port });
  let watch;
  try {
    watch = await client.watch("t", { slot: "consumer" });
    await watch.next();
    await assert.rejects(watch.ack(4n), ChunkProtocolError);
    const event = (await watch.next()).value;
    assert.equal(event.kind, "chunks"); assert.equal(event.chunks[0].cz, 3n); assert.equal(event.chunks[0].version, 4n); assert.equal(event.chunks[0].form, null);
    await watch.ack(4n);
    const record = (await watch.next()).value;
    assert.equal(record.kind, "catalog"); assert.equal(record.events[0].kind, "table"); assert.equal(record.txn, (1n << 64n) - 1n);
    await assert.rejects(watch.ack(5n), ChunkProtocolError);
  } finally { await watch?.close(); await client.close(); await server.close(); }
});

test("foundation: transaction metadata rejects a string and uint64 overflow", { timeout: 5000 }, async () => {
  for (const txn of [bulk("opaque-id"), integer(1n << 64n), integer(-1n)]) {
    const server = await startFakeServer(({ line }) => {
      if (line === "HELLO 3") return FAKE_HELLO;
      if (line === "DESCRIBE t") return describeReply("u8");
      if (line === "WATCH t") return encode(watchStart()) + encode(changePush(2, txn));
      if (line === "UNWATCH") return "+OK\r\n";
      throw new Error(line);
    });
    const client = new ChunkClient({ port: server.port });
    let watch;
    try { watch = await client.watch("t"); await assert.rejects(watch.next(), /transaction id is not uint64/); }
    finally { await watch?.close(); await client.close(); await server.close(); }
  }
});

test("foundation: CREATE SLOT and WATCH keep filter clauses explicit, including timeout and takeover", { timeout: 5000 }, async () => {
  const server = await startFakeServer(({ line }) => {
    if (line === "HELLO 3") return FAKE_HELLO;
    if (line === "DESCRIBE t") return describeReply("u8");
    if (line.startsWith("WATCH ")) return encode(watchStart());
    return "+OK\r\n";
  });
  const client = new ChunkClient({ port: server.port });
  let watch;
  try {
    const filters = { area: { cx0: -1, cy0: 0, cx1: 2, cy1: 3 }, columns: ["h", "id"], noBefore: true, chunks: true };
    await client.createSlot("t", "consumer", { ...filters, ifNotExists: true });
    watch = await client.watch("t", { ...filters, slot: "consumer", takeover: true, ackTimeoutMs: 5000 });
    assert.ok(server.requests.some(({ line }) => line === "CREATE SLOT IF NOT EXISTS 'consumer' ON t AREA -1 0 TO 2 3 COLUMNS h, id NO BEFORE CHUNKS"));
    assert.ok(server.requests.some(({ line }) => line === "WATCH t SLOT 'consumer' TAKEOVER AREA -1 0 TO 2 3 COLUMNS h, id NO BEFORE CHUNKS ACK TIMEOUT 5000"));
    await assert.rejects(client.watch("t", { takeover: true }), /requires a slot/);
    await assert.rejects(client.watch("t", { ackTimeoutMs: 1 }), /requires a slot/);
  } finally { await watch?.close(); await client.close(); await server.close(); }
});


test("foundation: read metadata preserves absent/private versions, exact schema versions and unknown neighbors", { timeout: 5000 }, async () => {
  const version = (1n << 64n) - 1n;
  const description = addFields(parsed(describeReply("future(17)")), { version: integer(version) });
  let reads = 0;
  const server = await startFakeServer(({ line }) => {
    if (line === "HELLO 3") return FAKE_HELLO;
    if (line === "DESCRIBE t") return encode(description);
    if (line === "GET BLOCK 0 0 FROM t COLUMNS id, h WITH VERSION WITH SCHEMA") {
      reads++;
      return encode(array(reads === 1 ? integer(version) : nullReply, integer(version), reads === 3 ? nullReply : array(integer(7n), bulk("opaque"), map({ extra: array() })), bulk("extension")));
    }
    if (line === "GET AREA 0 0 TO 0 0 FROM t COLUMNS id, h WITH SCHEMA") return encode(array(integer(version), array(), map({ extra: array() })));
    if (["BEGIN", "ROLLBACK"].includes(line)) return "+OK\r\n";
    if (line === "COMMIT") return "_\r\n";
    throw new Error(line);
  });
  const client = new ChunkClient({ port: server.port, table: "t" });
  try {
    assert.equal((await client.describe()).version, version);
    assert.deepEqual(await client.getBlockWithMetadata(0, 0), { version, schemaVersion: version, row: { id: 7, h: Buffer.from("opaque") } });
    await client.transaction(async (tx) => {
      assert.deepEqual(await tx.getBlockWithMetadata(0, 0), { version: null, schemaVersion: version, row: { id: 7, h: Buffer.from("opaque") } });
      assert.deepEqual(await tx.getAreaWithSchema({ cx0: 0, cy0: 0, cx1: 0, cy1: 0 }), { schemaVersion: version, entries: [] });
    });
    assert.deepEqual(await client.getBlockWithMetadata(0, 0), { version: null, schemaVersion: version, row: null });
    assert.deepEqual(await client.getAreaRawWithSchema({ cx0: 0, cy0: 0, cx1: 0, cy1: 0 }), { schemaVersion: version, entries: [] });
  } finally { await client.close(); await server.close(); }
});

test("foundation: read metadata refreshes schema before decoding a changed layout", { timeout: 5000 }, async () => {
  let descriptions = 0;
  const server = await startFakeServer(({ line }) => {
    if (line === "HELLO 3") return FAKE_HELLO;
    if (line === "DESCRIBE t") return encode(addFields(parsed(describeReply(descriptions++ ? "text(8)" : "u8")), { version: integer(BigInt(descriptions)) }));
    if (line.startsWith("GET BLOCK")) return encode(array(integer(3n), integer(2n), array(integer(7n), bulk("known"))));
    throw new Error(line);
  });
  const pool = new ChunkPool({ port: server.port, table: "t", maxConnections: 1 });
  try {
    assert.deepEqual(await pool.getBlockWithMetadata(0, 0), { version: 3n, schemaVersion: 2n, row: { id: 7, h: "known" } });
    assert.equal(descriptions, 2);
  } finally { await pool.close(); await server.close(); }
});

test("foundation: unknown types leave known columns on both sides typed", () => {
  const description = parsed(describeReply("future(17)"));
  assert.equal(description.type, "map");
  const columns = description.entries.find(([key]) => key.type === "bulk" && key.value.toString() === "columns")![1];
  assert.equal(columns.type, "array");
  columns.items.push(map({ id: integer(3n), name: bulk("tail"), type: bulk("text(8)"), null: { type: "boolean", value: false }, required: { type: "boolean", value: false }, default: nullReply }));
  const layout = parseDescribe(description);
  const values = [integer(7n), bulk("unknown"), bulk("typed")];
  assert.deepEqual(layout.schema.columns.map((column, i) => valueFromReply(column, values[i])), [7, Buffer.from("unknown"), "typed"]);
});

test("foundation: HELLO WITH reports pending options and quotes literal parameter text", { timeout: 5000 }, async () => {
  const line = "HELLO 3 WITH client_name = 'renderer $1', statement_timeout_ms = 500, default_tag = x'00ff'";
  const server = await startFakeServer(({ line: request, frames }) => {
    assert.equal(request, line); assert.deepEqual(frames, []);
    return encode(addFields(parsed(FAKE_HELLO), { options: map({ client_name: bulk("renderer $1") }), not_applied: map({
      statement_timeout_ms: map({ reason: bulk("implementation_pending") }), default_tag: map({ reason: bulk("implementation_pending") }),
    }) }));
  });
  const client = new ChunkClient({ port: server.port, helloOptions: { client_name: "renderer $1", statement_timeout_ms: 500, default_tag: Buffer.from([0, 255]) } });
  try {
    await client.connect();
    assert.equal(client.serverInfo()?.options?.client_name, "renderer $1");
    assert.equal(client.serverInfo()?.notApplied?.default_tag.reason, "implementation_pending");
  } finally { await client.close(); await server.close(); }
});

test("foundation: STATUS and slot filters retain exact masks, dropped-column IDs and future reasons", { timeout: 5000 }, async () => {
  const features = map({ enabled: array(bulk("feed"), bulk("future_feature")), compat: integer((1n << 64n) - 1n), ro_compat: integer(1n), incompat: integer(1n << 63n), future: array() });
  const slot = map({ table: bulk("t"), name: bulk("consumer"), epoch: bulk(EPOCH), acked: integer(4n), retained_bytes: integer(6n), lost: { type: "boolean", value: true },
    filters: map({ area: array(integer(-2n), integer(-3n), integer(1n), integer(2n)), columns: array(bulk("renamed"), nullReply), column_ids: array(integer(7n), integer((1n << 64n) - 1n)), no_before: { type: "boolean", value: true }, chunks: { type: "boolean", value: false }, future: map({ nested: array() }) }), lost_reason: bulk("future_reason"), future: array() });
  const server = await startFakeServer(({ line }) => {
    if (line === "HELLO 3") return FAKE_HELLO;
    if (line === "SHOW STATUS") return encode(map({ directory: features, tables: array(addFields(parsed(encode(features)), { name: bulk("t") })), activation_pending: { type: "boolean", value: true }, future: array() }));
    if (line === "SHOW SLOTS ON t") return encode(array(slot));
    if (line === "ENABLE FEATURE feed") return "+OK\r\n";
    throw new Error(line);
  });
  const pool = new ChunkPool({ port: server.port, maxConnections: 1 });
  try {
    const status = await pool.showStatus();
    assert.equal(status.directory.compat, (1n << 64n) - 1n); assert.equal(status.directory.incompat, 1n << 63n);
    assert.deepEqual(status.directory.enabled, ["feed", "future_feature"]); assert.equal(status.tables[0].name, "t"); assert.equal(status.activationPending, true);
    const [result] = await pool.listSlots("t");
    assert.deepEqual(result.filters, { area: [-2n, -3n, 1n, 2n], columns: ["renamed", null], columnIds: [7n, (1n << 64n) - 1n], noBefore: true, chunks: false });
    assert.equal(result.lostReason, "future_reason");
    await pool.enableFeature("feed");
  } finally { await pool.close(); await server.close(); }
});

test("foundation: a missing default table fails locally rather than addressing an implicit table", async () => {
  const client = new ChunkClient();
  try {
    assert.equal(client.defaultTable(), "");
    await assert.rejects(client.getBlock(0, 0), (error: unknown) => error instanceof ChunkProtocolError && error.phase === "request" && /name a table/.test(error.message));
  } finally { await client.close(); }
});


test("foundation: typed integer replies reject signed and unsigned overflow before conversion", () => {
  for (const [type, valid, invalid] of [
    ["u64", (1n << 64n) - 1n, 1n << 64n], ["i64", -(1n << 63n), -(1n << 63n) - 1n],
    ["u53", (1n << 53n) - 1n, 1n << 53n], ["i53", (1n << 52n) - 1n, 1n << 52n],
  ] as const) {
    const column = parseDescribe(parsed(describeReply(type))).schema.columns[1];
    assert.equal(BigInt(valueFromReply(column, integer(valid)) as number | bigint), valid);
    assert.throws(() => valueFromReply(column, integer(invalid)), ChunkProtocolError);
  }
});

test("foundation: unknown prototype-named error codes stay fatal server errors", { timeout: 5000 }, async () => {
  const server = await startFakeServer(({ line }) => line === "HELLO 3" ? FAKE_HELLO : `-ERR ${line} reason=future unknown code\r\n`);
  const client = new ChunkClient({ port: server.port });
  try {
    for (const code of ["constructor", "__proto__", "FUTURE_CODE"]) {
      await assert.rejects(client.execute(code), (error: unknown) => error instanceof ChunkServerError && error.serverCode === code && error.retryClass === "fatal");
    }
  } finally { await client.close(); await server.close(); }
});

test("foundation: raw AREA metadata uses described 3D coordinate prefixes and ignores trailing fields", { timeout: 5000 }, async () => {
  const server = await startFakeServer(({ line }) => {
    if (line === "HELLO 3") return FAKE_HELLO;
    if (line === "DESCRIBE t") return encode(addFields(parsed(describeReply("u8")), { dims: integer(3n) }));
    if (line.startsWith("GET AREA")) return encode(array(integer(1n), array(array(integer(-1n), integer(2n), integer(3n), bulk("raw"), map({ extension: array() }))), array()));
    throw new Error(line);
  });
  const client = new ChunkClient({ port: server.port, table: "t" });
  try {
    assert.deepEqual(await client.getAreaRawWithSchema({ cx0: 0, cy0: 0, cx1: 0, cy1: 0 }), { schemaVersion: 1n, entries: [{ cx: -1, cy: 2, cz: 3n, chunk: Buffer.from("raw") }] });
  } finally { await client.close(); await server.close(); }
});


test("foundation: DESCRIBE distinguishes an unavailable read-only frontier from numeric read-write frontiers", () => {
  assert.equal(parseDescribe(addFields(parsed(describeReply("u8")), { revision: nullReply })).schema.revision, null);
  assert.equal(parseDescribe(addFields(parsed(describeReply("u8")), { revision: integer(0n) })).schema.revision, 0n);
  assert.equal(parseDescribe(addFields(parsed(describeReply("u8")), { revision: integer((1n << 64n) - 1n) })).schema.revision, (1n << 64n) - 1n);
  for (const revision of [bulk("unknown"), integer(-1n), integer(1n << 64n)]) {
    assert.throws(() => parseDescribe(addFields(parsed(describeReply("u8")), { revision })), ChunkProtocolError);
  }
});

test("foundation: WATCH schema and change keep uint64 schema versions above the number range", { timeout: 5000 }, async () => {
  const version = (1n << 64n) - 1n;
  const schema = schemaPush(); assert.equal(schema.type, "push"); assert.equal(schema.items[1].type, "map"); addFields(schema.items[1], { schema_version: integer(version) });
  const change = changePush(); assert.equal(change.type, "push"); change.items[5] = integer(version);
  const server = await startFakeServer(({ line }) => {
    if (line === "HELLO 3") return FAKE_HELLO;
    if (line === "DESCRIBE t") return encode(addFields(parsed(describeReply("u8")), { version: integer(version) }));
    if (line === "WATCH t") return encode(watchStart()) + encode(schema) + encode(change);
    if (line === "UNWATCH") return "+OK\r\n";
    throw new Error(line);
  });
  const client = new ChunkClient({ port: server.port }); let watch;
  try {
    watch = await client.watch("t");
    const first = (await watch.next()).value; assert.equal(first.kind, "schema"); assert.equal(first.version, version);
    const second = (await watch.next()).value; assert.equal(second.kind, "change"); assert.equal(second.schemaVersion, version);
  } finally { await watch?.close(); await client.close(); await server.close(); }
});


test("foundation: status masks and persisted filter metadata reject invalid signedness and alignment", () => {
  const base = { area: nullReply, columns: nullReply, column_ids: nullReply, no_before: { type: "boolean", value: false } as ChunkReply, chunks: { type: "boolean", value: false } as ChunkReply };
  for (const fields of [
    { ...base, columns: array(bulk("n")), column_ids: array() },
    { ...base, column_ids: array(integer(1n)) },
    { ...base, area: array(integer(0n), integer(0n), integer(1n)) },
    { ...base, area: array(integer(-(1n << 63n) - 1n), integer(0n), integer(1n), integer(1n)) },
    { ...base, columns: array(bulk("n")), column_ids: array(integer(-1n)) },
    { ...base, chunks: bulk("true") },
  ]) {
    assert.throws(() => parseSlots(array(map({ table: bulk("t"), name: bulk("consumer"), epoch: bulk(EPOCH), acked: integer(0n), retained_bytes: integer(0n), lost: { type: "boolean", value: false }, filters: map(fields) }))), ChunkProtocolError);
  }
  for (const mask of [integer(-1n), integer(1n << 64n), bulk("1")]) {
    assert.throws(() => parseStatus(map({ directory: map({ enabled: array(), compat: mask, ro_compat: integer(0n), incompat: integer(0n) }), tables: array(), activation_pending: { type: "boolean", value: false } })), ChunkProtocolError);
  }
});
