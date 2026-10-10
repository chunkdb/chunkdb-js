import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { repoRoot, startServer } from "./helpers";

const run = promisify(execFile);
test("world example runs as one command and can be run again", { timeout: 20000 }, async () => {
  const server = await startServer();
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const { stdout } = await run("npm", ["run", "example:world"], {
        cwd: repoRoot(), env: { ...process.env, CHUNKDB_URI: server.uri }, timeout: 8000,
      });
      assert.match(stdout, /block \{ kind: 1, height: 0 \}/);
      assert.match(stdout, /area chunks 1/);
      assert.match(stdout, /watch change \{ kind: 2, height: 42 \}/);
    }
  } finally { await server.stop(); }
});
