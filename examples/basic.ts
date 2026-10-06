import { connectUri } from "../src/index";

const client = await connectUri("chunk://chunk-token@127.0.0.1:4242/");
console.log(client.serverInfo());
await client.set(0, 0, "1011001110110011");
console.log(await client.get(0, 0)); // "1011001110110011"
await client.unset(0, 0);
console.log(await client.get(0, 0)); // null: the block is unset
console.log(await client.info());
await client.close();
