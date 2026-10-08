import test from "node:test";
import assert from "node:assert/strict";

import { ChunkConflictError, ChunkConnectionError, ChunkServerError, connectPool, connectUri, type ChunkClient } from "../src/index";
import { startServer, type StartedServer } from "./helpers";

async function withWorld(fn: (server: StartedServer, client: ChunkClient, other: ChunkClient) => Promise<void>): Promise<void> {
  const server = await startServer();
  try {
    const client = await connectUri(`${server.uri}world`);
    const other = await connectUri(`${server.uri}world`);
    await client.createTable("world", { columns: [{ name: "n", type: "u16", required: true }], chunk: { width: 4, height: 4 } });
    await client.createTable("other", { columns: [{ name: "n", type: "u16", required: true }], chunk: { width: 4, height: 4 } });
    try {
      await fn(server, client, other);
    } finally {
      await client.close();
      await other.close();
    }
  } finally {
    await server.stop();
  }
}

test("transactions: a commit applies writes to two chunks together, with one version", async () => {
  await withWorld(async (_, client, other) => {
    const version = await client.transaction(async (tx) => {
      await tx.setBlock(0, 0, { n: 1 });
      await tx.setBlock(21, 21, { n: 2 });
      // Not visible outside the transaction before COMMIT.
      assert.equal(await other.getBlock(0, 0), null);
      assert.deepEqual(await tx.getBlock(0, 0), { n: 1 });
    });
    assert.equal(typeof version, "bigint");
    assert.equal((await other.getChunk(0, 0)).version, version);
    assert.equal((await other.getChunk(5, 5)).version, version);
    assert.deepEqual(await other.getBlock(21, 21), { n: 2 });
    assert.equal(await client.transaction(async (tx) => void (await tx.getBlock(0, 0))), null);
  });
});

test("transactions: reads see the snapshot; a conflicting plain write makes it run again", async () => {
  await withWorld(async (_, client, other) => {
    await other.setBlock(0, 0, { n: 1 });
    const seen: number[][] = [];
    await client.transaction(async (tx) => {
      const first = (await tx.getBlock(0, 0))!.n as number;
      if (seen.length === 0) {
        await other.setBlock(0, 0, { n: 2 });
      }
      const again = (await tx.getBlock(0, 0))!.n as number;
      seen.push([first, again]);
      await tx.setBlock(1, 1, { n: again + 10 });
    });
    // The first run read 1 twice although the block changed meanwhile, and
    // its COMMIT met CONFLICT chunk_changed; the second run read 2.
    assert.deepEqual(seen, [[1, 1], [2, 2]]);
    assert.deepEqual(await other.getBlock(1, 1), { n: 12 });
  });
});

test("transactions: a CONFLICT at a statement is rolled back, nothing after it applies, and the retry commits", async () => {
  await withWorld(async (_, client, other) => {
    let runs = 0;
    let caught: unknown;
    const version = await client.transaction(async (tx) => {
      runs += 1;
      await tx.setBlock(0, 0, { n: runs });
      if (runs === 1) {
        // Altering the table ends the transaction: its next statement gets
        // CONFLICT table_changed.
        await other.alterTable("world", { kind: "addColumn", column: { name: "m", type: "u8", nullable: true } });
        caught = await tx.getBlock(0, 0).catch((error: unknown) => error);
        // Caught or not, nothing of the first run applies.
        await tx.setBlock(2, 2, { n: 7 });
      }
    });
    assert.ok(caught instanceof ChunkConflictError);
    assert.equal(caught.reason, "table_changed");
    assert.equal(runs, 2);
    assert.equal((await other.getChunk(0, 0)).version, version);
    assert.deepEqual(await other.getBlock(0, 0, { columns: ["n"] }), { n: 2 });
    assert.equal(await other.getBlock(2, 2), null);
  });
});

