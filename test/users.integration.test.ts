import test from "node:test";
import assert from "node:assert/strict";

import {
  ChunkAuthError,
  ChunkClient,
  ChunkPermissionError,
  ChunkServerError,
  connect,
  connectUri,
} from "../src/index";
import { startServer } from "./helpers";

function authError(code: string, command: string) {
  return (error: unknown) => {
    assert.ok(error instanceof ChunkAuthError, String(error));
    assert.equal(error.serverCode, code);
    assert.equal(error.phase, "auth");
    assert.equal(error.command, command);
    return true;
  };
}

test("users log in with SCRAM-SHA-256; wrong, unknown and missing logins fail typed", async () => {
  const server = await startServer();
  try {
    // The URI carries the password percent-encoded: it holds ' ', '@', ':' and '/'.
    const admin = await connectUri(server.uri);
    assert.match(admin.serverInfo()?.serverSignature ?? "", /^v=[A-Za-z0-9+/]{43}=$/);
    assert.equal(await admin.ping(), "PONG");
    await admin.close();

    const options = { host: server.host, port: server.port };
    await assert.rejects(connect({ ...options, user: "admin", password: "wrong" }), authError("AUTH_FAILED", "AUTH"));
    await assert.rejects(connect({ ...options, user: "ghost", password: server.password }), authError("AUTH_FAILED", "AUTH"));
    await assert.rejects(connect(options), authError("AUTH_REQUIRED", "HELLO"));

    // Options win over the URI's credentials.
    const overridden = await connectUri(`chunk://ghost:x@${server.host}:${server.port}/`, {
      user: server.user,
      password: server.password,
    });
    assert.equal(await overridden.ping(), "PONG");
    await overridden.close();
  } finally {
    await server.stop();
  }
});

// The test server has two workers, and a connection holds one: at most two
// are open at once.
test("users and rights end to end", async () => {
  const server = await startServer();
  const opened: ChunkClient[] = [];
  const login = async (user: string, password: string) => {
    const client = await connect({ host: server.host, port: server.port, user, password, table: "world" });
    opened.push(client);
    return client;
  };
  try {
    const admin = await login(server.user, server.password);
    await admin.createTable("world", { columns: [{ name: "id", type: "u8" }], chunk: { width: 4, height: 4 } });
    await admin.setBlock(1, 1, { id: 7 });
    await admin.createUser("bot", "hunter2");
    await admin.grant("READ", "world", "bot");

    const bot = await login("bot", "hunter2");
    assert.deepEqual(await bot.getBlock(1, 1), { id: 7 });
    assert.deepEqual(await bot.listTables(), ["world"]);
    await assert.rejects(bot.setBlock(1, 1, { id: 8 }), (error: unknown) => {
      assert.ok(error instanceof ChunkPermissionError);
      assert.equal(error.serverCode, "PERMISSION_DENIED");
      assert.equal(error.serverMessage, "WRITE on world");
      assert.equal(error.command, "SET BLOCK");
      return true;
    });
    await assert.rejects(bot.createUser("eve", "x"), ChunkPermissionError);
    await assert.rejects(bot.listUsers(), ChunkPermissionError);

    assert.deepEqual(await admin.listUsers(), [
      { name: "admin", managesUsers: true, grants: { "*": "ADMIN" } },
      { name: "bot", managesUsers: false, grants: { world: "READ" } },
    ]);

    // A user changes their own password; the old one no longer logs in.
    await bot.setPassword("bot", "n3w pass");
    await bot.close();
    await assert.rejects(login("bot", "hunter2"), authError("AUTH_FAILED", "AUTH"));
    const again = await login("bot", "n3w pass");

    // Rights change at once, also for connections already logged in: a
    // table without any right reads as absent.
    await admin.revoke("READ", "world", "bot");
    await assert.rejects(again.getBlock(1, 1), (error: unknown) => error instanceof ChunkServerError && error.serverCode === "NO_TABLE");
    await admin.grant("WRITE", "*", "bot");
    assert.equal(typeof (await again.setBlock(2, 2, { id: 9 })), "bigint");

    await admin.setManagesUsers("bot", true);
    assert.equal((await again.listUsers()).find((user) => user.name === "bot")?.managesUsers, true);
    await admin.setManagesUsers("bot", false);
    await again.close();
    await admin.dropUser("bot");
    assert.deepEqual((await admin.listUsers()).map((user) => user.name), ["admin"]);
    await assert.rejects(login("bot", "n3w pass"), authError("AUTH_FAILED", "AUTH"));
  } finally {
    await Promise.all(opened.map((client) => client.close()));
    await server.stop();
  }
});

test("a server with --auth none takes HELLO 3 without a user", async () => {
  const server = await startServer({ auth: "none" });
  try {
    const client = await connectUri(server.uri);
    assert.equal(server.uri, `chunk://${server.host}:${server.port}/`);
    assert.equal(client.serverInfo()?.serverSignature, null);
    assert.deepEqual(await client.listTables(), ["default"]);
    await client.close();
    await assert.rejects(
      connect({ host: server.host, port: server.port, user: "admin", password: "x" }),
      (error: unknown) => error instanceof ChunkServerError && /runs without users/.test(error.serverMessage),
    );
  } finally {
    await server.stop();
  }
});
