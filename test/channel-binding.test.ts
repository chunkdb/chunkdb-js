import test from "node:test";
import assert from "node:assert/strict";
import { createHash, X509Certificate } from "node:crypto";
import tls from "node:tls";

import { ChunkClient, ChunkConnectionError, ChunkTlsError, connect, connectPool } from "../src/index";
import { endPointHash, tlsChannelBinding, type ScramChannelBinding } from "../src/channel-binding";
import { FAKE_HELLO, scramResponder, startFakeServer } from "./fake-server";
import { der, oid, sequence, testTlsPem, type TestCertificateKind } from "./tls-cert";

// A certificate's outer structure around a signature AlgorithmIdentifier.
function certificateWith(algorithm: Buffer): Buffer {
  return sequence(sequence(der(0x02, Buffer.from([1]))), algorithm, der(0x03, Buffer.from([0, 1])));
}

const pss = (...parameters: Buffer[]) => sequence(oid("1.2.840.113549.1.1.10"), sequence(...parameters));
const digest = (dotted: string) => der(0xa0, sequence(oid(dotted), der(0x05)));

test("tls-server-end-point hashes with the certificate's signature hash, SHA-256 for MD5 and SHA-1", () => {
  const cases: Array<[Buffer, string | undefined]> = [
    [sequence(oid("1.2.840.113549.1.1.4"), der(0x05)), "sha256"],
    [sequence(oid("1.2.840.113549.1.1.5"), der(0x05)), "sha256"],
    [sequence(oid("1.2.840.113549.1.1.14"), der(0x05)), "sha224"],
    [sequence(oid("1.2.840.113549.1.1.11"), der(0x05)), "sha256"],
    [sequence(oid("1.2.840.113549.1.1.12"), der(0x05)), "sha384"],
    [sequence(oid("1.2.840.113549.1.1.13"), der(0x05)), "sha512"],
    [sequence(oid("1.2.840.10045.4.1")), "sha256"],
    [sequence(oid("1.2.840.10045.4.3.2")), "sha256"],
    [sequence(oid("1.2.840.10045.4.3.3")), "sha384"],
    [sequence(oid("1.2.840.10045.4.3.4")), "sha512"],
    // RSASSA-PSS: the hash of its parameters, SHA-1 (so SHA-256) by default.
    [pss(), "sha256"],
    [pss(digest("1.3.14.3.2.26")), "sha256"],
    [pss(digest("2.16.840.1.101.3.4.2.1")), "sha256"],
    [pss(digest("2.16.840.1.101.3.4.2.2")), "sha384"],
    [pss(digest("2.16.840.1.101.3.4.2.3")), "sha512"],
    [pss(digest("1.2.3.4")), undefined],
    [sequence(oid("1.2.840.113549.1.1.10")), undefined],
    // Ed25519 and Ed448 have no single hash; unknown algorithms none known.
    [sequence(oid("1.3.101.112")), undefined],
    [sequence(oid("1.3.101.113")), undefined],
    [sequence(oid("1.2.840.10040.4.3")), undefined],
  ];
  for (const [algorithm, hash] of cases) {
    assert.equal(endPointHash(certificateWith(algorithm)), hash, algorithm.toString("hex"));
  }
  for (const malformed of [Buffer.alloc(0), Buffer.from([0x30]), Buffer.from([0x30, 0x80, 0, 0]),
    Buffer.from([0x30, 0x05, 0x30, 0x00]), certificateWith(sequence(der(0x06, Buffer.from([0x81]))))]) {
    assert.equal(endPointHash(malformed), undefined, malformed.toString("hex"));
  }
  const kinds: Array<[TestCertificateKind, string | undefined]> = [
    ["rsa-sha256", "sha256"], ["ecdsa-sha384", "sha384"], ["rsa-pss-sha384", "sha384"], ["ed25519", undefined],
  ];
  for (const [kind, hash] of kinds) {
    assert.equal(endPointHash(new X509Certificate(testTlsPem(kind).cert).raw), hash, kind);
  }
});

