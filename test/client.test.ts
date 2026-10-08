import test from "node:test";
import assert from "node:assert/strict";

import {
  ChunkAuthError,
  ChunkClient,
  ChunkConnectionError,
  ChunkProtocolError,
  ChunkTimeoutError,
  ChunkVersionMismatchError,
  connect,
} from "../src/index";
import { FAKE_HELLO, startFakeServer, type FakeRequest } from "./fake-server";

// DESCRIBE of `t (id u10 REQUIRED, h <hType>)`, 4 x 4 blocks.
function describeReply(hType: string): string {
  const bulk = (text: string) => `$${Buffer.byteLength(text)}\r\n${text}\r\n`;
  const column = (id: number, name: string, type: string, required: boolean) =>
    `%6\r\n${bulk("id")}:${id}\r\n${bulk("name")}${bulk(name)}${bulk("type")}${bulk(type)}${bulk("null")}#f\r\n` +
    `${bulk("required")}${required ? "#t" : "#f"}\r\n${bulk("default")}_\r\n`;
  return (
    `%6\r\n${bulk("table")}${bulk("t")}${bulk("version")}:1\r\n${bulk("columns")}*2\r\n` +
    column(1, "id", "u10", true) +
    column(2, "h", hType, false) +
    `${bulk("chunk")}*2\r\n:4\r\n:4\r\n${bulk("large")}*2\r\n:8\r\n:8\r\n${bulk("options")}%6\r\n` +
    `${bulk("durability_mode")}${bulk("relaxed")}${bulk("checkpoint_updates")}:256\r\n` +
    `${bulk("checkpoint_wal_bytes")}:1048576\r\n${bulk("wal_group_commit_updates")}:8\r\n` +
    `${bulk("checkpoint_compression")}${bulk("none")}${bulk("var_max_chunk_bytes")}:1048576\r\n`
  );
}

function hello(request: FakeRequest): string | null {
  return request.line.startsWith("HELLO 3") ? FAKE_HELLO : null;
}

test("an older chunkdb is reported as speaking an older protocol", async () => {
  for (const [reply, pattern] of [
    ["-ERR PROTOCOL expected HELLO 2\r\n", /older protocol 2/],
    ["-ERR UNKNOWN_COMMAND unknown command 'HELLO'\r\n", /chunkdb 1\.x/],
  ] as const) {
    const server = await startFakeServer((_, socket) => {
      socket.end(reply);
      return null;
    });
    try {
      await assert.rejects(connect({ port: server.port, token: "secret" }), (error: unknown) => {
        assert.ok(error instanceof ChunkProtocolError);
        assert.match(error.message, pattern);
        assert.match(error.message, /needs a chunkdb server of protocol 3/);
        return true;
      });
    } finally {
      await server.close();
    }
  }
});

test("HELLO sends the token and exposes the server's limits", async () => {
  const server = await startFakeServer((request) =>
    request.line === "HELLO 3 AUTH secret" ? FAKE_HELLO : "-ERR AUTH_FAILED wrong token\r\n",
  );
  try {
    const client = await connect({ port: server.port, token: "secret" });
    assert.deepEqual(client.serverInfo(), {
      protocol: 3,
      serverVersion: "test",
      maxLineBytes: 65536,
      maxParameters: 65535,
      maxAreaChunks: 256,
      maxResponseBytes: 67108864,
      maxScanLimit: 1024,
    });
    await client.close();
    await assert.rejects(connect({ port: server.port, token: "wrong" }), ChunkAuthError);
    await assert.rejects(connect({ port: server.port, token: "two words" }), /without spaces/);
  } finally {
    await server.close();
  }
});

