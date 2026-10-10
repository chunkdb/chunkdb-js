import test from "node:test";
import assert from "node:assert/strict";

import { ChunkServerError, connectUri } from "../src/index";
import { startServer } from "./helpers";

function serverError(code: string, message?: RegExp) {
  return (error: unknown) =>
    error instanceof ChunkServerError && error.serverCode === code && (message === undefined || message.test(error.serverMessage));
}

test("tables: create, describe, alter, list, drop", async () => {
  const server = await startServer();
  try {
    const client = await connectUri(server.uri);
    await client.createTable("land", {
      columns: [
        { name: "id", type: "u10", required: true },
        { name: "light", type: "u4", default: 15 },
        { name: "sign", type: "text(8)", nullable: true },
        { name: "h", type: { kind: "f32" }, default: 1.5 },
      ],
      chunk: { width: 4, height: 2 },
      large: { width: 2, height: 2 },
      options: { durabilityMode: "fsync-wal", varMaxChunkBytes: 4096, checkpointUpdates: 128 },
    });
    await assert.rejects(
      client.createTable("land", { columns: [{ name: "a", type: "u8" }], chunk: { width: 4, height: 4 } }),
      serverError("TABLE_EXISTS"),
    );
    assert.deepEqual(await client.listTables(), ["default", "land"]);

    const schema = await client.describe("land");
    assert.deepEqual(schema, {
      table: "land",
      version: 1,
      columns: [
        { name: "id", type: { kind: "u", bits: 10 }, typeName: "u10", nullable: false, required: true, default: null },
        { name: "light", type: { kind: "u", bits: 4 }, typeName: "u4", nullable: false, required: false, default: 15 },
        { name: "sign", type: { kind: "text", maxBytes: 8 }, typeName: "text(8)", nullable: true, required: false, default: null },
        { name: "h", type: { kind: "f32" }, typeName: "f32", nullable: false, required: false, default: 1.5 },
      ],
      chunk: { width: 4, height: 2 },
      large: { width: 2, height: 2 },
      options: {
        durabilityMode: "fsync-wal",
        checkpointUpdates: 128,
        checkpointWalBytes: schema.options.checkpointWalBytes,
        walGroupCommitUpdates: schema.options.walGroupCommitUpdates,
        checkpointCompression: "none",
        varMaxChunkBytes: 4096,
      },
    });

    await client.setBlock(0, 0, { id: 7, sign: "hi" }, { table: "land" });
    await client.alterTable("land", { kind: "addColumn", column: { name: "depth", type: "i8", nullable: true } });
    assert.deepEqual(await client.getBlock(0, 0, { table: "land", columns: ["depth", "id"] }), { depth: null, id: 7 });
    await client.setBlock(0, 0, { depth: 100 }, { table: "land" });
    await assert.rejects(
      client.alterTable("land", { kind: "alterColumnType", column: "depth", type: "i4" }),
      serverError("INVALID_ARGUMENT", /holds 100/),
    );
    await client.alterTable("land", { kind: "alterColumnType", column: "depth", type: "i4", using: "clamp" });
    await client.alterTable("land", { kind: "renameColumn", column: "sign", to: "label" });
    await client.alterTable("land", { kind: "setOption", option: "checkpointUpdates", value: 64 });
    assert.deepEqual(await client.getBlock(0, 0, { table: "land" }), { id: 7, light: 15, label: "hi", h: 1.5, depth: 7 });
    await client.alterTable("land", { kind: "dropColumn", column: "label" });
    const altered = await client.describe("land");
    assert.deepEqual(altered.columns.map((column) => column.name), ["id", "light", "h", "depth"]);
    assert.equal(altered.options.checkpointUpdates, 64);
    assert.ok(altered.version > 1);

    await client.dropTable("land");
    await assert.rejects(client.getBlock(0, 0, { table: "land" }), serverError("NO_TABLE"));
    await assert.rejects(client.dropTable("land"), serverError("NO_TABLE"));
    assert.deepEqual(await client.listTables(), ["default"]);
    await client.close();
  } finally {
    await server.stop();
  }
});

