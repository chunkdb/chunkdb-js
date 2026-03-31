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

test("auto auth and get/set", async () => {
  const server = await startServer();
  try {
    const client = await connectUri(server.uri);
    await client.set(0, 0, "1011001110110011");
    assert.equal(await client.get(0, 0), "1011001110110011");
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

    const chunkBits = await client.chunk(0, 0);
    assert.equal(chunkBits.length > 0, true);
    assert.equal(chunkBits.startsWith("1011001110110011"), true);

    const chunkBytes = await client.chunkbin(0, 0);
    assert.equal(chunkBytes.length > 0, true);

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
