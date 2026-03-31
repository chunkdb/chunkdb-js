import assert from "node:assert/strict";
import net from "node:net";
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";

export interface StartedServer {
  process: ChildProcessWithoutNullStreams;
  host: string;
  port: number;
  token: string;
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

function resolveServerBinary(tlsEnabled: boolean): string {
  const envValue = tlsEnabled ? process.env.CHUNKDB_SERVER_BIN_TLS : process.env.CHUNKDB_SERVER_BIN;
  if (envValue) {
    return envValue;
  }
  return path.join(
    chunkdbRepoRoot(),
    tlsEnabled ? "build-quick-tls/chunkdb_server" : "build-quick/chunkdb_server",
  );
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

function createTlsCredentials(baseDir: string): { cert: string; key: string } {
  const cert = path.join(baseDir, "cert.pem");
  const key = path.join(baseDir, "key.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-sha256",
      "-days",
      "1",
      "-nodes",
      "-subj",
      "/CN=127.0.0.1",
      "-keyout",
      key,
      "-out",
      cert,
    ],
    { stdio: "ignore" },
  );
  return { cert, key };
}

export async function startServer(options: { tls?: boolean; token?: string } = {}): Promise<StartedServer> {
  const host = "127.0.0.1";
  const port = await pickFreePort();
  const token = options.token ?? "chunk-token";
  const tlsEnabled = options.tls ?? false;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "chunkdb-node-sdk-"));
  const uri = `${tlsEnabled ? "chunks" : "chunk"}://${token}@${host}:${port}/`;
  const binary = resolveServerBinary(tlsEnabled);

  assert.ok(fs.existsSync(binary), `server binary not found: ${binary}`);

  const args = [
    "--listen-uri",
    uri,
    "--data-dir",
    dataDir,
    "--durability",
    "relaxed",
    "--workers",
    "2",
    "--log-level",
    "warn",
  ];

  if (tlsEnabled) {
    const credsDir = path.join(dataDir, "tls");
    fs.mkdirSync(credsDir, { recursive: true });
    const { cert, key } = createTlsCredentials(credsDir);
    args.push("--tls-cert", cert, "--tls-key", key);
  }

  const child = spawn(binary, args, {
    cwd: chunkdbRepoRoot(),
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stderr.on("data", () => {});
  child.stdout.on("data", () => {});

  await waitForServer(host, port);

  return {
    process: child,
    host,
    port,
    token,
    dataDir,
    tls: tlsEnabled,
    uri,
    async stop() {
      child.kill("SIGTERM");
      await Promise.race([once(child, "exit"), wait(2000)]);
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

export function hasOpenSsl(): boolean {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
