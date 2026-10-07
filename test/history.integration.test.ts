import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import {
  ChunkNotRetainedError,
  ChunkServerError,
  connectPool,
  connectUri,
  type ChunkClient,
  type ChunkHistoryEvent,
  type ChunkHistoryOptions,
  type ChunkHistoryPage,
} from "../src/index";
import { startServer } from "./helpers";

// The test server runs two workers, one per open connection: each test keeps
// at most two connections open at a time.

function serverError(code: string, message?: RegExp) {
  return (error: unknown) =>
    error instanceof ChunkServerError &&
    !(error instanceof ChunkNotRetainedError) &&
    error.code === code &&
    (message === undefined || message.test(error.serverMessage));
}

function notRetained(start: bigint) {
  return (error: unknown) => error instanceof ChunkNotRetainedError && error.start === start;
}

function tagOf(text: string): Buffer {
  return Buffer.from(text);
}

async function collect(events: AsyncIterable<ChunkHistoryEvent>): Promise<ChunkHistoryEvent[]> {
  const out: ChunkHistoryEvent[] = [];
  for await (const e of events) {
    out.push(e);
  }
  return out;
}

// What a test compares: the block, its change and the tag.
function summary(e: ChunkHistoryEvent): string {
  return `${e.x},${e.y} ${e.before ?? "-"}>${e.after ?? "-"} ${e.tag === null ? "-" : Buffer.from(e.tag).toString()}`;
}

function tableUri(uri: string, name: string): string {
  return uri.replace(/\/$/, `/${name}`);
}

// 4x4 blocks of 4 bits per chunk: block (x, y) has index
// (y mod 4) * 4 + (x mod 4) in chunk (floor(x / 4), floor(y / 4)).
const SMALL = { blockBits: 4, chunkWidthBlocks: 4, chunkHeightBlocks: 4 } as const;

test("history: table options, TABLEINFO and what a table without history refuses", async () => {
  const server = await startServer();
  try {
    const client = await connectUri(server.uri);
    const hello = client.serverInfo()!;
    assert.ok(hello.capabilities.includes("history"));
    assert.equal(hello.maxTagBytes, 255);
    assert.equal(hello.maxHistoryLimit, 1024);
    assert.equal(hello.table!.history, false);
    assert.equal(hello.table!.historyStart, 0n);
    assert.equal(hello.table!.historyStartTimeMs, 0);
    assert.equal(hello.table!.historyMaxTagBytes, 0);

    // Tables start without history; refused commands keep the connection,
    // also a tagged CHUNKPUT whose bytes the server reads and drops.
    await assert.rejects(client.set(0, 0, "1".repeat(16), { tag: tagOf("a") }), serverError("INVALID_ARGUMENT", /TAG needs a table with history/));
    const payload = Buffer.alloc((await client.getChunk(0, 0)).length, 0xff);
    await assert.rejects(client.putChunk(0, 0, payload, { tag: tagOf("a") }), serverError("INVALID_ARGUMENT", /TAG needs a table with history/));
    await assert.rejects(client.history(0, 0), serverError("INVALID_ARGUMENT", /history is not enabled/));
    await assert.rejects(client.get(0, 0, { at: { revision: 1n } }), serverError("INVALID_ARGUMENT", /history is not enabled/));
    assert.equal(await client.ping(), "PONG");
    assert.equal(await client.get(0, 0), null);

    const before = Date.now();
    await client.createTable("h", {
      ...SMALL,
      history: true,
      historyMaxAgeMs: 86_400_000,
      historyMaxChunkBytes: 1_048_576,
      historyMaxTagBytes: 8,
    });
    const info = await client.tableInfo("h");
    assert.equal(info.history, true);
    assert.ok(info.historyStart > 0n);
    assert.ok(info.historyStartTimeMs >= before - 1000 && info.historyStartTimeMs <= Date.now());
    assert.equal(info.historyMaxAgeMs, 86_400_000);
    assert.equal(info.historyMaxChunkBytes, 1_048_576);
    assert.equal(info.historyMaxTagBytes, 8);

    // Limits change; history, once on, stays on.
    await client.setTableOptions("h", { historyMaxTagBytes: 16, historyMaxAgeMs: 0 });
    const changed = await client.tableInfo("h");
    assert.equal(changed.historyMaxTagBytes, 16);
    assert.equal(changed.historyMaxAgeMs, 0);
    assert.equal(changed.historyStart, info.historyStart);
    await assert.rejects(client.setTableOptions("h", { history: false }), serverError("INVALID_ARGUMENT"));

    // An existing table can turn it on; history starts then.
    await client.setTableOptions("default", { history: true });
    const enabled = await client.tableInfo("default");
    assert.equal(enabled.history, true);
    assert.ok(enabled.historyStart > info.historyStart);
    assert.equal(enabled.historyMaxTagBytes, 32);
    await client.close();

    // A tag over the table's limit is refused, the connection stays usable.
    const h = await connectUri(tableUri(server.uri, "h"));
    assert.equal(h.serverInfo()!.table!.history, true);
    const long = tagOf("x".repeat(17));
    await assert.rejects(h.set(0, 0, "1010", { tag: long }), serverError("INVALID_ARGUMENT", /exceeds history_max_tag_bytes \(16\)/));
    await assert.rejects(h.putChunk(0, 0, Buffer.alloc(8), { tag: long }), serverError("INVALID_ARGUMENT", /history_max_tag_bytes/));
    await h.set(0, 0, "1010", { tag: tagOf("x".repeat(16)) });
    const [only] = (await h.history(0, 0)).events;
    assert.equal(summary(only), `0,0 ->1010 ${"x".repeat(16)}`);
    await h.close();
  } finally {
    await server.stop();
  }
});

