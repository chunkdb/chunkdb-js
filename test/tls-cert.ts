import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// A self-signed RSA 2048 certificate for 127.0.0.1 (common name and IP
// subject alternative name), valid from a day ago to a day ahead and signed
// with SHA-256. It is generated once per test process, so no key is kept in
// the repository.

function der(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  const length = body.length;
  let header: Buffer;
  if (length < 0x80) {
    header = Buffer.from([tag, length]);
  } else {
    const bytes: number[] = [];
    for (let rest = length; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest % 256);
    header = Buffer.from([tag, 0x80 | bytes.length, ...bytes]);
  }
  return Buffer.concat([header, body]);
}

const sequence = (...parts: Buffer[]): Buffer => der(0x30, ...parts);
const set = (...parts: Buffer[]): Buffer => der(0x31, ...parts);

function oid(dotted: string): Buffer {
  const [first, second, ...rest] = dotted.split(".").map(Number);
  const bytes = [first * 40 + second];
  for (const value of rest) {
    const groups = [value & 0x7f];
    for (let v = Math.floor(value / 128); v > 0; v = Math.floor(v / 128)) groups.unshift((v & 0x7f) | 0x80);
    bytes.push(...groups);
  }
  return der(0x06, Buffer.from(bytes));
}

function utcTime(date: Date): Buffer {
  const two = (n: number): string => String(n).padStart(2, "0");
  const text = `${two(date.getUTCFullYear() % 100)}${two(date.getUTCMonth() + 1)}${two(date.getUTCDate())}` +
    `${two(date.getUTCHours())}${two(date.getUTCMinutes())}${two(date.getUTCSeconds())}Z`;
  return der(0x17, Buffer.from(text, "ascii"));
}

function pem(label: string, body: Buffer): string {
  const lines = body.toString("base64").match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

let generated: { cert: string; key: string } | undefined;

/** The certificate and private key as PEM text. */
export function testTlsPem(): { cert: string; key: string } {
  if (generated) return generated;
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const sha256WithRsa = sequence(oid("1.2.840.113549.1.1.11"), der(0x05));
  const name = sequence(set(sequence(oid("2.5.4.3"), der(0x0c, Buffer.from("127.0.0.1", "utf8")))));
  const day = 24 * 60 * 60 * 1000;
  const now = Date.now();
  const subjectAltName = sequence(oid("2.5.29.17"), der(0x04, sequence(der(0x87, Buffer.from([127, 0, 0, 1])))));
  const tbs = sequence(
    der(0xa0, der(0x02, Buffer.from([2]))),
    der(0x02, Buffer.from([1])),
    sha256WithRsa,
    name,
    sequence(utcTime(new Date(now - day)), utcTime(new Date(now + day))),
    name,
    publicKey.export({ type: "spki", format: "der" }),
    der(0xa3, sequence(subjectAltName)),
  );
  const signature = crypto.sign("sha256", tbs, privateKey);
  const certificate = sequence(tbs, sha256WithRsa, der(0x03, Buffer.from([0]), signature));
  generated = {
    cert: pem("CERTIFICATE", certificate),
    key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
  return generated;
}

let files: { cert: string; key: string } | undefined;

/** Paths of the certificate and key written once to a private temporary directory. */
export function testTlsFiles(): { cert: string; key: string } {
  if (files) return files;
  const { cert, key } = testTlsPem();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chunkdb-node-tls-"));
  const certPath = path.join(dir, "cert.pem");
  const keyPath = path.join(dir, "key.pem");
  fs.writeFileSync(certPath, cert);
  fs.writeFileSync(keyPath, key, { mode: 0o600 });
  process.once("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
  files = { cert: certPath, key: keyPath };
  return files;
}
