import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import {
  ChunkClient, ChunkConnectionError, ChunkInvalidArgumentError, ChunkPool, ChunkProtocolError, ChunkServerError, encodeStatement,
} from "../src/index";
import { FAKE_HELLO, describeReply, startFakeServer } from "./fake-server";

function gate() {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => { open = resolve; });
  return { wait, open };
}

// Inspect the writes synchronously, even if TCP has yet to deliver some of them.
function observeWrites(t: TestContext, port: number) {
  const write = t.mock.method(net.Socket.prototype, "write");
  return () => write.mock.calls.flatMap(({ this: socket, arguments: args }) =>
    socket instanceof net.Socket && socket.remotePort === port && Buffer.isBuffer(args[0])
      ? [args[0].toString("utf8").split("\r\n", 1)[0]] : []);
}

test("the default sends eight requests before their replies and matches a semantic error in order", { timeout: 5000 }, async (t) => {
  const entered = gate(), release = gate();
  const server = await startFakeServer(async ({ line }) => {
    if (line === "HELLO 3") return FAKE_HELLO;
    if (line === "TEST 0") { entered.open(); await release.wait; }
    if (line === "TEST 4") return "-ERR INVALID_ARGUMENT reason=parameter_width wrong width\r\n";
    return `:${line.slice(5)}\r\n`;
  });
  const client = new ChunkClient({ port: server.port });
  try {
    await client.connect();
    const writes = observeWrites(t, server.port);
    const lines = Array.from({ length: 10 }, (_, index) => `TEST ${index}`);
    const pending = Promise.allSettled(lines.map((line) => client.execute(line)));
    await entered.wait;
    assert.deepEqual(writes(), lines.slice(0, 8));
    release.open();
    const results = await pending;
    for (const [index, result] of results.entries()) {
      if (index === 4) {
        assert.equal(result.status, "rejected");
        assert.ok(result.reason instanceof ChunkInvalidArgumentError);
      } else {
        assert.deepEqual(result, { status: "fulfilled", value: { type: "integer", value: BigInt(index) } });
      }
    }
    assert.deepEqual(writes(), lines);
    assert.equal(server.connections, 1);
  } finally { release.open(); await client.close(); await server.close(); }
});

test("pool leases honor sequential mode and reject a request above the byte cap", { timeout: 5000 }, async (t) => {
  const entered = gate(), release = gate();
  let pings = 0;
  const server = await startFakeServer(async ({ line }) => {
    if (line === "HELLO 3") return FAKE_HELLO;
    if (++pings === 1) { entered.open(); await release.wait; }
    return "+PONG\r\n";
  });
  // Both PINGs fit the byte cap; the depth is what holds the second one.
  const pool = new ChunkPool({ port: server.port, maxConnections: 1, pipelineDepth: 1, pipelineBytes: 12 });
  try {
    await pool.withClient(async (client) => {
      const writes = observeWrites(t, server.port);
      const pending = Promise.all([client.ping(), client.ping()]);
      await entered.wait;
      assert.deepEqual(writes(), ["PING"]);
      release.open();
      assert.deepEqual(await pending, ["PONG", "PONG"]);
      await assert.rejects(client.execute("LONGER REQUEST"), /pipelineBytes allows 12/);
      assert.deepEqual(writes(), ["PING", "PING"]);
    });
  } finally { release.open(); await pool.close(); await server.close(); }
});

test("the byte bound counts UTF-8, frame headers, NULL and terminators without letting requests overtake", { timeout: 5000 }, async (t) => {
  const entered = gate(), release = gate();
  const first = "TEST 'é' $1 $2";
  const frames = [Buffer.from([1, 2, 3]), null];
  const second = "TEST 'longer'";
  const budget = encodeStatement(first, frames).length + encodeStatement(second).length - 1;
  const server = await startFakeServer(async ({ line }) => {
    if (line === "HELLO 3") return FAKE_HELLO;
    if (line === first) { entered.open(); await release.wait; }
    return line === "PING" ? "+PONG\r\n" : "+OK\r\n";
  });
  const client = new ChunkClient({ port: server.port, pipelineBytes: budget });
  try {
    await client.connect();
    const writes = observeWrites(t, server.port);
    const pending = Promise.all([client.execute(first, frames), client.execute(second), client.ping()]);
    await entered.wait;
    assert.deepEqual(writes(), [first]);
    release.open();
    assert.deepEqual(await pending, [{ type: "simple", value: "OK" }, { type: "simple", value: "OK" }, "PONG"]);
    assert.deepEqual(writes(), [first, second, "PING"]);
    assert.deepEqual(server.requests[1].frames, frames);
  } finally { release.open(); await client.close(); await server.close(); }
});

