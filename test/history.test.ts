import test from "node:test";
import assert from "node:assert/strict";
import net, { type Socket } from "node:net";

import {
  ChunkClient,
  ChunkNotRetainedError,
  ChunkPool,
  ChunkProtocolError,
  ChunkServerError,
  zrleCompress,
  type ChunkHistoryEvent,
} from "../src/index";

// The fake server's table: 4x4 blocks of 4 bits, with extra data and
// history, so a state is 8 payload bytes and 2 presence bytes.
const TABLE_LINES = [
  "table=world",
  "store_id=0123456789abcdef0123456789abcdef",
  "block_bits=4",
  "chunk_width_blocks=4",
  "chunk_height_blocks=4",
  "large_chunk_width_chunks=8",
  "large_chunk_height_chunks=8",
  "durability_mode=relaxed",
  "checkpoint_updates=1000",
  "checkpoint_wal_bytes=1048576",
  "wal_group_commit_updates=1",
  "checkpoint_compression=none",
  "extra_max_block_bits=64",
  "extra_max_chunk_bytes=1024",
  "history=on",
  "history_start=18446744073709551615",
  "history_start_time_ms=1700000000000",
  "history_max_age_ms=86400000",
  "history_max_chunk_bytes=0",
  "history_max_tag_bytes=32",
];
const TAG = Buffer.from("job");
const TAG_HEX = "6a6f62";

function bulk(value: Buffer | string): Buffer {
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  return Buffer.concat([Buffer.from(`$${bytes.length}\r\n`), bytes, Buffer.from("\r\n")]);
}

function array(items: Array<string | Buffer | null>): Buffer {
  return Buffer.concat([
    Buffer.from(`*${items.length}\r\n`),
    ...items.map((item) => (item === null ? Buffer.from("$-1\r\n") : bulk(item))),
  ]);
}

function helloReply(
  options: { capabilities?: string; history?: boolean; maxTagBytes?: number; table?: string[] | null } = {},
): Buffer {
  const lines = [
    "protocol=2",
    "server_version=test",
    `capabilities=${options.capabilities ?? "zrle,extra-data,history"}`,
    "max_line_bytes=65536",
    "max_area_chunks=256",
    "max_response_bytes=67108864",
    "max_scan_limit=1024",
    "max_batch_ops=1024",
    "max_extra_chunk_bytes=16777216",
  ];
  if (options.history !== false) {
    lines.push(`max_tag_bytes=${options.maxTagBytes ?? 255}`, "max_history_limit=1024");
  }
  if (options.table !== null) {
    lines.push(...(options.table ?? TABLE_LINES));
  }
  return bulk(`${lines.join("\n")}\n`);
}

interface FakeRequest {
  line: string;
  payload?: Buffer;
}

interface FakeServer {
  port: number;
  requests: FakeRequest[];
  close(): Promise<void>;
}

