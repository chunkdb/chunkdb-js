import { connectUri } from "../src/index";

const client = await connectUri("chunk://admin:change-me@127.0.0.1:4242/");
console.log(await client.ping());
await client.close();