test("history: tags on every write kind appear in history", async () => {
  const server = await startServer();
  try {
    const admin = await connectUri(server.uri);
    await admin.createTable("t", { ...SMALL, history: true, extraMaxBlockBits: 64 });
    await admin.close();
    const client = await connectUri(tableUri(server.uri, "t"), { pipelineDepth: 4 });

    await client.set(1, 0, "1010", { tag: tagOf("set") });
    await client.mset(
      [
        { x: 0, y: 1, bits: "0001" },
        { x: 2, y: 1, bits: "0010" },
      ],
      { tag: tagOf("mset") },
    );
    await client.unset(1, 0, { tag: tagOf("unset") });
    // Block (3, 3) of chunk (0, 0) is bit 7 of presence byte 1.
    const state = await client.getChunkState(0, 0);
    state.presence[1] |= 0x80;
    await client.putChunkState(0, 0, state, { tag: tagOf("state") });
    const withExtra = await client.getChunkState(0, 0, { extra: true });
    withExtra.extra.set(4, { bitLength: 3, bytes: Buffer.from([0x05]) });
    await client.putChunkState(0, 0, withExtra, { tag: tagOf("extra"), zrle: true });
    const version = await client.chunkVersion(0, 0);
    const batch = await client.chunkBatch(0, 0, [{ type: "set", x: 3, y: 3, bits: "1111" }], {
      ifVersion: version,
      tag: tagOf("batch"),
    });
    assert.equal(batch.ok, true);
    await client.xput(3, 3, { bitLength: 12, bytes: Buffer.from([0xab, 0x0c]) }, { tag: tagOf("xput") });
    await client.xdel(3, 3, { tag: tagOf("xdel") });
    // Every block of chunk (1, 0) changes: 16 events per write.
    const put = await client.putChunk(1, 0, Buffer.alloc(8, 0x11), { tag: tagOf("put") });
    const zrle = await client.putChunk(1, 0, Buffer.alloc(8), { tag: tagOf("zrle"), zrle: true, ifVersion: put.version });
    assert.equal(zrle.ok, true);

    const events = await collect(client.chunkHistoryEvents(0, 0, { order: "asc" }));
    assert.deepEqual(events.map(summary), [
      "1,0 ->1010 set",
      "0,1 ->0001 mset",
      "2,1 ->0010 mset",
      "1,0 1010>- unset",
      "3,3 ->0000 state",
      "0,1 0001>0001 extra",
      "3,3 0000>1111 batch",
      "3,3 1111>1111 xput",
      "3,3 1111>1111 xdel",
    ]);
    assert.deepEqual(events[5].afterExtra, { bitLength: 3, bytes: Buffer.from([0x05]) });
    assert.equal(events[5].beforeExtra, null);
    assert.equal(events[6].revision, batch.version);
    assert.deepEqual(events[7].afterExtra, { bitLength: 12, bytes: Buffer.from([0xab, 0x0c]) });
    assert.deepEqual(events[8].beforeExtra, events[7].afterExtra);
    assert.equal(events[8].afterExtra, null);
    // Revisions grow; so do commit times within a chunk.
    for (let i = 1; i < events.length; i++) {
      assert.ok(events[i].revision > events[i - 1].revision);
      assert.ok(events[i].timeMs >= events[i - 1].timeMs);
    }

    // A chunk write's events carry its version as revision, by block index.
    const writes = await collect(client.chunkHistoryEvents(1, 0, { order: "asc", limit: 10 }));
    assert.equal(writes.length, 32);
    for (const [i, e] of writes.entries()) {
      const first = i < 16;
      assert.equal(e.revision, first ? put.version : zrle.version);
      assert.equal(summary(e), `${4 + (i % 4)},${Math.floor((i % 16) / 4)} ${first ? "-" : "1000"}>${first ? "1000" : "0000"} ${first ? "put" : "zrle"}`);
    }

    // Filters by tag.
    assert.deepEqual((await client.chunkHistory(0, 0, { tag: tagOf("mset") })).events.map(summary), [
      "2,1 ->0010 mset",
      "0,1 ->0001 mset",
    ]);
    assert.deepEqual((await client.history(3, 3, { tag: tagOf("xput") })).events.map(summary), ["3,3 1111>1111 xput"]);
    assert.deepEqual((await client.rangeHistory(0, 0, 1, 0, { tag: tagOf("none") })).events, []);

    // A pipelined read sees the tagged write called before it.
    const [, page] = await Promise.all([client.set(2, 2, "0110", { tag: tagOf("pipe") }), client.history(2, 2, { limit: 1 })]);
    assert.equal(summary(page.events[0]), "2,2 ->0110 pipe");
    await client.close();
  } finally {
    await server.stop();
  }
});

