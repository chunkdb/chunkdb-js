import { connectUri, type ChunkChangeEvent, type ChunkWatch } from "../src/index";

const uri = process.argv[2] ?? process.env.CHUNKDB_URI ?? "chunk://admin:change-me@127.0.0.1:4242/";
const client = await connectUri(uri);
let watch: ChunkWatch | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
try {
  await client.migrate([{
    name: "world_js_table",
    statement: "CREATE TABLE world_js (kind u8, height i16) CHUNK 4 x 4",
  }]);
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) {
      await client.setBlock(x, y, { kind: 1, height: x + y }, { table: "world_js" });
    }
  }
  console.log("block", await client.getBlock(0, 0, { table: "world_js" }));
  const area = await client.getArea({ cx0: 0, cy0: 0, cx1: 0, cy1: 0 }, { table: "world_js" });
  console.log("area chunks", area.length);

  watch = await client.watch("world_js"); // Resolves when the server has registered the watch.
  const changes = (async (): Promise<ChunkChangeEvent> => {
    for await (const event of watch!) {
      if (event.kind === "change") return event;
      if (event.kind === "resync") throw new Error("the example watch needs resynchronization");
    }
    throw new Error("the example watch ended before the update");
  })();
  const change = Promise.race([changes, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("no world change arrived within 5 seconds")), 5000);
  })]);
  const [, event] = await Promise.all([
    client.setBlock(0, 0, { kind: 2, height: 42 }, { table: "world_js" }), change,
  ]);
  console.log("watch change", event.blocks[0].after);
} finally {
  clearTimeout(timer);
  await watch?.close();
  await client.close();
}
