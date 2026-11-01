import test from "node:test";
import assert from "node:assert/strict";
import { ChunkClient, ChunkPool, ChunkProtocolError, parseReply } from "../src/index";
import { parseConnections } from "../src/connection-controls";
import { parseServerInfo } from "../src/schema";
import { FAKE_HELLO, startFakeServer } from "./fake-server";

const bulk=(text:string)=>`$${Buffer.byteLength(text)}\r\n${text}\r\n`;
const map=(fields:Record<string,string>)=>`%${Object.keys(fields).length}\r\n${Object.entries(fields).map(([key,value])=>bulk(key)+value).join("")}`;
const row=(id="(18446744073709551615\r\n")=>map({id,user:"_\r\n",peer:bulk("127.0.0.1:42"),state:bulk("idle"),statement:"_\r\n",future:"*0\r\n"});
const parsed=(wire:string)=>parseReply(Buffer.from(wire))!.reply;

test("connection controls preserve exact IDs and pool HELLO options",async()=>{
 const server=await startFakeServer(({line})=>{
  if(line==="HELLO 3 WITH statement_timeout_ms = 0") return FAKE_HELLO;
  if(line==="SHOW CONNECTIONS") return `*1\r\n${row()}`;
  if(line==="CANCEL 18446744073709551615") return map({cancelled:"#f\r\n"});
  if(line==="KILL CONNECTION 18446744073709551615") return map({killed:"#t\r\n"});
  if(line==="CANCEL 1") return map({cancelled:"#t\r\n"});
  if(line==="KILL CONNECTION 1") return map({killed:"#f\r\n"});
  throw new Error(`unexpected ${line}`);
 });
 const options={port:server.port,helloOptions:{statement_timeout_ms:0}};
 const client=new ChunkClient(options);
 const pool=new ChunkPool({...options,maxConnections:1});
 try {
  for(const c of [client,pool]) {
   const rows=await c.showConnections();
   assert.deepEqual(rows,[{id:(1n<<64n)-1n,user:null,peer:"127.0.0.1:42",state:"idle",statement:null}]);
   assert.equal(await c.cancel(rows[0].id),false);
   assert.equal(await c.killConnection(rows[0].id),true);
  }
  for(const id of [0n,-1n,1n<<64n,42 as unknown as bigint]) await assert.rejects(client.cancel(id),TypeError);
  assert.equal(await client.cancel(1n),true);
  assert.equal(await client.killConnection(1n),false);
 } finally {await client.close();await pool.close();await server.close();}
});

test("connection controls reject malformed listings and acknowledgments",async()=>{
 for(const wire of ["%0\r\n","*1\r\n_\r\n",`*1\r\n${row(":0\r\n")}`,`*1\r\n${row("(18446744073709551616\r\n")}`,`*2\r\n${row()}${row()}`,`*1\r\n${map({id:":1\r\n",user:"_\r\n",peer:bulk("peer"),state:":1\r\n",statement:"_\r\n"})}`]) {
  assert.throws(()=>parseConnections(parsed(wire)),ChunkProtocolError);
 }
 const server=await startFakeServer(({line})=>line==="HELLO 3"?FAKE_HELLO:map({cancelled:":1\r\n",killed:":1\r\n"}));
 const client=new ChunkClient({port:server.port});
 try {await assert.rejects(client.cancel(1n),ChunkProtocolError);await assert.rejects(client.killConnection(1n),ChunkProtocolError);}
 finally {await client.close();await server.close();}
});

test("statement timeout keeps explicit zero and checks request and reply bounds",async()=>{
 for(const value of [0,86400000,0n,86400000n]) {
  const server=await startFakeServer(({line})=>{assert.equal(line,`HELLO 3 WITH statement_timeout_ms = ${value}`);return FAKE_HELLO;});
  const client=new ChunkClient({port:server.port,helloOptions:{STATEMENT_TIMEOUT_MS:value}});
  try {await client.connect();} finally {await client.close();await server.close();}
 }
 for(const value of [-1,86400001,1n<<64n,1.5,"0",null,false]) assert.throws(()=>new ChunkClient({helloOptions:{statement_timeout_ms:value}}),TypeError);
 for(const value of [":86400001\r\n",bulk("0"),"#f\r\n"]) {
  const reply=parsed(FAKE_HELLO);assert.equal(reply.type,"map");
  reply.entries.push([parsed(bulk("options")),parsed(map({statement_timeout_ms:value}))]);
  assert.throws(()=>parseServerInfo(reply),ChunkProtocolError);
 }
});