test("pipelined statements reach the server in call order", async () => {
  let version = 100;
  const server = await startFakeServer(async (request) => {
    if (request.line.startsWith("DESCRIBE")) {
      // A slow schema fetch: what follows must still wait for its statement.
      await new Promise((resolve) => setTimeout(resolve, 30));
      return describeReply("f32");
    }
    if (request.line.startsWith("SET BLOCK") || request.line.startsWith("DELETE BLOCK")) {
      version += 1;
      return `:${version}\r\n`;
    }
    if (request.line.startsWith("GET BLOCK")) {
      return "*2\r\n:7\r\n,2.5\r\n";
    }
    return hello(request) ?? "+PONG\r\n";
  });
  try {
    const client = new ChunkClient({ port: server.port, table: "t", pipelineDepth: 8 });
    const results = await Promise.all([
      client.setBlock(0, 0, { id: 7, h: 2.5 }),
      client.deleteBlock(1, 0),
      client.getBlock(0, 0),
      client.ping(),
      client.setBlock(2, 0, { h: 1 }, { ifVersion: 101n }),
    ]);
    assert.deepEqual(results, [101n, 102n, { id: 7, h: 2.5 }, "PONG", 103n]);
    assert.deepEqual(
      server.requests.map((request) => request.line),
      [
        "HELLO 3",
        "DESCRIBE t",
        "SET BLOCK 0 0 IN t id = $1, h = $2",
        "DELETE BLOCK 1 0 FROM t",
        "GET BLOCK 0 0 FROM t COLUMNS id, h",
        "PING",
        "SET BLOCK 2 0 IN t h = $1 IF VERSION 101",
      ],
    );
    assert.deepEqual(server.requests[2].frames, [Buffer.from("0700000000000000", "hex"), Buffer.from("00002040", "hex")]);
    await client.close();
  } finally {
    await server.close();
  }
});

test("a frame of the wrong size refreshes the schema and retries once", async () => {
  let hType = "f32";
  const server = await startFakeServer((request) => {
    if (request.line.startsWith("DESCRIBE")) {
      const reply = describeReply(hType);
      // Another client changes the column after this DESCRIBE.
      hType = "f64";
      return reply;
    }
    if (request.line.startsWith("SET BLOCK")) {
      const frame = request.frames[0];
      return frame !== null && frame.length === 8
        ? ":5\r\n"
        : `-ERR INVALID_ARGUMENT $1 for column h (f64) must be 8 bytes, got ${frame?.length ?? 0}\r\n`;
    }
    return hello(request);
  });
  try {
    const client = await connect({ port: server.port, table: "t" });
    assert.equal(await client.setBlock(0, 0, { h: 0.5 }), 5n);
    assert.deepEqual(
      server.requests.slice(1).map((request) => [request.line, request.frames[0]?.length]),
      [
        ["DESCRIBE t", undefined],
        ["SET BLOCK 0 0 IN t h = $1", 4],
        ["DESCRIBE t", undefined],
        ["SET BLOCK 0 0 IN t h = $1", 8],
      ],
    );
    assert.equal((await client.describe()).columns[1].typeName, "f64");
    await client.close();
  } finally {
    await server.close();
  }
});

test("VERSION_MISMATCH rejects with the current version", async () => {
  const server = await startFakeServer((request) =>
    request.line.startsWith("DELETE") ? "-ERR VERSION_MISMATCH current=18446744073709551615\r\n" : hello(request),
  );
  try {
    const client = await connect({ port: server.port });
    await assert.rejects(client.deleteBlock(0, 0, { ifVersion: 3n }), (error: unknown) => {
      assert.ok(error instanceof ChunkVersionMismatchError);
      assert.equal(error.serverCode, "VERSION_MISMATCH");
      assert.equal(error.currentVersion, (1n << 64n) - 1n);
      assert.equal(error.command, "DELETE BLOCK");
      return true;
    });
    assert.equal(server.requests[1].line, "DELETE BLOCK 0 0 FROM default IF VERSION 3");
    await client.close();
  } finally {
    await server.close();
  }
});

