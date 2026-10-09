import test from "node:test";
import assert from "node:assert/strict";
import type { Socket } from "node:net";

import { ChunkClient, ChunkConnectionError, ChunkPool, ChunkProtocolError, ChunkServerError, ChunkTimeoutError, parseReply, type ChunkReply } from "../src/index";
import { ReplyReader } from "../src/protocol";
import { describeReply, FAKE_HELLO, startFakeServer } from "./fake-server";

const EPOCH = "0123456789abcdef0123456789abcdef";
const bulk = (text: string) => `$${Buffer.byteLength(text)}\r\n${text}\r\n`;
const resync = (revision = 2) => `>3\r\n${bulk("resync")}${bulk(EPOCH)}:${revision}\r\n`;
const change = (revision = 2, version = 1, value = ":7\r\n", coordinate = ":-1\r\n") =>
  `>7\r\n${bulk("change")}${bulk(EPOCH)}:${revision}\r\n:1234\r\n_\r\n:${version}\r\n*1\r\n*4\r\n${coordinate}:2\r\n_\r\n*2\r\n:3\r\n${value}`;

function encode(reply: ChunkReply): string {
  switch (reply.type) {
    case "bulk": return `$${reply.value.length}\r\n${reply.value.toString("latin1")}\r\n`;
    case "simple": return `+${reply.value}\r\n`;
    case "integer": return `:${reply.value}\r\n`;
    case "boolean": return `#${reply.value ? "t" : "f"}\r\n`;
    case "double": return `,${reply.value}\r\n`;
    case "null": return "_\r\n";
    case "array": case "push": return `${reply.type === "array" ? "*" : ">"}${reply.items.length}\r\n${reply.items.map(encode).join("")}`;
    case "map": return `%${reply.entries.length}\r\n${reply.entries.flatMap(([key, value]) => [encode(key), encode(value)]).join("")}`;
    case "error": return `-ERR ${reply.code} ${reply.message}\r\n`;
  }
}

