import { connectPool } from "../src/index";

const pool = await connectPool({
  uri: "chunk://chunk-token@127.0.0.1:4242/world",
  maxConnections: 4,
  minConnections: 1,
});

await Promise.all([pool.setBlock(0, 0, { id: 1 }), pool.setBlock(1, 0, { id: 2 })]);
console.log(await Promise.all([pool.getBlock(0, 0), pool.getBlock(1, 0)]));

await pool.close();