test("statements that cannot be framed are refused before sending", async () => {
  const server = await startFakeServer((request) => hello(request) ?? "+OK\r\n");
  try {
    const client = await connect({ port: server.port });
    await assert.rejects(client.execute("PING\r\nPING"), /one line/);
    await assert.rejects(client.getBlock(0.5, 0), /x must be a safe integer/);
    await assert.rejects(client.getBlock(0, 0, { table: "Bad-Name" }), /a table name must match/);
    await assert.rejects(client.deleteBlock(0, 0, { ifVersion: -1n }), /ifVersion/);
    await assert.rejects(client.execute(`SHOW ${"x".repeat(70000)}`), /takes at most 65536/);
    await assert.rejects(
      client.createTable("t", { columns: [{ name: "a", type: "text(4)", default: "a\nb" }], chunk: { width: 4, height: 4 } }),
      /CR or LF/,
    );
    assert.deepEqual(server.requests.map((request) => request.line), ["HELLO 3"]);
    await client.close();
  } finally {
    await server.close();
  }
});

test("table statements are written from their definitions", async () => {
  const server = await startFakeServer((request) => hello(request) ?? "+OK\r\n");
  try {
    const client = await connect({ port: server.port });
    await client.createTable("land", {
      columns: [
        { name: "id", type: "u10", required: true },
        { name: "light", type: { kind: "u", bits: 4 }, default: 15 },
        { name: "sign", type: "text(8)", nullable: true, default: "it's" },
        { name: "h", type: "f32", default: 1.5 },
      ],
      chunk: { width: 16, height: 16 },
      large: { width: 8, height: 8 },
      options: { durabilityMode: "fsync-wal", varMaxChunkBytes: 4096 },
    });
    await client.alterTable("land", { kind: "addColumn", column: { name: "depth", type: "i8", nullable: true } });
    await client.alterTable("land", { kind: "dropColumn", column: "depth" });
    await client.alterTable("land", { kind: "renameColumn", column: "sign", to: "label" });
    await client.alterTable("land", { kind: "alterColumnType", column: "light", type: "u2", using: "clamp" });
    await client.alterTable("land", { kind: "setOption", option: "checkpointUpdates", value: 64 });
    await client.alterTable("land", { kind: "setOption", option: "durabilityMode", value: "relaxed" });
    await client.dropTable("land");
    assert.deepEqual(server.requests.slice(1).map((request) => request.line), [
      "CREATE TABLE land (id u10 REQUIRED, light u4 DEFAULT 15, sign text(8) NULL DEFAULT 'it''s', h f32 DEFAULT 1.5) " +
        "CHUNK 16 x 16 LARGE 8 x 8 WITH durability_mode = 'fsync-wal', var_max_chunk_bytes = 4096",
      "ALTER TABLE land ADD COLUMN depth i8 NULL",
      "ALTER TABLE land DROP COLUMN depth",
      "ALTER TABLE land RENAME COLUMN sign TO label",
      "ALTER TABLE land ALTER COLUMN light TYPE u2 USING CLAMP",
      "ALTER TABLE land SET checkpoint_updates = 64",
      "ALTER TABLE land SET durability_mode = 'relaxed'",
      "DROP TABLE land",
    ]);
    await client.close();
  } finally {
    await server.close();
  }
});

test("a statement without a reply times out and the client reconnects", async () => {
  let pings = 0;
  const server = await startFakeServer((request) => {
    if (request.line === "PING") {
      pings += 1;
      return pings === 1 ? null : "+PONG\r\n";
    }
    return hello(request);
  });
  try {
    const client = new ChunkClient({ port: server.port, commandTimeoutMs: 100 });
    await assert.rejects(client.ping(), ChunkTimeoutError);
    assert.equal(await client.ping(), "PONG");
    assert.equal(server.connections, 2);
    await client.close();
    await assert.rejects(client.ping(), ChunkConnectionError);
  } finally {
    await server.close();
  }
});
