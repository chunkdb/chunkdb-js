import test from "node:test";
import assert from "node:assert/strict";
import type { Socket } from "node:net";

import {
  ChunkClient,
  ChunkConflictError,
  ChunkConnectionError,
  ChunkPool,
  ChunkProtocolError,
  ChunkServerError,
  connect,
} from "../src/index";
import { FAKE_HELLO, describeReply, startFakeServer, type FakeRequest } from "./fake-server";

interface Line {
  connection: number;
  line: string;
}

// A server that keeps a transaction per connection as chunkdb does: writes
// inside one answer `_`, outside one a version, and after a CONFLICT from a
// statement every statement answers it until ROLLBACK (+OK) or COMMIT (the
// CONFLICT again) closes the transaction. `answer` may override any reply;
// every statement is logged with its connection's number.
async function startTxServer(answer: (request: FakeRequest, inTx: boolean) => string | null | Promise<string | null> = () => null) {
  const lines: Line[] = [];
  const numbers = new WeakMap<Socket, number>();
  const inTx = new WeakSet<Socket>();
  const conflicts = new WeakMap<Socket, string>();
  let version = 10;
  let connections = 0;
  const server = await startFakeServer(async (request, socket) => {
    if (!numbers.has(socket)) {
      connections += 1;
      numbers.set(socket, connections);
    }
    lines.push({ connection: numbers.get(socket)!, line: request.line });
    const word = request.line.split(" ", 1)[0];
    const conflict = conflicts.get(socket);
    if (conflict !== undefined) {
      if (word === "ROLLBACK" || word === "COMMIT") {
        conflicts.delete(socket);
        inTx.delete(socket);
      }
      return word === "ROLLBACK" ? "+OK\r\n" : conflict;
    }
    const custom = await answer(request, inTx.has(socket));
    if (word === "COMMIT" || word === "ROLLBACK") {
      inTx.delete(socket);
    } else if (word === "BEGIN") {
      inTx.add(socket);
    }
    if (custom !== null) {
      if (custom.startsWith("-ERR CONFLICT") && inTx.has(socket)) {
        if (word === "COMMIT") {
          inTx.delete(socket);
        } else {
          conflicts.set(socket, custom);
        }
      }
      return custom;
    }
    switch (word) {
      case "HELLO":
        return FAKE_HELLO;
      case "DESCRIBE":
        return describeReply("f32");
      case "BEGIN":
      case "ROLLBACK":
        return "+OK\r\n";
      case "PING":
        return "+PONG\r\n";
      case "GET":
        return "*2\r\n:7\r\n,2.5\r\n";
      case "SET":
      case "DELETE":
        version += 1;
        return inTx.has(socket) ? "_\r\n" : `:${version}\r\n`;
      case "COMMIT":
        version += 1;
        return `:${version}\r\n`;
      default:
        return "-ERR SYNTAX unexpected\r\n";
    }
  });
  return { server, lines, statements: () => lines.map((l) => l.line).filter((line) => !line.startsWith("HELLO")) };
}

test("a transaction sends BEGIN, its statements and COMMIT, and resolves the commit version", async () => {
  const { server, statements } = await startTxServer();
  try {
    const client = await connect({ port: server.port, table: "t" });
    const results: unknown[] = [];
    const version = await client.transaction(async (tx) => {
      results.push(await tx.getBlock(0, 0));
      results.push(await tx.setBlock(1, 0, { id: 3 }));
      results.push(await tx.deleteBlock(2, 0));
    });
    assert.equal(version, 13n);
    assert.deepEqual(results, [{ id: 7, h: 2.5 }, undefined, undefined]);
    // The schema is fetched inside the transaction, on its connection.
    assert.deepEqual(statements(), [
      "BEGIN",
      "DESCRIBE t",
      "GET BLOCK 0 0 FROM t COLUMNS id, h",
      "SET BLOCK 1 0 IN t id = $1",
      "DELETE BLOCK 2 0 FROM t",
      "COMMIT",
    ]);
    await client.close();
  } finally {
    await server.close();
  }
});

test("COMMIT of a transaction that wrote nothing resolves null", async () => {
  const { server } = await startTxServer((request) => (request.line === "COMMIT" ? "_\r\n" : null));
  try {
    const client = await connect({ port: server.port, table: "t" });
    assert.equal(await client.transaction(async (tx) => void (await tx.getBlock(0, 0))), null);
    assert.equal(await client.transaction(() => {}), null);
    await client.close();
  } finally {
    await server.close();
  }
});