function schema(version: number, type: string): string {
  const reply = parseReply(Buffer.from(describeReply(type)))!.reply;
  assert.equal(reply.type, "map");
  const columns = reply.entries.find(([key]) => key.type === "bulk" && key.value.toString() === "columns")![1];
  return `>5\r\n${bulk("schema")}${bulk(EPOCH)}:3\r\n:${version}\r\n${encode(columns)}`;
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test("WATCH pushes parse across every byte boundary", () => {
  const wire = Buffer.from(change() + schema(2, "u64") + resync());
  const expected = ["change", "schema", "resync"];
  for (const step of [1, 2, 7, wire.length]) {
    const reader = new ReplyReader();
    const kinds: string[] = [];
    for (let offset = 0; offset < wire.length; offset += step) {
      reader.push(wire.subarray(offset, offset + step));
      for (let reply = reader.next(); reply !== null; reply = reader.next()) {
        assert.equal(reply.type, "push");
        assert.equal(reply.items[0].type, "bulk");
        kinds.push(reply.items[0].value.toString());
      }
    }
    assert.deepEqual(kinds, expected);
  }
  assert.throws(() => parseReply(Buffer.from(">-1\r\n")), ChunkProtocolError);
});

test("WATCH has a dedicated socket, start and typed values", async () => {
  const server = await startFakeServer(({ line }) => {
    if (line === "HELLO 3") return FAKE_HELLO;
    if (line === "DESCRIBE t") return describeReply("u64");
    if (line === "WATCH t AREA -2 -1 TO 3 4 AFTER " + EPOCH + " 1") return `+OK ${EPOCH} 1\r\n` + change(2, 1, ":18446744073709551615\r\n");
    if (line === "PING") return "+PONG\r\n";
    if (line === "UNWATCH") return "+OK\r\n";
    throw new Error(line);
  });
  const client = new ChunkClient({ port: server.port });
  try {
    await client.connect();
    const watch = await client.watch("t", { area: { cx0: -2, cy0: -1, cx1: 3, cy1: 4 }, after: { epoch: EPOCH, revision: 1n } });
    assert.deepEqual(watch.start, { epoch: EPOCH, revision: 1n });
    assert.equal(await client.ping(), "PONG");
    assert.equal(server.connections, 3);
    assert.deepEqual(await watch.next(), { done: false, value: { kind: "change", position: { epoch: EPOCH, revision: 2n }, commitTimeMs: 1234n, user: null, schemaVersion: 1,
      blocks: [{ x: -1n, y: 2n, before: null, after: { id: 3, h: 18446744073709551615n } }] } });
    await watch.close();
    assert.equal(await client.ping(), "PONG");
  } finally { await client.close(); await server.close(); }
});

test("WATCH caches schemas by version and preserves overflow coordinates", async () => {
  const server = await startFakeServer(({ line }) => {
    if (line === "HELLO 3") return FAKE_HELLO;
    if (line === "DESCRIBE t") return describeReply("u8");
    if (line === "WATCH t") return `+OK ${EPOCH} 1\r\n` + schema(2, "u64") + change(4, 2, ":9007199254740993\r\n", "*2\r\n:9223372036854775807\r\n:3\r\n") + change(5, 1) + resync(6);
    if (line === "UNWATCH") return "+OK\r\n";
    throw new Error(line);
  });
  const client = new ChunkClient({ port: server.port });
  try {
    const watch = await client.watch("t");
    const event = (await watch.next()).value;
    assert.equal(event.kind, "schema");
    assert.equal(event.version, 2);
    assert.equal(event.columns[1].typeName, "u64");
    const wide = (await watch.next()).value;
    assert.equal(wide.kind, "change");
    assert.deepEqual(wide.blocks[0].x, { chunk: 9223372036854775807n, offset: 3 });
    assert.equal(wide.blocks[0].after!.h, 9007199254740993n);
    const older = (await watch.next()).value;
    assert.equal(older.kind, "change");
    assert.equal(older.blocks[0].after!.h, 7);
    assert.deepEqual((await watch.next()).value, { kind: "resync", position: { epoch: EPOCH, revision: 6n } });
    assert.equal(server.requests.filter(({ line }) => line === "DESCRIBE t").length, 1);
    await watch.close();
  } finally { await client.close(); await server.close(); }
});

test("WATCH fetches an uncached event schema on another socket", async () => {
  let descriptions = 0;
  const server = await startFakeServer(({ line }) => {
    if (line === "HELLO 3") return FAKE_HELLO;
    if (line === "DESCRIBE t") {
      descriptions += 1;
      return descriptions === 1 ? describeReply("u8") : describeReply("u64").replace(`${bulk("version")}:1`, `${bulk("version")}:2`);
    }
    if (line === "WATCH t") return `+OK ${EPOCH} 1\r\n` + change(2, 2, ":9007199254740993\r\n");
    if (line === "UNWATCH") return "+OK\r\n";
    throw new Error(line);
  });
  const client = new ChunkClient({ port: server.port });
  try {
    const watch = await client.watch("t");
    const event = (await watch.next()).value;
    assert.equal(event.kind, "change");
    assert.equal(event.blocks[0].after!.h, 9007199254740993n);
    assert.equal(descriptions, 2);
    assert.equal(server.connections, 3);
    await watch.close();
  } finally { await client.close(); await server.close(); }
});

test("WATCH refuses to decode an unavailable historical schema", async () => {
  const server = await startFakeServer(({ line }) => {
    if (line === "HELLO 3") return FAKE_HELLO;
    if (line === "DESCRIBE t") return describeReply("u8");
    if (line === "WATCH t") return `+OK ${EPOCH} 1\r\n` + change(2, 9);
    throw new Error(line);
  });
  const client = new ChunkClient({ port: server.port });
  try {
    const watch = await client.watch("t");
    await assert.rejects(watch.next(), (error: unknown) => error instanceof ChunkProtocolError && /version 9 is unavailable/.test(error.message));
    await watch.close();
  } finally { await client.close(); await server.close(); }
});

test("WATCH close drains pushes and waits for UNWATCH acknowledgment", async () => {
  const unwatch = deferred();
  const acknowledge = deferred();
  const server = await startFakeServer(async ({ line }) => {
    if (line === "HELLO 3") return FAKE_HELLO;
    if (line === "DESCRIBE t") return describeReply("u8");
    // More than the receive queue: close must resume and drain it.
    if (line === "WATCH t") return `+OK ${EPOCH} 1\r\n` + resync().repeat(128);
    if (line === "UNWATCH") { unwatch.resolve(); await acknowledge.promise; return resync(3) + "+OK\r\n"; }
    throw new Error(line);
  });
  const client = new ChunkClient({ port: server.port });
  try {
    const watch = await client.watch("t");
    let closed = false;
    const closing = watch.close().then(() => { closed = true; });
    assert.equal(watch.close(), watch.close());
    await unwatch.promise;
    assert.equal(closed, false);
    acknowledge.resolve();
    await closing;
    assert.deepEqual(await watch.next(), { done: true, value: undefined });
    assert.equal(server.requests.filter(({ line }) => line === "UNWATCH").length, 1);
  } finally { acknowledge.resolve(); await client.close(); await server.close(); }
});

test("WATCH close wakes idle and concurrent next calls", async () => {
  const server = await startFakeServer(({ line }) => {
    if (line === "HELLO 3") return FAKE_HELLO;
    if (line === "DESCRIBE t") return describeReply("u8");
    if (line === "WATCH t") return `+OK ${EPOCH} 1\r\n`;
    if (line === "UNWATCH") return "+OK\r\n";
    throw new Error(line);
  });
  const client = new ChunkClient({ port: server.port, commandTimeoutMs: 100 });
  try {
    const watch = await client.watch("t");
    const pending = [watch.next(), watch.next()];
    await watch.close();
    assert.deepEqual(await Promise.all(pending), [{ done: true, value: undefined }, { done: true, value: undefined }]);
  } finally { await client.close(); await server.close(); }
});

test("WATCH transport loss ends iteration without reconnecting", async () => {
  const watching = deferred<Socket>();
  const server = await startFakeServer(({ line }, socket) => {
    if (line === "HELLO 3") return FAKE_HELLO;
    if (line === "DESCRIBE t") return describeReply("u8");
    if (line === "WATCH t") { watching.resolve(socket); return `+OK ${EPOCH} 1\r\n`; }
    throw new Error(line);
  });
  const client = new ChunkClient({ port: server.port });
  try {
    const watch = await client.watch("t");
    const next = watch.next();
    (await watching.promise).destroy();
    await assert.rejects(next, ChunkConnectionError);
    await assert.rejects(watch.next(), ChunkConnectionError);
    await watch.close();
    assert.equal(server.connections, 2);
    assert.equal(server.requests.some(({ line }) => line === "UNWATCH"), false);
  } finally { await client.close(); await server.close(); }
});

test("WATCH errors at startup and during streaming retain their codes", async () => {
  for (const code of ["NO_TABLE", "BUSY"]) {
    const socketReady = deferred<Socket>();
    let rejectStart = true;
    const server = await startFakeServer(({ line }, socket) => {
      if (line === "HELLO 3") return FAKE_HELLO;
      if (line === "DESCRIBE t") return describeReply("u8");
      if (line === "WATCH t") {
        if (rejectStart) return `-ERR ${code} refused\r\n`;
        socketReady.resolve(socket);
        return `+OK ${EPOCH} 1\r\n`;
      }
      throw new Error(line);
    });
    const client = new ChunkClient({ port: server.port });
    try {
      const typed = (error: unknown) => error instanceof ChunkServerError && error.serverCode === code;
      await assert.rejects(client.watch("t"), typed);
      rejectStart = false;
      const watch = await client.watch("t");
      const next = watch.next();
      (await socketReady.promise).write(`-ERR ${code} ended\r\n`);
      await assert.rejects(next, typed);
      await watch.close();
    } finally { await client.close(); await server.close(); }
  }
});

test("WATCH validates options before opening any socket", async () => {
  const client = new ChunkClient();
  await assert.rejects(client.watch("t\r\nPING"), ChunkProtocolError);
  await assert.rejects(client.watch("t", { after: { epoch: "no", revision: 1n } }), ChunkProtocolError);
  await assert.rejects(client.watch("t", { after: { epoch: EPOCH, revision: -1n } }), ChunkProtocolError);
  await assert.rejects(client.watch("t", { area: { cx0: 1, cy0: 0, cx1: 0, cy1: 0 } }), ChunkProtocolError);
  await client.close();
  await assert.rejects(client.watch("t"), ChunkConnectionError);
});

test("WATCH fails malformed event rows and unsolicited replies", async () => {
  for (const frame of [change().replace("*2\r\n:3\r\n:7\r\n", "*1\r\n:3\r\n"), "+PONG\r\n", ">3\r\n" + bulk("other") + bulk(EPOCH) + ":2\r\n"]) {
    const ready = deferred<Socket>();
    const server = await startFakeServer(({ line }, socket) => {
      if (line === "HELLO 3") return FAKE_HELLO;
      if (line === "DESCRIBE t") return describeReply("u8");
      if (line === "WATCH t") { ready.resolve(socket); return `+OK ${EPOCH} 1\r\n`; }
      throw new Error(line);
    });
    const client = new ChunkClient({ port: server.port });
    try {
      const watch = await client.watch("t");
      const next = watch.next();
      (await ready.promise).write(frame);
      await assert.rejects(next, ChunkProtocolError);
      await watch.close();
    } finally { await client.close(); await server.close(); }
  }
});

test("WATCH UNWATCH timeout closes the dedicated socket", async () => {
  const server = await startFakeServer(({ line }) => {
    if (line === "HELLO 3") return FAKE_HELLO;
    if (line === "DESCRIBE t") return describeReply("u8");
    if (line === "WATCH t") return `+OK ${EPOCH} 1\r\n`;
    if (line === "UNWATCH") return null;
    throw new Error(line);
  });
  const client = new ChunkClient({ port: server.port, commandTimeoutMs: 100 });
  try {
    const watch = await client.watch("t");
    await assert.rejects(watch.close(), ChunkTimeoutError);
    assert.deepEqual(await watch.next(), { done: true, value: undefined });
  } finally { await client.close(); await server.close(); }
});

test("pool WATCH uses dedicated connections and for-await break closes it", async () => {
  const server = await startFakeServer(({ line }) => {
    if (line === "HELLO 3") return FAKE_HELLO;
    if (line === "DESCRIBE t") return describeReply("u8");
    if (line === "WATCH t") return `+OK ${EPOCH} 1\r\n` + resync();
    if (line === "UNWATCH") return "+OK\r\n";
    if (line === "PING") return "+PONG\r\n";
    throw new Error(line);
  });
  const pool = new ChunkPool({ port: server.port, maxConnections: 1 });
  try {
    const watch = await pool.watch("t");
    assert.equal(await pool.ping(), "PONG");
    for await (const event of watch) { assert.equal(event.kind, "resync"); break; }
    assert.equal(server.requests.filter(({ line }) => line === "UNWATCH").length, 1);
    assert.equal(await pool.ping(), "PONG");
    await pool.close();
    await assert.rejects(pool.watch("t"), ChunkConnectionError);
  } finally { await pool.close(); await server.close(); }
});
