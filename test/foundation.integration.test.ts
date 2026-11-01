import test from "node:test";
import assert from "node:assert/strict";
import { ChunkConnectionError, ChunkKilledError, ChunkProtocolError, ChunkSlotBusyError, connectUri, type ChunkWatch, type ChunkWatchEvent } from "../src/index";
import { startServer } from "./helpers";

async function eventOf(watch: ChunkWatch, kind: ChunkWatchEvent["kind"]): Promise<ChunkWatchEvent> {
  while (true) {
    const next = await watch.next();
    if (next.done) throw new Error(`watch ended before ${kind}`);
    if (next.value.kind === "resync") throw new Error("foundation stream unexpectedly requires a state rebuild");
    if (next.value.kind === kind) return next.value;
  }
}

for (const tls of [false, true]) {
  test(`foundation: ${tls ? "TLS" : "plain"} HELLO, structured errors, read metadata and explicit features`, { timeout: 20000 }, async () => {
    const server = await startServer({ tls });
    const client = await connectUri(server.uri, { tlsInsecure: tls, table: "foundation", pipelineDepth: 4,
      helloOptions: { client_name: "foundation-client", statement_timeout_ms: 500, default_tag: Buffer.from("pending") } });
    try {
      const info = client.serverInfo()!;
      assert.ok(info.connectionId! > 0n); assert.ok(info.features!.includes("read_metadata"));
      assert.equal(info.options!.client_name, "foundation-client");
      if (info.features!.includes("statement_timeout")) assert.equal(info.options!.statement_timeout_ms, 500);
      else assert.equal(info.notApplied!.statement_timeout_ms.reason, "implementation_pending");
      assert.equal(info.notApplied!.default_tag.reason, "implementation_pending");
      assert.equal(info.limits!.txn_max_written_chunks, 64);
      await client.createTable("foundation", { columns: [{ name: "n", type: "u64" }], chunk: { width: 4, height: 4 } });
      const schema = await client.describe();
      assert.match(schema.epoch!, /^[0-9a-f]{32}$/); assert.equal(schema.dims, 2); assert.deepEqual(schema.chunkColumns, []);
      assert.deepEqual(await client.getBlockWithMetadata(0, 0), { version: null, schemaVersion: BigInt(schema.version), row: null });
      const committed = await client.setBlock(0, 0, { n: (1n << 64n) - 1n });
      assert.deepEqual(await client.getBlockWithMetadata(0, 0), { version: committed, schemaVersion: BigInt(schema.version), row: { n: (1n << 64n) - 1n } });
      const current = await client.describe(); assert.ok(current.revision! >= committed);
      for (const suffix of ["WITH VERSION", "WITH SCHEMA", "WITH SCHEMA WITH VERSION"]) {
        const reply = await client.execute(`GET BLOCK 0 0 FROM foundation ${suffix}`);
        assert.equal(reply.type, "array"); assert.equal(reply.items.length, suffix.includes("WITH SCHEMA WITH VERSION") ? 3 : 2);
      }
      await client.transaction(async (tx) => {
        assert.equal((await tx.getBlockWithMetadata(0, 0)).version, committed);
        await tx.setBlock(0, 0, { n: 7n });
        assert.deepEqual(await tx.getBlockWithMetadata(0, 0), { version: null, schemaVersion: BigInt(schema.version), row: { n: 7n } });
      });
      assert.equal((await client.getAreaWithSchema({ cx0: 0, cy0: 0, cx1: 0, cy1: 0 })).entries.length, 1);
      assert.equal((await client.getAreaRawWithSchema({ cx0: 1, cy0: 1, cx1: 1, cy1: 1 })).entries.length, 0);
      const [first, failed, last] = await Promise.allSettled([client.ping(), client.execute("UNKNOWN FOUNDATION $1", [Buffer.from("discard")]), client.ping()]);
      assert.equal(first.status, "fulfilled"); assert.equal(last.status, "fulfilled");
      assert.equal(failed.status, "rejected"); assert.equal(failed.reason.serverCode, "UNKNOWN_COMMAND"); assert.equal(failed.reason.retryClass, "fatal");
      await client.enableFeature("feed_slots");
      const status = await client.showStatus();
      assert.ok(status.directory.enabled.includes("feed_slots")); assert.equal(typeof status.directory.incompat, "bigint");
      assert.equal(status.activationPending, false); assert.ok(status.tables.some(({ name }) => name === "foundation"));
    } finally { await client.close(); await server.stop(); }
  });

  test(`foundation: ${tls ? "TLS" : "plain"} persisted filters, quiet progress, CHUNKS ACK and takeover`, { timeout: 25000 }, async () => {
    const server = await startServer({ tls });
    const client = await connectUri(server.uri, { tlsInsecure: tls, table: "foundation" });
    let watch: ChunkWatch | undefined, old: ChunkWatch | undefined;
    try {
      await client.createTable("foundation", { columns: [{ name: "n", type: "u16" }, { name: "other", type: "u8" }], chunk: { width: 4, height: 4 } });
      await client.createSlot("foundation", "filtered", { columns: ["n"], noBefore: true, area: { cx0: 0, cy0: 0, cx1: 1, cy1: 1 } });
      const [slot] = await client.listSlots("foundation");
      assert.deepEqual(slot.filters!.columns, ["n"]); assert.equal(slot.filters!.columnIds!.length, 1);
      assert.deepEqual(slot.filters!.area, [0n, 0n, 1n, 1n]); assert.equal(slot.filters!.noBefore, true); assert.equal(slot.lostReason, null);
      watch = await client.watch("foundation", { slot: "filtered", ackTimeoutMs: 10000 });
      const revision = await client.setBlock(0, 0, { n: 7, other: 8 });
      const change = await eventOf(watch, "change"); assert.equal(change.kind, "change");
      assert.deepEqual(change.blocks[0].after, { n: 7 }); assert.equal(change.blocks[0].before, null); assert.equal(change.tag, null); assert.equal(change.txn, null); assert.deepEqual(change.chunkChanges, []);
      await watch.ack(revision); await watch.close(); watch = undefined;
      assert.equal((await client.listSlots("foundation"))[0].acked, revision);
      await client.createSlot("foundation", "raw", { chunks: true });
      watch = await client.watch("foundation", { slot: "raw" });
      const written = await client.setBlock(0, 0, { n: 9 });
      await assert.rejects(watch.ack(written), ChunkProtocolError);
      const chunks = await eventOf(watch, "chunks"); assert.equal(chunks.kind, "chunks");
      assert.equal(chunks.chunks[0].version, written); assert.ok(chunks.chunks[0].form instanceof Buffer);
      await watch.ack(chunks.position.revision); await watch.close(); watch = undefined;
      assert.equal((await client.listSlots("foundation")).find(({ name }) => name === "raw")!.acked, written);
      await client.createSlot("foundation", "quiet");
      old = await client.watch("foundation", { slot: "quiet" });
      const progress = await eventOf(old, "progress"); await old.ack(progress.position.revision);
      await assert.rejects(client.watch("foundation", { slot: "quiet" }), ChunkSlotBusyError);
      watch = await client.watch("foundation", { slot: "quiet", takeover: true });
      await assert.rejects(async () => { for await (const _event of old!) { /* Drain queued events; takeover must eventually fail this owner. */ } }, (error: unknown) => error instanceof ChunkKilledError || error instanceof ChunkConnectionError);
      await watch.close(); watch = undefined;
    } finally { await watch?.close(); await old?.close(); await client.close(); await server.stop(); }
  });
}
