import test from "node:test";
import assert from "node:assert/strict";
import tls from "node:tls";

import { ChunkAuthError, ChunkClient, ChunkConnectionError, ChunkTlsError, connect, type ChunkClientOptions } from "../src/index";
import { startServer, type StartedServer } from "./helpers";
import { testTlsPem, type TestCertificateKind } from "./tls-cert";

type Version = "TLSv1.3" | "TLSv1.2";

// The binding types the client computed while `run` ran: tls-exporter when
// it exported keying material under the RFC 9266 label, tls-server-end-point
// when it read the server certificate.
async function bindingsDuring(run: () => Promise<void>): Promise<string[]> {
  const proto = tls.TLSSocket.prototype;
  const exportKeyingMaterial = proto.exportKeyingMaterial;
  const getPeerX509Certificate = proto.getPeerX509Certificate;
  const seen: string[] = [];
  proto.exportKeyingMaterial = function (this: tls.TLSSocket, ...args: Parameters<typeof exportKeyingMaterial>) {
    if (args[1] === "EXPORTER-Channel-Binding") seen.push("tls-exporter");
    return exportKeyingMaterial.apply(this, args);
  };
  proto.getPeerX509Certificate = function (this: tls.TLSSocket) {
    seen.push("tls-server-end-point");
    return getPeerX509Certificate.call(this);
  };
  try {
    await run();
  } finally {
    proto.exportKeyingMaterial = exportKeyingMaterial;
    proto.getPeerX509Certificate = getPeerX509Certificate;
  }
  return seen;
}

// Connections opened during `run` offer TLS up to `version`; the server
// accepts 1.2 and 1.3, so TLSv1.2 caps the connection at TLS 1.2.
async function withTlsUpTo<T>(version: Version, run: () => Promise<T>): Promise<T> {
  const saved = tls.DEFAULT_MAX_VERSION;
  tls.DEFAULT_MAX_VERSION = version;
  try {
    return await run();
  } finally {
    tls.DEFAULT_MAX_VERSION = saved;
  }
}

function options(server: StartedServer, overrides: ChunkClientOptions = {}): ChunkClientOptions {
  return { host: server.host, port: server.port, tls: true, tlsInsecure: true, user: server.user, password: server.password, ...overrides };
}

// Logs in, checks the TLS version and the login, and closes. `kind` is the
// certificate the server presents, which the version probe verifies.
async function logIn(clientOptions: ChunkClientOptions, version: Version, kind?: TestCertificateKind): Promise<void> {
  const client = await connect(clientOptions);
  try {
    assert.equal(await client.ping(), "PONG");
    assert.match(client.serverInfo()?.serverSignature ?? "", /^v=/);
    assert.ok(client.serverInfo()?.features?.includes("channel_binding"));
    // The client's socket is private; the version shows on a new connection under the same cap.
    const probe = tls.connect({ host: clientOptions.host, port: clientOptions.port, ca: testTlsPem(kind).cert });
    await new Promise<void>((resolve, reject) => { probe.once("secureConnect", resolve); probe.once("error", reject); });
    assert.equal(probe.getProtocol(), version);
    probe.destroy();
  } finally {
    await client.close();
  }
}

function serverError(code: string, reason: string, command: string) {
  return (error: unknown) => {
    assert.ok(error instanceof ChunkAuthError, String(error));
    assert.equal(error.serverCode, code);
    assert.equal(error.reason, reason);
    assert.equal(error.command, command);
    assert.equal(error.phase, "auth");
    return true;
  };
}

test("auto binds with tls-exporter on TLS 1.3 and tls-server-end-point on TLS 1.2; off logs in unbound", async () => {
  const server = await startServer({ tls: true });
  try {
    const admin = await connect(options(server));
    await admin.createUser("bound", "bound-pass", { requiresChannelBinding: true });
    await admin.createUser("plain", "plain-pass");
    const byName = new Map((await admin.listUsers()).map((user) => [user.name, user]));
    assert.equal(byName.get("bound")?.requiresChannelBinding, true);
    assert.equal(byName.get("plain")?.requiresChannelBinding, false);
    assert.equal(byName.get("admin")?.requiresChannelBinding, false);
    await admin.close();

    const bound = options(server, { user: "bound", password: "bound-pass" });
    for (const [version, type] of [["TLSv1.3", "tls-exporter"], ["TLSv1.2", "tls-server-end-point"]] as const) {
      await withTlsUpTo(version, async () => {
        // The default is auto; a user that requires binding logs in only bound.
        assert.deepEqual(await bindingsDuring(() => logIn(options(server), version)), [type]);
        assert.deepEqual(await bindingsDuring(() => logIn(bound, version)), [type]);
        assert.deepEqual(await bindingsDuring(() => logIn({ ...bound, channelBinding: "require" }, version)), [type]);
        assert.deepEqual(await bindingsDuring(() => logIn(options(server, { channelBinding: "off" }), version)), []);
        // Unbound, that user fails like a wrong password; the next bound login clears the failure.
        await assert.rejects(connect({ ...bound, channelBinding: "off" }), serverError("AUTH_FAILED", "auth_failed", "AUTH"));
        await logIn(bound, version);
      });
    }

    const manager = await connect(options(server));
    await manager.setRequiresChannelBinding("bound", false);
    await manager.setRequiresChannelBinding("plain", true);
    const changed = new Map((await manager.listUsers()).map((user) => [user.name, user.requiresChannelBinding]));
    assert.equal(changed.get("bound"), false);
    assert.equal(changed.get("plain"), true);
    await manager.close();
    await logIn({ ...bound, channelBinding: "off" }, "TLSv1.3");
    await assert.rejects(connect(options(server, { user: "plain", password: "plain-pass", channelBinding: "off" })),
      serverError("AUTH_FAILED", "auth_failed", "AUTH"));
    await logIn(options(server, { user: "plain", password: "plain-pass" }), "TLSv1.3");
  } finally {
    await server.stop();
  }
});

