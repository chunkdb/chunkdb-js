import { connectUri } from "@chunkdb/client";

const client = await connectUri(process.env.CHUNKDB_URI!);
try {
  await client.migrate([{
    name: "world_js_table",
    statement: "CREATE TABLE world_js (id u16, light u4 DEFAULT 15) CHUNK 16 x 16",
  }]);
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) await client.setBlock(x, y, { id: 1, light: x + y });
  const area = await client.getArea({ cx0: 0, cy0: 0, cx1: 0, cy1: 0 });
  console.log("area chunks", area.length, "block 3 3", await client.getBlock(3, 3));
  const watch = await client.watch("world_js");
  try {
    await client.setBlock(0, 0, { id: 2, light: 9 });
    for await (const event of watch) {
      if (event.kind === "resync") throw new Error("rebuild state before continuing");
      if (event.kind === "change") { console.log("change", event.blocks[0].after); break; }
    }
  } finally {
    await watch.close();
  }
} finally {
  await client.close();
}
