import test from "node:test";
import assert from "node:assert/strict";
import { ChunkCancelledError, ChunkRateLimitedError, ChunkServerError, ChunkStatementTimeoutError, ChunkTimeoutError, connectUri, emptyChunk } from "../src/index";
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

// A stopped statement is a server error, not a client deadline, reports
// applied=false and leaves its connection usable.
function assertNotApplied(error: unknown, ErrorClass: typeof ChunkServerError, code: string): void {
  assert.ok(error instanceof ErrorClass, `expected ${code}, got ${String(error)}`);
  assert.ok(!(error instanceof ChunkTimeoutError));
  assert.equal(error.code, code);
  assert.equal(error.keys.applied, "false");
  assert.equal(error.retryClass, "fatal");
}

test("connection controls: a statement deadline and CANCEL stop a large area read", { timeout: 60000 }, async () => {
  const server = await startServer();
  const client = await connectUri(`${server.uri}stops`);
  const clients = [client];
  try {
    await client.createTable("stops", { columns: [{ name: "n", type: "u8" }, { name: "s", type: "text(64)", nullable: true }], chunk: { width: 64, height: 64 } });
    const full = emptyChunk(await client.describe("stops"));
    full.present.fill(true); full.columns.n.fill(1); full.columns.s.fill("x".repeat(64));
    const side = 8;
    for (let x = 0; x < side; x++) for (let y = 0; y < side; y++) await client.setChunk(x, y, full);
    const area = { cx0: 0, cy0: 0, cx1: side - 1, cy1: side - 1 };
    assert.equal((await client.getArea(area)).length, side * side);

    const deadline = await connectUri(`${server.uri}stops`, { helloOptions: { statement_timeout_ms: 1 } });
    clients.push(deadline);
    assert.equal(deadline.serverInfo()?.options?.statement_timeout_ms, 1);
    await assert.rejects(deadline.getArea(area), (error) => { assertNotApplied(error, ChunkStatementTimeoutError, "TIMEOUT"); return true; });
    assert.equal(await deadline.ping(), "PONG");

    const reader = await connectUri(`${server.uri}stops`);
    clients.push(reader);
    const id = reader.serverInfo()!.connectionId!;
    // Cancel only once SHOW CONNECTIONS shows the read running: a CANCEL that
    // reaches the server first finds nothing to cancel.
    const running = async (): Promise<boolean> => {
      const row = (await client.showConnections()).find((entry) => entry.id === id);
      assert.ok(row, "reader connection missing");
      return row.statement !== null;
    };
    let accepted = false;
    for (let attempt = 0; attempt < 20 && !accepted; attempt++) {
      let finished = false;
      const read = reader.getArea(area).then(() => null, (error: unknown) => error).finally(() => { finished = true; });
      while (!finished && !(await running())) { /* poll until the read runs or ends */ }
      if (finished) {
        assert.equal(await read, null);
        continue;
      }
      const cancelled = await client.cancel(id);
      const error = await read;
      if (cancelled) {
        assertNotApplied(error, ChunkCancelledError, "CANCELLED");
        accepted = true;
      } else {
        assert.equal(error, null);
      }
    }
    assert.ok(accepted, "no cancellation of a running area read was accepted");
    assert.equal(await reader.ping(), "PONG");
  } finally {
    for (const each of clients) await each.close();
    await server.stop();
  }
});

test("connection controls: a bound login keeps its deadline and reaches both user limits", { timeout: 30000 }, async () => {
  const server = await startServer({ tls: true });
  const admin = await connectUri(server.uri, { tlsInsecure: true });
  try {
    await admin.createUser("bot", "limited-password");
    await admin.execute("ALTER USER bot LIMIT max_connections = 1, statements_per_sec = 1");
    const uri = `chunks://bot:limited-password@${server.host}:${server.port}/`;
    const bot = await connectUri(uri, { tlsInsecure: true, channelBinding: "require", helloOptions: { statement_timeout_ms: 5000 } });
    try {
      assert.equal(bot.serverInfo()?.options?.statement_timeout_ms, 5000);
      const limited = (reason: string) => (error: unknown) => {
        assert.ok(error instanceof ChunkRateLimitedError, String(error));
        assert.equal(error.reason, reason);
        assert.ok(error.retryAfterMs !== undefined);
        assert.equal(error.retryClass, "backoff");
        return true;
      };
      await assert.rejects(connectUri(uri, { tlsInsecure: true }), limited("max_connections"));
      assert.equal(await bot.ping(), "PONG");
      await assert.rejects(bot.ping(), limited("statements_per_sec"));
      assert.equal(await bot.cancel(bot.serverInfo()!.connectionId!), false, "CANCEL stays available at the statement limit");
    } finally {
      await bot.close();
    }
  } finally {
    await admin.close();
    await server.stop();
  }
});