// A deterministic stream of numbers (the high bits of a linear
// congruential generator; its low bits repeat quickly).
function generator(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return Math.floor(state / 65536);
  };
}

interface ModelEvent {
  x: number;
  y: number;
  before: string | null;
  after: string | null;
  tag: string | null;
}

function modelSummary(e: ModelEvent): string {
  return `${e.x},${e.y} ${e.before ?? "-"}>${e.after ?? "-"} ${e.tag ?? "-"}`;
}

function blockIndex(x: number, y: number): number {
  return (((y % 4) + 4) % 4) * 4 + (((x % 4) + 4) % 4);
}

// Random writes to blocks -4..3 (chunks -1..0 on both axes) and the events
// they must leave: one per changed block, the blocks of one CHUNKBATCH in
// block order, nothing for a write that changes nothing.
async function writeModel(client: ChunkClient, count: number): Promise<ModelEvent[]> {
  const next = generator(7);
  const blocks = new Map<string, string>();
  const events: ModelEvent[] = [];
  const coord = () => (next() % 8) - 4;
  const bits = () => (next() % 16).toString(2).padStart(4, "0");
  const change = (x: number, y: number, after: string | null, tag: string | null) => {
    const before = blocks.get(`${x},${y}`) ?? null;
    if (before === after) {
      return;
    }
    if (after === null) {
      blocks.delete(`${x},${y}`);
    } else {
      blocks.set(`${x},${y}`, after);
    }
    events.push({ x, y, before, after, tag });
  };
  for (let i = 0; i < count; i++) {
    const tag = [null, "a", "b"][next() % 3];
    const options = tag === null ? {} : { tag: tagOf(tag) };
    const kind = next() % 4;
    if (kind === 0) {
      const [x, y, value] = [coord(), coord(), bits()];
      await client.set(x, y, value, options);
      change(x, y, value, tag);
    } else if (kind === 1) {
      const [x, y] = [coord(), coord()];
      await client.unset(x, y, options);
      change(x, y, null, tag);
    } else if (kind === 2) {
      const first = { x: coord(), y: coord(), bits: bits() };
      const second = { x: first.x === 3 ? -4 : first.x + 1, y: first.y, bits: bits() };
      await client.mset([first, second], options);
      change(first.x, first.y, first.bits, tag);
      change(second.x, second.y, second.bits, tag);
    } else {
      const cx = (next() % 2) - 1;
      const cy = (next() % 2) - 1;
      const picked = new Map<number, { x: number; y: number; bits: string | null }>();
      for (let n = 0; n < 3; n++) {
        const x = cx * 4 + (next() % 4);
        const y = cy * 4 + (next() % 4);
        picked.set(blockIndex(x, y), { x, y, bits: next() % 3 === 0 ? null : bits() });
      }
      await client.chunkBatch(
        cx,
        cy,
        [...picked.values()].map(({ x, y, bits: value }) =>
          value === null ? { type: "unset" as const, x, y } : { type: "set" as const, x, y, bits: value },
        ),
        options,
      );
      for (const [, { x, y, bits: value }] of [...picked.entries()].sort((a, b) => a[0] - b[0])) {
        change(x, y, value, tag);
      }
    }
  }
  return events;
}