// Connects to a local TLS server and returns the binding the client side
// computes, with the server's view of the same connection.
async function bindingOver(kind: TestCertificateKind, maxVersion: tls.SecureVersion) {
  const { cert, key } = testTlsPem(kind);
  let serverExporter: (value: Buffer | undefined) => void = () => {};
  const exported = new Promise<Buffer | undefined>((resolve) => { serverExporter = resolve; });
  const server = tls.createServer({ cert, key }, (socket) => {
    serverExporter(socket.getProtocol() === "TLSv1.3"
      ? socket.exportKeyingMaterial(32, "EXPORTER-Channel-Binding", Buffer.alloc(0)) : undefined);
    socket.on("error", () => {});
    socket.resume();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  const socket = await new Promise<tls.TLSSocket>((resolve, reject) => {
    const client = tls.connect({ host: "127.0.0.1", port, ca: cert, maxVersion }, () => resolve(client));
    client.once("error", reject);
  });
  try {
    let result: ScramChannelBinding | Error;
    try {
      result = tlsChannelBinding(socket);
    } catch (error) {
      result = error as Error;
    }
    return { protocol: socket.getProtocol(), result, serverExporter: await exported, raw: new X509Certificate(cert).raw };
  } finally {
    socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("TLS 1.3 binds with tls-exporter, TLS 1.2 with tls-server-end-point", async () => {
  const exporter = await bindingOver("rsa-sha256", "TLSv1.3");
  assert.equal(exporter.protocol, "TLSv1.3");
  assert.ok(!(exporter.result instanceof Error));
  assert.equal(exporter.result.type, "tls-exporter");
  assert.equal(exporter.result.data.length, 32);
  assert.deepEqual(exporter.result.data, exporter.serverExporter);

  for (const [kind, hash] of [["rsa-sha256", "sha256"], ["ecdsa-sha384", "sha384"], ["rsa-pss-sha384", "sha384"]] as const) {
    const endPoint = await bindingOver(kind, "TLSv1.2");
    assert.equal(endPoint.protocol, "TLSv1.2");
    assert.ok(!(endPoint.result instanceof Error), kind);
    assert.equal(endPoint.result.type, "tls-server-end-point");
    assert.deepEqual(endPoint.result.data, createHash(hash).update(endPoint.raw).digest(), kind);
  }

  // Ed25519 defines no tls-server-end-point; TLS 1.3 binds anyway.
  const undefinedEndPoint = await bindingOver("ed25519", "TLSv1.2");
  assert.ok(undefinedEndPoint.result instanceof ChunkTlsError);
  assert.match(undefinedEndPoint.result.message, /tls-server-end-point.*TLS 1\.3.*channelBinding: "off"/);
  const ed25519Exporter = await bindingOver("ed25519", "TLSv1.3");
  assert.ok(!(ed25519Exporter.result instanceof Error));
  assert.equal(ed25519Exporter.result.type, "tls-exporter");
});

test("channelBinding is auto, off or require; require refuses plain TCP before connecting", async () => {
  const server = await startFakeServer((request) => (request.line.startsWith("HELLO 3") ? FAKE_HELLO : null));
  try {
    assert.throws(() => new ChunkClient({ channelBinding: "on" as "auto" }), (error: unknown) => {
      assert.ok(error instanceof TypeError);
      assert.match(error.message, /channelBinding must be "auto", "off" or "require", got "on"/);
      return true;
    });
    const refused = (error: unknown) => {
      assert.ok(error instanceof ChunkConnectionError, String(error));
      assert.equal(error.phase, "connect");
      assert.match(error.message, /channelBinding "require" needs TLS/);
      return true;
    };
    assert.throws(() => new ChunkClient({ port: server.port, user: "bot", password: "x", channelBinding: "require" }), refused);
    assert.throws(() => new ChunkClient({ uri: `chunk://bot:x@127.0.0.1:${server.port}/`, channelBinding: "require" }), refused);
    const pool = await connectPool({ port: server.port, user: "bot", password: "x", channelBinding: "require", maxConnections: 1 });
    await assert.rejects(pool.ping(), refused);
    await pool.close();
    assert.equal(server.connections, 0);

    // Over TLS the option is accepted, with a user to log in as.
    assert.doesNotThrow(() => new ChunkClient({ uri: "chunks://bot:x@127.0.0.1:1/", channelBinding: "require" }));
    assert.throws(() => new ChunkClient({ uri: "chunks://127.0.0.1:1/", channelBinding: "require" }), (error: unknown) => {
      assert.ok(error instanceof ChunkConnectionError, String(error));
      assert.match(error.message, /channelBinding "require" needs a user/);
      return true;
    });
  } finally {
    await server.close();
  }
});

test("auto and off log in unbound over plain TCP: n,, and c=biws", async () => {
  const server = await startFakeServer(scramResponder("bot", "secret"));
  try {
    for (const channelBinding of [undefined, "auto", "off"] as const) {
      const client = await connect({ port: server.port, user: "bot", password: "secret", channelBinding });
      await client.close();
    }
    const firsts = server.requests.filter((request) => request.line.startsWith("HELLO"));
    const finals = server.requests.filter((request) => request.line === "AUTH $1");
    assert.equal(firsts.length, 3);
    assert.equal(finals.length, 3);
    for (const request of firsts) assert.match(request.frames[0]?.toString("utf8") ?? "", /^n,,n=bot,r=/);
    for (const request of finals) assert.match(request.frames[0]?.toString("utf8") ?? "", /^c=biws,r=/);
  } finally {
    await server.close();
  }
});
