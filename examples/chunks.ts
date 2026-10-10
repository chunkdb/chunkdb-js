import { ChunkVersionMismatchError, connectUri, emptyChunk } from "../src/index";

// The URI path names the client's table.
const client = await connectUri("chunk://admin:change-me@127.0.0.1:4242/world");

// Create a never-written chunk normally, or update an existing chunk only
// if nobody else wrote it in between.
const previous = await client.getChunk(0, 0);
const chunk = previous ?? emptyChunk(await client.describe());
chunk.present[0] = true;
chunk.columns.id[0] = 7;
chunk.columns.light[0] = 15;
try {
  console.log("written, version", await client.setChunk(0, 0, chunk, { ifVersion: previous?.version }));
} catch (error) {
  if (!(error instanceof ChunkVersionMismatchError)) throw error;
  console.log("conflict, current version", error.currentVersion);
}

// The populated chunks of a 5 x 5 area, then every populated chunk.
for (const { cx, cy, chunk: area } of await client.getArea({ cx0: -2, cy0: -2, cx1: 2, cy1: 2 }, { columns: ["id"] })) {
  console.log(cx, cy, area.present.filter(Boolean).length);
}
for await (const { cx, cy } of client.scanAllChunks()) {
  console.log(cx, cy);
}
await client.close();