for (const [code, detail] of [
  ["PROTOCOL", "reason=protocol invalid frame"],
  ["BUSY", "reason=input_budget input byte budget is full"],
  ["INVALID_ARGUMENT", "reason=invalid_argument the parameters of one statement take at most 10 bytes together"],
] as const) {
  test(`a closing ${code} reply rejects written, byte-blocked and queued tails before reconnect`, { timeout: 5000 }, async (t) => {
    const entered = gate(), release = gate();
    const server = await startFakeServer(async ({ line }) => {
      if (line === "HELLO 3") return FAKE_HELLO;
      if (line === "FIRST") {
        entered.open();
        await release.wait;
        return `:1\r\n-ERR ${code} ${detail}\r\n:999\r\n`;
      }
      return line === "PING" ? "+PONG\r\n" : null;
    });
    const client = new ChunkClient({ port: server.port, pipelineDepth: 4, pipelineBytes: 19 });
    try {
      await client.connect();
      const writes = observeWrites(t, server.port);
      const pending = Promise.allSettled([
        client.execute("FIRST"), client.execute("FAIL"), client.execute("TAIL"),
        client.execute("HOLD_LONG_CREDIT"), client.execute("QUEUED"),
      ]);
      await entered.wait;
      assert.deepEqual(writes(), ["FIRST", "FAIL", "TAIL"]);
      release.open();
      const [first, failed, tail, byteBlocked, queued] = await pending;
      assert.deepEqual(first, { status: "fulfilled", value: { type: "integer", value: 1n } });
      assert.equal(failed.status, "rejected");
      assert.ok(failed.reason instanceof ChunkServerError);
      assert.equal(failed.reason.serverCode, code);
      for (const [result, retryClass] of [[tail, "unknown_outcome"], [byteBlocked, undefined], [queued, undefined]] as const) {
        assert.equal(result.status, "rejected");
        assert.ok(result.reason instanceof ChunkConnectionError);
        assert.equal(result.reason.retryClass, retryClass);
      }
      assert.equal(server.connections, 1);
      assert.equal(await client.ping(), "PONG");
      assert.equal(server.connections, 2);
      assert.deepEqual(server.requests.slice(-2).map(({ line }) => line), ["HELLO 3", "PING"]);
    } finally { release.open(); await client.close(); await server.close(); }
  });
}

test("raw BEGIN, its statements and COMMIT run one at a time", { timeout: 5000 }, async (t) => {
  const entered = gate(), release = gate();
  const first = "SET BLOCK 0 0 IN t h = 1";
  const second = "SET BLOCK 1 0 IN t h = 2";
  const server = await startFakeServer(async ({ line }) => {
    if (line === "HELLO 3") return FAKE_HELLO;
    if (line === first) { entered.open(); await release.wait; }
    if (line.startsWith("SET BLOCK")) return "_\r\n";
    if (line === "COMMIT") return ":42\r\n";
    return line === "BEGIN" ? "+OK\r\n" : "+PONG\r\n";
  });
  const client = new ChunkClient({ port: server.port });
  try {
    await client.connect();
    const writes = observeWrites(t, server.port);
    const pending = Promise.all([
      client.execute("BEGIN"), client.execute(first), client.execute(second), client.execute("COMMIT"), client.ping(),
    ]);
    await entered.wait;
    assert.deepEqual(writes(), ["BEGIN", first]);
    release.open();
    assert.deepEqual((await pending).slice(1), [
      { type: "null" }, { type: "null" }, { type: "integer", value: 42n }, "PONG",
    ]);
    assert.deepEqual(writes(), ["BEGIN", first, second, "COMMIT", "PING"]);
  } finally { release.open(); await client.close(); await server.close(); }
});