test("a CONFLICT at COMMIT runs the callback again", async () => {
  let commits = 0;
  const { server, statements } = await startTxServer((request) => {
    if (request.line === "COMMIT") {
      commits += 1;
      return commits === 1 ? "-ERR CONFLICT chunk_changed chunk (0, 0) changed after the snapshot\r\n" : ":42\r\n";
    }
    return null;
  });
  try {
    const client = await connect({ port: server.port, table: "t" });
    let runs = 0;
    const version = await client.transaction(async (tx) => {
      runs += 1;
      await tx.setBlock(0, 0, { id: runs });
    });
    assert.equal(version, 42n);
    assert.equal(runs, 2);
    assert.deepEqual(statements(), [
      "BEGIN",
      "DESCRIBE t",
      "SET BLOCK 0 0 IN t id = $1",
      "COMMIT",
      "BEGIN",
      "SET BLOCK 0 0 IN t id = $1",
      "COMMIT",
    ]);
    await client.close();
  } finally {
    await server.close();
  }
});

test("a CONFLICT stops after the retry limit with ChunkConflictError", async () => {
  const { server, statements } = await startTxServer((request) =>
    request.line === "COMMIT" ? "-ERR CONFLICT history_limit the table kept too many chunk states\r\n" : null,
  );
  try {
    const client = await connect({ port: server.port, table: "t" });
    let runs = 0;
    await assert.rejects(
      client.transaction(async (tx) => {
        runs += 1;
        await tx.setBlock(0, 0, { id: 1 });
      }, { retries: 2 }),
      (error: unknown) => {
        assert.ok(error instanceof ChunkConflictError && error instanceof ChunkServerError);
        assert.equal(error.serverCode, "CONFLICT");
        assert.equal(error.reason, "history_limit");
        assert.equal(error.command, "COMMIT");
        return true;
      },
    );
    assert.equal(runs, 3);
    assert.equal(statements().filter((line) => line === "COMMIT").length, 3);
    assert.ok(!statements().includes("ROLLBACK"));
    await assert.rejects(client.transaction(() => {}, { retries: -1 }), TypeError);
    await client.close();
  } finally {
    await server.close();
  }
});

test("a callback that throws rolls back and is not run again", async () => {
  const { server, statements } = await startTxServer();
  try {
    const client = await connect({ port: server.port, table: "t" });
    let runs = 0;
    const failure = new Error("not enough gold");
    await assert.rejects(
      client.transaction(async (tx) => {
        runs += 1;
        await tx.setBlock(0, 0, { id: 1 });
        throw failure;
      }),
      (error: unknown) => error === failure,
    );
    assert.equal(runs, 1);
    assert.deepEqual(statements(), ["BEGIN", "DESCRIBE t", "SET BLOCK 0 0 IN t id = $1", "ROLLBACK"]);
    // The connection is free again.
    assert.equal(await client.ping(), "PONG");
    await client.close();
  } finally {
    await server.close();
  }
});

test("after a CONFLICT inside the transaction its statements are not sent, and it runs again", async () => {
  let sets = 0;
  const { server, statements } = await startTxServer((request) => {
    if (request.line.startsWith("SET BLOCK 0 0")) {
      sets += 1;
      return sets === 1 ? "-ERR CONFLICT duration the transaction is open longer than 5000 ms\r\n" : null;
    }
    return null;
  });
  try {
    const client = await connect({ port: server.port, table: "t" });
    let runs = 0;
    const version = await client.transaction(async (tx) => {
      runs += 1;
      try {
        await tx.setBlock(0, 0, { id: 1 });
      } catch (error) {
        assert.ok(error instanceof ChunkConflictError);
        assert.equal(error.reason, "duration");
      }
      // The server ended the transaction: this write is not sent.
      await tx.setBlock(1, 1, { id: 2 });
    });
    // The first run swallowed the CONFLICT, so its second write rejected
    // with it; ROLLBACK closed the ended transaction, which then ran again
    // and committed.
    assert.equal(runs, 2);
    assert.equal(typeof version, "bigint");
    assert.deepEqual(statements(), [
      "BEGIN",
      "DESCRIBE t",
      "SET BLOCK 0 0 IN t id = $1",
      "ROLLBACK",
      "BEGIN",
      "SET BLOCK 0 0 IN t id = $1",
      "SET BLOCK 1 1 IN t id = $1",
      "COMMIT",
    ]);
    await client.close();
  } finally {
    await server.close();
  }
});

