import test from "node:test";
import assert from "node:assert/strict";

import { formatChunkUri, parseChunkUri } from "../src/index";

test("parse chunk URI", () => {
  const uri = parseChunkUri("chunk://token@localhost:4242/");
  assert.equal(uri.scheme, "chunk");
  assert.equal(uri.secure, false);
  assert.equal(uri.host, "localhost");
  assert.equal(uri.port, 4242);
  assert.equal(uri.token, "token");
  assert.equal(uri.path, "/");
});

test("parse chunks URI default port", () => {
  const uri = parseChunkUri("chunks://abc@127.0.0.1/");
  assert.equal(uri.scheme, "chunks");
  assert.equal(uri.secure, true);
  assert.equal(uri.port, 4242);
  assert.equal(uri.token, "abc");
});

test("format chunk URI", () => {
  const text = formatChunkUri({
    scheme: "chunk",
    secure: false,
    host: "127.0.0.1",
    port: 4242,
    token: "my token",
    path: "/",
  });
  assert.equal(text, "chunk://my%20token@127.0.0.1:4242/");
});

test("reject invalid URI scheme", () => {
  assert.throws(() => parseChunkUri("http://localhost:4242/"));
});
