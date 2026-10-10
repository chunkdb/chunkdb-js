import test from "node:test";
import assert from "node:assert/strict";

import {
  ChunkAuthError,
  ChunkClient,
  ChunkConnectionError,
  ChunkPermissionError,
  ChunkProtocolError,
  ChunkServerError,
  ChunkTimeoutError,
  ChunkVersionMismatchError,
  connect,
  connectPool,
} from "../src/index";
import { FAKE_HELLO, describeReply, scramResponder, startFakeServer, type FakeRequest } from "./fake-server";

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
      await assert.rejects(connect({ port: server.port, user: "bot", password: "secret" }), (error: unknown) => {
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

test("HELLO without a user exposes the server's limits", async () => {
  const server = await startFakeServer((request) =>
    request.line === "HELLO 3" ? FAKE_HELLO : "-ERR SYNTAX unexpected\r\n",
  );
  try {
    const client = await connect({ port: server.port });
    assert.deepEqual(client.serverInfo(), {
      protocol: 3,
      serverVersion: "test",
      maxLineBytes: 65536,
      maxParameters: 65535,
      maxAreaChunks: 256,
      maxResponseBytes: 67108864,
      maxScanLimit: 1024,
      serverSignature: null,
    });
    await client.close();
    assert.deepEqual(server.requests.map((request) => request.frames.length), [0]);
  } finally {
    await server.close();
  }
});

test("a user logs in with SCRAM-SHA-256 and the password never crosses the wire", async () => {
  const password = "p@ss: word";
  const server = await startFakeServer(scramResponder("bot", password));
  try {
    const client = await connect({ uri: `chunk://bot:${encodeURIComponent(password)}@127.0.0.1:${server.port}/` });
    assert.match(client.serverInfo()?.serverSignature ?? "", /^v=[A-Za-z0-9+/]+=*$/);
    await client.close();
    assert.deepEqual(server.requests.map((request) => request.line), ["HELLO 3 USER bot $1", "AUTH $1"]);
    const first = server.requests[0].frames[0]?.toString("utf8") ?? "";
    assert.match(first, /^n,,n=bot,r=[A-Za-z0-9+/]{24}$/);
    assert.match(server.requests[1].frames[0]?.toString("utf8") ?? "", /^c=biws,r=[^,]+,p=[A-Za-z0-9+/]{43}=$/);
    for (const request of server.requests) {
      assert.ok(!request.frames.some((frame) => frame?.includes(password)));
    }

    await assert.rejects(connect({ port: server.port, user: "bot", password: "wrong" }), (error: unknown) => {
      assert.ok(error instanceof ChunkAuthError);
      assert.equal(error.serverCode, "AUTH_FAILED");
      assert.equal(error.phase, "auth");
      assert.equal(error.command, "AUTH");
      return true;
    });
  } finally {
    await server.close();
  }
});

test("a server that cannot prove it knows the password is refused", async () => {
  for (const signature of ["v=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", "v=", "_"]) {
    const respond = scramResponder("bot", "secret", { signature: signature === "_" ? undefined : signature });
    const server = await startFakeServer((request) => {
      const reply = respond(request);
      // A server signature of null: the HELLO map of a login without a user.
      return signature === "_" && reply?.startsWith("%") ? FAKE_HELLO : reply;
    });
    try {
      await assert.rejects(connect({ port: server.port, user: "bot", password: "secret" }), (error: unknown) => {
        assert.ok(error instanceof ChunkConnectionError);
        assert.equal(error.phase, "auth");
        assert.match(error.message, /could not prove it knows the password/);
        return true;
      });
    } finally {
      await server.close();
    }
  }
});

test("a server-first message that does not continue the login is refused", async () => {
  const server = await startFakeServer((request) =>
    request.line.startsWith("HELLO") ? "+SCRAM r=someone-else,s=QUJDREVGR0hJSktMTU5PUA==,i=4096\r\n" : null,
  );
  try {
    await assert.rejects(connect({ port: server.port, user: "bot", password: "secret" }), /does not continue the client nonce/);
  } finally {
    await server.close();
  }
});

test("credentials are checked before connecting", () => {
  assert.throws(() => new ChunkClient({ user: "Bot", password: "x" }), /a user name must match/);
  assert.throws(() => new ChunkClient({ user: "bot two" }), /a user name must match/);
  assert.throws(() => new ChunkClient({ password: "x" }), /a password needs a user/);
  assert.throws(() => new ChunkClient({ user: "bot", verifierIterations: 1000 }), /at least 4096/);
});

test("users statements send verifiers and map their errors", async () => {
  const server = await startFakeServer((request) => {
    if (request.line.startsWith("HELLO")) {
      return FAKE_HELLO;
    }
    if (request.line === "SHOW USERS") {
      const bulk = (text: string) => `$${text.length}\r\n${text}\r\n`;
      return (
        `*2\r\n%3\r\n${bulk("name")}${bulk("admin")}${bulk("manages_users")}#t\r\n${bulk("grants")}%1\r\n${bulk("*")}${bulk("ADMIN")}` +
        `%3\r\n${bulk("name")}${bulk("bot")}${bulk("manages_users")}#f\r\n${bulk("grants")}%2\r\n` +
        `${bulk("__proto__")}${bulk("READ")}${bulk("world")}${bulk("WRITE")}`
      );
    }
    if (request.line === "DROP USER admin") {
      return "-ERR PERMISSION_DENIED MANAGES USERS\r\n";
    }
    if (request.line === "DROP USER ghost") {
      return "-ERR INVALID_ARGUMENT user ghost does not exist\r\n";
    }
    return "+OK\r\n";
  });
  try {
    const client = await connect({ port: server.port, verifierIterations: 5000 });
    await client.createUser("bot", "hunter2", { managesUsers: true });
    await client.setPassword("bot", "new");
    await client.setManagesUsers("bot", false);
    await client.grant("READ", "world", "bot");
    await client.revoke("WRITE", "*", "bot");
    await client.dropUser("bot");
    assert.deepEqual(await client.listUsers(), [
      { name: "admin", managesUsers: true, grants: { "*": "ADMIN" } },
      { name: "bot", managesUsers: false, grants: Object.fromEntries([["__proto__", "READ"], ["world", "WRITE"]]) },
    ]);
    await assert.rejects(client.dropUser("admin"), (error: unknown) => {
      assert.ok(error instanceof ChunkPermissionError && error instanceof ChunkServerError);
      assert.equal(error.serverCode, "PERMISSION_DENIED");
      assert.equal(error.serverMessage, "MANAGES USERS");
      return true;
    });
    await assert.rejects(client.dropUser("ghost"), (error: unknown) => !(error instanceof ChunkPermissionError) && error instanceof ChunkServerError);
    await assert.rejects(client.grant("OWNER" as "READ", "world", "bot"), /a right is READ, WRITE or ADMIN/);
    await assert.rejects(client.grant("READ", "a b", "bot"), /a table name/);
    await assert.rejects(client.createUser("Bot", "x"), /a user name must match/);
    await client.close();

    const lines = server.requests.map((request) => request.line);
    assert.deepEqual(lines.slice(1, 8), [
      "CREATE USER bot VERIFIER $1 MANAGES USERS",
      "ALTER USER bot VERIFIER $1",
      "ALTER USER bot NO MANAGES USERS",
      "GRANT READ ON world TO bot",
      "REVOKE WRITE ON * FROM bot",
      "DROP USER bot",
      "SHOW USERS",
    ]);
    for (const request of server.requests.slice(1, 3)) {
      const verifier = request.frames[0]?.toString("utf8") ?? "";
      assert.match(verifier, /^SCRAM-SHA-256\$5000:[A-Za-z0-9+/]{22}==\$[A-Za-z0-9+/]{43}=:[A-Za-z0-9+/]{43}=$/);
    }
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
      options: { durabilityMode: "fsync-wal", varMaxChunkBytes: 4096, feedBufferBytes: 2097152, slotMaxBytes: 4194304 },
    });
    await client.alterTable("land", { kind: "addColumn", column: { name: "depth", type: "i8", nullable: true } });
    await client.alterTable("land", { kind: "dropColumn", column: "depth" });
    await client.alterTable("land", { kind: "renameColumn", column: "sign", to: "label" });
    await client.alterTable("land", { kind: "alterColumnType", column: "light", type: "u2", using: "clamp" });
    await client.alterTable("land", { kind: "setOption", option: "checkpointUpdates", value: 64 });
    await client.alterTable("land", { kind: "setOption", option: "durabilityMode", value: "relaxed" });
    await client.alterTable("land", { kind: "setOption", option: "feedBufferBytes", value: 3145728 });
    await client.alterTable("land", { kind: "setOption", option: "slotMaxBytes", value: 5242880 });
    await client.dropTable("land");
    assert.deepEqual(server.requests.slice(1).map((request) => request.line), [
      "CREATE TABLE land (id u10 REQUIRED, light u4 DEFAULT 15, sign text(8) NULL DEFAULT 'it''s', h f32 DEFAULT 1.5) " +
        "CHUNK 16 x 16 LARGE 8 x 8 WITH durability_mode = 'fsync-wal', var_max_chunk_bytes = 4096, feed_buffer_bytes = 2097152, slot_max_bytes = 4194304",
      "ALTER TABLE land ADD COLUMN depth i8 NULL",
      "ALTER TABLE land DROP COLUMN depth",
      "ALTER TABLE land RENAME COLUMN sign TO label",
      "ALTER TABLE land ALTER COLUMN light TYPE u2 USING CLAMP",
      "ALTER TABLE land SET checkpoint_updates = 64",
      "ALTER TABLE land SET durability_mode = 'relaxed'",
      "ALTER TABLE land SET feed_buffer_bytes = 3145728",
      "ALTER TABLE land SET slot_max_bytes = 5242880",
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


test("never-written chunks are null; versioned empty forms remain decoded", async (t) => {
  for (const mode of ["client", "pool", "transaction"] as const) {
    await t.test(mode, async () => {
      const form = Buffer.alloc(16 + 2 + 20 + 64);
      form.writeBigUInt64LE(7n, 0);
      form.writeBigUInt64LE(1n, 8);
      const server = await startFakeServer((request) => {
        if (request.line.startsWith("HELLO")) return FAKE_HELLO;
        if (request.line.startsWith("DESCRIBE")) return describeReply("f32");
        if (request.line.startsWith("GET CHUNK 8 8 ")) return "_\r\n";
        if (request.line.startsWith("GET CHUNK")) return Buffer.concat([Buffer.from(`$${form.length}\r\n`), form, Buffer.from("\r\n")]);
        if (request.line === "BEGIN" || request.line === "ROLLBACK") return "+OK\r\n";
        if (request.line === "COMMIT") return "_\r\n";
        return "-ERR SYNTAX unexpected\r\n";
      });
      const client = mode === "pool" ? await connectPool({ port: server.port, table: "t", maxConnections: 1 }) : await connect({ port: server.port, table: "t" });
      const check = async (reader: Pick<typeof client, "getChunk" | "getChunkRaw">) => {
        assert.equal(await reader.getChunk(8, 8), null);
        assert.equal(await reader.getChunkRaw(8, 8), null);
        const empty = await reader.getChunk(9, 9);
        assert.ok(empty);
        assert.equal(empty.version, 7n);
        assert.ok(empty.present.every((present) => !present));
        assert.deepEqual(await reader.getChunkRaw(9, 9), form);
      };
      try {
        if (mode === "transaction") await client.transaction(check);
        else await check(client);
      } finally {
        await client.close();
        await server.close();
      }
    });
  }
});


test("DESCRIBE exposes per-table feed and slot limits", async () => {
  const server = await startFakeServer((request) => hello(request) ?? describeReply("f32"));
  try {
    const client = await connect({ port: server.port });
    const schema = await client.describe("t");
    assert.equal(schema.options.feedBufferBytes, 67108864);
    assert.equal(schema.options.slotMaxBytes, 1073741824);
    await client.close();
  } finally {
    await server.close();
  }
});