// Every page of a window, following cursors by hand.
async function pages(
  read: (options: ChunkHistoryOptions) => Promise<ChunkHistoryPage>,
  options: ChunkHistoryOptions,
): Promise<ChunkHistoryPage[]> {
  const out: ChunkHistoryPage[] = [];
  let page = await read(options);
  out.push(page);
  while (page.cursor !== null) {
    page = await read(options.order === "asc" ? { ...options, after: page.cursor } : { ...options, before: page.cursor });
    out.push(page);
  }
  return out;
}

test("history: paging in both directions until END matches a model of the writes", async () => {
  const server = await startServer();
  try {
    const admin = await connectUri(server.uri);
    await admin.createTable("p", { ...SMALL, history: true });
    await admin.close();
    const uri = tableUri(server.uri, "p");
    const client = await connectUri(uri);
    const model = await writeModel(client, 80);
    const expected = model.map(modelSummary);
    assert.ok(expected.length > 60, `only ${expected.length} events`);

    // The whole rectangle, oldest and newest first, by iterator and by hand.
    const ascending = await collect(client.rangeHistoryEvents(-1, -1, 0, 0, { order: "asc", limit: 7 }));
    assert.deepEqual(ascending.map(summary), expected);
    const descending = await collect(client.rangeHistoryEvents(-1, -1, 0, 0, { limit: 5 }));
    assert.deepEqual(descending.map(summary), [...expected].reverse());
    for (const order of ["asc", "desc"] as const) {
      const read = async (options: ChunkHistoryOptions) => await client.rangeHistory(-1, -1, 0, 0, options);
      const all = await pages(read, { order, limit: 9 });
      assert.ok(all.length >= Math.ceil(expected.length / 9));
      const listed = all.flatMap((page) => page.events);
      assert.deepEqual(listed, order === "asc" ? ascending : descending);
      assert.equal(all.at(-1)!.cursor, null);
    }
    // Revisions only grow; the events of one mutation follow block order.
    for (let i = 1; i < ascending.length; i++) {
      const [a, b] = [ascending[i - 1], ascending[i]];
      assert.ok(b.revision > a.revision || (b.revision === a.revision && blockIndex(b.x, b.y) > blockIndex(a.x, a.y)));
    }

    // One chunk, one block, a tag.
    const inChunk = (e: { x: number; y: number }) => e.x >= 0 && e.y < 0;
    assert.deepEqual(
      (await collect(client.chunkHistoryEvents(0, -1, { order: "asc", limit: 3 }))).map(summary),
      model.filter(inChunk).map(modelSummary),
    );
    const block = model[model.length - 1];
    const ofBlock = (e: { x: number; y: number }) => e.x === block.x && e.y === block.y;
    assert.deepEqual(
      (await collect(client.historyEvents(block.x, block.y, { limit: 2 }))).map(summary),
      model.filter(ofBlock).map(modelSummary).reverse(),
    );
    assert.deepEqual(
      (await collect(client.rangeHistoryEvents(-1, -1, 0, 0, { order: "asc", tag: tagOf("a"), limit: 4 }))).map(summary),
      model.filter((e) => e.tag === "a").map(modelSummary),
    );

    // AFTER a bare revision (a chunk version works the same), BEFORE a
    // cursor, and the commit-time bounds.
    const middle = ascending[Math.floor(ascending.length / 2)];
    assert.deepEqual(
      await collect(client.rangeHistoryEvents(-1, -1, 0, 0, { order: "asc", after: middle.revision })),
      ascending.filter((e) => e.revision > middle.revision),
    );
    assert.deepEqual(
      await collect(client.rangeHistoryEvents(-1, -1, 0, 0, { before: middle.revision, limit: 6 })),
      descending.filter((e) => e.revision < middle.revision),
    );
    assert.deepEqual(
      await collect(client.rangeHistoryEvents(-1, -1, 0, 0, { order: "asc", since: middle.timeMs })),
      ascending.filter((e) => e.timeMs >= middle.timeMs),
    );
    assert.deepEqual(
      await collect(client.rangeHistoryEvents(-1, -1, 0, 0, { order: "asc", until: middle.timeMs })),
      ascending.filter((e) => e.timeMs <= middle.timeMs),
    );
    const version = await client.chunkVersion(0, -1);
    assert.deepEqual(await collect(client.chunkHistoryEvents(0, -1, { order: "asc", after: version })), []);
    await client.close();

    // A pool reads the same pages.
    const pool = await connectPool({ uri, maxConnections: 2 });
    assert.deepEqual(await collect(pool.rangeHistoryEvents(-1, -1, 0, 0, { order: "asc", limit: 11 })), ascending);
    assert.deepEqual((await pool.history(block.x, block.y, { limit: 1 })).events[0], descending.find(ofBlock));
    await pool.close();
  } finally {
    await server.stop();
  }
});

