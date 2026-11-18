import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { repoRoot, startServer } from "./helpers";

const run = promisify(execFile);
const root = repoRoot();
// The README's "World in five minutes" program and its output.
const section = /^## World in five minutes\n[\s\S]*?^```ts docs-check\n([\s\S]*?)^```\n\s*^```output\n([\s\S]*?)^```/m
  .exec(fs.readFileSync(path.join(root, "README.md"), "utf8"));

test("world example is the README program and prints its output on every run", { timeout: 20000 }, async () => {
  assert.ok(section, "README.md: missing the World in five minutes program and output");
  assert.equal(fs.readFileSync(path.join(root, "examples/world.ts"), "utf8"), section[1], "examples/world.ts differs from README.md");
  const server = await startServer();
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      // `@chunkdb/client` resolves to this package's build (npm run build).
      const { stdout, stderr } = await run(path.join(root, "node_modules/.bin/tsx"), ["examples/world.ts"], {
        cwd: root, env: { ...process.env, CHUNKDB_URI: `${server.uri}world_js` }, timeout: 8000,
      });
      assert.equal(stderr, "");
      assert.equal(stdout, section[2], `run ${attempt + 1}`);
    }
  } finally { await server.stop(); }
});
