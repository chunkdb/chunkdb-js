import { connectUri } from "../src/index";

const client = await connectUri("chunk://chunk-token@127.0.0.1:4242/");
await client.set(0, 0, "10110011");
console.log(await client.get(0, 0));
console.log(await client.info());
await client.close();