async function untilClockPasses(ms: number): Promise<void> {
  while (Date.now() <= ms) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

test("history: AT a revision and AT a time on every read command", async () => {
  const server = await startServer();
  try {
    const admin = await connectUri(server.uri);
    await admin.createTable("a", { ...SMALL, history: true, extraMaxBlockBits: 64 });
    await admin.close();
    const client = await connectUri(tableUri(server.uri, "a"));
    const info = client.serverInfo()!.table!;

    await client.set(1, 1, "1010");
    await client.xput(1, 1, { bitLength: 3, bytes: Buffer.from([0x05]) });
    await client.set(5, 5, "0110");
    const then = {
      get: await client.get(1, 1),
      chunk: await client.getChunk(0, 0),
      state: await client.getChunkState(0, 0),
      extra: await client.getChunkState(0, 0, { extra: true, zrle: true }),
      range: await client.chunkRange(0, 0, 1, 1),
      radius: await client.chunkRadius(0, 0, 1, { zrle: true }),
    };
    const written = (await client.rangeHistory(0, 0, 1, 1)).events;
    const revision = written[0].revision;
    const timeMs = Math.max(...written.map((e) => e.timeMs));
    // Later writes commit after `timeMs`, and AT TIME needs a time in the past.
    await untilClockPasses(timeMs);

    await client.unset(1, 1);
    await client.set(2, 2, "1111");
    await client.set(5, 5, "1001");
    assert.notEqual(await client.get(1, 1), then.get);

    for (const at of [{ revision }, { timeMs }]) {
      assert.equal(await client.get(1, 1, { at }), then.get);
      assert.equal(await client.get(2, 2, { at }), null);
      assert.deepEqual(await client.getChunk(0, 0, { at }), then.chunk);
      assert.deepEqual(await client.getChunk(0, 0, { at, zrle: true }), then.chunk);
      assert.deepEqual(await client.getChunkState(0, 0, { at }), then.state);
      assert.deepEqual(await client.getChunkState(0, 0, { at, extra: true, zrle: true }), then.extra);
      assert.deepEqual(await client.chunkRange(0, 0, 1, 1, { at }), then.range);
      assert.deepEqual(await client.chunkRadius(0, 0, 1, { at, zrle: true }), then.radius);
    }
    // Before any write of the table: nothing was set.
    assert.equal(await client.get(1, 1, { at: { revision: info.historyStart } }), null);

    // A point not yet settled is OUT_OF_RANGE; one before history started
    // is NOT_RETAINED with the revision history starts at.
    await assert.rejects(client.get(1, 1, { at: { revision: (1n << 64n) - 1n } }), serverError("OUT_OF_RANGE"));
    await assert.rejects(client.getChunk(0, 0, { at: { timeMs: Date.now() + 60_000 } }), serverError("OUT_OF_RANGE"));
    await assert.rejects(client.get(1, 1, { at: { revision: info.historyStart - 1n } }), notRetained(info.historyStart));
    await assert.rejects(client.getChunkState(0, 0, { at: { timeMs: 5 } }), notRetained(info.historyStart));
    await assert.rejects(client.chunkRange(0, 0, 1, 1, { at: { revision: 0n } }), notRetained(info.historyStart));
    await assert.rejects(client.chunkRadius(0, 0, 1, { at: { timeMs: 5 } }), notRetained(info.historyStart));
    assert.equal(await client.ping(), "PONG");
    await client.close();
  } finally {
    await server.stop();
  }
});

test("history: a window below what retention keeps fails with NOT_RETAINED", async () => {
  const server = await startServer();
  try {
    const admin = await connectUri(server.uri);
    // A checkpoint after every write; each removes all but the newest
    // segment (about 64 KiB of history, here 8 rewrites of the whole chunk).
    await admin.createTable("r", {
      blockBits: 16,
      chunkWidthBlocks: 64,
      chunkHeightBlocks: 64,
      history: true,
      historyMaxChunkBytes: 1,
      checkpointUpdates: 1,
    });
    await admin.close();
    const client = await connectUri(tableUri(server.uri, "r"), { commandTimeoutMs: 30_000 });
    const historyStart = client.serverInfo()!.table!.historyStart;
    for (let i = 0; i < 20; i++) {
      await client.putChunk(0, 0, randomBytes(8192));
    }

    // Oldest first fails at once and tells where history is kept from.
    let start = 0n;
    await assert.rejects(client.chunkHistory(0, 0, { order: "asc" }), (error: unknown) => {
      assert.ok(error instanceof ChunkNotRetainedError);
      start = error.start;
      return true;
    });
    assert.ok(start > historyStart);
    // Newest first returns what is kept, then fails.
    const kept: ChunkHistoryEvent[] = [];
    await assert.rejects(
      (async () => {
        for await (const e of client.chunkHistoryEvents(0, 0, { limit: 1024 })) {
          kept.push(e);
        }
      })(),
      notRetained(start),
    );
    assert.ok(kept.length > 0 && kept.every((e) => e.revision > start));
    // From the start on, the window ends normally.
    const fromStart = await collect(client.chunkHistoryEvents(0, 0, { order: "asc", after: start, limit: 1024 }));
    assert.deepEqual(fromStart, [...kept].reverse());
    // AT the start reads its state; below it is not kept.
    await client.getChunk(0, 0, { at: { revision: start } });
    await assert.rejects(client.getChunk(0, 0, { at: { revision: start - 1n } }), notRetained(start));
    await client.close();
  } finally {
    await server.stop();
  }
});

test("history: paging through an empty page", async () => {
  const server = await startServer();
  try {
    const admin = await connectUri(server.uri);
    // One read scans at most 16 MiB of history; whole-chunk rewrites of 256
    // KiB exceed that, so a filtered read stops early, here with an empty
    // page and a cursor.
    await admin.createTable("e", { blockBits: 32, chunkWidthBlocks: 256, chunkHeightBlocks: 256, history: true, checkpointUpdates: 4 });
    await admin.close();
    const client = await connectUri(tableUri(server.uri, "e"), { commandTimeoutMs: 60_000 });
    await client.set(0, 0, "1".repeat(32), { tag: tagOf("old") });
    const bytes = (await client.getChunk(0, 0)).length;
    let last = Buffer.alloc(0);
    for (let i = 0; i < 100; i++) {
      last = randomBytes(bytes);
      await client.putChunk(0, 0, last);
    }
    await client.set(1, 0, "0".repeat(32), { tag: tagOf("new") });
    // Block 1 is bits 32 to 63 of the last payload.
    const before = Array.from({ length: 32 }, (_, n) => (last[4 + (n >> 3)] >> (n & 7)) & 1).join("");

    // The tagged event at the far end of the window, and a tag no event has.
    const cases: Array<[ChunkHistoryOptions, string[]]> = [
      [{ order: "asc", tag: tagOf("new") }, [`1,0 ${before}>${"0".repeat(32)} new`]],
      [{ order: "desc", tag: tagOf("old") }, [`0,0 ->${"1".repeat(32)} old`]],
      [{ order: "asc", tag: tagOf("none") }, []],
      [{ tag: tagOf("none") }, []],
    ];
    for (const [options, expected] of cases) {
      const all = await pages(async (page) => await client.chunkHistory(0, 0, page), options);
      const sizes = all.map((page) => `${page.events.length}${page.cursor === null ? "" : "+"}`).join(",");
      assert.ok(all[0].events.length === 0 && all[0].cursor !== null, `pages ${options.order ?? "desc"}: ${sizes}`);
      assert.deepEqual(all.flatMap((page) => page.events).map(summary), expected);
      assert.deepEqual((await collect(client.chunkHistoryEvents(0, 0, options))).map(summary), expected);
    }
    await client.close();
  } finally {
    await server.stop();
  }
});
