import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { ChunkClient, ChunkConnectionError, ChunkTimeoutError, ChunkTlsError } from "../src/index";
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

test("TLS handshake timeout gives address, scheme and connect timeout guidance", async () => {
  const sockets = new Set<net.Socket>();
  const listener = net.createServer((socket) => { sockets.add(socket); socket.resume(); });
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  const client = new ChunkClient({ port: address.port, tls: true, connectTimeoutMs: 100 });
  try {
    await assert.rejects(client.connect(), (error: unknown) => {
      assert.ok(error instanceof ChunkTimeoutError);
      assert.equal(error.command, "CONNECT");
      assert.match(error.message, /connection timeout after 100ms.*127\.0\.0\.1/);
      assert.match(error.message, /firewall.*chunk:\/\/ versus chunks:\/\/.*connectTimeoutMs/);
      return true;
    });
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
      return true;
    });
  } finally { await client.close(); await server.close(); }
});