// A server that answers HELLO with `hello` and every other request with
// `respond(request)`. XPUT and CHUNKPUT read the bytes their last argument
// declares and the empty line after them. With `batch`, replies are held
// until that many requests arrived, so a client that does not pipeline them
// times out.
async function startFakeServer(
  respond: (request: FakeRequest) => string | Buffer,
  options: { hello?: Buffer; batch?: number } = {},
): Promise<FakeServer> {
  const requests: FakeRequest[] = [];
  const sockets = new Set<Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    let buffer = Buffer.alloc(0);
    const held: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const newline = buffer.indexOf(0x0a);
        if (newline === -1) {
          return;
        }
        const line = buffer.subarray(0, newline).toString("utf8").replace(/\r$/, "");
        const name = line.split(" ", 1)[0];
        let consumed = newline + 1;
        const request: FakeRequest = { line };
        if (name === "XPUT" || name === "CHUNKPUT") {
          const length = Number(line.split(" ").at(-1));
          if (buffer.length < consumed + length + 2) {
            return;
          }
          request.payload = Buffer.from(buffer.subarray(consumed, consumed + length));
          assert.equal(buffer.subarray(consumed + length, consumed + length + 2).toString(), "\r\n");
          consumed += length + 2;
        }
        buffer = buffer.subarray(consumed);
        if (name === "HELLO") {
          socket.write(options.hello ?? helloReply());
          continue;
        }
        requests.push(request);
        const reply = respond(request);
        held.push(typeof reply === "string" ? Buffer.from(reply) : reply);
        if (held.length >= (options.batch ?? 1)) {
          socket.write(Buffer.concat(held.splice(0)));
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  return {
    port: address.port,
    requests,
    async close() {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function withClient(
  respond: (request: FakeRequest) => string | Buffer,
  run: (client: ChunkClient, server: FakeServer) => Promise<void>,
  options: { hello?: Buffer; batch?: number; pipelineDepth?: number } = {},
): Promise<void> {
  const server = await startFakeServer(respond, options);
  const client = new ChunkClient({
    host: "127.0.0.1",
    port: server.port,
    commandTimeoutMs: 1000,
    pipelineDepth: options.pipelineDepth,
  });
  try {
    await client.connect();
    await run(client, server);
  } finally {
    await client.close();
    await server.close();
  }
}

function protocolError(phase: "request" | "protocol", message?: RegExp) {
  return (error: unknown) =>
    error instanceof ChunkProtocolError && error.phase === phase && (message === undefined || message.test(error.message));
}

function lines(server: FakeServer): string[] {
  return server.requests.map((request) => request.line);
}

// Replies by request line; anything else is OK.
function script(replies: Record<string, string | Buffer>): (request: FakeRequest) => string | Buffer {
  return (request) => replies[request.line] ?? "+OK\r\n";
}

// An event item of a history reply.
function event(revision: number): string {
  return `${revision} ${1700000000000 + revision} 1 2 0000 1111 - - -`;
}

test("history, chunkHistory and rangeHistory send their options and read every field form", async () => {
  const page = array([
    "CURSOR 7:3",
    `9 1700000000123 -5 3 - 1010 - 12:ab0c ${TAG_HEX}`,
    "8 1700000000100 3 -4 0110 - 3:05 - -",
    "7 0 9007199254740991 -9007199254740991 1111 0000 1:01 64:ffffffffffffffff FF",
  ]);
  await withClient(
    script({
      [`HISTORY -5 3 LIMIT 3 ASC AFTER 5:2 BEFORE 12 SINCE 10 UNTIL 20 TAG ${TAG_HEX}`]: page,
      "CHUNKHISTORY 1 -2": array(["END"]),
      "RANGEHISTORY -1 -1 1 1 DESC AFTER 3 BEFORE 9:0": array(["CURSOR 4"]),
    }),
    async (client, server) => {
      const result = await client.history(-5, 3, {
        limit: 3,
        order: "asc",
        after: "5:2",
        before: 12n,
        since: 10,
        until: 20,
        tag: TAG,
      });
      assert.deepEqual(result, {
        cursor: "7:3",
        events: [
          {
            revision: 9n,
            timeMs: 1700000000123,
            x: -5,
            y: 3,
            before: null,
            after: "1010",
            beforeExtra: null,
            afterExtra: { bitLength: 12, bytes: Buffer.from([0xab, 0x0c]) },
            tag: TAG,
          },
          {
            revision: 8n,
            timeMs: 1700000000100,
            x: 3,
            y: -4,
            before: "0110",
            after: null,
            beforeExtra: { bitLength: 3, bytes: Buffer.from([0x05]) },
            afterExtra: null,
            tag: null,
          },
          {
            revision: 7n,
            timeMs: 0,
            x: Number.MAX_SAFE_INTEGER,
            y: -Number.MAX_SAFE_INTEGER,
            before: "1111",
            after: "0000",
            beforeExtra: { bitLength: 1, bytes: Buffer.from([0x01]) },
            afterExtra: { bitLength: 64, bytes: Buffer.alloc(8, 0xff) },
            tag: Buffer.from([0xff]),
          },
        ],
      });
      // END ends the window; a page can be empty and still have a cursor.
      assert.deepEqual(await client.chunkHistory(1, -2), { events: [], cursor: null });
      assert.deepEqual(await client.rangeHistory(-1, -1, 1, 1, { order: "desc", after: 3n, before: "9:0" }), {
        events: [],
        cursor: "4",
      });
      assert.deepEqual(lines(server), [
        `HISTORY -5 3 LIMIT 3 ASC AFTER 5:2 BEFORE 12 SINCE 10 UNTIL 20 TAG ${TAG_HEX}`,
        "CHUNKHISTORY 1 -2",
        "RANGEHISTORY -1 -1 1 1 DESC AFTER 3 BEFORE 9:0",
      ]);
    },
  );
});

test("history replies that break the protocol are rejected", async () => {
  const cases: Array<[Buffer, RegExp]> = [
    [array([]), /empty HISTORY response/],
    [array(["NEXT 5"]), /unexpected HISTORY header: NEXT 5/],
    [array(["CURSOR"]), /unexpected HISTORY header/],
    [array(["CURSOR 1:x"]), /invalid cursor/],
    [array(["CURSOR 18446744073709551616"]), /invalid cursor/],
    [array(["CURSOR 1:4294967296"]), /invalid cursor/],
    [array([null]), /unexpected null item/],
    [array(["END", null]), /unexpected null item/],
    [array(["END", "9 1 1 2 0000 1111 - -"]), /unexpected HISTORY event/],
    [array(["END", "9 1 1 2 0000 1111 - - - -"]), /unexpected HISTORY event/],
    [array(["END", "9  1 2 0000 1111 - - -"]), /invalid time/],
    [array(["END", "x 1 1 2 0000 1111 - - -"]), /invalid revision/],
    [array(["END", "9 -1 1 2 0000 1111 - - -"]), /invalid time/],
    [array(["END", "9 9007199254740993 1 2 0000 1111 - - -"]), /invalid time/],
    // Coordinates beyond the safe integers, also beyond int64, are refused,
    // never rounded.
    [array(["END", "9 1 9007199254740992 2 0000 1111 - - -"]), /invalid coordinate in HISTORY response: 9007199254740992/],
    [array(["END", "9 1 1 -147573952589676412928 0000 1111 - - -"]), /invalid coordinate/],
    [array(["END", "9 1 01 2 0000 1111 - - -"]), /invalid coordinate/],
    [array(["END", "9 1 1 2 000 1111 - - -"]), /invalid block bits/],
    [array(["END", "9 1 1 2 0000 11a1 - - -"]), /invalid block bits/],
    [array(["END", "9 1 1 2 0000 1111 12 - -"]), /invalid extra data: 12/],
    [array(["END", "9 1 1 2 0000 1111 0:00 - -"]), /invalid extra data/],
    [array(["END", "9 1 1 2 0000 1111 - 12:ab0 -"]), /invalid extra data/],
    [array(["END", "9 1 1 2 0000 1111 - 12:ab -"]), /1 extra data bytes for 12 bits/],
    [array(["END", "9 1 1 2 0000 1111 - 3:ff -"]), /set bits past its bit length/],
    [array(["END", "9 1 1 2 0000 1111 - - abc"]), /invalid tag/],
    [array(["END", "9 1 1 2 0000 1111 - - zz"]), /invalid tag/],
    [bulk("END"), /expected array response/],
  ];
  let next = 0;
  await withClient(
    (request) => (request.line === "PING" ? "+PONG\r\n" : cases[next++][0]),
    async (client) => {
      for (const [, check] of cases) {
        await assert.rejects(client.history(1, 2), (error: unknown) => {
          assert.ok(protocolError("protocol", check)(error), String(error));
          assert.equal((error as ChunkProtocolError).command, "HISTORY");
          return true;
        });
      }
      assert.equal(await client.ping(), "PONG");
    },
  );
});

test("history options, tags and points are checked before sending", async () => {
  await withClient(
    () => "+OK\r\n",
    async (client, server) => {
      const options: Array<[object, RegExp]> = [
        [{ limit: 0 }, /HISTORY limit must be an integer from 1 to 1024/],
        [{ limit: 1025 }, /limit must be an integer from 1 to 1024/],
        [{ limit: 1.5 }, /limit must be/],
        [{ order: "up" }, /order must be "asc" or "desc"/],
        [{ after: "1:x" }, /after must be a cursor/],
        [{ after: "1 LIMIT 2" }, /after must be a cursor/],
        [{ after: "18446744073709551616" }, /after must be a cursor/],
        [{ before: 5 }, /before must be a cursor/],
        [{ after: -1n }, /after must be an unsigned 64-bit bigint/],
        [{ before: 1n << 64n }, /before must be an unsigned 64-bit bigint/],
        [{ since: -1 }, /since must be a non-negative integer/],
        [{ until: 1.5 }, /until must be a non-negative integer/],
        [{ tag: new Uint8Array(0) }, /HISTORY tag must be a Uint8Array of 1 to 255 bytes/],
        [{ tag: new Uint8Array(256) }, /tag must be a Uint8Array of 1 to 255 bytes/],
        [{ tag: "job" }, /tag must be a Uint8Array/],
      ];
      for (const [bad, check] of options) {
        await assert.rejects(client.history(0, 0, bad), protocolError("request", check));
      }
      const points: Array<[object, RegExp]> = [
        [{}, /GET at must be \{ revision \} or \{ timeMs \}/],
        [{ revision: 1n, timeMs: 1 }, /at must be/],
        [{ revision: -1n }, /GET at.revision must be an unsigned 64-bit bigint/],
        [{ revision: 5 }, /at.revision must be/],
        [{ timeMs: -1 }, /GET at.timeMs must be a non-negative integer/],
        [{ timeMs: 1.5 }, /at.timeMs must be/],
      ];
      for (const [bad, check] of points) {
        await assert.rejects(client.get(0, 0, { at: bad as never }), protocolError("request", check));
      }
      await assert.rejects(client.set(0, 0, "1010", { tag: new Uint8Array(0) }), protocolError("request", /SET tag must be/));
      await assert.rejects(client.xput(0, 0, Buffer.from([1]), { tag: new Uint8Array(256) }), protocolError("request", /XPUT tag/));
      await assert.rejects(client.putChunk(0, 0, Buffer.alloc(8), { tag: new Uint8Array(0) }), protocolError("request", /CHUNKPUT tag/));
      assert.deepEqual(server.requests, []);
    },
  );
  // The server's max_tag_bytes bounds tags; the table's own limit is the
  // server's to check.
  await withClient(
    () => "+OK\r\n",
    async (client, server) => {
      await assert.rejects(client.set(0, 0, "1010", { tag: Buffer.from("12345") }), protocolError("request", /1 to 4 bytes/));
      await client.set(0, 0, "1010", { tag: Buffer.from("1234") });
      assert.deepEqual(lines(server), ["SET 0 0 1010 TAG 31323334"]);
    },
    { hello: helloReply({ maxTagBytes: 4 }) },
  );
  // A server without history would read a tagged CHUNKPUT or XPUT header as
  // malformed and close the connection.
  await withClient(
    () => "+OK\r\n",
    async (client, server) => {
      const refused = protocolError("request", /needs a server with block history \(capability "history"\)/);
      await assert.rejects(client.set(0, 0, "1010", { tag: TAG }), refused);
      await assert.rejects(client.putChunk(0, 0, Buffer.alloc(8), { tag: TAG }), refused);
      await assert.rejects(client.xput(0, 0, Buffer.from([1]), { tag: TAG }), refused);
      await assert.rejects(client.get(0, 0, { at: { revision: 1n } }), refused);
      await assert.rejects(client.getChunk(0, 0, { at: { timeMs: 1 } }), refused);
      await assert.rejects(client.history(0, 0), refused);
      await assert.rejects(client.chunkHistory(0, 0), refused);
      await assert.rejects(client.rangeHistory(0, 0, 1, 1), refused);
      assert.deepEqual(server.requests, []);
      // Without tags and AT, the same calls work as before.
      await client.set(0, 0, "1010");
      assert.deepEqual(lines(server), ["SET 0 0 1010"]);
    },
    { hello: helloReply({ capabilities: "zrle,extra-data", history: false }) },
  );
  // Without a table there are no block sizes to read events with.
  await withClient(
    () => "+OK\r\n",
    async (client, server) => {
      await assert.rejects(client.history(0, 0), protocolError("request", /HISTORY needs a table/));
      assert.deepEqual(server.requests, []);
    },
    { hello: helloReply({ table: null }) },
  );
});

const PAYLOAD = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
const PRESENCE = Buffer.from([0x01, 0x80]);

test("tags go where each write command takes them", async () => {
  await withClient(
    (request) => (request.line.startsWith("CHUNK") ? bulk("5") : "+OK\r\n"),
    async (client, server) => {
      const tag = { tag: TAG };
      await client.set(1, 2, "1010", tag);
      await client.unset(1, 2, tag);
      await client.mset(
        [
          { x: 1, y: 2, bits: "1010" },
          { x: 3, y: 4, bits: "0101" },
        ],
        tag,
      );
      await client.xput(1, 2, { bitLength: 12, bytes: Uint8Array.from([0xab, 0x0c]) }, tag);
      await client.xdel(1, 2, tag);
      assert.deepEqual(await client.putChunk(0, 0, PAYLOAD, tag), { ok: true, version: 5n });
      await client.putChunk(0, 0, Buffer.alloc(8), { tag: TAG, ifVersion: 4n, zrle: true });
      await client.putChunkState(0, 0, { payload: PAYLOAD, presence: PRESENCE }, tag);
      await client.putChunkState(0, 0, { payload: PAYLOAD, presence: PRESENCE, extra: new Map() }, { tag: TAG, ifVersion: 4n });
      await client.chunkBatch(0, 0, [{ type: "set", x: 1, y: 1, bits: "1010" }], { ifVersion: 7n, tag: TAG });
      await client.chunkBatch(0, 0, [{ type: "unset", x: 1, y: 1 }], tag);
      // Without a tag every form stays as it was.
      await client.set(1, 2, "1010");
      await client.chunkBatch(0, 0, [{ type: "xdel", x: 1, y: 1 }]);
      await client.putChunk(0, 0, PAYLOAD);
      assert.deepEqual(server.requests, [
        { line: `SET 1 2 1010 TAG ${TAG_HEX}` },
        { line: `UNSET 1 2 TAG ${TAG_HEX}` },
        { line: `MSET 1 2 1010 3 4 0101 TAG ${TAG_HEX}` },
        { line: `XPUT 1 2 12 TAG ${TAG_HEX} 2`, payload: Buffer.from([0xab, 0x0c]) },
        { line: `XDEL 1 2 TAG ${TAG_HEX}` },
        { line: `CHUNKPUT 0 0 TAG ${TAG_HEX} 8`, payload: PAYLOAD },
        { line: `CHUNKPUT 0 0 ZRLE IF 4 TAG ${TAG_HEX} ${server.requests[6].payload!.length}`, payload: server.requests[6].payload },
        { line: `CHUNKPUT 0 0 STATE TAG ${TAG_HEX} 10`, payload: Buffer.concat([PAYLOAD, PRESENCE]) },
        { line: `CHUNKPUT 0 0 STATE EXTRA IF 4 TAG ${TAG_HEX} 10`, payload: Buffer.concat([PAYLOAD, PRESENCE]) },
        { line: `CHUNKBATCH 0 0 IF 7 TAG ${TAG_HEX} SET 1 1 1010` },
        { line: `CHUNKBATCH 0 0 TAG ${TAG_HEX} UNSET 1 1` },
        { line: "SET 1 2 1010" },
        { line: "CHUNKBATCH 0 0 XDEL 1 1" },
        { line: "CHUNKPUT 0 0 8", payload: PAYLOAD },
      ]);
      assert.ok(server.requests[6].payload!.length < 8);
    },
  );
});

test("at reads the past on every read command", async () => {
  const state = Buffer.concat([PAYLOAD, PRESENCE]);
  await withClient(
    (request) => {
      const name = request.line.split(" ", 1)[0];
      if (name === "GET") return bulk("1010");
      if (name === "CHUNKRANGE" || name === "CHUNKRADIUS") return array(["0 0", state]);
      if (request.line.includes("STATE")) return bulk(state);
      return bulk(PAYLOAD);
    },
    async (client, server) => {
      const revision = { at: { revision: 5n } };
      const time = { at: { timeMs: 1700000000000 } };
      assert.equal(await client.get(1, 2, revision), "1010");
      assert.equal(await client.get(1, 2, time), "1010");
      assert.deepEqual(await client.getChunk(0, 0, revision), PAYLOAD);
      await client.getChunk(0, 0, { ...time, zrle: false });
      assert.deepEqual(await client.getChunkState(0, 0, revision), { exists: true, payload: PAYLOAD, presence: PRESENCE });
      await client.getChunkState(0, 0, { ...time, extra: true });
      const [entry] = await client.chunkRange(0, 0, 1, 1, revision);
      assert.deepEqual(entry, { cx: 0, cy: 0, payload: PAYLOAD, presence: PRESENCE });
      await client.chunkRadius(0, 0, 1, time);
      assert.deepEqual(lines(server), [
        "GET 1 2 AT 5",
        "GET 1 2 AT TIME 1700000000000",
        "CHUNKGET 0 0 AT 5",
        "CHUNKGET 0 0 AT TIME 1700000000000",
        "CHUNKGET 0 0 STATE AT 5",
        "CHUNKGET 0 0 STATE EXTRA AT TIME 1700000000000",
        "CHUNKRANGE 0 0 1 1 STATE AT 5",
        "CHUNKRADIUS 0 0 1 STATE AT TIME 1700000000000",
      ]);
    },
  );
  // ZRLE comes before AT.
  await withClient(
    () => bulk(zrleCompress(Buffer.alloc(8))),
    async (client, server) => {
      assert.deepEqual(await client.getChunk(0, 0, { zrle: true, at: { revision: 18446744073709551615n } }), Buffer.alloc(8));
      assert.deepEqual(lines(server), ["CHUNKGET 0 0 ZRLE AT 18446744073709551615"]);
    },
  );
});

test("NOT_RETAINED is a ChunkNotRetainedError with the start revision", async () => {
  await withClient(
    (request) => {
      if (request.line.startsWith("GET")) return "-ERR NOT_RETAINED start=42\r\n";
      if (request.line.startsWith("HISTORY")) return "-ERR NOT_RETAINED start=18446744073709551615\r\n";
      if (request.line.startsWith("CHUNKGET")) return "-ERR NOT_RETAINED gone\r\n";
      if (request.line.startsWith("CHUNKRANGE")) return "-ERR OUT_OF_RANGE AT 99 is not below the next revision (7)\r\n";
      return "+PONG\r\n";
    },
    async (client) => {
      await assert.rejects(client.get(1, 2, { at: { revision: 1n } }), (error: unknown) => {
        assert.ok(error instanceof ChunkNotRetainedError);
        assert.ok(error instanceof ChunkServerError);
        assert.equal(error.code, "NOT_RETAINED");
        assert.equal(error.serverCode, "NOT_RETAINED");
        assert.equal(error.serverMessage, "start=42");
        assert.equal(error.start, 42n);
        assert.equal(error.command, "GET");
        assert.equal(error.phase, "response");
        return true;
      });
      await assert.rejects(
        client.history(1, 2, { order: "asc" }),
        (error: unknown) => error instanceof ChunkNotRetainedError && error.start === 18446744073709551615n,
      );
      await assert.rejects(client.getChunk(0, 0, { at: { revision: 1n } }), protocolError("protocol", /unexpected NOT_RETAINED payload for CHUNKGET/));
      await assert.rejects(client.chunkRange(0, 0, 1, 1, { at: { revision: 99n } }), (error: unknown) => {
        assert.ok(error instanceof ChunkServerError && !(error instanceof ChunkNotRetainedError));
        assert.equal(error.code, "OUT_OF_RANGE");
        return true;
      });
      assert.equal(await client.ping(), "PONG");
    },
  );
});

async function collect(events: AsyncIterable<ChunkHistoryEvent>): Promise<bigint[]> {
  const revisions: bigint[] = [];
  for await (const e of events) {
    revisions.push(e.revision);
  }
  return revisions;
}

test("history iterators follow cursors through short and empty pages until END", async () => {
  await withClient(
    script({
      // Ascending: each cursor becomes AFTER; BEFORE stays the window's end.
      "HISTORY 1 2 LIMIT 2 ASC AFTER 3 BEFORE 100": array(["CURSOR 5:1", event(4), event(5)]),
      "HISTORY 1 2 LIMIT 2 ASC AFTER 5:1 BEFORE 100": array(["CURSOR 6"]),
      "HISTORY 1 2 LIMIT 2 ASC AFTER 6 BEFORE 100": array(["CURSOR 8", event(8)]),
      "HISTORY 1 2 LIMIT 2 ASC AFTER 8 BEFORE 100": array(["END", event(9)]),
      // Newest first (the default): each cursor becomes BEFORE.
      "CHUNKHISTORY 0 0 AFTER 2": array(["CURSOR 9", event(12), event(10)]),
      "CHUNKHISTORY 0 0 AFTER 2 BEFORE 9": array(["CURSOR 4"]),
      "CHUNKHISTORY 0 0 AFTER 2 BEFORE 4": array(["END"]),
      "RANGEHISTORY 0 0 1 1 LIMIT 1 DESC": array(["CURSOR 7", event(7)]),
      "RANGEHISTORY 0 0 1 1 LIMIT 1 DESC BEFORE 7": "-ERR NOT_RETAINED start=6\r\n",
    }),
    async (client, server) => {
      assert.deepEqual(await collect(client.historyEvents(1, 2, { limit: 2, order: "asc", after: 3n, before: 100n })), [
        4n,
        5n,
        8n,
        9n,
      ]);
      assert.deepEqual(await collect(client.chunkHistoryEvents(0, 0, { after: 2n })), [12n, 10n]);
      assert.equal(server.requests.length, 7);

      // A failing page ends the iteration after the events before it.
      const seen: bigint[] = [];
      await assert.rejects(
        (async () => {
          for await (const e of client.rangeHistoryEvents(0, 0, 1, 1, { order: "desc", limit: 1 })) {
            seen.push(e.revision);
          }
        })(),
        (error: unknown) => error instanceof ChunkNotRetainedError && error.start === 6n,
      );
      assert.deepEqual(seen, [7n]);
      assert.equal(server.requests.length, 9);

      // Breaking out early sends nothing more.
      for await (const e of client.historyEvents(1, 2, { limit: 2, order: "asc", after: 3n, before: 100n })) {
        assert.equal(e.revision, 4n);
        break;
      }
      assert.equal(server.requests.length, 10);
    },
  );
});

test("HELLO and table info report the history keys; create and set send them", async () => {
  const plain = TABLE_LINES.filter((line) => !line.startsWith("history")).map((line) =>
    line.startsWith("table=") ? "table=plain" : line,
  );
  const off = [
    ...plain,
    "history=off",
    "history_start=0",
    "history_start_time_ms=0",
    "history_max_age_ms=0",
    "history_max_chunk_bytes=0",
    "history_max_tag_bytes=0",
  ];
  await withClient(
    (request) => {
      if (request.line === "TABLEINFO plain") return bulk(`${plain.join("\n")}\n`);
      if (request.line === "TABLEINFO off") return bulk(`${off.join("\n")}\n`);
      if (request.line === "TABLEINFO bad") return bulk(`${[...plain, "history=yes"].join("\n")}\n`);
      if (request.line === "TABLEINFO worse") return bulk(`${[...plain, "history=on", "history_start=-1"].join("\n")}\n`);
      return "+OK\r\n";
    },
    async (client, server) => {
      const hello = client.serverInfo()!;
      assert.ok(hello.capabilities.includes("history"));
      assert.equal(hello.maxTagBytes, 255);
      assert.equal(hello.maxHistoryLimit, 1024);
      const table = hello.table!;
      assert.equal(table.history, true);
      assert.equal(table.historyStart, 18446744073709551615n);
      assert.equal(table.historyStartTimeMs, 1700000000000);
      assert.equal(table.historyMaxAgeMs, 86400000);
      assert.equal(table.historyMaxChunkBytes, 0);
      assert.equal(table.historyMaxTagBytes, 32);

      // A server without history reports none of the keys.
      for (const name of ["plain", "off"]) {
        const info = await client.tableInfo(name);
        assert.equal(info.history, false);
        assert.equal(info.historyStart, 0n);
        assert.equal(info.historyStartTimeMs, 0);
        assert.equal(info.historyMaxTagBytes, 0);
      }
      await assert.rejects(client.tableInfo("bad"), protocolError("protocol", /invalid history: yes/));
      await assert.rejects(client.tableInfo("worse"), protocolError("protocol", /invalid history_start: -1/));

      await client.createTable("w", {
        blockBits: 4,
        history: true,
        historyMaxAgeMs: 1000,
        historyMaxChunkBytes: 0,
        historyMaxTagBytes: 8,
      });
      await client.setTableOptions("w", { history: false });
      await client.setTableOptions("w", { history: true, historyMaxChunkBytes: 4096 });
      assert.deepEqual(lines(server).slice(-3), [
        "TABLECREATE w block_bits 4 history on history_max_age_ms 1000 history_max_chunk_bytes 0 history_max_tag_bytes 8",
        "TABLESET w history off",
        "TABLESET w history on history_max_chunk_bytes 4096",
      ]);
    },
  );
  await withClient(
    () => "+OK\r\n",
    async (client) => {
      assert.equal(client.serverInfo()!.maxTagBytes, 0);
      assert.equal(client.serverInfo()!.maxHistoryLimit, 0);
    },
    { hello: helloReply({ history: false }) },
  );
});

test("history commands pipeline in call order", async () => {
  // Replies are held until all four requests arrived.
  await withClient(
    (request) => {
      if (request.line.startsWith("GET")) return bulk("1010");
      if (request.line.startsWith("HISTORY")) return array(["END", event(3)]);
      return "+OK\r\n";
    },
    async (client, server) => {
      const results = await Promise.all([
        client.set(1, 2, "1010", { tag: TAG }),
        client.get(1, 2),
        client.history(1, 2, { limit: 1 }),
        client.get(1, 2, { at: { revision: 2n } }),
      ]);
      assert.equal(results[1], "1010");
      assert.equal(results[2].events[0].revision, 3n);
      // The tagged SET and AT read check the server's capability first, yet
      // the calls after them do not overtake them.
      assert.deepEqual(lines(server), [`SET 1 2 1010 TAG ${TAG_HEX}`, "GET 1 2", "HISTORY 1 2 LIMIT 1", "GET 1 2 AT 2"]);
    },
    { batch: 4, pipelineDepth: 4 },
  );
});

test("ChunkPool forwards the history methods and options", async () => {
  const server = await startFakeServer(
    script({
      "GET 1 2 AT 3": bulk("1010"),
      "HISTORY 1 2": array(["CURSOR 4", event(5)]),
      "HISTORY 1 2 BEFORE 4": array(["END", event(3)]),
      "CHUNKHISTORY 0 0 ASC": array(["END", event(6)]),
      "RANGEHISTORY 0 0 1 1 LIMIT 1": array(["END"]),
      [`CHUNKBATCH 0 0 TAG ${TAG_HEX} UNSET 1 1`]: bulk("9"),
    }),
  );
  const pool = new ChunkPool({ host: "127.0.0.1", port: server.port, maxConnections: 1, commandTimeoutMs: 1000 });
  try {
    const tag = { tag: TAG };
    await pool.set(1, 2, "1010", tag);
    await pool.unset(1, 2, tag);
    await pool.mset([{ x: 1, y: 2, bits: "1010" }], tag);
    await pool.xput(1, 2, Buffer.from([1]), tag);
    await pool.xdel(1, 2, tag);
    assert.deepEqual(await pool.chunkBatch(0, 0, [{ type: "unset", x: 1, y: 1 }], tag), { ok: true, version: 9n });
    assert.equal(await pool.get(1, 2, { at: { revision: 3n } }), "1010");
    assert.equal((await pool.history(1, 2)).cursor, "4");
    assert.deepEqual(await collect(pool.historyEvents(1, 2)), [5n, 3n]);
    assert.deepEqual((await pool.chunkHistory(0, 0, { order: "asc" })).events.map((e) => e.revision), [6n]);
    assert.deepEqual(await collect(pool.chunkHistoryEvents(0, 0, { order: "asc" })), [6n]);
    assert.deepEqual(await pool.rangeHistory(0, 0, 1, 1, { limit: 1 }), { events: [], cursor: null });
    assert.deepEqual(await collect(pool.rangeHistoryEvents(0, 0, 1, 1, { limit: 1 })), []);
    assert.deepEqual(lines(server), [
      `SET 1 2 1010 TAG ${TAG_HEX}`,
      `UNSET 1 2 TAG ${TAG_HEX}`,
      `MSET 1 2 1010 TAG ${TAG_HEX}`,
      `XPUT 1 2 8 TAG ${TAG_HEX} 1`,
      `XDEL 1 2 TAG ${TAG_HEX}`,
      `CHUNKBATCH 0 0 TAG ${TAG_HEX} UNSET 1 1`,
      "GET 1 2 AT 3",
      "HISTORY 1 2",
      "HISTORY 1 2",
      "HISTORY 1 2 BEFORE 4",
      "CHUNKHISTORY 0 0 ASC",
      "CHUNKHISTORY 0 0 ASC",
      "RANGEHISTORY 0 0 1 1 LIMIT 1",
      "RANGEHISTORY 0 0 1 1 LIMIT 1",
    ]);
  } finally {
    await pool.close();
    await server.close();
  }
});
