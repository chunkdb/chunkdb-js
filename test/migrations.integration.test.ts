import test from "node:test";
import assert from "node:assert/strict";
import { ChunkMigrationError, ChunkServerError, connectUri } from "../src/index";
import { startServer } from "./helpers";

for (const tls of [false, true]) {
  test(`migrations: ${tls ? "TLS" : "plain"} concurrent application, repeat and conflict`, { timeout: 15000 }, async () => {
    const server = await startServer({ tls });
    const a = await connectUri(server.uri, { tlsInsecure: tls });
    const b = await connectUri(server.uri, { tlsInsecure: tls });
    const migrations = [
      { name: "world_table", statement: "CREATE TABLE world (n u8) CHUNK 4 x 4" },
      { name: "world_label", statement: "ALTER TABLE world ADD COLUMN label text(32) NULL" },
    ];
    try {
      const concurrent = await Promise.all([a.migrate(migrations), b.migrate(migrations)]);
      for (let index = 0; index < migrations.length; index++) {
        assert.deepEqual(concurrent.map((results) => results[index].status).sort(), ["applied", "skipped"]);
      }
      assert.deepEqual(await a.migrate(migrations), migrations.map(({ name }) => ({ name, status: "skipped" })));
      const schema = await a.describe("world");
      assert.deepEqual(schema.columns.map(({ name }) => name), ["n", "label"]);
      await assert.rejects(a.migrate([
        { name: "world_table", statement: "CREATE TABLE other (n u8) CHUNK 4 x 4" },
        { name: "must_not_run", statement: "DROP TABLE world" },
      ]), (error: unknown) => error instanceof ChunkMigrationError && error.migration.name === "world_table" &&
        error.code === "CONFLICT" && error.cause instanceof ChunkServerError && error.results.length === 0);
      assert.deepEqual(await a.listTables(), ["default", "world"]);

      // A cached column must disappear after a table migration, including a skipped step.
      await a.migrate([{ name: "world_remove_label", statement: "ALTER TABLE world DROP COLUMN label" }]);
      assert.deepEqual(Object.keys((await a.getChunk(0, 0, { table: "world" })).columns), ["n"]);
      const reply = await a.execute("SHOW MIGRATIONS");
      assert.equal(reply.type, "array");
      if (reply.type === "array") assert.equal(reply.items.length, 3);
    } finally { await a.close(); await b.close(); await server.stop(); }
  });
}
