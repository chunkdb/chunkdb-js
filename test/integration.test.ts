import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";

import {
  ChunkClient,
  ChunkServerError,
  ChunkTimeoutError,
  connect,
  connectUri,
} from "../src/index";
import { startServer } from "./helpers";

test("ping and close", async () => {
  const server = await startServer();
  try {
    const client = await connectUri(server.uri);
    assert.equal(await client.ping(), "PONG");
    await client.close();
  } finally {
    await server.stop();
  }
});

test("readBlock exposes unset vs explicit zero without manual exists/get composition", async () => {
  const server = await startServer();
  try {
    const client = await connectUri(server.uri);

    assert.deepEqual(await client.readBlock(0, 0), {
      exists: false,
      bits: null,
    });
    assert.equal(await client.exists(0, 0), false);

    await client.set(0, 0, "1011001110110011");
    assert.deepEqual(await client.readBlock(0, 0), {
      exists: true,
      bits: "1011001110110011",
    });
    assert.equal(await client.get(0, 0), "1011001110110011");

    await client.set(1, 0, "0000000000000000");
    assert.deepEqual(await client.readBlock(1, 0), {
      exists: true,
      bits: "0000000000000000",
    });
    assert.equal(await client.exists(1, 0), true);
    assert.equal(await client.get(1, 0), "0000000000000000");

    await client.unset(1, 0);
    assert.deepEqual(await client.readBlock(1, 0), {
      exists: false,
      bits: null,
    });
    assert.equal(await client.exists(1, 0), false);
    assert.equal(await client.get(1, 0), "0000000000000000");
    await client.close();
  } finally {
    await server.stop();
  }
});

test("info, chunk, and chunkbin", async () => {
  const server = await startServer();
  try {
    const client = await connectUri(server.uri);
    await client.set(0, 0, "1011001110110011");
    const info = await client.info();
    assert.equal(info.values.durability_mode, "relaxed");
    const expectedPresenceBytes = Math.ceil(
      (Number.parseInt(info.values.chunk_width_blocks, 10) *
        Number.parseInt(info.values.chunk_height_blocks, 10)) / 8,
    );

    const chunkBits = await client.chunk(0, 0);
    assert.equal(chunkBits.length > 0, true);
    assert.equal(chunkBits.startsWith("1011001110110011"), true);

    const chunkBytes = await client.chunkbin(0, 0);
    assert.equal(chunkBytes.length > 0, true);

    const chunkStateBytes = await client.chunkbinState(0, 0);
    assert.equal(chunkStateBytes.length, chunkBytes.length + expectedPresenceBytes);

    await client.close();
  } finally {
    await server.stop();
  }
});

test("chunkExists and setChunk distinguish absent chunks from explicit zero chunks", async () => {
  const server = await startServer();
  try {
    const client = await connectUri(server.uri);

    assert.equal(await client.chunkExists(0, 0), false);
    const zeroChunk = await client.chunk(0, 0);
    assert.equal(/^[0]+$/.test(zeroChunk), true);

    await client.setChunk(0, 0, zeroChunk);
    assert.equal(await client.chunkExists(0, 0), true);
    assert.equal(await client.chunk(0, 0), zeroChunk);

    const oneChunk = `1${zeroChunk.slice(1)}`;
    await client.setChunk(1, 0, oneChunk);
    assert.equal(await client.chunkExists(1, 0), true);
    assert.equal(await client.chunk(1, 0), oneChunk);

    await client.close();
  } finally {
    await server.stop();
  }
});

test("readChunk and setChunkState preserve per-block presence", async () => {
  const server = await startServer();
  try {
    const client = await connectUri(server.uri);

    const absent = await client.readChunk(0, 0);
    assert.equal(absent.exists, false);
    assert.equal(/^[0]+$/.test(absent.bits), true);
    assert.equal(/^[0]+$/.test(absent.presence), true);
    const blockBits = absent.bits.length / absent.presence.length;

    const zeroChunk = await client.chunk(0, 0);
    const fullPresence = "1".repeat(absent.presence.length);
    await client.setChunkState(0, 0, {
      bits: zeroChunk,
      presence: fullPresence,
    });
    assert.deepEqual(await client.readChunk(0, 0), {
      exists: true,
      bits: zeroChunk,
      presence: fullPresence,
    });

    const firstBlock = "1".repeat(blockBits);
    const sparseBits = `${firstBlock}${"0".repeat(zeroChunk.length - (2 * blockBits))}${"0".repeat(blockBits)}`;
    const sparsePresence = `1${"0".repeat(absent.presence.length - 2)}1`;
    await client.setChunkState(1, 0, {
      bits: sparseBits,
      presence: sparsePresence,
    });

    assert.deepEqual(await client.readChunk(1, 0), {
      exists: true,
      bits: sparseBits,
      presence: sparsePresence,
    });
    assert.equal(await client.chunk(1, 0), sparseBits);
    assert.equal(await client.chunkExists(1, 0), true);
    const chunkWidth = Number.parseInt((await client.info()).values.chunk_width_blocks, 10);
    assert.equal(await client.exists(chunkWidth, 0), true);
    assert.equal(await client.get(chunkWidth, 0), firstBlock);
    assert.equal(await client.exists(chunkWidth + 1, 0), false);
    assert.equal(await client.get(chunkWidth + 1, 0), "0".repeat(blockBits));

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

test("explicit auth failure surfaces typed server error", async () => {
  const server = await startServer({ token: "expected-token" });
  try {
    const client = new ChunkClient({
      host: server.host,
      port: server.port,
      autoAuth: false,
    });
    await client.connect();
    await assert.rejects(() => client.auth("wrong-token"), (error: unknown) => {
      assert.ok(error instanceof ChunkServerError);
      assert.equal((error as ChunkServerError).serverCode, "AUTH_FAILED");
      return true;
    });
    await client.close();
  } finally {
    await server.stop();
  }
});

test("command timeout rejects and closes hanging connection", async () => {
  const host = "127.0.0.1";
  const holder = net.createServer((socket) => {
    socket.on("data", () => {});
  });
  const port = await new Promise<number>((resolve, reject) => {
    holder.once("error", reject);
    holder.listen(0, host, () => {
      const address = holder.address();
      if (address === null || typeof address === "string") {
        reject(new Error("failed to get dummy server address"));
        return;
      }
      resolve(address.port);
    });
  });

  try {
    const client = await connect({
      host,
      port,
      autoAuth: false,
      commandTimeoutMs: 100,
      connectTimeoutMs: 1000,
    });
    await assert.rejects(() => client.ping(), (error: unknown) => {
      assert.ok(error instanceof ChunkTimeoutError);
      return true;
    });
    await client.close();
  } finally {
    holder.close();
  }
});