test("a server that requires binding refuses off and accepts auto", async () => {
  const server = await startServer({ tls: true, authChannelBinding: "require" });
  try {
    // AUTH_REQUIRED with its reason, not mistaken for an older server.
    await assert.rejects(connect(options(server, { channelBinding: "off" })), serverError("AUTH_REQUIRED", "channel_binding", "HELLO"));
    for (const version of ["TLSv1.3", "TLSv1.2"] as const) {
      await withTlsUpTo(version, () => logIn(options(server), version));
    }
  } finally {
    await server.stop();
  }
});

test("over plain TCP auto logs in unbound and require fails before login", async () => {
  const server = await startServer();
  try {
    const admin = await connect({ uri: server.uri });
    await admin.createUser("bound", "bound-pass", { requiresChannelBinding: true });
    await admin.close();
    assert.throws(() => new ChunkClient({ uri: server.uri, channelBinding: "require" }), (error: unknown) => {
      assert.ok(error instanceof ChunkConnectionError);
      assert.match(error.message, /channelBinding "require" needs TLS/);
      return true;
    });
    const bound = { host: server.host, port: server.port, user: "bound", password: "bound-pass" };
    await assert.rejects(connect(bound), serverError("AUTH_FAILED", "auth_failed", "AUTH"));
    const client = await connect({ uri: server.uri, channelBinding: "auto" });
    assert.equal(await client.ping(), "PONG");
    await client.close();
  } finally {
    await server.stop();
  }
});

test("tls-server-end-point follows the certificate's signature hash; Ed25519 binds on TLS 1.3 only", async () => {
  const kinds: TestCertificateKind[] = ["ecdsa-sha384", "rsa-pss-sha384", "ed25519"];
  for (const kind of kinds) {
    const server = await startServer({ tls: true, tlsCertificate: kind, authChannelBinding: "require" });
    try {
      await withTlsUpTo("TLSv1.3", () => logIn(options(server), "TLSv1.3", kind));
      await withTlsUpTo("TLSv1.2", async () => {
        if (kind !== "ed25519") {
          await logIn(options(server), "TLSv1.2", kind);
          return;
        }
        // No silent unbound login: the client fails before HELLO.
        await assert.rejects(connect(options(server)), (error: unknown) => {
          assert.ok(error instanceof ChunkTlsError, String(error));
          assert.match(error.message, /tls-server-end-point.*TLS 1\.3.*channelBinding: "off"/);
          return true;
        });
      });
    } finally {
      await server.stop();
    }
  }
});

// A TLS relay with its own certificate, which the client trusts: it ends the
// client's TLS and opens its own to the server.
async function startRelay(server: StartedServer): Promise<{ port: number; ca: string; close(): Promise<void> }> {
  const { cert, key } = testTlsPem("ecdsa-sha384");
  const sockets = new Set<tls.TLSSocket>();
  const relay = tls.createServer({ cert, key }, (inbound) => {
    const outbound = tls.connect({ host: server.host, port: server.port, ca: testTlsPem().cert });
    for (const socket of [inbound, outbound]) {
      sockets.add(socket);
      socket.on("error", () => {});
      socket.on("close", () => { sockets.delete(socket); inbound.destroy(); outbound.destroy(); });
    }
    inbound.pipe(outbound).pipe(inbound);
  });
  await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve));
  return {
    port: (relay.address() as { port: number }).port,
    ca: cert,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => relay.close(() => resolve()));
    },
  };
}

test("a relay that ends TLS fails a bound login with reason channel_binding; off logs in through it", async () => {
  const server = await startServer({ tls: true });
  const relay = await startRelay(server);
  try {
    const throughRelay = { host: "127.0.0.1", port: relay.port, tls: true, ca: relay.ca, user: server.user, password: server.password };
    for (const version of ["TLSv1.3", "TLSv1.2"] as const) {
      await withTlsUpTo(version, async () => {
        await assert.rejects(connect(throughRelay), (error: unknown) => {
          serverError("AUTH_FAILED", "channel_binding", "AUTH")(error);
          assert.match((error as ChunkAuthError).serverMessage, /bound to another TLS connection/);
          return true;
        });
        const client = await connect({ ...throughRelay, channelBinding: "off" });
        assert.equal(await client.ping(), "PONG");
        await client.close();
      });
    }
  } finally {
    await relay.close();
    await server.stop();
  }
});
