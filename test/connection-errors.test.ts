import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { once } from "node:events";
import { ChunkClient, ChunkConnectionError, ChunkTimeoutError, ChunkTlsError, connectUri } from "../src/index";
import { FAKE_HELLO, startFakeServer } from "./fake-server";

test("connection refused names the endpoint and preserves native code and cause", async () => {
  const listener = net.createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  const client = new ChunkClient({ host: "127.0.0.1", port: address.port });
  try {
    await assert.rejects(client.connect(), (error: unknown) => {
      assert.ok(error instanceof ChunkConnectionError);
      assert.equal(error.code, "ECONNREFUSED");
      assert.ok(error.cause instanceof Error);
      assert.equal((error.cause as NodeJS.ErrnoException).code, "ECONNREFUSED");
      assert.match(error.message, new RegExp(`127\\.0\\.0\\.1:${address.port}`));
      assert.match(error.message, /start the server.*listen address and port/);
      return true;
    });
  } finally { await client.close(); }
});

test("TLS against a plaintext endpoint names the scheme and certificate checks", async () => {
  const sockets = new Set<net.Socket>();
  const listener = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.resume();
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  });
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  const client = new ChunkClient({ port: address.port, tls: true });
  try {
    await assert.rejects(client.connect(), (error: unknown) => {
      assert.ok(error instanceof ChunkTlsError);
      assert.match(error.message, /chunks:\/\/.*TLS-enabled server.*CA certificate and server name/);
      assert.ok(error.cause instanceof Error);
      assert.equal(error.code, (error.cause as NodeJS.ErrnoException).code);
      assert.ok(error.code);
      return true;
    });
  } finally {
    await client.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => listener.close(() => resolve()));
  }
});

test("TLS handshake timeout gives address, scheme and connect timeout guidance", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const sockets = new Set<net.Socket>();
  const listener = net.createServer((socket) => { sockets.add(socket); socket.resume(); });
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  const client = new ChunkClient({ port: address.port, tls: true, connectTimeoutMs: 100 });
  try {
    const accepted = once(listener, "connection");
    const rejected = assert.rejects(client.connect(), (error: unknown) => {
      assert.ok(error instanceof ChunkTimeoutError);
      assert.equal(error.command, "CONNECT");
      assert.match(error.message, /connection timeout after 100ms.*127\.0\.0\.1/);
      assert.match(error.message, /firewall.*chunk:\/\/ versus chunks:\/\/.*connectTimeoutMs/);
      return true;
    });
    // The deadline covers TCP establishment as well as TLS negotiation.
    // Advance it only after TCP acceptance, so host load cannot turn this
    // handshake fixture into a pre-accept connection timeout.
    await accepted;
    t.mock.timers.tick(100);
    await rejected;
    assert.equal(sockets.size, 1);
  } finally {
    await client.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => listener.close(() => resolve()));
  }
});

test("command timeout identifies the command and its timeout setting", async () => {
  const server = await startFakeServer(({ line }) => line === "HELLO 3" ? FAKE_HELLO : null);
  const client = new ChunkClient({ port: server.port, commandTimeoutMs: 100 });
  try {
    await assert.rejects(client.ping(), (error: unknown) => {
      assert.ok(error instanceof ChunkTimeoutError);
      assert.equal(error.command, "PING");
      assert.match(error.message, /PING command timeout after 100ms.*server and network.*commandTimeoutMs/);
      // The PING was written: its outcome is unknown.
      assert.equal(error.retryClass, "unknown_outcome");
      return true;
    });
  } finally { await client.close(); await server.close(); }
});