test("a CONFLICT the callback catches is still rolled back before the transaction runs again", async () => {
  let gets = 0;
  const { server, statements } = await startTxServer((request) => {
    if (request.line.startsWith("GET")) {
      gets += 1;
      return gets === 1 ? "-ERR CONFLICT table_changed the table was altered\r\n" : null;
    }
    return null;
  });
  try {
    const client = await connect({ port: server.port, table: "t" });
    let runs = 0;
    const version = await client.transaction(async (tx) => {
      runs += 1;
      await tx.getBlock(0, 0).catch(() => null);
    });
    assert.equal(runs, 2);
    assert.equal(version, 11n);
    assert.deepEqual(statements(), [
      "BEGIN",
      "DESCRIBE t",
      "GET BLOCK 0 0 FROM t COLUMNS id, h",
      "ROLLBACK",
      "BEGIN",
      "GET BLOCK 0 0 FROM t COLUMNS id, h",
      "COMMIT",
    ]);
    await client.close();
  } finally {
    await server.close();
  }
});

test("a ROLLBACK that does not answer +OK closes the connection", async () => {
  const { server, lines } = await startTxServer((request) =>
    request.line === "ROLLBACK" ? "-ERR INTERNAL rollback failed\r\n" : null,
  );
  try {
    const client = await connect({ port: server.port, table: "t" });
    const failure = new Error("stop");
    await assert.rejects(
      client.transaction(async (tx) => {
        await tx.setBlock(0, 0, { id: 1 });
        throw failure;
      }),
      (error: unknown) => error === failure,
    );
    // The server rolls back the closed connection's transaction; the next
    // call reconnects.
    assert.equal(await client.ping(), "PONG");
    assert.deepEqual(
      lines.filter((l) => !l.line.startsWith("HELLO")).map((l) => [l.connection, l.line]),
      [
        [1, "BEGIN"],
        [1, "DESCRIBE t"],
        [1, "SET BLOCK 0 0 IN t id = $1"],
        [1, "ROLLBACK"],
        [2, "PING"],
      ],
    );
    await client.close();
  } finally {
    await server.close();
  }
});

test("statements inside a transaction run one at a time", async () => {
  let inFlight = 0;
  let most = 0;
  const { server } = await startTxServer(async (request) => {
    if (request.line.startsWith("GET")) {
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight -= 1;
    }
    return null;
  });
  try {
    const client = await connect({ port: server.port, table: "t", pipelineDepth: 8 });
    await client.transaction(async (tx) => {
      await Promise.all([tx.getBlock(0, 0), tx.getBlock(1, 0), tx.getBlock(2, 0)]);
    });
    assert.equal(most, 1);
    await client.close();
  } finally {
    await server.close();
  }
});

test("plain calls wait for the transaction and never land inside it", async () => {
  let releaseGet!: () => void;
  const getHeld = new Promise<void>((resolve) => {
    releaseGet = resolve;
  });
  let slowPing = true;
  const { server, statements } = await startTxServer(async (request) => {
    if (request.line === "PING" && slowPing) {
      slowPing = false;
      await new Promise((resolve) => setTimeout(resolve, 30));
      return "+PONG\r\n";
    }
    return null;
  });
  try {
    const client = new ChunkClient({ port: server.port, table: "t", pipelineDepth: 8 });
    // A call in flight before the transaction finishes before BEGIN.
    const before = client.ping();
    let gate!: () => void;
    const callbackStarted = new Promise<void>((resolve) => {
      gate = resolve;
    });
    const transaction = client.transaction(async (tx) => {
      await tx.getBlock(0, 0);
      gate();
      await getHeld;
      await tx.setBlock(0, 0, { id: 1 });
    });
    await callbackStarted;
    // Called while the transaction holds the connection: they wait.
    const during = [client.ping(), client.setBlock(5, 5, { id: 9 })];
    await new Promise((resolve) => setTimeout(resolve, 20));
    releaseGet();
    assert.equal(await before, "PONG");
    assert.equal(typeof (await transaction), "bigint");
    assert.deepEqual(await Promise.all(during), ["PONG", 13n]);
    assert.deepEqual(statements(), [
      "PING",
      "BEGIN",
      "DESCRIBE t",
      "GET BLOCK 0 0 FROM t COLUMNS id, h",
      "SET BLOCK 0 0 IN t id = $1",
      "COMMIT",
      "PING",
      "SET BLOCK 5 5 IN t id = $1",
    ]);
    await client.close();
  } finally {
    await server.close();
  }
});

