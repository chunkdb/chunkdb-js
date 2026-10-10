import test from "node:test";
import assert from "node:assert/strict";
import { ChunkClient, ChunkConnectionError, ChunkMigrationError, ChunkProtocolError, ChunkServerError } from "../src/index";
import { tableOfStatement } from "../src/client";
import { FAKE_HELLO, startFakeServer } from "./fake-server";

test("migrations send steps in order, preserve statement identity and accept applied/skipped", async () => {
  const server = await startFakeServer(({ line }) => {
    if (line === "HELLO 3") return FAKE_HELLO;
    if (line === "MIGRATE 'first' CREATE TABLE t (n u8) CHUNK 4 x 4") return "+applied\r\n";
    if (line === "MIGRATE 'second' ALTER  TABLE t ADD COLUMN label text(32) NULL") return "+skipped\r\n";
    throw new Error(line);
  });
  const client = new ChunkClient({ port: server.port });
  try {
    assert.deepEqual(await client.migrate([]), []);
    assert.equal(server.connections, 0);
    assert.deepEqual(await client.migrate([
      { name: "first", statement: " \tCREATE TABLE t (n u8) CHUNK 4 x 4\t " },
      { name: "second", statement: "ALTER  TABLE t ADD COLUMN label text(32) NULL" },
    ]), [{ name: "first", status: "applied" }, { name: "second", status: "skipped" }]);
    assert.deepEqual(server.requests.map(({ line }) => line), ["HELLO 3",
      "MIGRATE 'first' CREATE TABLE t (n u8) CHUNK 4 x 4", "MIGRATE 'second' ALTER  TABLE t ADD COLUMN label text(32) NULL"]);
  } finally { await client.close(); await server.close(); }
});

test("migrations stop on the first server error with its code, cause, step and earlier results", async () => {
  const server = await startFakeServer(({ line }) => line === "HELLO 3" ? FAKE_HELLO :
    line.startsWith("MIGRATE 'first'") ? "+applied\r\n" : "-ERR CONFLICT migration second has different statement\r\n");
  const client = new ChunkClient({ port: server.port });
  try {
    await assert.rejects(client.migrate([
      { name: "first", statement: "CREATE TABLE t (n u8) CHUNK 4 x 4" },
      { name: "second", statement: "ALTER TABLE t ADD COLUMN label text(32) NULL" },
      { name: "third", statement: "DROP TABLE t" },
    ]), (error: unknown) => {
      assert.ok(error instanceof ChunkMigrationError);
      assert.equal(error.index, 1);
      assert.equal(error.migration.name, "second");
      assert.match(error.message, /second.*step 2.*CONFLICT/);
      assert.equal(error.code, "CONFLICT");
      assert.equal(error.phase, "response");
      assert.ok(error.cause instanceof ChunkServerError);
      assert.equal(error.cause.serverCode, "CONFLICT");
      assert.deepEqual(error.results, [{ name: "first", status: "applied" }]);
      return true;
    });
    assert.equal(server.requests.length, 3);
  } finally { await client.close(); await server.close(); }
});

test("migration names and framing are validated before connecting", async () => {
  const server = await startFakeServer(() => { throw new Error("unexpected request"); });
  const client = new ChunkClient({ port: server.port });
  try {
    for (const name of ["", "Upper", "a".repeat(64), "a'\r\nPING", "../name"]) {
      await assert.rejects(client.migrate([{ name, statement: "DROP TABLE t" }]), (error: unknown) =>
        error instanceof ChunkMigrationError && error.cause instanceof ChunkProtocolError && error.phase === "request");
    }
    for (const statement of ["", " \t", "DROP TABLE t\r", "DROP TABLE t\nPING", "DROP TABLE t\0", "GRANT $1 ON t TO bot"]) {
      await assert.rejects(client.migrate([{ name: "valid", statement }]), ChunkMigrationError);
    }
    assert.equal(server.connections, 0);
  } finally { await client.close(); await server.close(); }
});

test("malformed migration replies stop later steps and preserve the protocol cause", async () => {
  for (const reply of ["+OK\r\n", "$7\r\napplied\r\n", "_\r\n", ":1\r\n"]) {
    const server = await startFakeServer(({ line }) => line === "HELLO 3" ? FAKE_HELLO : reply);
    const client = new ChunkClient({ port: server.port });
    try {
      await assert.rejects(client.migrate([
        { name: "first", statement: "DROP TABLE t" }, { name: "later", statement: "DROP TABLE other" },
      ]), (error: unknown) => error instanceof ChunkMigrationError && error.index === 0 &&
        error.phase === "protocol" && error.cause instanceof ChunkProtocolError && error.results.length === 0);
      assert.equal(server.requests.length, 2);
    } finally { await client.close(); await server.close(); }
  }
});

test("migration table statements participate in schema cache invalidation", () => {
  for (const verb of ["CREATE", "ALTER", "DROP"]) {
    assert.equal(tableOfStatement(`MIGRATE 'step' ${verb} TABLE world`), "world");
  }
  assert.equal(tableOfStatement("MIGRATE 'step' CREATE SLOT 'consumer' ON world"), null);
});

test("migration transport failures retain their cause and do not retry or send later steps", async () => {
  const server = await startFakeServer(({ line }, socket) => {
    if (line === "HELLO 3") return FAKE_HELLO;
    socket.destroy();
    return null;
  });
  const client = new ChunkClient({ port: server.port });
  try {
    await assert.rejects(client.migrate([
      { name: "first", statement: "DROP TABLE t" }, { name: "later", statement: "DROP TABLE other" },
    ]), (error: unknown) => error instanceof ChunkMigrationError && error.index === 0 &&
      error.cause instanceof ChunkConnectionError && error.results.length === 0);
    assert.equal(server.requests.length, 2);
    assert.equal(server.connections, 1);
  } finally { await client.close(); await server.close(); }
});

test("a 63-byte name and parameter-like text inside a quoted literal remain valid", async () => {
  const name = "a".repeat(63);
  const statement = "ALTER TABLE t ADD COLUMN label text(32) DEFAULT '$1'";
  const server = await startFakeServer(({ line }) => {
    if (line === "HELLO 3") return FAKE_HELLO;
    assert.equal(line, `MIGRATE '${name}' ${statement}`);
    return "+applied\r\n";
  });
  const client = new ChunkClient({ port: server.port });
  try {
    assert.deepEqual(await client.migrate([{ name, statement }]), [{ name, status: "applied" }]);
  } finally { await client.close(); await server.close(); }
});
