import test from "node:test";
import assert from "node:assert/strict";
import net, { type Socket } from "node:net";

import {
  ChunkClient,
  ChunkConnectionError,
  ChunkTimeoutError,
  ChunkPool,
  connectPool,
} from "../src/index";

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface PingServer {
  readonly host: string;
  readonly port: number;
  readonly totalConnections: number;
  readonly peakConnections: number;
  readonly requestCount: number;
  waitForConnections(count: number): Promise<void>;
  waitForRequests(count: number): Promise<void>;
  respondNext(payload?: string): void;
  close(): Promise<void>;
}

async function startPingServer(options: { autoRespond?: boolean } = {}): Promise<PingServer> {
  const host = "127.0.0.1";
  let totalConnections = 0;
  let openConnections = 0;
  let peakConnections = 0;
  let requestCount = 0;
  const pendingResponses: Array<() => void> = [];
  const sockets = new Set<Socket>();
  const connectionWaiters: Array<{ count: number; resolve: () => void }> = [];
  const requestWaiters: Array<{ count: number; resolve: () => void }> = [];

  const flushWaiters = () => {
    for (let i = connectionWaiters.length - 1; i >= 0; i -= 1) {
      if (totalConnections >= connectionWaiters[i].count) {
        const waiter = connectionWaiters.splice(i, 1)[0];
        waiter.resolve();
      }
    }
    for (let i = requestWaiters.length - 1; i >= 0; i -= 1) {
      if (requestCount >= requestWaiters[i].count) {
        const waiter = requestWaiters.splice(i, 1)[0];
        waiter.resolve();
      }
    }
  };

  const server = net.createServer((socket) => {
    sockets.add(socket);
    totalConnections += 1;
    openConnections += 1;
    peakConnections = Math.max(peakConnections, openConnections);
    flushWaiters();

    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      while (true) {
        const lineEnd = buffer.indexOf("\n");
        if (lineEnd === -1) {
          break;
        }
        const line = buffer.slice(0, lineEnd).replace(/\r$/, "");
        buffer = buffer.slice(lineEnd + 1);
        if (line === "") {
          continue;
        }
        if (line === "PING") {
          requestCount += 1;
          const respond = () => {
            socket.write("+PONG\r\n");
          };
          pendingResponses.push(respond);
          flushWaiters();
          if (options.autoRespond === true) {
            pendingResponses.shift()?.();
          }
          continue;
        }
        if (line.startsWith("AUTH ")) {
          socket.write("+OK\r\n");
          continue;
        }
        socket.write("-ERR UNKNOWN_COMMAND unsupported\r\n");
      }
    });

    socket.on("close", () => {
      sockets.delete(socket);
      openConnections -= 1;
    });

    socket.on("error", () => {});
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => resolve());
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("failed to determine test server address");
  }

  return {
    host,
    port: address.port,
    get totalConnections() {
      return totalConnections;
    },
    get peakConnections() {
      return peakConnections;
    },
    get requestCount() {
      return requestCount;
    },
    async waitForConnections(count: number) {
      if (totalConnections >= count) {
        return;
      }
      await new Promise<void>((resolve) => {
        connectionWaiters.push({ count, resolve });
      });
    },
    async waitForRequests(count: number) {
      if (requestCount >= count) {
        return;
      }
      await new Promise<void>((resolve) => {
        requestWaiters.push({ count, resolve });
      });
    },
    respondNext(payload = "+PONG\r\n") {
      const respond = pendingResponses.shift();
      assert.ok(respond, "expected pending response");
      if (payload === "+PONG\r\n") {
        respond();
        return;
      }
      const socket = Array.from(sockets)[0];
      assert.ok(socket, "expected active socket");
      socket.write(payload);
    },
    async close() {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

test("connectPool warms minConnections", async () => {
  const server = await startPingServer();
  try {
    const pool = await connectPool({
      host: server.host,
      port: server.port,
      autoAuth: false,
      maxConnections: 3,
      minConnections: 2,
    });
    await server.waitForConnections(2);
    assert.equal(server.totalConnections, 2);
    await pool.close();
  } finally {
    await server.close();
  }
});

test("ChunkPool reuses one socket for sequential work", async () => {
  const server = await startPingServer({ autoRespond: true });
  try {
    const pool = new ChunkPool({
      host: server.host,
      port: server.port,
      autoAuth: false,
      maxConnections: 1,
    });

    assert.equal(await pool.ping(), "PONG");
    assert.equal(await pool.ping(), "PONG");
    assert.equal(server.totalConnections, 1);

    await pool.close();
  } finally {
    await server.close();
  }
});

test("ChunkPool caps concurrent sockets at maxConnections", async () => {
  const server = await startPingServer();
  try {
    const pool = new ChunkPool({
      host: server.host,
      port: server.port,
      autoAuth: false,
      maxConnections: 2,
      acquireTimeoutMs: 500,
    });

    const pending = [pool.ping(), pool.ping(), pool.ping()];
    await server.waitForConnections(2);
    await server.waitForRequests(2);
    assert.equal(server.totalConnections, 2);
    assert.equal(server.peakConnections, 2);

    await wait(25);
    assert.equal(server.requestCount, 2);

    server.respondNext();
    await server.waitForRequests(3);
    assert.equal(server.totalConnections, 2);

    server.respondNext();
    server.respondNext();
    const replies = await Promise.all(pending);
    assert.deepEqual(replies, ["PONG", "PONG", "PONG"]);

    await pool.close();
  } finally {
    await server.close();
  }
});

test("ChunkPool wakes queued waiters in FIFO order", async () => {
  const server = await startPingServer();
  try {
    const pool = new ChunkPool({
      host: server.host,
      port: server.port,
      autoAuth: false,
      maxConnections: 1,
      acquireTimeoutMs: 500,
    });

    const resolved: number[] = [];
    const first = pool.ping().then(() => {
      resolved.push(1);
    });
    const second = pool.ping().then(() => {
      resolved.push(2);
    });
    const third = pool.ping().then(() => {
      resolved.push(3);
    });

    await server.waitForRequests(1);
    server.respondNext();
    await first;

    await server.waitForRequests(2);
    assert.deepEqual(resolved, [1]);
    server.respondNext();
    await second;

    await server.waitForRequests(3);
    assert.deepEqual(resolved, [1, 2]);
    server.respondNext();
    await third;

    assert.deepEqual(resolved, [1, 2, 3]);
    assert.equal(server.totalConnections, 1);

    await pool.close();
  } finally {
    await server.close();
  }
});

test("ChunkPool times out queued acquires", async () => {
  const server = await startPingServer();
  try {
    const pool = new ChunkPool({
      host: server.host,
      port: server.port,
      autoAuth: false,
      maxConnections: 1,
      commandTimeoutMs: 1000,
      acquireTimeoutMs: 50,
    });

    const first = pool.ping();
    await server.waitForRequests(1);

    await assert.rejects(
      () => pool.ping(),
      (error: unknown) => {
        assert.ok(error instanceof ChunkTimeoutError);
        assert.equal((error as ChunkTimeoutError).command, "ACQUIRE");
        return true;
      },
    );

    server.respondNext();
    assert.equal(await first, "PONG");
    await pool.close();
  } finally {
    await server.close();
  }
});

test("ChunkPool close rejects queued waiters and drains active leases", async () => {
  const server = await startPingServer();
  try {
    const pool = new ChunkPool({
      host: server.host,
      port: server.port,
      autoAuth: false,
      maxConnections: 1,
      acquireTimeoutMs: 1000,
    });

    const first = pool.ping();
    await server.waitForRequests(1);

    const second = pool.ping();
    await wait(25);

    const closePromise = pool.close();

    await assert.rejects(
      () => second,
      (error: unknown) => {
        assert.ok(error instanceof ChunkConnectionError);
        assert.match((error as ChunkConnectionError).message, /pool is closing/);
        return true;
      },
    );

    server.respondNext();
    assert.equal(await first, "PONG");
    await closePromise;
  } finally {
    await server.close();
  }
});

test("ChunkClient clears stale buffered data after forced disconnect and can reconnect", async () => {
  const host = "127.0.0.1";
  let connectionCount = 0;
  const server = net.createServer((socket) => {
    connectionCount += 1;
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      while (true) {
        const lineEnd = buffer.indexOf("\n");
        if (lineEnd === -1) {
          break;
        }
        const line = buffer.slice(0, lineEnd).replace(/\r$/, "");
        buffer = buffer.slice(lineEnd + 1);
        if (line !== "PING") {
          socket.write("-ERR UNKNOWN_COMMAND unsupported\r\n");
          continue;
        }
        if (connectionCount === 1) {
          socket.write("+PO");
          setTimeout(() => {
            socket.destroy();
          }, 10);
          continue;
        }
        socket.write("+PONG\r\n");
      }
    });
    socket.on("error", () => {});
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => resolve());
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("failed to determine reconnect test port");
  }

  const client = new ChunkClient({
    host,
    port: address.port,
    autoAuth: false,
    connectTimeoutMs: 500,
    commandTimeoutMs: 500,
  });

  try {
    await assert.rejects(
      () => client.ping(),
      (error: unknown) => {
        assert.ok(error instanceof ChunkConnectionError);
        return true;
      },
    );

    assert.equal(await client.ping(), "PONG");
    assert.equal(connectionCount, 2);
  } finally {
    await client.close();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
});
