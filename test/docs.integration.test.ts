import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { repoRoot, startServer, type StartedServer } from "./helpers";

const run = promisify(execFile);
const root = repoRoot();
const pages = ["README.md", ...fs.readdirSync(path.join(root, "docs"))
  .filter((name) => name.endsWith(".md")).sort().map((name) => `docs/${name}`)];
const packageUrl = pathToFileURL(path.join(root, "dist/esm/index.js")).href;

for (const page of pages) {
  const markdown = fs.readFileSync(path.join(root, page), "utf8");
  const blocks = [...markdown.matchAll(/^```ts docs-check\r?\n([\s\S]*?)^```\r?\n\s*^```output\r?\n([\s\S]*?)^```/gm)];
  const marked = [...markdown.matchAll(/^```ts docs-check\s*$/gm)].length;
  const typescript = [...markdown.matchAll(/^```ts(?:\s+[^\n]*)?$/gm)].length;
  test(`documentation markers: ${page}`, () => {
    assert.equal(marked, typescript, `${page}: mark every TypeScript example with docs-check`);
    assert.equal(blocks.length, marked, `${page}: each docs-check needs an output block`);
  });
  if (blocks.length === 0) continue;

  test(`documentation examples: ${page}`, { timeout: 35000 }, async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "chunkdb-js-docs-"));
    const backupDir = path.join(temporary, "backups");
    fs.mkdirSync(backupDir);
    let server: StartedServer | undefined;
    try {
      server = await startServer({ backupDir });
      const boundary = "--chunkdb-doc-example-end--\n";
      // Each README example is a complete program and runs on its own; the
      // snippets of a guide run together in one program.
      const groups = page === "README.md" ? blocks.map((block) => [block]) : [blocks];
      const programs = groups.map((group, number) => {
        const snippets = group.map((block) => `${block[1]}\nprocess.stdout.write(${JSON.stringify(boundary)});`).join("\n");
        const code = (page === "README.md" || page === "docs/CONNECTIONS.md") ? snippets : `
import { connectUri, connectPool, emptyChunk, ChunkMigrationError } from "@chunkdb/client";
const client = await connectUri(process.env.CHUNKDB_URI!);
try {
  await client.migrate([{
    name: "world_js_table",
    statement: "CREATE TABLE world_js (id u16, light u4 DEFAULT 15) CHUNK 16 x 16",
  }]);
${snippets}
} finally { await client.close(); }
`;
        const filename = path.join(temporary, `example-${number + 1}.mts`);
        fs.writeFileSync(filename, code.replaceAll('from "@chunkdb/client"', `from ${JSON.stringify(packageUrl)}`));
        return { filename, group };
      });
      // The README promises repeatable startup; execute its exact programs twice.
      for (let attempt = 0; attempt < (page === "README.md" ? 2 : 1); attempt++) {
        for (const { filename, group } of programs) {
          const { stdout, stderr } = await run(path.join(root, "node_modules/.bin/tsx"), [filename], {
            cwd: root, env: { ...process.env, CHUNKDB_URI: `${server.uri}world_js` }, timeout: 12000,
          });
          assert.equal(stderr, "", `${page}: unexpected standard error`);
          const outputs = stdout.replaceAll("\r\n", "\n").split(boundary);
          assert.equal(outputs.length, group.length + 1, `${page}: missing example boundary`);
          for (let index = 0; index < group.length; index++) {
            const number = blocks.indexOf(group[index]) + 1;
            assert.equal(outputs[index], group[index][2].replaceAll("\r\n", "\n"), `${page}: example ${number}`);
          }
          assert.equal(outputs.at(-1), "", `${page}: unexpected output after examples`);
        }
      }
    } finally {
      try { await server?.stop(); }
      finally { fs.rmSync(temporary, { recursive: true, force: true }); }
    }
  });
}
