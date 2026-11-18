import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { connectUri } from "../src/index";
import { chunkdbRepoRoot, resolveServerBinary, startServer } from "./helpers";

for (const tls of [false, true]) {
  test(`test server: explicit ${tls ? "TLS" : "plain"} binary works without a sibling source tree`, async () => {
    const binary = path.resolve(resolveServerBinary(tls));
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "chunkdb-helper-workspace-"));
    const envName = tls ? "CHUNKDB_SERVER_BIN_TLS" : "CHUNKDB_SERVER_BIN";
    const saved = [process.env.CHUNKDB_CLIENT_REPO_ROOT, process.env.CHUNKDB_REPO_ROOT, process.env[envName]];
    process.env.CHUNKDB_CLIENT_REPO_ROOT = path.join(temporary, "client");
    fs.mkdirSync(process.env.CHUNKDB_CLIENT_REPO_ROOT);
    delete process.env.CHUNKDB_REPO_ROOT;
    process.env[envName] = path.relative(process.cwd(), binary);
    try {
      assert.equal(fs.existsSync(chunkdbRepoRoot()), false);
      const server = await startServer({ tls, auth: "none" });
      try {
        const client = await connectUri(server.uri, { tlsInsecure: tls });
        try { assert.equal(await client.ping(), "PONG"); }
        finally { await client.close(); }
      } finally { await server.stop(); }
    } finally {
      for (const [index, name] of ["CHUNKDB_CLIENT_REPO_ROOT", "CHUNKDB_REPO_ROOT", envName].entries()) {
        if (saved[index] === undefined) delete process.env[name];
        else process.env[name] = saved[index];
      }
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });
}
