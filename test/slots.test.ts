import test from "node:test";
import assert from "node:assert/strict";
import { ChunkClient, ChunkPool, ChunkProtocolError, ChunkServerError } from "../src/index";
import { FAKE_HELLO, startFakeServer } from "./fake-server";

const epoch = "0123456789abcdef0123456789abcdef";
const bulk = (value: string) => `$${Buffer.byteLength(value)}\r\n${value}\r\n`;
function slot(fields: Record<string, string> = {}): string {
  const values = { table: bulk("t"), name: bulk("consumer"), epoch: bulk(epoch), acked: ":9007199254740993\r\n",
    retained_bytes: ":18446744073709551615\r\n", lost: "#t\r\n", ...fields };
  return `*1\r\n%${Object.keys(values).length}\r\n${Object.entries(values).map(([key, value]) => bulk(key) + value).join("")}`;
}

test("slot management quotes names and preserves exact typed positions on client and pool", async () => {
  const server = await startFakeServer(({ line }) => {
    if (line === "HELLO 3") return FAKE_HELLO;
    if (line === "CREATE SLOT 'consumer' ON t" || line === "DROP SLOT 'consumer' ON t") return "+OK\r\n";
    if (line === "SHOW SLOTS" || line === "SHOW SLOTS ON t") return slot();
    throw new Error(line);
  });
  const client = new ChunkClient({ port: server.port });
  const pool = new ChunkPool({ port: server.port, maxConnections: 1 });
  try {
    for (const api of [client, pool]) {
      await api.createSlot("t", "consumer");
      const expected = [{ table: "t", name: "consumer", epoch, acked: 9007199254740993n, retainedBytes: 18446744073709551615n, lost: true }];
      assert.deepEqual(await api.listSlots(), expected);
      assert.deepEqual(await api.listSlots("t"), expected);
      await api.dropSlot("t", "consumer");
    }
  } finally { await client.close(); await pool.close(); await server.close(); }
});

test("slot names and table names are checked before sending commands", async () => {
  const server = await startFakeServer(() => { throw new Error("unexpected connection"); });
  const client = new ChunkClient({ port: server.port });
  try {
    for (const name of ["", "a".repeat(64), "a' ON t\r\nPING", "Upper", "../consumer"]) {
      await assert.rejects(client.createSlot("t", name), ChunkProtocolError);
      await assert.rejects(client.dropSlot("t", name), ChunkProtocolError);
      await assert.rejects(client.watch("t", { slot: name }), ChunkProtocolError);
    }
    await assert.rejects(client.createSlot("t\r\nPING", "consumer"), ChunkProtocolError);
    await assert.rejects(client.listSlots("t\r\nPING"), ChunkProtocolError);
    assert.equal(server.connections, 0);
  } finally { await client.close(); await server.close(); }
});

test("SHOW SLOTS rejects malformed maps and uint64 fields", async () => {
  const replies = ["_\r\n", "*1\r\n_\r\n", slot({ acked: ":-1\r\n" }), slot({ retained_bytes: ":18446744073709551616\r\n" }),
    slot({ lost: ":1\r\n" }), slot({ epoch: bulk("bad") }), slot({ name: bulk("a".repeat(64)) }),
    slot().replace("%6", "%5").replace(bulk("acked") + ":9007199254740993\r\n", ""),
    slot().replace("%6", "%7") + bulk("acked") + ":1\r\n"];
  const server = await startFakeServer(({ line }) => line === "HELLO 3" ? FAKE_HELLO : replies.shift()!);
  const client = new ChunkClient({ port: server.port });
  try {
    while (replies.length !== 0) await assert.rejects(client.listSlots(), ChunkProtocolError);
  } finally { await client.close(); await server.close(); }
});

test("slot management preserves server errors", async () => {
  const server = await startFakeServer(({ line }) => line === "HELLO 3" ? FAKE_HELLO : "-ERR NO_TABLE unknown table\r\n");
  const client = new ChunkClient({ port: server.port });
  try {
    for (const request of [() => client.createSlot("t", "consumer"), () => client.dropSlot("t", "consumer"), () => client.listSlots("t")]) {
      await assert.rejects(request(), (error: unknown) => error instanceof ChunkServerError && error.serverCode === "NO_TABLE");
    }
  } finally { await client.close(); await server.close(); }
});