test("a pooled transaction keeps its connection; other calls use another one", async () => {
  let releaseGet!: () => void;
  const getHeld = new Promise<void>((resolve) => {
    releaseGet = resolve;
  });
  const { server, lines } = await startTxServer();
  const pool = new ChunkPool({ port: server.port, table: "t", maxConnections: 2 });
  try {
    let gate!: () => void;
    const callbackStarted = new Promise<void>((resolve) => {
      gate = resolve;
    });
    const transaction = pool.transaction(async (tx) => {
      await tx.getBlock(0, 0);
      gate();
      await getHeld;
      await tx.setBlock(0, 0, { id: 1 });
    });
    await callbackStarted;
    assert.equal(await pool.ping(), "PONG");
    assert.equal(await pool.setBlock(3, 3, { id: 2 }), 11n);
    releaseGet();
    assert.equal(await transaction, 13n);
    const of = (connection: number) => lines.filter((l) => l.connection === connection && !l.line.startsWith("HELLO")).map((l) => l.line);
    assert.deepEqual(of(1), ["BEGIN", "DESCRIBE t", "GET BLOCK 0 0 FROM t COLUMNS id, h", "SET BLOCK 0 0 IN t id = $1", "COMMIT"]);
    assert.deepEqual(of(2), ["PING", "DESCRIBE t", "SET BLOCK 3 3 IN t id = $1"]);
  } finally {
    await pool.close();
    await server.close();
  }
});

test("misuse is refused before anything is sent", async () => {
  const { server, statements } = await startTxServer();
  try {
    const client = await connect({ port: server.port, table: "t" });
    let kept: Parameters<Parameters<ChunkClient["transaction"]>[0]>[0] | undefined;
    await client.transaction(async (tx) => {
      kept = tx;
      await assert.rejects(
        tx.setBlock(0, 0, { id: 1 }, { ifVersion: 3n } as { table?: string }),
        (error: unknown) => error instanceof ChunkProtocolError && /ifVersion is not taken inside a transaction/.test(error.message),
      );
      // The client itself would wait for the transaction to end.
      await assert.rejects(client.ping(), /running a transaction: inside its callback use tx/);
      await assert.rejects(client.transaction(() => {}), /transactions do not nest/);
    });
    await assert.rejects(kept!.getBlock(0, 0), /the transaction has ended/);
    assert.deepEqual(statements(), ["BEGIN", "COMMIT"]);
    await client.close();
  } finally {
    await server.close();
  }
});

test("a lost connection fails the transaction and nothing goes to a new connection", async () => {
  const { server, lines } = await startTxServer((request) => {
    if (request.line.startsWith("GET")) {
      return "-ERR BAD_REQUEST the frame is too long\r\n";
    }
    return null;
  });
  try {
    const client = await connect({ port: server.port, table: "t" });
    let runs = 0;
    await assert.rejects(
      client.transaction(async (tx) => {
        runs += 1;
        await tx.getBlock(0, 0).catch(() => {});
        await tx.setBlock(0, 0, { id: 1 });
      }),
      (error: unknown) => error instanceof ChunkConnectionError && /server rolled the transaction back/.test(error.message),
    );
    assert.equal(runs, 1);
    // BAD_REQUEST closed the connection; the write was not sent anywhere.
    assert.ok(!lines.some((l) => l.line.startsWith("SET")));
    assert.ok(!lines.some((l) => l.line === "COMMIT"));
    // The client reconnects for the next call.
    assert.equal(await client.ping(), "PONG");
    await client.close();
  } finally {
    await server.close();
  }
});

test("an out-of-date schema is refreshed inside the transaction, on its connection", async () => {
  let hType = "f32";
  const { server, lines } = await startTxServer((request) => {
    if (request.line.startsWith("DESCRIBE")) {
      const reply = describeReply(hType);
      // Another client changes the column after this DESCRIBE.
      hType = "f64";
      return reply;
    }
    if (request.line.startsWith("SET BLOCK") && request.frames[0]?.length !== 8) {
      return `-ERR INVALID_ARGUMENT $1 for column h (f64) must be 8 bytes, got ${request.frames[0]?.length ?? 0}\r\n`;
    }
    return null;
  });
  try {
    const client = await connect({ port: server.port, table: "t" });
    assert.equal(typeof (await client.transaction(async (tx) => await tx.setBlock(0, 0, { h: 0.5 }))), "bigint");
    assert.deepEqual(
      lines.map((l) => [l.connection, l.line]),
      [
        [1, "HELLO 3"],
        [1, "BEGIN"],
        [1, "DESCRIBE t"],
        [1, "SET BLOCK 0 0 IN t h = $1"],
        [1, "DESCRIBE t"],
        [1, "SET BLOCK 0 0 IN t h = $1"],
        [1, "COMMIT"],
      ],
    );
    await client.close();
  } finally {
    await server.close();
  }
});
