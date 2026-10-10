import assert from "node:assert/strict";
import net from "node:net";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";

import { startScramLogin } from "../src/scram";

export interface StartedServer {
  process: ChildProcessWithoutNullStreams;
  host: string;
  port: number;
  /** "users": the administrator below logs in; "none": `--auth none`. */
  auth: "users" | "none";
  /** The administrator, or "" with `--auth none`. */
  user: string;
  password: string;
  dataDir: string;
  tls: boolean;
  uri: string;
  stop(): Promise<void>;
}

export function repoRoot(): string {
  return process.env.CHUNKDB_CLIENT_REPO_ROOT ?? path.resolve(import.meta.dirname, "..");
}

export function chunkdbRepoRoot(): string {
  return process.env.CHUNKDB_REPO_ROOT ?? path.resolve(repoRoot(), "../chunkdb");
}

function serverBinaryName(): string {
  return process.platform === "win32" ? "chunkdb_server.exe" : "chunkdb_server";
}

export function workspaceServerBinary(root = chunkdbRepoRoot()): string {
  const base = path.join(root, "build-js-tests");
  const direct = path.join(base, serverBinaryName());
  if (fs.existsSync(direct)) {
    return direct;
  }
  // Multi-config generators place executables below the selected config.
  return path.join(base, "Debug", serverBinaryName());
}

export function resolveServerBinary(
  tlsEnabled: boolean,
  root = chunkdbRepoRoot(),
): string {
  const envValue = tlsEnabled ? process.env.CHUNKDB_SERVER_BIN_TLS : process.env.CHUNKDB_SERVER_BIN;
  if (envValue) {
    return envValue;
  }
  const candidate = workspaceServerBinary(root);
  if (fs.existsSync(candidate)) {
    return candidate;
  }
  const envName = tlsEnabled ? "CHUNKDB_SERVER_BIN_TLS" : "CHUNKDB_SERVER_BIN";
  throw new Error(
    `fresh workspace chunkdb server binary not found at ${candidate}. ` +
      "Run `npm run test:server` (or ordinary `npm test`) from chunkdb-js, " +
      `or explicitly set ${envName}.`,
  );
}

/**
 * Why the first reply line of a `HELLO 3` (or `HELLO 3 USER`) makes a server
 * unusable for the suite, or undefined when it answered the HELLO map or
 * started the SCRAM login.
 */
export function helloProbeFailure(firstLine: string): string | undefined {
  if (firstLine.startsWith("%") || firstLine.startsWith("+SCRAM ")) {
    return undefined;
  }
  return (
    `server refused HELLO 3 during the compatibility probe (${firstLine}); it does not speak protocol 3. ` +
    "Rebuild the current workspace server with `npm run test:server`, or set CHUNKDB_SERVER_BIN."
  );
}

async function assertServerSpeaksProtocol3(host: string, port: number, user: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = net.connect({ host, port });
    let buffer = "";
    socket.setEncoding("latin1");
    socket.once("error", reject);
    socket.once("connect", () => {
      if (user === "") {
        socket.write("HELLO 3\r\n");
      } else {
        const first = startScramLogin(user).first;
        socket.write(`HELLO 3 USER ${user} $1\r\n$${Buffer.byteLength(first)}\r\n${first}\r\n`);
      }
    });
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) {
        return;
      }
      socket.destroy();
      const failure = helloProbeFailure(buffer.slice(0, newline).replace(/\r$/, ""));
      if (failure === undefined) {
        resolve();
      } else {
        reject(new Error(failure));
      }
    });
  });
}

async function pickFreePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("failed to determine free port"));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tlsFixtureDir(): string {
  return path.join(repoRoot(), "test/fixtures/tls");
}

async function waitForServer(host: string, port: number): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = net.connect({ host, port });
        socket.once("connect", () => {
          socket.end();
          resolve();
        });
        socket.once("error", reject);
      });
      return;
    } catch {
      await wait(100);
    }
  }
  throw new Error(`server did not start on ${host}:${port}`);
}

function removeServerFiles(dataDir: string): void {
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(`${dataDir}.admin-password`, { force: true });
}

function tlsFixtures(): { cert: string; key: string } {
  const cert = path.join(tlsFixtureDir(), "cert.pem");
  const key = path.join(tlsFixtureDir(), "key.pem");
  assert.ok(fs.existsSync(cert), `TLS cert fixture not found: ${cert}`);
  assert.ok(fs.existsSync(key), `TLS key fixture not found: ${key}`);
  return { cert, key };
}

/**
 * Starts a server with an administrator (`admin`, whose password `uri`
 * carries), or with `--auth none`.
 */
export async function startServer(options: { tls?: boolean; auth?: "users" | "none"; slotMaxBytes?: number; feedLingerMs?: number } = {}): Promise<StartedServer> {
  const host = "127.0.0.1";
  const port = await pickFreePort();
  const auth = options.auth ?? "users";
  const user = auth === "users" ? "admin" : "";
  const password = auth === "users" ? "admin p@ss:word/1" : "";
  const tlsEnabled = options.tls ?? false;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "chunkdb-node-sdk-"));
  const scheme = tlsEnabled ? "chunks" : "chunk";
  const credentials = user === "" ? "" : `${user}:${encodeURIComponent(password)}@`;
  const uri = `${scheme}://${credentials}${host}:${port}/`;
  const binary = resolveServerBinary(tlsEnabled);

  assert.ok(fs.existsSync(binary), `server binary not found: ${binary}`);

  const args = [
    "--listen-uri",
    `${scheme}://${host}:${port}/`,
    "--data-dir",
    dataDir,
    "--durability",
    "relaxed",
    "--workers",
    "2",
    "--log-level",
    "warn",
  ];
  if (options.slotMaxBytes !== undefined) args.push("--slot-max-bytes", String(options.slotMaxBytes));
  if (options.feedLingerMs !== undefined) args.push("--feed-linger-ms", String(options.feedLingerMs));

  if (auth === "users") {
    // Outside the data directory, which must start empty.
    const passwordFile = `${dataDir}.admin-password`;
    fs.writeFileSync(passwordFile, `${password}\n`, { mode: 0o600 });
    args.push("--admin-user", user, "--admin-password-file", passwordFile);
  } else {
    args.push("--auth", "none");
  }

  if (tlsEnabled) {
    const { cert, key } = tlsFixtures();
    args.push("--tls-cert", cert, "--tls-key", key);
  }

  const child = spawn(binary, args, {
    cwd: chunkdbRepoRoot(),
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stderr.on("data", () => {});
  child.stdout.on("data", () => {});

  await waitForServer(host, port);
  // The plaintext probe cannot speak TLS; the non-TLS suites already exercise
  // the same binary, so a TLS-only mismatch still surfaces there.
  if (!tlsEnabled) {
    try {
      await assertServerSpeaksProtocol3(host, port, user);
    } catch (error) {
      child.kill("SIGKILL");
      removeServerFiles(dataDir);
      throw error;
    }
  }

  return {
    process: child,
    host,
    port,
    auth,
    user,
    password,
    dataDir,
    tls: tlsEnabled,
    uri,
    async stop() {
      child.kill("SIGTERM");
      await Promise.race([once(child, "exit"), wait(2000)]);
      removeServerFiles(dataDir);
    },
  };
}
