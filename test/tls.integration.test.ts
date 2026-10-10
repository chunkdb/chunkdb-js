import test from "node:test";
import assert from "node:assert/strict";

import { ChunkBits, ChunkTlsError, connectUri } from "../src/index";
import { startServer } from "./helpers";

test("TLS: login, typed blocks and a chunk round trip", async () => {
  const server = await startServer({ tls: true });
  try {
    // The administrator logs in over TLS.
    const client = await connectUri(server.uri, { tlsInsecure: true });
    assert.equal(client.serverInfo()?.protocol, 3);
    assert.match(client.serverInfo()?.serverSignature ?? "", /^v=/);
    assert.equal(await client.ping(), "PONG");
    await client.setBlock(3, 4, { bits: ChunkBits.from("1".repeat(16)) });
    assert.equal((await client.getBlock(3, 4))?.bits?.toString(), "1".repeat(16));
    const raw = await client.getChunkRaw(0, 0);
    assert.ok(raw);
    await client.setChunkRaw(1, 0, raw);
    assert.deepEqual((await client.getChunkRaw(1, 0))?.subarray(8), raw.subarray(8));
    await client.close();

    // Without tlsInsecure the self-signed certificate is refused.
    await assert.rejects(connectUri(server.uri), ChunkTlsError);
  } finally {
    await server.stop();
  }
});
