import test from "node:test";
import assert from "node:assert/strict";

import { ChunkClient, formatChunkUri, parseChunkUri, tableFromUriPath } from "../src/index";

test("parse chunk URI", () => {
  const uri = parseChunkUri("chunk://bot:secret@localhost:4242/");
  assert.equal(uri.scheme, "chunk");
  assert.equal(uri.secure, false);
  assert.equal(uri.host, "localhost");
  assert.equal(uri.port, 4242);
  assert.equal(uri.user, "bot");
  assert.equal(uri.password, "secret");
  assert.equal(uri.path, "/");
});

test("parse chunks URI default port", () => {
  const uri = parseChunkUri("chunks://bot@127.0.0.1/");
  assert.equal(uri.scheme, "chunks");
  assert.equal(uri.secure, true);
  assert.equal(uri.port, 4242);
  assert.equal(uri.user, "bot");
  assert.equal(uri.password, "");
  const anonymous = parseChunkUri("chunk://127.0.0.1/");
  assert.equal(anonymous.user, "");
  assert.equal(anonymous.password, "");
});

test("URI credentials are percent-decoded", () => {
  const uri = parseChunkUri("chunk://bot:p%3Ass%40w%2Frd%20%C3%A9@127.0.0.1:4242/world");
  assert.equal(uri.user, "bot");
  assert.equal(uri.password, "p:ss@w/rd é");
  assert.equal(uri.path, "/world");
  assert.throws(() => parseChunkUri("chunk://bot:%E0%A4%A@127.0.0.1/"), /password has an invalid % escape/);
  assert.throws(() => parseChunkUri("chunk://:secret@127.0.0.1/"), /password without a user/);
});

test("URI errors show the expected form", () => {
  const form = /chunk:\/\/user:password@host:4242\/table/;
  assert.throws(() => parseChunkUri("127.0.0.1:47421"), (error: Error) => /invalid chunk URI/.test(error.message) && form.test(error.message));
  assert.throws(() => parseChunkUri("localhost:4242"), /unsupported chunk URI scheme: localhost; use chunk:\/\/ or chunks:\/\/ \(TLS\)/);
  assert.throws(() => parseChunkUri("http://127.0.0.1:4242/"), /scheme: http; use chunk:\/\/ or chunks:\/\//);
  assert.throws(() => parseChunkUri("chunk://127.0.0.1:0/"), /port: 0; use a port from 1 to 65535/);
  assert.throws(() => parseChunkUri("chunk://bot:50%@127.0.0.1/"), /percent-encode reserved characters, for example % as %25/);
  assert.throws(() => tableFromUriPath("/a/b"), form);
});

test("format chunk URI", () => {
  const text = formatChunkUri({
    scheme: "chunk",
    secure: false,
    host: "127.0.0.1",
    port: 4242,
    user: "bot",
    password: "p:ss@w/rd",
    path: "/",
  });
  assert.equal(text, "chunk://bot:p%3Ass%40w%2Frd@127.0.0.1:4242/");
  assert.equal(parseChunkUri(text).password, "p:ss@w/rd");
  assert.equal(formatChunkUri({ ...parseChunkUri(text), user: "", password: "" }), "chunk://127.0.0.1:4242/");
});

test("options win over URI credentials, and uri() leaves the password out", () => {
  const client = new ChunkClient({ uri: "chunk://bot:secret@127.0.0.1:4242/" });
  assert.equal(client.uri(), "chunk://bot@127.0.0.1:4242/");
  const other = new ChunkClient({ uri: "chunk://bot:secret@127.0.0.1:4242/", user: "eve", password: "x" });
  assert.equal(other.uri(), "chunk://eve@127.0.0.1:4242/");
});

test("URI path names the table", () => {
  assert.equal(tableFromUriPath("/"), null);
  assert.equal(tableFromUriPath(""), null);
  assert.equal(tableFromUriPath("/terrain"), "terrain");
  assert.equal(tableFromUriPath(parseChunkUri("chunk://t@h:1/world_2").path), "world_2");
  assert.throws(() => tableFromUriPath("/a/b"), /one table/);
});

test("the client's table comes from the option, then the URI path", () => {
  const plain = new ChunkClient({ uri: "chunk://t@127.0.0.1:4242/" });
  assert.equal(plain.defaultTable(), "");
  assert.equal(plain.uri(), "chunk://t@127.0.0.1:4242/");
  const fromPath = new ChunkClient({ uri: "chunk://t@127.0.0.1:4242/terrain" });
  assert.equal(fromPath.defaultTable(), "terrain");
  assert.equal(fromPath.uri(), "chunk://t@127.0.0.1:4242/terrain");
  // An explicit option wins over the path.
  const explicit = new ChunkClient({ uri: "chunk://t@127.0.0.1:4242/terrain", table: "sky" });
  assert.equal(explicit.defaultTable(), "sky");
  assert.equal(explicit.uri(), "chunk://t@127.0.0.1:4242/sky");
});

test("reject invalid URI scheme", () => {
  assert.throws(() => parseChunkUri("http://localhost:4242/"));
});

test("an IPv6 URI host is the address without brackets", () => {
  const uri = parseChunkUri("chunks://bot:secret@[::1]:4243/world");
  assert.equal(uri.host, "::1");
  assert.equal(uri.port, 4243);
  assert.equal(formatChunkUri(uri), "chunks://bot:secret@[::1]:4243/world");
  assert.equal(parseChunkUri("chunk://[2001:db8::7]/").host, "2001:db8::7");
  assert.equal(new ChunkClient({ uri: "chunk://[::1]:4242/" }).uri(), "chunk://[::1]:4242/");
});
