import test from "node:test";
import assert from "node:assert/strict";

import {
  ChunkBits,
  ChunkClient,
  ChunkProtocolError,
  ChunkServerError,
  ChunkVersionMismatchError,
  connectUri,
  type ChunkClient as Client,
} from "../src/index";
import { startServer } from "./helpers";

function serverError(code: string, message?: RegExp) {
  return (error: unknown) =>
    error instanceof ChunkServerError && error.serverCode === code && (message === undefined || message.test(error.serverMessage));
}

// A table of every column type.
async function createKinds(client: Client): Promise<void> {
  await client.createTable("kinds", {
    columns: [
      { name: "id", type: "u10", required: true },
      { name: "temp", type: "i8", nullable: true },
      { name: "solid", type: "bool" },
      { name: "h", type: "f32" },
      { name: "d", type: "f64" },
      { name: "wide", type: "u64" },
      { name: "neg", type: "i64" },
      { name: "mask", type: "bits(3)", nullable: true },
      { name: "name", type: "text(16)", nullable: true },
      { name: "blob", type: "bytes(8)" },
      { name: "light", type: "u4", default: 15 },
    ],
    chunk: { width: 4, height: 4 },
  });
}

test("HELLO 3, ping, FLUSH WAL, SHOW METRICS and the default table", async () => {
  const server = await startServer();
  try {
    const client = await connectUri(server.uri);
    const info = client.serverInfo();
    assert.ok(info !== null);
    assert.equal(info.protocol, 3);
    assert.equal(info.maxParameters, 65535);
    assert.equal(info.maxAreaChunks, 256);
    assert.equal(info.maxScanLimit, 1024);
    assert.ok(info.maxLineBytes > 0 && info.maxResponseBytes > 0 && info.serverVersion !== "");
    assert.equal(await client.ping(), "PONG");
    await client.flushWal();
    assert.match(await client.metrics(), /^# (HELP|TYPE) /m);
    assert.deepEqual(await client.listTables(), ["default"]);
    assert.equal(client.defaultTable(), "default");

    // The default table: one bits(16) column.
    const schema = await client.describe();
    assert.equal(schema.table, "default");
    assert.deepEqual(schema.columns.map((column) => column.typeName), ["bits(16)"]);
    const version = await client.setBlock(0, 0, { bits: ChunkBits.from("1011001110110011") });
    assert.equal(typeof version, "bigint");
    const row = await client.getBlock(0, 0);
    assert.ok(row !== null && row.bits instanceof ChunkBits);
    assert.equal(row.bits.toString(), "1011001110110011");
    assert.equal(await client.getBlock(1, 0), null);
    await client.close();
  } finally {
    await server.stop();
  }
});

test("typed values round-trip through blocks", async () => {
  const server = await startServer();
  try {
    const client = await connectUri(`${server.uri}kinds`);
    await createKinds(client);
    assert.equal(client.defaultTable(), "kinds");

    const values = {
      id: 1023,
      temp: -128,
      solid: true,
      h: 0.1,
      d: -2e-300,
      wide: (1n << 64n) - 1n,
      neg: -(1n << 63n),
      mask: ChunkBits.from("101"),
      name: "it's ünïcødé",
      blob: Buffer.from([0x00, 0x0d, 0x0a, 0x24, 0x2d, 0x31, 0x0d, 0x0a]),
    };
    await client.setBlock(-5, 7, values);
    const row = await client.getBlock(-5, 7);
    assert.deepEqual(row, { ...values, h: Math.fround(0.1), light: 15 });

    // A new block takes defaults: NULL, zero or empty, and DEFAULT.
    await client.setBlock(1, 1, { id: 1 });
    assert.deepEqual(await client.getBlock(1, 1), {
      id: 1,
      temp: null,
      solid: false,
      h: 0,
      d: 0,
      wide: 0n,
      neg: 0n,
      mask: null,
      name: null,
      blob: Buffer.alloc(0),
      light: 15,
    });

    // NULL, inf and nan; text with CR and LF; bytes of zeros.
    await client.setBlock(1, 1, {
      temp: null,
      h: Number.NEGATIVE_INFINITY,
      d: Number.NaN,
      name: "a\r\nb",
      blob: Buffer.alloc(8),
    });
    const special = await client.getBlock(1, 1, { columns: ["d", "h", "name", "blob", "temp"] });
    assert.ok(special !== null);
    assert.deepEqual(Object.keys(special), ["d", "h", "name", "blob", "temp"]);
    assert.ok(Number.isNaN(special.d));
    assert.equal(special.h, Number.NEGATIVE_INFINITY);
    assert.equal(special.name, "a\r\nb");
    assert.deepEqual(special.blob, Buffer.alloc(8));
    assert.equal(special.temp, null);

    // An empty text value of a NULL column stays empty.
    await client.setBlock(1, 1, { name: "" });
    assert.deepEqual(await client.getBlock(1, 1, { columns: ["name"] }), { name: "" });

    // deleteBlock answers the chunk version; the block reads as absent.
    const deleted = await client.deleteBlock(-5, 7);
    assert.equal(typeof deleted, "bigint");
    assert.equal(await client.getBlock(-5, 7), null);

    // The server refuses what the client cannot check, and the connection
    // stays usable.
    await assert.rejects(client.setBlock(2, 2, { temp: 1 }), serverError("INVALID_ARGUMENT", /REQUIRED/));
    await assert.rejects(client.getBlock(0, 0, { table: "nowhere" }), serverError("NO_TABLE"));
    // The client refuses values that do not fit before sending them.
    await assert.rejects(client.setBlock(2, 2, { id: 1024 }), ChunkProtocolError);
    await assert.rejects(client.setBlock(2, 2, { name: "x".repeat(17) }), /at most 16 bytes/);
    await assert.rejects(client.setBlock(2, 2, { id: 1, solid: null }), /cannot be NULL/);
    await assert.rejects(client.setBlock(2, 2, { nope: 1 }), /no column nope/);
    assert.equal(await client.ping(), "PONG");
    await client.close();
  } finally {
    await server.stop();
  }
});

test("IF VERSION writes only at the version, else VERSION_MISMATCH", async () => {
  const server = await startServer();
  try {
    const client = await connectUri(server.uri);
    await createKinds(client);
    const options = { table: "kinds" };
    const first = await client.setBlock(0, 0, { id: 1 }, options);
    // Another block of the chunk changes its version.
    const second = await client.setBlock(3, 3, { id: 2 }, options);
    assert.notEqual(second, first);

    await assert.rejects(client.setBlock(0, 0, { id: 9 }, { ...options, ifVersion: first }), (error: unknown) => {
      assert.ok(error instanceof ChunkVersionMismatchError);
      assert.equal(error.currentVersion, second);
      return true;
    });
    assert.deepEqual(await client.getBlock(0, 0, { ...options, columns: ["id"] }), { id: 1 });
    const third = await client.setBlock(0, 0, { id: 9 }, { ...options, ifVersion: second });
    await assert.rejects(client.deleteBlock(0, 0, { ...options, ifVersion: second }), ChunkVersionMismatchError);
    await client.deleteBlock(0, 0, { ...options, ifVersion: third });
    assert.equal(await client.getBlock(0, 0, options), null);
    await client.close();
  } finally {
    await server.stop();
  }
});

test("pipelined statements keep their order and replies", async () => {
  const server = await startServer();
  try {
    const client = new ChunkClient({ uri: `${server.uri}kinds`, pipelineDepth: 16 });
    await createKinds(client);
    client.clearSchemaCache();
    // Writes and reads issued without awaiting, from a cold schema cache.
    const pending: Array<Promise<unknown>> = [];
    for (let i = 0; i < 40; i += 1) {
      pending.push(client.setBlock(i, 0, { id: i, name: `n${i}` }));
      pending.push(client.getBlock(i, 0, { columns: ["id", "name"] }));
      if (i % 5 === 0) {
        pending.push(client.deleteBlock(i, 0));
        pending.push(client.getBlock(i, 0));
      }
    }
    const results = await Promise.all(pending);
    let at = 0;
    for (let i = 0; i < 40; i += 1) {
      assert.equal(typeof results[at], "bigint");
      assert.deepEqual(results[at + 1], { id: i, name: `n${i}` });
      at += 2;
      if (i % 5 === 0) {
        assert.equal(typeof results[at], "bigint");
        assert.equal(results[at + 1], null);
        at += 2;
      }
    }
    await client.close();
  } finally {
    await server.stop();
  }
});

test("execute sends a statement with parameter frames", async () => {
  const server = await startServer();
  try {
    const client = await connectUri(server.uri);
    await createKinds(client);
    const reply = await client.execute("SET BLOCK 4 4 IN kinds id = $1, name = $2, blob = $3", [
      Buffer.from("0700000000000000", "hex"),
      null,
      Uint8Array.of(0x0d, 0x0a, 0x00),
    ]);
    assert.equal(reply.type, "integer");
    assert.deepEqual(await client.execute("GET BLOCK 4 4 FROM kinds COLUMNS id, name, blob"), {
      type: "array",
      items: [{ type: "integer", value: 7n }, { type: "null" }, { type: "bulk", value: Buffer.from([0x0d, 0x0a, 0x00]) }],
    });
    // A parameter is never part of the statement.
    await client.execute("SET BLOCK 4 4 IN kinds name = $1", [Buffer.from("'; DROP TABLE t")]);
    assert.deepEqual(await client.listTables(), ["default", "kinds"]);
    await assert.rejects(client.execute("GET BLOCK 0 0 FROM kinds;"), serverError("SYNTAX"));
    // A frame longer than its column holds is refused unread and the server
    // closes the connection; the next statement reconnects.
    await assert.rejects(
      client.execute("SET BLOCK 4 4 IN kinds name = $1", [Buffer.alloc(17)]),
      serverError("BAD_REQUEST", /longer than its column holds/),
    );
    assert.equal(await client.ping(), "PONG");
    await client.close();
  } finally {
    await server.stop();
  }
});
