import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ChunkServerError, connectUri, type ChunkClient, type ChunkReply } from "../src/index";
import { startServer, type StartedServer } from "./helpers";

function fields(reply: ChunkReply): Map<string, ChunkReply> {
  assert.equal(reply.type, "map");
  if (reply.type !== "map") throw new Error("expected a map");
  return new Map(reply.entries.map(([key, value]) => {
    assert.equal(key.type, "bulk");
    if (key.type !== "bulk") throw new Error("expected a bulk map key");
    return [key.value.toString(), value];
  }));
}

function integer(reply: ChunkReply | undefined): bigint {
  assert.equal(reply?.type, "integer");
  if (reply?.type !== "integer") throw new Error("expected an integer");
  return reply.value;
}

function filesBelow(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const name = path.join(root, entry.name);
    return entry.isDirectory() ? filesBelow(name) : [name];
  });
}

for (const tls of [false, true]) {
  test(`backup: generic execute copies a populated table over ${tls ? "TLS" : "plain TCP"}`, { timeout: 15000 }, async () => {
    const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), "chunkdb-node-backup-"));
    let server: StartedServer | undefined;
    let client: ChunkClient | undefined;
    try {
      server = await startServer({ tls, backupDir });
      client = await connectUri(server.uri, { tlsInsecure: tls });
      await client.createTable("world", {
        columns: [{ name: "value", type: "u16", required: true }],
        chunk: { width: 4, height: 4 },
        options: { checkpointUpdates: 1 },
      });
      const revision = await client.setBlock(0, 0, { value: 73 }, { table: "world" });
      const source = path.join(server.dataDir, "tables", "world");
      const images = filesBelow(source).filter((file) => file.endsWith(".chk"));
      assert.equal(images.length, 1);
      const imageBytes = fs.readFileSync(images[0]);
      const tableCount = (await client.listTables()).length;

      const reply = fields(await client.execute("BACKUP TO 'snapshot'"));
      assert.deepEqual([...reply.keys()], ["tables", "files", "bytes", "cuts"]);
      assert.equal(integer(reply.get("tables")), BigInt(tableCount));
      assert.ok(integer(reply.get("files")) > 0n);
      assert.ok(integer(reply.get("bytes")) > 0n);
      const cuts = reply.get("cuts");
      assert.equal(cuts?.type, "array");
      if (cuts?.type !== "array") throw new Error("expected cuts");
      assert.equal(cuts.items.length, tableCount);
      const world = cuts.items.map(fields).find((cut) => {
        const name = cut.get("table");
        return name?.type === "bulk" && name.value.toString() === "world";
      });
      assert.ok(world);
      const epoch = world.get("epoch");
      assert.equal(epoch?.type, "bulk");
      if (epoch?.type !== "bulk") throw new Error("expected an epoch");
      assert.match(epoch.value.toString(), /^[0-9a-f]{32}$/);
      assert.ok(integer(world.get("revision")) >= revision);

      const snapshot = path.join(backupDir, "snapshot");
      assert.ok(fs.statSync(path.join(snapshot, "chunkdb.backup")).size > 0);
      assert.equal(fs.existsSync(path.join(snapshot, ".chunkdb.backup.incomplete")), false);
      assert.ok(fs.statSync(path.join(snapshot, "tables", "world", "table.manifest")).size > 0);
      const copiedImage = path.join(snapshot, "tables", "world", path.relative(source, images[0]));
      assert.deepEqual(fs.readFileSync(copiedImage), imageBytes);
      // Later writes change the live image without changing the copied data.
      await client.setBlock(0, 0, { value: 99 }, { table: "world" });
      assert.deepEqual(await client.getBlock(0, 0, { table: "world" }), { value: 99 });
      assert.notDeepEqual(fs.readFileSync(images[0]), imageBytes);
      assert.deepEqual(fs.readFileSync(copiedImage), imageBytes);
      await assert.rejects(client.execute("BACKUP TO 'snapshot'"), (error: unknown) =>
        error instanceof ChunkServerError && error.serverCode === "INVALID_ARGUMENT" && /absent or empty/.test(error.serverMessage));
    } finally {
      try { await client?.close(); }
      finally {
        try { await server?.stop(); }
        finally { fs.rmSync(backupDir, { recursive: true, force: true }); }
      }
    }
  });
}
