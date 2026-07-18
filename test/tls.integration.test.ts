import test from "node:test";
import assert from "node:assert/strict";

import { connectUri } from "../src/index";
import { startServer } from "./helpers";

test("tls ping and info", async () => {
  const server = await startServer({ tls: true });
  try {
    const client = await connectUri(server.uri, { tlsInsecure: true });
    assert.equal(await client.ping(), "PONG");
    const info = await client.info();
    assert.equal(info.values.durability_mode, "relaxed");
    await client.close();
  } finally {
    await server.stop();
  }
});
