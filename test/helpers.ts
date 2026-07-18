import assert from "node:assert/strict";
import net from "node:net";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
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

// Every command family exercised by the integration suite. Deliberately
// invalid arguments keep the probe side-effect-free while still distinguishing
// an implemented command (INVALID_ARGUMENT) from an absent one
// (UNKNOWN_COMMAND).
export const REQUIRED_COMMAND_PROBES = [
  "PING extra",
  "INFO extra",
  "GET",
  "EXISTS",
  "SET",
  "UNSET",
  "MGET",
  "MSET",
  "CHUNKEXISTS",
  "CHUNK",
  "CHUNKSET",
  "CHUNKBIN",
  "CHUNKSCAN",
  "CHUNKRANGE",
  "CHUNKRADIUS",
  "CHUNKVER",
  "CHUNKCAS",
  "CHUNKBATCH",
  "CHUNKBINC",
  "WALFLUSH extra",
  "METRICS extra",
] as const;

export function missingCommandFromProbe(
  probe: string,
  responseLine: string,
): string | undefined {
  return responseLine.startsWith("-ERR UNKNOWN_COMMAND")
    ? probe.split(" ", 1)[0]
    : undefined;
}

async function assertServerSupportsRequiredCommands(
  host: string,
  port: number,
  token: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = net.connect({ host, port });
    let buffer = "";
    let authenticated = false;
    let probeIndex = 0;
    let pendingBulkBytes: number | undefined;
    const fail = (message: string) => {
      socket.destroy();
      reject(new Error(message));
    };
    socket.setEncoding("utf8");
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.write(`AUTH ${token}\r\n`);
    });
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      while (true) {
        if (pendingBulkBytes !== undefined) {
          if (buffer.length < pendingBulkBytes + 2) {
            return;
          }
          buffer = buffer.slice(pendingBulkBytes + 2);
          pendingBulkBytes = undefined;
          probeIndex += 1;
          if (probeIndex === REQUIRED_COMMAND_PROBES.length) {
            socket.end();
            resolve();
            return;
          }
          socket.write(`${REQUIRED_COMMAND_PROBES[probeIndex]}\r\n`);
          continue;
        }
        const newline = buffer.indexOf("\n");
        if (newline === -1) {
          return;
        }
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (!authenticated) {
          if (!line.startsWith("+OK")) {
            fail(`server rejected AUTH during compatibility probe: ${line}`);
            return;
          }
          authenticated = true;
          socket.write(`${REQUIRED_COMMAND_PROBES[probeIndex]}\r\n`);
          continue;
        }
        const probe = REQUIRED_COMMAND_PROBES[probeIndex];
        const missing = missingCommandFromProbe(probe, line);
        if (missing !== undefined) {
          fail(
            "chunkdb server is missing protocol capabilities required by the integration suite " +
              `(${missing}). Rebuild the current workspace server with \`npm run test:server\`.`,
          );
          return;
        }
        if (line.startsWith("$")) {
          const length = Number.parseInt(line.slice(1), 10);
          if (!Number.isSafeInteger(length) || length < 0) {
            fail(`invalid bulk response during compatibility probe: ${line}`);
            return;
          }
          pendingBulkBytes = length;
          continue;
        }
        probeIndex += 1;
        if (probeIndex === REQUIRED_COMMAND_PROBES.length) {
          socket.end();
          resolve();
          return;
        }
        socket.write(`${REQUIRED_COMMAND_PROBES[probeIndex]}\r\n`);
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

function tlsFixtures(): { cert: string; key: string } {
  const cert = path.join(tlsFixtureDir(), "cert.pem");
  const key = path.join(tlsFixtureDir(), "key.pem");
  assert.ok(fs.existsSync(cert), `TLS cert fixture not found: ${cert}`);
  assert.ok(fs.existsSync(key), `TLS key fixture not found: ${key}`);
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
      await assertServerSupportsRequiredCommands(host, port, token);
    } catch (error) {
      child.kill("SIGKILL");
      fs.rmSync(dataDir, { recursive: true, force: true });
      throw error;
    }
  }

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
