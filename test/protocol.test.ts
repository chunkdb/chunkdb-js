import test from "node:test";
import assert from "node:assert/strict";

import { parseFrame, parseInfoPayload, serializeCommand } from "../src/index";

test("serialize command", () => {
  assert.deepEqual(serializeCommand(["PING"]), Buffer.from("PING\r\n"));
  assert.deepEqual(serializeCommand(["GET", 1, 2]), Buffer.from("GET 1 2\r\n"));
});

test("parse simple frame", () => {
  const parsed = parseFrame(Buffer.from("+PONG\r\n", "utf8"));
  assert.ok(parsed !== null);
  assert.equal(parsed.frame.type, "simple");
  if (parsed.frame.type === "simple") {
    assert.equal(parsed.frame.value, "PONG");
  }
});

test("parse error frame", () => {
  const parsed = parseFrame(Buffer.from("-ERR AUTH_REQUIRED use AUTH <token>\r\n", "utf8"));
  assert.ok(parsed !== null);
  assert.equal(parsed.frame.type, "error");
  if (parsed.frame.type === "error") {
    assert.equal(parsed.frame.code, "AUTH_REQUIRED");
    assert.equal(parsed.frame.message, "use AUTH <token>");
  }
});

test("parse bulk frame", () => {
  const payload = Buffer.from([0x00, 0x01, 0x02, 0x03]);
  const frame = Buffer.concat([
    Buffer.from("$4\r\n", "utf8"),
    payload,
    Buffer.from("\r\n", "utf8"),
  ]);
  const parsed = parseFrame(frame);
  assert.ok(parsed !== null);
  assert.equal(parsed.frame.type, "bulk");
  if (parsed.frame.type === "bulk") {
    assert.deepEqual(parsed.frame.value, payload);
  }
});

test("parse info payload", () => {
  const values = parseInfoPayload(Buffer.from("chunkdb_version=1\nblock_bits=16\n", "utf8"));
  assert.equal(values.chunkdb_version, "1");
  assert.equal(values.block_bits, "16");
});
