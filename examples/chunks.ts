import { connectUri } from "../src/index";

const client = await connectUri("chunk://chunk-token@127.0.0.1:4242/");

// Read a chunk's payload and presence bitmap, change it, and write it back
// only if nobody else wrote the chunk in between.
const version = await client.chunkVersion(0, 0);
const state = await client.getChunkState(0, 0);
state.payload[0] ^= 0xff;
state.presence[0] |= 0x01;
const result = await client.putChunkState(0, 0, state, { ifVersion: version, zrle: true });
console.log(result.ok ? `written, version ${result.version}` : `conflict, current ${result.version}`);

// Stream a 5x5 area of populated chunks, zrle-compressed on the wire.
for (const entry of await client.chunkRange(-2, -2, 2, 2, { zrle: true })) {
  console.log(entry.cx, entry.cy, entry.payload.length);
}
await client.close();
