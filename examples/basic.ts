import { connectUri } from "../src/index";

const client = await connectUri("chunk://chunk-token@127.0.0.1:4242/");
console.log(client.serverInfo());

await client.createTable("world", {
  columns: [
    { name: "id", type: "u10", required: true },
    { name: "light", type: "u4", default: 15 },
    { name: "sign", type: "text(64)", nullable: true },
  ],
  chunk: { width: 16, height: 16 },
});

const version = await client.setBlock(10, 4, { id: 23, sign: "hello" }, { table: "world" });
console.log(version); // the chunk version after the write
console.log(await client.getBlock(10, 4, { table: "world" })); // { id: 23, light: 15, sign: "hello" }
await client.deleteBlock(10, 4, { table: "world" });
console.log(await client.getBlock(10, 4, { table: "world" })); // null: the block is absent
await client.close();