test("the schema cache follows changes another client makes", async () => {
  const server = await startServer();
  try {
    const admin = await connectUri(server.uri);
    await admin.createTable("t", {
      columns: [
        { name: "id", type: "u10" },
        { name: "h", type: "f32" },
        { name: "note", type: "text(8)", nullable: true },
        { name: "data", type: "bytes(4)" },
      ],
      chunk: { width: 2, height: 2 },
    });
    const client = await connectUri(`${server.uri}t`);
    await client.setBlock(0, 0, { id: 1, h: 0.5, note: "a", data: Buffer.from("x") });
    assert.equal((await client.describe()).columns.length, 4);

    // A frame of the wrong size: refreshed and retried once.
    await admin.alterTable("t", { kind: "alterColumnType", column: "h", type: "f64" });
    await client.setBlock(0, 0, { h: 0.1 });
    assert.deepEqual(await client.getBlock(0, 0, { columns: ["h"] }), { h: 0.1 });

    // A column the cache does not know.
    await admin.alterTable("t", { kind: "addColumn", column: { name: "tag", type: "text(4)", nullable: true } });
    await client.setBlock(0, 0, { tag: "new" });
    assert.deepEqual(await client.getBlock(0, 0, { columns: ["tag"] }), { tag: "new" });

    // A renamed and a dropped column: a read of every cached column is
    // refused, refreshed and retried.
    await admin.alterTable("t", { kind: "renameColumn", column: "note", to: "label" });
    await admin.alterTable("t", { kind: "dropColumn", column: "id" });
    assert.deepEqual(await client.getBlock(0, 0), { h: 0.1, label: "a", data: Buffer.from("x"), tag: "new" });

    // After DROP and ADD the text and bytes columns have ids that are not
    // their positions; chunk forms are decoded by the ids DESCRIBE reports.
    await admin.alterTable("t", { kind: "dropColumn", column: "label" });
    await admin.alterTable("t", { kind: "addColumn", column: { name: "label", type: "text(8)", nullable: true } });
    await client.setBlock(1, 0, { h: 2, label: "b1", data: Buffer.from("y"), tag: "t1" });
    const chunk = await client.getChunk(0, 0);
    assert.ok(chunk);
    assert.deepEqual(Object.keys(chunk.columns), ["h", "data", "tag", "label"]);
    assert.deepEqual(chunk.columns.label.slice(0, 2), [null, "b1"]);
    assert.deepEqual(chunk.columns.tag.slice(0, 2), ["new", "t1"]);
    assert.deepEqual(chunk.columns.data.slice(0, 2), [Buffer.from("x"), Buffer.from("y")]);
    chunk.columns.label[0] = "b0";
    await client.setChunk(0, 0, chunk, { ifVersion: chunk.version });
    assert.deepEqual(await client.getBlock(0, 0, { columns: ["label", "tag"] }), { label: "b0", tag: "new" });

    // A write naming a column dropped since: the server refuses it and
    // closes the connection; the next call reconnects with a fresh schema.
    await client.describe();
    await admin.alterTable("t", { kind: "dropColumn", column: "tag" });
    await assert.rejects(client.setBlock(0, 0, { tag: "x" }), serverError("INVALID_ARGUMENT", /no column tag/));
    assert.deepEqual(await client.getBlock(0, 0, { columns: ["label"] }), { label: "b0" });
    await assert.rejects(client.setBlock(0, 0, { tag: "x" }), /no column tag/);

    // A table dropped and created again with other columns.
    await admin.dropTable("t");
    await admin.createTable("t", { columns: [{ name: "flag", type: "bool" }], chunk: { width: 2, height: 2 } });
    assert.equal(await client.getBlock(0, 0), null);
    await client.setBlock(0, 0, { flag: true });
    assert.deepEqual(await client.getBlock(0, 0), { flag: true });
    await Promise.all([admin.close(), client.close()]);
  } finally {
    await server.stop();
  }
});
