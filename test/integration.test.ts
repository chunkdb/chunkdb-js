import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";

import {
  ChunkAuthError,
  ChunkClient,
  ChunkProtocolError,
  ChunkTimeoutError,
  connect,
  connectUri,
} from "../src/index";
import { startServer } from "./helpers";

// A listener that answers every line with `reply` (or never, when null).
async function fakeServer(reply: string | null): Promise<{ port: number; close(): void }> {
  const holder = net.createServer((socket) => {
    socket.on("data", () => {
      if (reply !== null) {
        socket.write(reply);
      }
    });
  });
  const port = await new Promise<number>((resolve, reject) => {
    holder.once("error", reject);
    holder.listen(0, "127.0.0.1", () => {
      const address = holder.address();
      if (address === null || typeof address === "string") {
        reject(new Error("failed to get dummy server address"));
        return;
      }
      resolve(address.port);
    });
  });
  return { port, close: () => holder.close() };
}

test("ping, close, and the HELLO reply", async () => {
  const server = await startServer();
  try {
    const client = await connectUri(server.uri);
    assert.equal(await client.ping(), "PONG");
    const hello = client.serverInfo();
    assert.ok(hello !== null);
    assert.equal(hello.protocol, 2);
    assert.ok(hello.capabilities.includes("zrle"));
    assert.equal(hello.maxAreaChunks, 256);
    assert.equal(hello.maxBatchOps, 1024);
    assert.ok(hello.table !== null);
    assert.equal(hello.table.name, "default");
    assert.equal(hello.table.blockBits, 16);
    await client.close();
  } finally {
    await server.stop();
  }
});

test("get and mget return null for unset blocks and bits for explicit zero", async () => {
  const server = await startServer();
  try {
    const client = await connectUri(server.uri);

    assert.equal(await client.get(0, 0), null);
    await client.set(0, 0, "1011001110110011");
    assert.equal(await client.get(0, 0), "1011001110110011");

    await client.set(1, 0, "0000000000000000");
    assert.equal(await client.get(1, 0), "0000000000000000");
    assert.deepEqual(await client.mget([{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 1, y: 0 }]), [
      "1011001110110011",
      null,
      "0000000000000000",
    ]);

    await client.unset(1, 0);
    assert.equal(await client.get(1, 0), null);
    await client.close();
  } finally {
    await server.stop();
  }
});

test("getChunk, getChunkState, and putChunk round-trip binary chunks", async () => {
  const server = await startServer();
  try {
    const client = await connectUri(server.uri);
    const table = client.serverInfo()!.table!;
    const blockCount = table.chunkWidthBlocks * table.chunkHeightBlocks;
    const payloadBytes = Math.ceil((blockCount * table.blockBits) / 8);
    const presenceBytes = Math.ceil(blockCount / 8);

    // An absent chunk reads as zeros with an empty presence bitmap.
    assert.deepEqual(await client.getChunk(2, 3), Buffer.alloc(payloadBytes));
    const absent = await client.getChunkState(2, 3);
    assert.equal(absent.exists, false);
    assert.deepEqual(absent.presence, Buffer.alloc(presenceBytes));

    const payload = Buffer.alloc(payloadBytes);
    for (let i = 0; i < payloadBytes; i += 1) payload[i] = (i * 37 + 11) & 0xff;
    const written = await client.putChunk(2, 3, payload);
    assert.equal(written.ok, true);
    assert.equal(written.version, await client.chunkVersion(2, 3));
    assert.equal(await client.chunkExists(2, 3), true);
    assert.deepEqual(await client.getChunk(2, 3), payload);
    const state = await client.getChunkState(2, 3);
    assert.equal(state.exists, true);
    assert.deepEqual(state.payload, payload);
    assert.deepEqual(state.presence, Buffer.alloc(presenceBytes, 0xff));
    assert.equal(await client.get(table.chunkWidthBlocks * 2, table.chunkHeightBlocks * 3), payload.subarray(0, 2).reduce(
      (bits, byte) => bits + [...Array(8).keys()].map((bit) => (byte >> bit) & 1).join(""),
      "",
    ));

    // An empty presence bitmap leaves the chunk absent even though payload
    // bytes were sent (they are stored as zero).
    await client.putChunkState(4, 3, { payload, presence: Buffer.alloc(presenceBytes) });
    assert.equal(await client.chunkExists(4, 3), false);
    assert.deepEqual(await client.getChunk(4, 3), Buffer.alloc(payloadBytes));

    // Writing back what getChunkState returned reproduces the state.
    const sparse = { payload: Buffer.from(payload), presence: Buffer.alloc(presenceBytes) };
    sparse.presence[0] = 0b00000001;
    sparse.payload.fill(0, 2);
    await client.putChunkState(5, 3, sparse);
    const sparseBack = await client.getChunkState(5, 3);
    assert.deepEqual(sparseBack.payload, sparse.payload);
    assert.deepEqual(sparseBack.presence, sparse.presence);
    assert.equal(await client.get(table.chunkWidthBlocks * 5 + 1, table.chunkHeightBlocks * 3), null);

    // Sizes are checked before anything is sent; the connection stays usable.
    await assert.rejects(client.putChunk(6, 3, Buffer.alloc(payloadBytes + 1)), /CHUNKPUT payload must be/);
    await assert.rejects(
      client.putChunkState(6, 3, { payload, presence: Buffer.alloc(1) }),
      /CHUNKPUT STATE presence must be/,
    );
    await assert.rejects(client.putChunk(0.5, 3, payload), /CHUNKPUT cx must be a safe integer/);
    assert.equal(await client.ping(), "PONG");

    await client.close();
  } finally {
    await server.stop();
  }
});

