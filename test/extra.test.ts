import test from "node:test";
import assert from "node:assert/strict";
import net, { type Socket } from "node:net";

import {
  ChunkClient,
  ChunkPool,
  ChunkProtocolError,
  ChunkServerError,
  decodeExtraSection,
  encodeExtraSection,
  zrleCompress,
  zrleDecompress,
} from "../src/index";

// The fake server's table: 4x4 blocks of 4 bits, so a state is 8 payload
// bytes and 2 presence bytes, and block indexes run from 0 to 15.
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
];
const STATE_BYTES = 10;
const BLOCKS = 16;

function bulk(value: Buffer | string): Buffer {
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  return Buffer.concat([Buffer.from(`$${bytes.length}\r\n`), bytes, Buffer.from("\r\n")]);
}

function helloReply(
  options: { capabilities?: string; maxExtraChunkBytes?: number | null; table?: string[] | null } = {},
): Buffer {
  const lines = [
    "protocol=2",
    "server_version=test",
    `capabilities=${options.capabilities ?? "zrle,extra-data"}`,
    "max_line_bytes=65536",
    "max_area_chunks=256",
    "max_response_bytes=67108864",
    "max_scan_limit=1024",
    "max_batch_ops=1024",
  ];
  if (options.maxExtraChunkBytes !== null) {
    lines.push(`max_extra_chunk_bytes=${options.maxExtraChunkBytes ?? 16777216}`);
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

function value(bitLength: number, bytes: number[]) {
  return { bitLength, bytes: Buffer.from(bytes) };
}

function section(entries: number[][]): Buffer {
  return Buffer.from(entries.flat());
}

test("EXTRA section: encode orders by block index, clears padding, and decodes back", () => {
  const extra = new Map([
    [9, { bitLength: 12, bytes: Uint8Array.from([0xab, 0xfc]) }],
    [2, { bitLength: 1, bytes: Uint8Array.from([0x01]) }],
  ]);
  const encoded = encodeExtraSection(extra, BLOCKS);
  assert.deepEqual(
    encoded,
    section([
      [2, 0, 0, 0, 1, 0, 0, 0, 0x01],
      [9, 0, 0, 0, 12, 0, 0, 0, 0xab, 0x0c],
    ]),
  );
  const decoded = decodeExtraSection(encoded, BLOCKS);
  assert.deepEqual([...decoded.keys()], [2, 9]);
  assert.deepEqual(decoded.get(9), value(12, [0xab, 0x0c]));
  assert.deepEqual(decoded.get(2), value(1, [0x01]));

  // Whole bytes have no padding; an empty section has no values.
  const whole = encodeExtraSection(new Map([[15, value(16, [0xff, 0xff])]]), BLOCKS);
  assert.deepEqual(decodeExtraSection(whole, BLOCKS).get(15), value(16, [0xff, 0xff]));
  assert.equal(encodeExtraSection(new Map(), BLOCKS).length, 0);
  assert.equal(decodeExtraSection(Buffer.alloc(0), BLOCKS).size, 0);
});

test("EXTRA section: decode rejects what the protocol rules out", () => {
  const cases: Array<[string, Buffer]> = [
    ["header extends past", Buffer.from([2, 0, 0, 0, 1, 0, 0])],
    ["value extends past", section([[2, 0, 0, 0, 9, 0, 0, 0, 0x01]])],
    ["the chunk has 16 blocks", section([[16, 0, 0, 0, 1, 0, 0, 0, 0x01]])],
    ["not strictly ascending", section([[5, 0, 0, 0, 1, 0, 0, 0, 0x01], [5, 0, 0, 0, 1, 0, 0, 0, 0x01]])],
    ["not strictly ascending", section([[5, 0, 0, 0, 1, 0, 0, 0, 0x01], [3, 0, 0, 0, 1, 0, 0, 0, 0x01]])],
    ["has 0 bits", section([[2, 0, 0, 0, 0, 0, 0, 0]])],
    ["set bits past its bit length", section([[2, 0, 0, 0, 1, 0, 0, 0, 0x03]])],
  ];
  for (const [message, bytes] of cases) {
    assert.throws(() => decodeExtraSection(bytes, BLOCKS), protocolError("protocol", new RegExp(message)));
  }
  assert.throws(() => decodeExtraSection(Buffer.alloc(0), 0), TypeError);
});

test("EXTRA section: encode rejects invalid values and block indexes", () => {
  const ok = value(3, [0x05]);
  for (const blockIndex of [-1, 1.5, BLOCKS]) {
    assert.throws(() => encodeExtraSection(new Map([[blockIndex, ok]]), BLOCKS), protocolError("request", /block index/));
  }
  for (const bad of [value(0, []), { bitLength: 1.5, bytes: Buffer.from([1]) }, value(134_217_665, [])]) {
    assert.throws(() => encodeExtraSection(new Map([[0, bad]]), BLOCKS), protocolError("request", /bitLength/));
  }
  assert.throws(
    () => encodeExtraSection(new Map([[0, value(9, [0x01])]]), BLOCKS),
    protocolError("request", /9 bits takes 2 bytes, got 1/),
  );
  assert.throws(() => encodeExtraSection(new Map(), 0), TypeError);
});

test("xget, xput and xdel frame their commands and read the replies", async () => {
  await withClient(
    (request) => {
      if (request.line === "XGET 3 -4") return bulk(Buffer.from([12, 0, 0, 0, 0xab, 0x0c]));
      if (request.line === "XGET 0 0") return "$-1\r\n";
      return "+OK\r\n";
    },
    async (client, server) => {
      assert.deepEqual(await client.xget(3, -4), value(12, [0xab, 0x0c]));
      assert.equal(await client.xget(0, 0), null);
      await client.xput(1, 2, { bitLength: 12, bytes: Uint8Array.from([0xab, 0x0c]) });
      await client.xput(-5, 2, Buffer.from("hi"));
      await client.xdel(1, 2);
      assert.deepEqual(server.requests, [
        { line: "XGET 3 -4" },
        { line: "XGET 0 0" },
        { line: "XPUT 1 2 12 2", payload: Buffer.from([0xab, 0x0c]) },
        { line: "XPUT -5 2 16 2", payload: Buffer.from("hi") },
        { line: "XDEL 1 2" },
      ]);
    },
  );
});

test("xget rejects malformed values", async () => {
  const replies = [
    bulk(Buffer.from([12, 0, 0])),
    bulk(Buffer.from([12, 0, 0, 0, 0xab])),
    bulk(Buffer.from([0, 0, 0, 0])),
    bulk(Buffer.from([3, 0, 0, 0, 0xff])),
  ];
  let next = 0;
  await withClient(
    () => replies[next++],
    async (client) => {
      for (let i = 0; i < replies.length; i += 1) {
        await assert.rejects(client.xget(0, 0), (error: unknown) => {
          assert.ok(protocolError("protocol")(error), String(error));
          assert.equal((error as ChunkProtocolError).command, "XGET");
          return true;
        });
      }
    },
  );
});

test("server errors are ChunkServerErrors and leave the connection usable", async () => {
  await withClient(
    (request) => {
      if (request.line.startsWith("XGET")) {
        return "-ERR INVALID_ARGUMENT extra data is not enabled on table 'world' (TABLESET world extra_max_block_bits <bits>)\r\n";
      }
      if (request.line.startsWith("XPUT")) {
        return "-ERR INVALID_ARGUMENT XPUT bit_length must be between 1 and extra_max_block_bits (64)\r\n";
      }
      return request.line === "PING" ? "+PONG\r\n" : "-ERR NO_TABLE table 'world' does not exist\r\n";
    },
    async (client) => {
      await assert.rejects(client.xget(0, 0), (error: unknown) => {
        assert.ok(error instanceof ChunkServerError);
        assert.equal(error.code, "INVALID_ARGUMENT");
        assert.equal(error.command, "XGET");
        assert.match(error.serverMessage, /extra data is not enabled on table 'world'/);
        return true;
      });
      await assert.rejects(
        client.xput(0, 0, value(65, new Array(9).fill(0))),
        (error: unknown) => error instanceof ChunkServerError && error.code === "INVALID_ARGUMENT" && error.command === "XPUT",
      );
      await assert.rejects(
        client.xdel(0, 0),
        (error: unknown) => error instanceof ChunkServerError && error.code === "NO_TABLE",
      );
      assert.equal(await client.ping(), "PONG");
    },
  );
});

test("xput checks the value before sending anything", async () => {
  await withClient(
    () => "+OK\r\n",
    async (client, server) => {
      await assert.rejects(client.xput(0, 0, value(0, [])), protocolError("request", /bitLength/));
      await assert.rejects(client.xput(0, 0, Buffer.alloc(0)), protocolError("request", /must not be empty/));
      await assert.rejects(client.xput(0, 0, value(134_217_665, [])), protocolError("request", /bitLength/));
      await assert.rejects(client.xput(0, 0, value(12, [1])), protocolError("request", /12 bits takes 2 bytes/));
      await assert.rejects(client.xput(0.5, 0, value(1, [1])), protocolError("request", /XPUT x must be a safe integer/));
      assert.deepEqual(server.requests, []);
    },
  );
  // A server without the capability would read the bytes as commands.
  await withClient(
    () => "+OK\r\n",
    async (client, server) => {
      await assert.rejects(client.xput(0, 0, value(1, [1])), protocolError("request", /capability "extra-data"/));
      await assert.rejects(
        client.putChunkState(0, 0, { payload: Buffer.alloc(8), presence: Buffer.alloc(2), extra: new Map() }),
        protocolError("request", /capability "extra-data"/),
      );
      assert.deepEqual(server.requests, []);
    },
    { hello: helloReply({ capabilities: "zrle", maxExtraChunkBytes: null }) },
  );
  // Without a table the server could not size the bytes.
  await withClient(
    () => "+OK\r\n",
    async (client, server) => {
      await assert.rejects(client.xput(0, 0, value(1, [1])), protocolError("request", /needs a table/));
      assert.deepEqual(server.requests, []);
    },
    { hello: helloReply({ table: null }) },
  );
});

test("chunkBatch sends XPUT and XDEL operations", async () => {
  await withClient(
    () => bulk("8"),
    async (client, server) => {
      const result = await client.chunkBatch(
        0,
        0,
        [
          { type: "set", x: 1, y: 1, bits: "1010" },
          { type: "xput", x: 1, y: 1, bits: "101" },
          { type: "xdel", x: 2, y: 2 },
          { type: "unset", x: 3, y: 3 },
        ],
        { ifVersion: 7n },
      );
      assert.deepEqual(result, { ok: true, version: 8n });
      assert.deepEqual(server.requests, [{ line: "CHUNKBATCH 0 0 IF 7 SET 1 1 1010 XPUT 1 1 101 XDEL 2 2 UNSET 3 3" }]);

      for (const bits of ["", "102"]) {
        await assert.rejects(
          client.chunkBatch(0, 0, [{ type: "xput", x: 1, y: 1, bits }]),
          protocolError("request", /chunkBatch xput bits must contain only 0 and 1/),
        );
      }
      await assert.rejects(
        client.chunkBatch(0, 0, [{ type: "xdell", x: 1, y: 1 } as never]),
        protocolError("request", /unknown chunkBatch operation type: xdell/),
      );
      assert.equal(server.requests.length, 1);
    },
  );
});

const PAYLOAD = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
const PRESENCE = Buffer.from([0x01, 0x80]);
// Values of blocks 0 and 15, the blocks PRESENCE has present.
const SECTION = section([
  [0, 0, 0, 0, 3, 0, 0, 0, 0x05],
  [15, 0, 0, 0, 12, 0, 0, 0, 0xab, 0x0c],
]);

test("getChunkState with extra reads the EXTRA section, also zrle-compressed", async () => {
  const body = Buffer.concat([PAYLOAD, PRESENCE, SECTION]);
  await withClient(
    (request) => {
      if (request.line.endsWith("ZRLE")) return bulk(zrleCompress(body));
      if (request.line.endsWith("EXTRA")) return bulk(body);
      return bulk(Buffer.concat([PAYLOAD, PRESENCE]));
    },
    async (client, server) => {
      const expected = {
        exists: true,
        payload: PAYLOAD,
        presence: PRESENCE,
        extra: new Map([
          [0, value(3, [0x05])],
          [15, value(12, [0xab, 0x0c])],
        ]),
      };
      assert.deepEqual(await client.getChunkState(-1, -1, { extra: true }), expected);
      assert.deepEqual(await client.getChunkState(-1, -1, { extra: true, zrle: true }), expected);
      assert.deepEqual(await client.getChunkState(-1, -1), { exists: true, payload: PAYLOAD, presence: PRESENCE });
      assert.deepEqual(
        server.requests.map((request) => request.line),
        ["CHUNKGET -1 -1 STATE EXTRA", "CHUNKGET -1 -1 STATE EXTRA ZRLE", "CHUNKGET -1 -1 STATE"],
      );
    },
  );
});

test("getChunkState with extra bounds the reply and checks the section", async () => {
  // A zrle header declaring `size` bytes, without the tokens.
  const declaring = (size: number) => {
    const header = Buffer.from([0x01, 0, 0, 0, 0]);
    header.writeUInt32LE(size, 1);
    return header;
  };
  const replies = [
    bulk(Buffer.alloc(STATE_BYTES - 1)),
    bulk(Buffer.alloc(STATE_BYTES + 65)),
    bulk(declaring(STATE_BYTES + 65)),
    bulk(declaring(STATE_BYTES - 1)),
    bulk(zrleCompress(Buffer.concat([PAYLOAD, PRESENCE, section([[4, 0, 0, 0, 1, 0, 0, 0, 1], [3, 0, 0, 0, 1, 0, 0, 0, 1]])]))),
  ];
  const checks = [
    /returned 9 bytes, expected 10 to 74/,
    /returned 75 bytes, expected 10 to 74/,
    /declares 75 bytes, expected 10 to 74/,
    /declares 9 bytes, expected 10 to 74/,
    /not strictly ascending/,
  ];
  let next = 0;
  await withClient(
    () => replies[next++],
    async (client) => {
      for (const [i, check] of checks.entries()) {
        await assert.rejects(
          client.getChunkState(0, 0, { extra: true, zrle: i >= 2 }),
          protocolError("protocol", check),
        );
      }
    },
    { hello: helloReply({ maxExtraChunkBytes: 64 }) },
  );
});

test("putChunkState with extra sends STATE EXTRA and the section", async () => {
  await withClient(
    (request) => (request.line.includes(" IF ") ? "-ERR VERSION_MISMATCH current=9\r\n" : bulk("5")),
    async (client, server) => {
      const extra = new Map([
        [15, value(12, [0xab, 0x0c])],
        [0, value(3, [0x05])],
      ]);
      const state = { payload: PAYLOAD, presence: PRESENCE, extra };
      assert.deepEqual(await client.putChunkState(0, 0, state), { ok: true, version: 5n });
      assert.deepEqual(server.requests.at(-1), {
        line: `CHUNKPUT 0 0 STATE EXTRA ${STATE_BYTES + SECTION.length}`,
        payload: Buffer.concat([PAYLOAD, PRESENCE, SECTION]),
      });

      // ZRLE and IF go after EXTRA; the body decodes to the state and section.
      const zeros = new Map([[3, value(512, new Array(64).fill(0))]]);
      const sparse = { payload: Buffer.alloc(8), presence: PRESENCE, extra: zeros };
      assert.deepEqual(await client.putChunkState(0, 0, sparse, { zrle: true, ifVersion: 4n }), {
        ok: false,
        version: 9n,
      });
      const zrle = server.requests.at(-1)!;
      assert.match(zrle.line, /^CHUNKPUT 0 0 STATE EXTRA ZRLE IF 4 [0-9]+$/);
      assert.deepEqual(
        zrleDecompress(zrle.payload!, STATE_BYTES + 72),
        Buffer.concat([sparse.payload, PRESENCE, encodeExtraSection(zeros, BLOCKS)]),
      );

      // An empty map deletes every value; no map keeps them.
      await client.putChunkState(0, 0, { payload: PAYLOAD, presence: PRESENCE, extra: new Map() });
      assert.equal(server.requests.at(-1)!.line, `CHUNKPUT 0 0 STATE EXTRA ${STATE_BYTES}`);
      await client.putChunkState(0, 0, { payload: PAYLOAD, presence: PRESENCE });
      assert.equal(server.requests.at(-1)!.line, `CHUNKPUT 0 0 STATE ${STATE_BYTES}`);
      assert.equal(server.requests.length, 4);

      // An invalid block index is refused before anything is sent.
      await assert.rejects(
        client.putChunkState(0, 0, { payload: PAYLOAD, presence: PRESENCE, extra: new Map([[16, value(1, [1])]]) }),
        protocolError("request", /CHUNKPUT extra data block index must be an integer from 0 to 15, got 16/),
      );
      assert.equal(server.requests.length, 4);
    },
  );
});

test("putChunkState refuses an EXTRA section above max_extra_chunk_bytes", async () => {
  await withClient(
    () => bulk("1"),
    async (client, server) => {
      // 8 header bytes and 57 value bytes: one byte over the cap.
      const extra = new Map([[0, value(57 * 8, new Array(57).fill(1))]]);
      await assert.rejects(
        client.putChunkState(0, 0, { payload: PAYLOAD, presence: PRESENCE, extra }),
        protocolError("request", /EXTRA section of 65 bytes exceeds max_extra_chunk_bytes \(64\)/),
      );
      assert.deepEqual(server.requests, []);
    },
    { hello: helloReply({ maxExtraChunkBytes: 64 }) },
  );
});

test("xput refuses a value above max_extra_chunk_bytes minus 8", async () => {
  await withClient(
    () => "+OK\r\n",
    async (client, server) => {
      // The server refuses a longer XPUT unread and closes the connection.
      await assert.rejects(
        client.xput(0, 0, value(57 * 8, new Array(57).fill(1))),
        protocolError("request", /XPUT value of 57 bytes exceeds max_extra_chunk_bytes minus 8 \(56\)/),
      );
      assert.deepEqual(server.requests, []);
      await client.xput(0, 0, value(56 * 8, new Array(56).fill(1)));
      assert.deepEqual(server.requests.map((request) => request.line), ["XPUT 0 0 448 56"]);
    },
    { hello: helloReply({ maxExtraChunkBytes: 64 }) },
  );
});

test("HELLO and table info report the extra-data keys; create and set send them", async () => {
  const plain = TABLE_LINES.filter((line) => !line.startsWith("extra_")).map((line) =>
    line.startsWith("table=") ? "table=plain" : line,
  );
  await withClient(
    (request) => {
      if (request.line === "TABLEINFO plain") return bulk(`${plain.join("\n")}\n`);
      if (request.line === "TABLEINFO off") {
        return bulk(`${[...plain, "extra_max_block_bits=0", "extra_max_chunk_bytes=0"].join("\n")}\n`);
      }
      if (request.line === "TABLEINFO bad") return bulk(`${[...plain, "extra_max_block_bits=-1"].join("\n")}\n`);
      return "+OK\r\n";
    },
    async (client, server) => {
      const hello = client.serverInfo()!;
      assert.ok(hello.capabilities.includes("extra-data"));
      assert.equal(hello.maxExtraChunkBytes, 16777216);
      assert.equal(hello.table!.extraMaxBlockBits, 64);
      assert.equal(hello.table!.extraMaxChunkBytes, 1024);

      // A server without extra data reports neither key.
      const info = await client.tableInfo("plain");
      assert.equal(info.extraMaxBlockBits, 0);
      assert.equal(info.extraMaxChunkBytes, 0);
      assert.equal((await client.tableInfo("off")).extraMaxBlockBits, 0);
      await assert.rejects(client.tableInfo("bad"), protocolError("protocol", /invalid extra_max_block_bits: -1/));

      await client.createTable("w", { blockBits: 4, extraMaxBlockBits: 256, extraMaxChunkBytes: 4096 });
      await client.setTableOptions("w", { extraMaxBlockBits: 512 });
      assert.deepEqual(server.requests.slice(-2), [
        { line: "TABLECREATE w block_bits 4 extra_max_block_bits 256 extra_max_chunk_bytes 4096" },
        { line: "TABLESET w extra_max_block_bits 512" },
      ]);
    },
  );
  await withClient(
    () => "+OK\r\n",
    async (client) => {
      assert.equal(client.serverInfo()!.maxExtraChunkBytes, 0);
    },
    { hello: helloReply({ maxExtraChunkBytes: null }) },
  );
});

// XPUT stores, XGET reads and XDEL deletes the one value of a fake block.
function valueStore(): (request: FakeRequest) => string | Buffer {
  let stored: Buffer | null = null;
  return (request) => {
    const [name, , , bits] = request.line.split(" ");
    if (name === "XPUT") {
      stored = Buffer.concat([Buffer.alloc(4), request.payload!]);
      stored.writeUInt32LE(Number(bits), 0);
      return "+OK\r\n";
    }
    if (name === "XDEL") {
      stored = null;
      return "+OK\r\n";
    }
    if (name === "XGET") return stored === null ? "$-1\r\n" : bulk(stored);
    if (name === "CHUNKGET") return bulk(Buffer.concat([PAYLOAD, PRESENCE, SECTION]));
    return "-ERR UNKNOWN_COMMAND unsupported\r\n";
  };
}

test("extra-data commands pipeline", async () => {
  // Replies are held until all four requests arrived.
  await withClient(
    (request) => {
      if (request.line === "XGET 0 0") return bulk(Buffer.from([12, 0, 0, 0, 0xab, 0x0c]));
      if (request.line === "XGET 1 1") return "$-1\r\n";
      return "+OK\r\n";
    },
    async (client, server) => {
      const results = await Promise.all([
        client.xget(0, 0),
        client.xput(2, 2, value(3, [0x05])),
        client.xget(1, 1),
        client.xdel(3, 3),
      ]);
      assert.deepEqual(results, [value(12, [0xab, 0x0c]), undefined, null, undefined]);
      assert.deepEqual(server.requests.map((request) => request.line).sort(), [
        "XDEL 3 3",
        "XGET 0 0",
        "XGET 1 1",
        "XPUT 2 2 3 1",
      ]);
    },
    { batch: 4, pipelineDepth: 4 },
  );
});

test("ChunkPool forwards the extra-data methods", async () => {
  const server = await startFakeServer(valueStore());
  const pool = new ChunkPool({ host: "127.0.0.1", port: server.port, maxConnections: 1, commandTimeoutMs: 1000 });
  try {
    await pool.xput(0, 0, Buffer.from([0x5a]));
    assert.deepEqual(await pool.xget(0, 0), value(8, [0x5a]));
    await pool.xdel(0, 0);
    assert.equal(await pool.xget(0, 0), null);
    const state = await pool.getChunkState(0, 0, { extra: true });
    assert.deepEqual([...state.extra.keys()], [0, 15]);
  } finally {
    await pool.close();
    await server.close();
  }
});

test("a request line longer than max_line_bytes is refused before sending", async () => {
  await withClient(
    () => "+PONG\r\n",
    async (client, server) => {
      // A long batch value: the server would answer BAD_REQUEST and close.
      await assert.rejects(
        client.chunkBatch(0, 0, [{ type: "xput", x: 0, y: 0, bits: "1".repeat(70_000) }]),
        protocolError("request", /exceeds max_line_bytes \(65536\)/),
      );
      assert.deepEqual(server.requests, []);
      assert.equal(await client.ping(), "PONG");
    },
  );
});
