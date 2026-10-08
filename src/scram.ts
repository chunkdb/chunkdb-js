// SCRAM-SHA-256 (RFC 5802, RFC 7677) as chunkdb logs in with it, and the
// verifier `CREATE USER` / `ALTER USER ... VERIFIER` take.
import { createHash, createHmac, pbkdf2, pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

import type { ChunkVerifierOptions } from "./types";

const pbkdf2Async = promisify(pbkdf2);

/** The fewest PBKDF2 iterations a chunkdb server takes in a verifier. */
export const MIN_SCRAM_ITERATIONS = 4096;
const SALT_BYTES = 16;
const NONCE_BYTES = 18;
// base64("n,,"): no channel binding.
const CHANNEL_BINDING = "c=biws";
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** The client side of one login, between `HELLO 3 USER` and `AUTH`. */
export interface ScramLogin {
  /** The client-first message: `n,,n=<user>,r=<nonce>`. */
  first: string;
  firstBare: string;
  nonce: string;
}

export interface ScramFinal {
  /** The client-final message: `c=biws,r=<nonce>,p=<proof>`. */
  message: string;
  /** The server-final message the server must answer: `v=<signature>`. */
  serverSignature: string;
}

function hmac(key: Uint8Array, text: string): Buffer {
  return createHmac("sha256", key).update(text, "utf8").digest();
}

function sha256(bytes: Uint8Array): Buffer {
  return createHash("sha256").update(bytes).digest();
}

function checkIterations(iterations: number): number {
  if (!Number.isSafeInteger(iterations) || iterations < MIN_SCRAM_ITERATIONS || iterations > 0xffffffff) {
    throw new RangeError(`SCRAM iterations must be an integer of at least ${MIN_SCRAM_ITERATIONS}, got ${String(iterations)}`);
  }
  return iterations;
}

function verifierText(salted: Buffer, salt: Uint8Array, iterations: number): string {
  const storedKey = sha256(hmac(salted, "Client Key"));
  const serverKey = hmac(salted, "Server Key");
  return (
    `SCRAM-SHA-256$${iterations}:${Buffer.from(salt).toString("base64")}` +
    `$${storedKey.toString("base64")}:${serverKey.toString("base64")}`
  );
}

function verifierInputs(options: ChunkVerifierOptions): { iterations: number; salt: Uint8Array } {
  const iterations = checkIterations(options.iterations ?? MIN_SCRAM_ITERATIONS);
  const salt = options.salt ?? randomBytes(SALT_BYTES);
  if (!(salt instanceof Uint8Array) || salt.length < SALT_BYTES) {
    throw new RangeError(`a SCRAM salt is at least ${SALT_BYTES} bytes`);
  }
  return { iterations, salt };
}

/**
 * The SCRAM-SHA-256 verifier of a password, as `CREATE USER ... VERIFIER $1`
 * and `ALTER USER ... VERIFIER $1` take it:
 * `SCRAM-SHA-256$<iterations>:<salt>$<StoredKey>:<ServerKey>` (base64 parts).
 * The password itself never reaches the server.
 */
export function scramVerifier(password: string, options: ChunkVerifierOptions = {}): string {
  const { iterations, salt } = verifierInputs(options);
  return verifierText(pbkdf2Sync(password, salt, iterations, 32, "sha256"), salt, iterations);
}

/** `scramVerifier` without blocking the event loop during PBKDF2. */
export async function scramVerifierAsync(password: string, options: ChunkVerifierOptions = {}): Promise<string> {
  const { iterations, salt } = verifierInputs(options);
  return verifierText(await pbkdf2Async(password, salt, iterations, 32, "sha256"), salt, iterations);
}

/** A new client nonce: 18 random bytes in base64. */
export function scramNonce(): string {
  return randomBytes(NONCE_BYTES).toString("base64");
}

export function startScramLogin(user: string, nonce: string = scramNonce()): ScramLogin {
  const firstBare = `n=${user},r=${nonce}`;
  return { first: `n,,${firstBare}`, firstBare, nonce };
}

/**
 * The client-final message for the server-first message
 * `r=<nonce>,s=<salt>,i=<iterations>`, and the server signature to expect.
 * Throws a `TypeError` for a server-first message that does not continue
 * this login.
 */
export async function finishScramLogin(login: ScramLogin, password: string, serverFirst: string): Promise<ScramFinal> {
  const parts = /^r=([^,]+),s=([^,]+),i=([0-9]+)$/.exec(serverFirst);
  if (parts === null) {
    throw new TypeError("not a SCRAM server-first message");
  }
  const [, nonce, saltText, iterationsText] = parts;
  if (!nonce.startsWith(login.nonce) || nonce.length === login.nonce.length) {
    throw new TypeError("the server nonce does not continue the client nonce");
  }
  const iterations = Number(iterationsText);
  if (!BASE64.test(saltText) || !Number.isSafeInteger(iterations) || iterations < 1 || iterations > 0xffffffff) {
    throw new TypeError("not a SCRAM server-first message");
  }
  const salted = await pbkdf2Async(password, Buffer.from(saltText, "base64"), iterations, 32, "sha256");
  const clientKey = hmac(salted, "Client Key");
  const withoutProof = `${CHANNEL_BINDING},r=${nonce}`;
  const authMessage = `${login.firstBare},${serverFirst},${withoutProof}`;
  const signature = hmac(sha256(clientKey), authMessage);
  const proof = Buffer.alloc(clientKey.length);
  for (let i = 0; i < proof.length; i += 1) {
    proof[i] = clientKey[i] ^ signature[i];
  }
  return {
    message: `${withoutProof},p=${proof.toString("base64")}`,
    serverSignature: `v=${hmac(hmac(salted, "Server Key"), authMessage).toString("base64")}`,
  };
}

/** Whether the server's signature is the expected one, in constant time. */
export function scramSignatureMatches(expected: string, actual: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(actual, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