test("a lost raw transaction cannot send its remaining statements on a new connection", { timeout: 5000 }, async () => {
  const server = await startFakeServer(({ line }, socket) => {
    if (line === "HELLO 3") return FAKE_HELLO;
    if (line === "BEGIN") return "+OK\r\n";
    if (line.startsWith("SET BLOCK")) { socket.destroy(); return null; }
    return "+PONG\r\n";
  });
  const client = new ChunkClient({ port: server.port });
  try {
    await client.execute("BEGIN");
    const first = "SET BLOCK 0 0 IN t h = 1", second = "SET BLOCK 1 0 IN t h = 2";
    const pending = await Promise.allSettled([client.execute(first), client.execute(second)]);
    for (const result of pending) {
      assert.equal(result.status, "rejected");
      assert.ok(result.reason instanceof ChunkConnectionError);
      assert.equal(result.reason.retryClass, undefined);
    }
    await assert.rejects(client.execute(second), /rolled the transaction back/);
    await assert.rejects(client.execute("ROLLBACK"), /rolled the transaction back/);
    assert.equal(await client.ping(), "PONG");
    assert.deepEqual(server.requests.map(({ line }) => line), ["HELLO 3", "BEGIN", first, "HELLO 3", "PING"]);
  } finally { await client.close(); await server.close(); }
});

test("a raw COMMIT without a reply reports an unknown outcome and releases its session", { timeout: 5000 }, async () => {
  const server = await startFakeServer(({ line }, socket) => {
    if (line === "HELLO 3") return FAKE_HELLO;
    if (line === "BEGIN") return "+OK\r\n";
    if (line === "COMMIT") { socket.destroy(); return null; }
    return "+PONG\r\n";
  });
  const client = new ChunkClient({ port: server.port });
  try {
    await client.execute("BEGIN");
    await assert.rejects(client.execute("COMMIT"), (error: unknown) =>
      error instanceof ChunkConnectionError && error.command === "COMMIT" && error.retryClass === "unknown_outcome");
    assert.equal(await client.ping(), "PONG");
    assert.deepEqual(server.requests.map(({ line }) => line), ["HELLO 3", "BEGIN", "COMMIT", "HELLO 3", "PING"]);
  } finally { await client.close(); await server.close(); }
});

test("a managed transaction reserves its place before a later call on a cold connection", { timeout: 5000 }, async () => {
  const server = await startFakeServer(({ line }) => {
    if (line === "HELLO 3") return FAKE_HELLO;
    if (line === "BEGIN") return "+OK\r\n";
    if (line === "COMMIT") return "_\r\n";
    return "+PONG\r\n";
  });
  const client = new ChunkClient({ port: server.port });
  try {
    assert.deepEqual(await Promise.all([client.transaction(() => {}), client.ping()]), [null, "PONG"]);
    assert.deepEqual(server.requests.map(({ line }) => line), ["HELLO 3", "BEGIN", "COMMIT", "PING"]);
  } finally { await client.close(); await server.close(); }
});

test("a refused COMMIT rolls back before queued ordinary calls reuse the connection", { timeout: 5000 }, async () => {
  const server = await startFakeServer(({ line }) => {
    if (line === "HELLO 3") return FAKE_HELLO;
    if (line === "BEGIN" || line === "ROLLBACK") return "+OK\r\n";
    if (line === "COMMIT") return "-ERR RATE_LIMITED reason=statements_per_sec refused before execution\r\n";
    return "+PONG\r\n";
  });
  const client = new ChunkClient({ port: server.port });
  try {
    const rejected = assert.rejects(client.transaction(() => {}), (error: unknown) =>
      error instanceof ChunkServerError && error.serverCode === "RATE_LIMITED");
    const after = client.ping();
    await rejected;
    assert.equal(await after, "PONG");
    assert.deepEqual(server.requests.map(({ line }) => line), ["HELLO 3", "BEGIN", "COMMIT", "ROLLBACK", "PING"]);
  } finally { await client.close(); await server.close(); }
});

test("a self-kill delivers its acknowledgment and discards queued calls", { timeout: 5000 }, async () => {
  const hello = FAKE_HELLO.replace("%8\r\n", "%9\r\n") + "$13\r\nconnection_id\r\n:42\r\n";
  const server = await startFakeServer(({ line }) => {
    if (line === "HELLO 3") return hello;
    if (line === "KILL CONNECTION 42") return "%1\r\n$6\r\nkilled\r\n#t\r\n";
    return "+PONG\r\n";
  });
  const client = await new ChunkClient({ port: server.port }).connect();
  try {
    const [kill, queued] = await Promise.allSettled([client.killConnection(42n), client.ping()]);
    assert.deepEqual(kill, { status: "fulfilled", value: true });
    assert.equal(queued.status, "rejected");
    assert.ok(queued.reason instanceof ChunkConnectionError);
    assert.equal(queued.reason.retryClass, undefined);
    assert.equal(await client.ping(), "PONG");
    assert.deepEqual(server.requests.map(({ line }) => line), ["HELLO 3", "KILL CONNECTION 42", "HELLO 3", "PING"]);
  } finally { await client.close(); await server.close(); }
});

