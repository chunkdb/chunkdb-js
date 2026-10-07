import { connectPool } from "../src/index";

const pool = await connectPool({
  uri: "chunk://chunk-token@127.0.0.1:4242/",
  maxConnections: 4,
  minConnections: 1,
});

await Promise.all([
  pool.set(0, 0, "1011001110110011"),
  pool.set(1, 0, "0000111100001111"),
]);

console.log(await pool.mget([{ x: 0, y: 0 }, { x: 1, y: 0 }]));

await pool.close();
