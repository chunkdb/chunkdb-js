import test from "node:test";
import assert from "node:assert/strict";
import { connectUri } from "../src/index";
import { startServer } from "./helpers";

for(const tls of [false,true]) {
 test(`connection controls: ${tls?"TLS":"plain"} listing, idle cancellation and self-kill`,{timeout:20000},async()=>{
  const server=await startServer({tls});
  const client=await connectUri(server.uri,{tlsInsecure:tls,helloOptions:{statement_timeout_ms:0}});
  try {
   const info=client.serverInfo()!;
   assert.ok(info.features?.includes("connection_controls"));
   assert.ok(info.features?.includes("statement_timeout"));
   assert.equal(info.options?.statement_timeout_ms,0);
   const rows=await client.showConnections();
   const own=rows.find(row=>row.id===info.connectionId);
   assert.ok(own);assert.ok(own.peer);assert.ok(own.state);
   assert.equal(await client.cancel(own.id),false);
   assert.equal(await client.cancel((1n<<64n)-1n),false);
   assert.equal(await client.killConnection(own.id),true);
  } finally {await client.close();await server.stop();}
 });
}
