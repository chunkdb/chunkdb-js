import { connectUri } from "../src/index";

const client = await connectUri("chunk://chunk-token@127.0.0.1:4242/");
const payload = await client.chunkbin(0, 0);
console.log(`chunk bytes=${payload.length}`);
await client.close();