test("a close names the scheme check only before the login completes", async () => {
  const server = await startFakeServer(({ line }, socket) => {
    if (line.startsWith("HELLO 3 WITH client_name = 'early'")) {
      socket.end();
      return null;
    }
    if (line.startsWith("HELLO 3")) return FAKE_HELLO;
    socket.end();
    return null;
  });
  const early = new ChunkClient({ port: server.port, helloOptions: { client_name: "early" } });
  const late = new ChunkClient({ port: server.port });
  try {
    await assert.rejects(early.connect(), (error: unknown) => {
      assert.ok(error instanceof ChunkConnectionError);
      assert.match(error.message, /chunk:\/\/ uses plaintext and chunks:\/\/ uses TLS/);
      return true;
    });
    await late.connect();
    // A connection closed after login, as by KILL CONNECTION, is not a scheme mismatch.
    await assert.rejects(late.ping(), (error: unknown) => {
      assert.ok(error instanceof ChunkConnectionError);
      assert.match(error.message, /^the outcome of PING is unknown: connection closed; check the server log$/);
      assert.equal(error.retryClass, "unknown_outcome");
      return true;
    });
  } finally {
    await early.close();
    await late.close();
    await server.close();
  }
});

test("a reset during connect points to chunk:// versus chunks://", async () => {
  const sockets = new Set<net.Socket>();
  const listener = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("data", () => socket.resetAndDestroy());
  });
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  const client = new ChunkClient({ host: "127.0.0.1", port: address.port });
  try {
    await assert.rejects(client.connect(), (error: unknown) => {
      assert.ok(error instanceof ChunkConnectionError);
      assert.equal(error.code, "ECONNRESET");
      assert.match(error.message, new RegExp(`connection reset by 127\\.0\\.0\\.1:${address.port}; check that chunk:// uses plaintext and chunks:// uses TLS`));
      return true;
    });
  } finally {
    await client.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => listener.close(() => resolve()));
  }
});

test("a user without a password fails before connecting", async () => {
  let connections = 0;
  const listener = net.createServer((socket) => { connections++; socket.destroy(); });
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  const client = new ChunkClient({ uri: `chunk://admin@127.0.0.1:${address.port}/` });
  try {
    await assert.rejects(client.connect(), (error: unknown) => {
      assert.ok(error instanceof ChunkConnectionError);
      assert.equal(error.phase, "connect");
      assert.match(error.message, /names user admin without a password; use chunk:\/\/admin:PASSWORD@host:4242\/ or the password option/);
      return true;
    });
    assert.equal(connections, 0);
  } finally {
    await client.close();
    await new Promise<void>((resolve) => listener.close(() => resolve()));
  }
});

test("connectUri refuses a missing URI instead of using the defaults", async () => {
  await assert.rejects(connectUri(undefined as unknown as string), (error: unknown) => {
    assert.ok(error instanceof ChunkConnectionError);
    assert.match(error.message, /connectUri needs a chunk URI, got undefined; .*chunk:\/\/user:password@host:4242\/table/);
    return true;
  });
  await assert.rejects(connectUri(""), /got an empty string/);
});

test("a connection lost after a request was written reports an unknown outcome", async () => {
  let pings = 0;
  const server = await startFakeServer(({ line }, socket) => {
    if (line.startsWith("HELLO 3")) return FAKE_HELLO;
    // The second PING closes the connection; neither PING gets a reply.
    pings += 1;
    if (pings === 2) socket.destroy();
    return null;
  });
  const client = new ChunkClient({ port: server.port, pipelineDepth: 2 });
  try {
    await client.connect();
    // Two requests are written; the third waits for room and is never sent.
    const results = await Promise.allSettled([client.ping(), client.ping(), client.ping()]);
    const errors = results.map((result) => {
      assert.equal(result.status, "rejected");
      assert.ok(result.reason instanceof ChunkConnectionError, String(result.reason));
      return result.reason;
    });
    for (const error of errors.slice(0, 2)) {
      assert.equal(error.retryClass, "unknown_outcome");
      assert.equal(error.command, "PING");
      assert.match(error.message, /^the outcome of PING is unknown: /);
    }
    assert.equal(errors[2].retryClass, undefined);
    assert.equal(pings, 2);
  } finally { await client.close(); await server.close(); }
});
