import test from "node:test";
import assert from "node:assert/strict";
import {
  ChunkClient, ChunkProtocolError, ChunkServerError, ChunkVersionMismatchError,
  ChunkSchemaMismatchError, ChunkOutcomeUnknownError, ChunkUnknownColumnTypeError,
  countParameters, encodeStatement, parseReply, retryClassOf, type ChunkReply,
} from "../src/index";
import { parseDescribe, parseServerInfo } from "../src/schema";
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
      assert.deepEqual(parseReply(wire)!.reply, integer(value));
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
    options: map({ client_name: bulk("renderer") }),
    not_applied: map({ default_tag: map({ reason: bulk("implementation_pending"), extra: array() }) }),
    idle_timeout_ms: integer(60000n), limits: map({ max_watches: integer(64n) }),
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
