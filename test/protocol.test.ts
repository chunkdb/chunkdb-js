import test from "node:test";
import assert from "node:assert/strict";

import { ChunkProtocolError, encodeStatement, parseReply, type ChunkReply } from "../src/index";
import { ReplyReader } from "../src/protocol";

function parse(text: string | Buffer): ChunkReply {
  const parsed = parseReply(typeof text === "string" ? Buffer.from(text, "latin1") : text);
  assert.ok(parsed !== null, "expected a complete reply");
  assert.equal(parsed.bytesConsumed, typeof text === "string" ? Buffer.byteLength(text, "latin1") : text.length);
  return parsed.reply;
}

test("simple strings, errors, null and booleans", () => {
  assert.deepEqual(parse("+PONG\r\n"), { type: "simple", value: "PONG" });
  assert.deepEqual(parse("-ERR VERSION_MISMATCH current=1043\r\n"), {
    type: "error",
    code: "VERSION_MISMATCH",
    message: "current=1043",
  });
  assert.deepEqual(parse("-ERR AUTH_REQUIRED\r\n"), { type: "error", code: "AUTH_REQUIRED", message: "" });
  assert.deepEqual(parse("_\r\n"), { type: "null" });
  assert.deepEqual(parse("#t\r\n"), { type: "boolean", value: true });
  assert.deepEqual(parse("#f\r\n"), { type: "boolean", value: false });
});

test("integers keep 64 bits, unsigned and signed", () => {
  assert.deepEqual(parse(":0\r\n"), { type: "integer", value: 0n });
  assert.deepEqual(parse(":-9223372036854775808\r\n"), { type: "integer", value: -(1n << 63n) });
  // A u64 value above the i64 range.
  assert.deepEqual(parse(":18446744073709551615\r\n"), { type: "integer", value: (1n << 64n) - 1n });
  assert.throws(() => parse(":1.5\r\n"), ChunkProtocolError);
});

test("doubles, including inf, -inf and nan", () => {
  assert.deepEqual(parse(",1.5\r\n"), { type: "double", value: 1.5 });
  assert.deepEqual(parse(",0.002\r\n"), { type: "double", value: 0.002 });
  assert.deepEqual(parse(",1e+38\r\n"), { type: "double", value: 1e38 });
  assert.deepEqual(parse(",inf\r\n"), { type: "double", value: Number.POSITIVE_INFINITY });
  assert.deepEqual(parse(",-inf\r\n"), { type: "double", value: Number.NEGATIVE_INFINITY });
  const nan = parse(",nan\r\n");
  assert.ok(nan.type === "double" && Number.isNaN(nan.value));
  assert.throws(() => parse(",x\r\n"), ChunkProtocolError);
});

test("bulk strings are binary", () => {
  const bytes = Buffer.from([0x00, 0x0d, 0x0a, 0xff, 0x24]);
  const reply = parse(Buffer.concat([Buffer.from("$5\r\n"), bytes, Buffer.from("\r\n")]));
  assert.ok(reply.type === "bulk");
  assert.deepEqual(reply.value, bytes);
  assert.deepEqual(parse("$0\r\n\r\n"), { type: "bulk", value: Buffer.alloc(0) });
  assert.throws(() => parse("$2\r\nabc\r\n"), ChunkProtocolError);
});

test("arrays and maps nest", () => {
  assert.deepEqual(parse("*3\r\n:23\r\n_\r\n$2\r\nhi\r\n"), {
    type: "array",
    items: [{ type: "integer", value: 23n }, { type: "null" }, { type: "bulk", value: Buffer.from("hi") }],
  });
  assert.deepEqual(parse("%2\r\n$6\r\nchunks\r\n*1\r\n*2\r\n:-1\r\n:2\r\n$4\r\nmore\r\n#f\r\n"), {
    type: "map",
    entries: [
      [
        { type: "bulk", value: Buffer.from("chunks") },
        { type: "array", items: [{ type: "array", items: [{ type: "integer", value: -1n }, { type: "integer", value: 2n }] }] },
      ],
      [{ type: "bulk", value: Buffer.from("more") }, { type: "boolean", value: false }],
    ],
  });
  assert.deepEqual(parse("*0\r\n"), { type: "array", items: [] });
});

test("an incomplete reply waits for more bytes", () => {
  for (const partial of ["", "+PON", "+PONG\r", "$5\r\nhel", "$5\r\nhello\r", "*2\r\n:1\r\n", "%1\r\n$1\r\na\r\n"]) {
    assert.equal(parseReply(Buffer.from(partial, "latin1")), null, JSON.stringify(partial));
  }
});

test("malformed replies are protocol errors", () => {
  assert.throws(() => parseReply(Buffer.from("!3\r\nerr\r\n")), ChunkProtocolError);
  assert.throws(() => parseReply(Buffer.from("+PONG\n")), ChunkProtocolError);
  assert.throws(() => parseReply(Buffer.from("*x\r\n")), ChunkProtocolError);
});

test("the reader keeps reply order across arbitrary chunk boundaries", () => {
  const wire = Buffer.concat([
    Buffer.from("+OK\r\n:1043\r\n$3\r\na\r\n\r\n*1\r\n*3\r\n:0\r\n:0\r\n$2\r\n"),
    Buffer.from([0xde, 0xad]),
    Buffer.from("\r\n,nan\r\n-ERR SYNTAX column 1: unknown statement 'X'\r\n%1\r\n$1\r\nk\r\n#t\r\n"),
  ]);
  for (const step of [1, 2, 3, 7, wire.length]) {
    const reader = new ReplyReader();
    const replies: ChunkReply[] = [];
    for (let at = 0; at < wire.length; at += step) {
      reader.push(wire.subarray(at, at + step));
      for (let reply = reader.next(); reply !== null; reply = reader.next()) {
        replies.push(reply);
      }
    }
    assert.deepEqual(
      replies.map((reply) => reply.type),
      ["simple", "integer", "bulk", "array", "double", "error", "map"],
      `step ${step}`,
    );
    assert.deepEqual(replies[2], { type: "bulk", value: Buffer.from("a\r\n") });
    assert.equal(reader.next(), null);
  }
});

test("a statement is one line followed by its parameter frames", () => {
  assert.deepEqual(encodeStatement("PING"), Buffer.from("PING\r\n"));
  assert.deepEqual(
    encodeStatement("SET BLOCK 10 4 IN world sign = $1, chest = $2", [Buffer.from("hello"), null]),
    Buffer.from("SET BLOCK 10 4 IN world sign = $1, chest = $2\r\n$5\r\nhello\r\n$-1\r\n"),
  );
  const binary = Uint8Array.of(0x0d, 0x0a, 0x00);
  assert.deepEqual(
    encodeStatement("SET CHUNK 0 0 IN t $1", [binary]),
    Buffer.concat([Buffer.from("SET CHUNK 0 0 IN t $1\r\n$3\r\n"), Buffer.from(binary), Buffer.from("\r\n")]),
  );
  assert.throws(() => encodeStatement("PING\r\nDROP TABLE t"), /one line/);
  assert.throws(() => encodeStatement("GET BLOCK 0 0 FROM t\n"), /one line/);
});
