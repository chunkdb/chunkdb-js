import test from "node:test";
import assert from "node:assert/strict";

import { connectUri } from "../src/index";
import { startServer } from "./helpers";

test("tls ping, info, and a binary chunk round trip", async () => {
  const server = await startServer({ tls: true });
  try {
    const client = await connectUri(server.uri, { tlsInsecure: true });
    assert.equal(await client.ping(), "PONG");
    const info = await client.info();
    assert.equal(info.values.table, "default");
    assert.equal(client.serverInfo()?.table?.durabilityMode, "relaxed");
    const payload = Buffer.alloc(512, 0xa5);
    assert.equal((await client.putChunk(0, 0, payload)).ok, true);
    assert.deepEqual(await client.getChunk(0, 0), payload);
    await client.close();
  } finally {
    await server.stop();
  }
});
