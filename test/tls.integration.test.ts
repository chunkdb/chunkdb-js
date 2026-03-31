import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { connectUri } from "../src/index";
import { chunkdbRepoRoot, startServer } from "./helpers";

const canRunTls = fs.existsSync(path.join(chunkdbRepoRoot(), "build-quick-tls/chunkdb_server"));

test("tls ping and info", { skip: !canRunTls }, async () => {
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
