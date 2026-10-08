import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac, pbkdf2Sync } from "node:crypto";

import { scramVerifier } from "../src/index";
import { finishScramLogin, scramSignatureMatches, startScramLogin } from "../src/scram";

// RFC 7677, section 3.
const RFC_SERVER_FIRST = "r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096";

test("the SCRAM-SHA-256 exchange matches RFC 7677", async () => {
  const login = startScramLogin("user", "rOprNGfwEbeRWgbNEkqO");
  assert.equal(login.first, "n,,n=user,r=rOprNGfwEbeRWgbNEkqO");
  const final = await finishScramLogin(login, "pencil", RFC_SERVER_FIRST);
  assert.equal(
    final.message,
    "c=biws,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,p=dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ=",
  );
  assert.equal(final.serverSignature, "v=6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=");
  assert.ok(scramSignatureMatches(final.serverSignature, "v=6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4="));
  assert.ok(!scramSignatureMatches(final.serverSignature, "v=6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G5="));
  assert.ok(!scramSignatureMatches(final.serverSignature, "v="));
});

test("a server-first message must continue the client nonce", async () => {
  const login = startScramLogin("user", "rOprNGfwEbeRWgbNEkqO");
  for (const serverFirst of [
    "r=rOprNGfwEbeRWgbNEkqO,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096",
    "r=other%hvYD,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096",
  ]) {
    await assert.rejects(finishScramLogin(login, "pencil", serverFirst), /does not continue the client nonce/);
  }
  for (const serverFirst of [
    "r=rOprNGfwEbeRWgbNEkqOx,s=W22ZaJ0SNY7soEsUEjb6gQ==",
    "r=rOprNGfwEbeRWgbNEkqOx,s=not base64!,i=4096",
    "r=rOprNGfwEbeRWgbNEkqOx,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=0",
    "s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096",
  ]) {
    await assert.rejects(finishScramLogin(login, "pencil", serverFirst), /not a SCRAM server-first message/);
  }
});

test("a client nonce is 18 random bytes in base64", () => {
  const a = startScramLogin("bot");
  const b = startScramLogin("bot");
  assert.match(a.nonce, /^[A-Za-z0-9+/]{24}$/);
  assert.equal(Buffer.from(a.nonce, "base64").length, 18);
  assert.notEqual(a.nonce, b.nonce);
});

test("a verifier is SCRAM-SHA-256$<iterations>:<salt>$<StoredKey>:<ServerKey>", () => {
  const salt = Buffer.from("W22ZaJ0SNY7soEsUEjb6gQ==", "base64");
  const verifier = scramVerifier("pencil", { salt });
  const match = /^SCRAM-SHA-256\$([0-9]+):([^$]+)\$([^:]+):(.+)$/.exec(verifier);
  assert.ok(match !== null, verifier);
  const [, iterations, saltText, storedKey, serverKey] = match;
  assert.equal(iterations, "4096");
  assert.equal(saltText, "W22ZaJ0SNY7soEsUEjb6gQ==");
  const salted = pbkdf2Sync("pencil", salt, 4096, 32, "sha256");
  const hmac = (key: Buffer, text: string) => createHmac("sha256", key).update(text).digest();
  assert.equal(storedKey, createHash("sha256").update(hmac(salted, "Client Key")).digest("base64"));
  assert.equal(serverKey, hmac(salted, "Server Key").toString("base64"));

  const random = scramVerifier("pencil");
  assert.match(random, /^SCRAM-SHA-256\$4096:[A-Za-z0-9+/]{22}==\$[A-Za-z0-9+/]{43}=:[A-Za-z0-9+/]{43}=$/);
  assert.notEqual(random, scramVerifier("pencil"));
  assert.match(scramVerifier("pencil", { iterations: 10000 }), /^SCRAM-SHA-256\$10000:/);
  assert.throws(() => scramVerifier("pencil", { iterations: 4095 }), /at least 4096/);
  assert.throws(() => scramVerifier("pencil", { iterations: 4096.5 }), /at least 4096/);
  assert.throws(() => scramVerifier("pencil", { salt: Buffer.alloc(15) }), /at least 16 bytes/);
});

test("a verifier logs in: the proof checks against its StoredKey", async () => {
  const salt = Buffer.from("W22ZaJ0SNY7soEsUEjb6gQ==", "base64");
  const [, , storedKey, serverKey] = /^SCRAM-SHA-256\$([0-9]+):[^$]+\$([^:]+):(.+)$/.exec(scramVerifier("pencil", { salt }))!;
  const login = startScramLogin("user", "rOprNGfwEbeRWgbNEkqO");
  const final = await finishScramLogin(login, "pencil", RFC_SERVER_FIRST);
  const authMessage = `${login.firstBare},${RFC_SERVER_FIRST},${final.message.slice(0, final.message.indexOf(",p="))}`;
  const proof = Buffer.from(final.message.slice(final.message.indexOf(",p=") + 3), "base64");
  const signature = createHmac("sha256", Buffer.from(storedKey, "base64")).update(authMessage).digest();
  const clientKey = Buffer.from(proof.map((byte, i) => byte ^ signature[i]));
  assert.equal(createHash("sha256").update(clientKey).digest("base64"), storedKey);
  assert.equal(
    final.serverSignature,
    `v=${createHmac("sha256", Buffer.from(serverKey, "base64")).update(authMessage).digest("base64")}`,
  );
});