test("transactions: after a CONFLICT at a statement the server answers it until ROLLBACK", async () => {
  await withWorld(async (_, client, other) => {
    await client.execute("BEGIN");
    assert.equal((await client.execute("SET BLOCK 0 0 IN world n = 1")).type, "null");
    await other.alterTable("world", { kind: "addColumn", column: { name: "m", type: "u8", nullable: true } });
    for (const statement of ["GET BLOCK 0 0 FROM world", "SET BLOCK 1 1 IN world n = 2", "PING", "BEGIN"]) {
      await assert.rejects(client.execute(statement), (error: unknown) => error instanceof ChunkConflictError && error.reason === "table_changed");
    }
    assert.deepEqual(await client.execute("ROLLBACK"), { type: "simple", value: "OK" });
    assert.equal(await other.getBlock(0, 0), null);
    assert.equal(await other.getBlock(1, 1), null);
    // Outside a transaction again, a write applies at once.
    assert.equal(typeof (await client.setBlock(1, 1, { n: 3 })), "bigint");
  });
});

test("transactions: concurrent read-modify-write transactions lose no update", async () => {
  const server = await startServer();
  // The test server runs two workers, each serving one connection.
  const pool = await connectPool({ uri: `${server.uri}world`, maxConnections: 2 });
  try {
    await pool.createTable("world", { columns: [{ name: "n", type: "u16", required: true }], chunk: { width: 4, height: 4 } });
    await pool.setBlock(0, 0, { n: 0 });
    const increment = () =>
      pool.transaction(async (tx) => {
        const n = (await tx.getBlock(0, 0))!.n as number;
        await tx.setBlock(0, 0, { n: n + 1 });
      }, { retries: 100 });
    await Promise.all(Array.from({ length: 4 }, async () => {
      for (let i = 0; i < 10; i += 1) {
        await increment();
      }
    }));
    assert.deepEqual(await pool.getBlock(0, 0), { n: 40 });
  } finally {
    await pool.close();
    await server.stop();
  }
});

test("transactions: a callback that throws rolls back", async () => {
  await withWorld(async (_, client, other) => {
    await assert.rejects(
      client.transaction(async (tx) => {
        await tx.setBlock(0, 0, { n: 5 });
        throw new Error("changed my mind");
      }),
      /changed my mind/,
    );
    assert.equal(await other.getBlock(0, 0), null);
    assert.equal(typeof (await client.setBlock(0, 0, { n: 6 })), "bigint");
  });
});

test("transactions: refused statements leave the transaction open", async () => {
  await withWorld(async (_, client, other) => {
    await client.transaction(async (tx) => {
      await tx.setBlock(0, 0, { n: 1 });
      await assert.rejects(tx.getBlock(0, 0, { table: "other" }), (error: unknown) => {
        assert.ok(error instanceof ChunkServerError);
        assert.equal(error.serverCode, "INVALID_ARGUMENT");
        assert.match(error.serverMessage, /a transaction covers one table/);
        return true;
      });
      await assert.rejects(tx.setBlock(1, 0, { n: 70000 }), /u16/);
      await tx.setBlock(1, 0, { n: 2 });
    });
    assert.deepEqual(await other.getBlock(0, 0), { n: 1 });
    assert.deepEqual(await other.getBlock(1, 0), { n: 2 });

    // The server refuses other statements inside a transaction.
    assert.equal((await client.execute("BEGIN")).type, "simple");
    await assert.rejects(client.execute("SCAN CHUNKS FROM world"), /INVALID_ARGUMENT: inside a transaction only/);
    await assert.rejects(client.execute("SET BLOCK 0 0 IN world n = 3 IF VERSION 1"), /IF VERSION is not used inside a transaction/);
    assert.equal((await client.execute("DESCRIBE world")).type, "map");
    assert.deepEqual(await client.execute("ROLLBACK"), { type: "simple", value: "OK" });
  });
});

test("transactions: a closed connection rolls the transaction back", async () => {
  await withWorld(async (_, client, other) => {
    await assert.rejects(
      client.transaction(async (tx) => {
        await tx.setBlock(0, 0, { n: 9 });
        await client.close();
        await tx.setBlock(1, 0, { n: 9 });
      }),
      (error: unknown) => error instanceof ChunkConnectionError && /rolled the transaction back/.test(error.message),
    );
    assert.equal(await other.getBlock(0, 0), null);
    assert.equal(await other.getBlock(1, 0), null);
  });
});