test("raw WATCH drains prior replies, and UNWATCH gates the return to ordinary requests", { timeout: 5000 }, async (t) => {
  const pingEntered = gate(), pingRelease = gate(), watchEntered = gate(), watchRelease = gate();
  const unwatchEntered = gate(), unwatchRelease = gate();
  let firstPing = true;
  const server = await startFakeServer(async ({ line }) => {
    if (line === "HELLO 3") return FAKE_HELLO;
    if (line === "WATCH t") {
      watchEntered.open(); await watchRelease.wait;
      return "+OK 0123456789abcdef0123456789abcdef 0\r\n>1\r\n+progress\r\n";
    }
    if (line === "UNWATCH") { unwatchEntered.open(); await unwatchRelease.wait; return "+OK\r\n"; }
    if (firstPing) { firstPing = false; pingEntered.open(); await pingRelease.wait; }
    return "+PONG\r\n";
  });
  const client = new ChunkClient({ port: server.port });
  try {
    await client.connect();
    const writes = observeWrites(t, server.port);
    const before = client.ping();
    const watch = client.execute("WATCH t");
    const refused = assert.rejects(client.ping(), /WATCH connection only accepts UNWATCH/);
    const unwatch = client.execute("UNWATCH");
    const after = client.ping();
    await pingEntered.wait;
    assert.deepEqual(writes(), ["PING"]);
    pingRelease.open();
    await watchEntered.wait;
    assert.deepEqual(writes(), ["PING", "WATCH t"]);
    watchRelease.open();
    await unwatchEntered.wait;
    assert.deepEqual(writes(), ["PING", "WATCH t", "UNWATCH"]);
    unwatchRelease.open();
    await refused;
    assert.deepEqual(await Promise.all([before, watch, unwatch, after]), [
      "PONG", { type: "simple", value: "OK 0123456789abcdef0123456789abcdef 0" }, { type: "simple", value: "OK" }, "PONG",
    ]);
  } finally {
    pingRelease.open(); watchRelease.open(); unwatchRelease.open();
    await client.close(); await server.close();
  }
});

test("local failures preserve send order and schema changes wait for a fresh layout", { timeout: 5000 }, async (t) => {
  const entered = gate(), release = gate();
  let type = "f32";
  const server = await startFakeServer(async ({ line, frames }) => {
    if (line === "HELLO 3") return FAKE_HELLO;
    if (line === "DESCRIBE t") { entered.open(); await release.wait; return describeReply(type); }
    if (line.startsWith("ALTER TABLE")) { type = "f64"; return "+OK\r\n"; }
    if (line.startsWith("SET BLOCK")) return `:${frames[0]?.length}\r\n`;
    return "+PONG\r\n";
  });
  const client = new ChunkClient({ port: server.port, table: "t" });
  try {
    await client.connect();
    const writes = observeWrites(t, server.port);
    const first = client.setBlock(0, 0, { h: 1.5 });
    const rejected = assert.rejects(client.execute("TEST $1"), ChunkProtocolError);
    const ping = client.ping();
    const alter = client.alterTable("t", { kind: "alterColumnType", column: "h", type: "f64" });
    const second = client.setBlock(1, 0, { h: 2.5 });
    await entered.wait;
    assert.deepEqual(writes(), ["DESCRIBE t"]);
    release.open();
    await rejected;
    assert.deepEqual(await Promise.all([first, ping, alter, second]), [4n, "PONG", undefined, 8n]);
    assert.deepEqual(writes(), [
      "DESCRIBE t", "SET BLOCK 0 0 IN t h = $1", "PING", "ALTER TABLE t ALTER COLUMN h TYPE f64",
      "DESCRIBE t", "SET BLOCK 1 0 IN t h = $1",
    ]);
  } finally { release.open(); await client.close(); await server.close(); }
});