test("zrle transfers decode to the same bytes", async () => {
  const server = await startServer();
  try {
    const client = await connectUri(server.uri);
    const table = client.serverInfo()!.table!;
    const blockCount = table.chunkWidthBlocks * table.chunkHeightBlocks;
    const payloadBytes = Math.ceil((blockCount * table.blockBits) / 8);

    // A sparse chunk compresses; a dense one is sent uncompressed.
    const sparse = Buffer.alloc(payloadBytes);
    sparse[7] = 0x5a;
    const dense = Buffer.alloc(payloadBytes);
    for (let i = 0; i < payloadBytes; i += 1) dense[i] = (i * 131 + 7) | 1;
    await client.putChunk(0, 0, sparse, { zrle: true });
    await client.putChunk(1, 0, dense, { zrle: true });

    assert.deepEqual(await client.getChunk(0, 0, { zrle: true }), sparse);
    assert.deepEqual(await client.getChunk(1, 0, { zrle: true }), dense);
    const state = await client.getChunkState(0, 0, { zrle: true });
    assert.deepEqual(state, await client.getChunkState(0, 0));
    await client.close();
  } finally {
    await server.stop();
  }
});

test("connectUri explicit overrides win over URI values", async () => {
  const server = await startServer();
  try {
    const client = await connectUri("chunk://wrong-token@127.0.0.1:1/", {
      host: server.host,
      port: server.port,
      token: server.token,
    });
    assert.equal(await client.ping(), "PONG");
    await client.close();
  } finally {
    await server.stop();
  }
});

test("a wrong or missing token fails the connect with a typed auth error", async () => {
  const server = await startServer({ token: "expected-token" });
  try {
    for (const [token, code] of [["wrong-token", "AUTH_FAILED"], [undefined, "AUTH_REQUIRED"]] as const) {
      const client = new ChunkClient({ host: server.host, port: server.port, token });
      await assert.rejects(() => client.connect(), (error: unknown) => {
        assert.ok(error instanceof ChunkAuthError);
        assert.equal((error as ChunkAuthError).serverCode, code);
        assert.equal((error as ChunkAuthError).phase, "auth");
        return true;
      });
      await client.close();
    }
  } finally {
    await server.stop();
  }
});

test("a server without protocol 2 is reported as such", async () => {
  const fake = await fakeServer("-ERR UNKNOWN_COMMAND HELLO\r\n");
  try {
    await assert.rejects(
      () => connect({ host: "127.0.0.1", port: fake.port, connectTimeoutMs: 1000 }),
      (error: unknown) => {
        assert.ok(error instanceof ChunkProtocolError);
        assert.match((error as Error).message, /does not speak protocol 2/);
        return true;
      },
    );
  } finally {
    fake.close();
  }
});

test("a 1.x server that requires a token is reported as such", async () => {
  // It answers every command before AUTH with AUTH_REQUIRED, also a HELLO
  // that carries the token.
  const fake = await fakeServer("-ERR AUTH_REQUIRED use AUTH <token>\r\n");
  try {
    await assert.rejects(
      () => connect({ host: "127.0.0.1", port: fake.port, token: "tok", connectTimeoutMs: 1000 }),
      (error: unknown) => error instanceof ChunkProtocolError && /does not speak protocol 2/.test((error as Error).message),
    );
    // Without a token the reply is ambiguous: it stays an auth error.
    await assert.rejects(
      () => connect({ host: "127.0.0.1", port: fake.port, connectTimeoutMs: 1000 }),
      (error: unknown) => error instanceof ChunkAuthError && error.serverCode === "AUTH_REQUIRED",
    );
  } finally {
    fake.close();
  }
});

test("command timeout rejects and closes hanging connection", async () => {
  const fake = await fakeServer(null);
  try {
    await assert.rejects(
      () => connect({ host: "127.0.0.1", port: fake.port, commandTimeoutMs: 100, connectTimeoutMs: 1000 }),
      (error: unknown) => {
        assert.ok(error instanceof ChunkTimeoutError);
        assert.equal((error as ChunkTimeoutError).command, "HELLO");
        return true;
      },
    );
  } finally {
    fake.close();
  }
});
