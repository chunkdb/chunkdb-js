import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as wait } from "node:timers/promises";
import { ChunkServerError, connectPool, connectUri, type ChunkChangeEvent, type ChunkWatch } from "../src/index";
import { startServer } from "./helpers";

async function changed(watch: ChunkWatch): Promise<ChunkChangeEvent> {
  let event = await watch.next();
  assert.equal(event.done, false);
  if (event.value.kind === "schema") event = await watch.next();
  assert.equal(event.done, false);
  assert.equal(event.value.kind, "change");
  return event.value;
}

for (const tls of [false, true]) {
  test(`slots: ${tls ? "TLS pool" : "plain client"} archive replay, ACK, reconnect and resume`, { timeout: 15000 }, async () => {
    const server = await startServer({ tls });
    const api = tls ? await connectPool({ uri: server.uri, tlsInsecure: true, maxConnections: 1 }) : await connectUri(server.uri);
    let watch: ChunkWatch | undefined;
    try {
      await api.createTable("world", { columns: [{ name: "n", type: "u16", required: true }], chunk: { width: 4, height: 4 }, options: { checkpointUpdates: 1 } });
      await api.createSlot("world", "consumer");
      const [slot] = await api.listSlots("world");
      assert.equal(slot.table, "world"); assert.equal(slot.name, "consumer"); assert.equal(slot.lost, false);
      assert.equal(typeof slot.acked, "bigint"); assert.equal(typeof slot.retainedBytes, "bigint");
      const first = await api.setBlock(0, 0, { n: 1 }, { table: "world" });
      watch = await api.watch("world", { slot: "consumer" });
      assert.deepEqual(watch.start, { epoch: slot.epoch, revision: slot.acked });
      await assert.rejects(api.watch("world", { slot: "consumer" }), (error: unknown) => error instanceof ChunkServerError && error.serverCode === "BUSY");
      const one = await changed(watch);
      assert.equal(one.position.revision, first); assert.equal(one.user, server.user);
      assert.deepEqual(one.blocks[0].before, null); assert.deepEqual(one.blocks[0].after, { n: 1 });
      await watch.ack(first); await watch.close();
      assert.equal((await api.listSlots("world"))[0].acked, first); // UNWATCH waits for metadata persistence.
      const second = await api.setBlock(0, 0, { n: 2 }, { table: "world" });
      watch = await api.watch("world", { slot: "consumer" });
      assert.deepEqual(watch.start, one.position);
      const two = await changed(watch);
      assert.equal(two.position.revision, second); assert.deepEqual(two.blocks[0].before, { n: 1 }); assert.deepEqual(two.blocks[0].after, { n: 2 });
      await watch.close(); // Leave this change unacknowledged: it must be replayable.
      watch = await api.watch("world", { slot: "consumer", after: two.position });
      assert.deepEqual(watch.start, two.position);
      assert.equal((await api.listSlots("world"))[0].acked, first); // AFTER does not acknowledge.
      const third = await api.setBlock(0, 0, { n: 3 }, { table: "world" });
      const three = await changed(watch);
      assert.equal(three.position.revision, third); assert.deepEqual(three.blocks[0].before, { n: 2 }); assert.deepEqual(three.blocks[0].after, { n: 3 });
      await watch.ack(third); await watch.close();
      assert.equal((await api.listSlots())[0].acked, third);
      await api.dropSlot("world", "consumer"); assert.deepEqual(await api.listSlots("world"), []);
      assert.equal(await api.ping(), "PONG");
    } finally { await watch?.close(); await api.close(); await server.stop(); }
  });

  test(`slots: ${tls ? "TLS" : "plain"} lost slots retain their typed error and require recreation`, { timeout: 15000 }, async () => {
    const server = await startServer({ tls, slotMaxBytes: 1 });
    const client = await connectUri(server.uri, { tlsInsecure: tls });
    try {
      await client.createTable("world", { columns: [{ name: "n", type: "u16", required: true }], chunk: { width: 4, height: 4 }, options: { checkpointUpdates: 1 } });
      await client.createSlot("world", "consumer");
      await client.setBlock(0, 0, { n: 7 }, { table: "world" });
      const deadline = Date.now() + 5000;
      while (!(await client.listSlots("world"))[0].lost) {
        assert.ok(Date.now() < deadline, "slot did not become lost after exceeding its retention limit");
        await wait(50);
      }
      await assert.rejects(client.watch("world", { slot: "consumer" }), (error: unknown) => error instanceof ChunkServerError && error.serverCode === "SLOT_LOST");
      await client.dropSlot("world", "consumer"); await client.createSlot("world", "consumer");
      assert.equal((await client.listSlots("world"))[0].lost, false);
      const watch = await client.watch("world", { slot: "consumer" }); await watch.close();
      assert.equal(await client.ping(), "PONG");
    } finally { await client.close(); await server.stop(); }
  });
}
