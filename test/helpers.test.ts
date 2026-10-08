import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { helloProbeFailure, resolveServerBinary, workspaceServerBinary } from "./helpers";

// Resolution without CHUNKDB_SERVER_BIN / CHUNKDB_SERVER_BIN_TLS, which win
// when set.
function withoutServerEnv(run: () => void): void {
  const saved = [process.env.CHUNKDB_SERVER_BIN, process.env.CHUNKDB_SERVER_BIN_TLS];
  delete process.env.CHUNKDB_SERVER_BIN;
  delete process.env.CHUNKDB_SERVER_BIN_TLS;
  try {
    run();
  } finally {
    if (saved[0] !== undefined) process.env.CHUNKDB_SERVER_BIN = saved[0];
    if (saved[1] !== undefined) process.env.CHUNKDB_SERVER_BIN_TLS = saved[1];
  }
}

test("plain and TLS resolution fail clearly when the dedicated build is missing", () => withoutServerEnv(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chunkdb-helper-missing-"));
  try {
    for (const tlsEnabled of [false, true]) {
      assert.throws(
        () => resolveServerBinary(tlsEnabled, root),
        /npm run test:server/,
      );
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}));

test("plain and TLS server resolution use the same dedicated build", () => withoutServerEnv(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chunkdb-helper-current-"));
  try {
    const binary = workspaceServerBinary(root);
    fs.mkdirSync(path.dirname(binary), { recursive: true });
    fs.writeFileSync(binary, "");
    assert.equal(resolveServerBinary(false, root), binary);
    assert.equal(resolveServerBinary(true, root), binary);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}));

test("the compatibility probe accepts only a HELLO 3 map", () => {
  assert.equal(helloProbeFailure("%7"), undefined);
  assert.match(helloProbeFailure("-ERR PROTOCOL expected HELLO 2") ?? "", /does not speak protocol 3/);
  assert.match(helloProbeFailure("$120") ?? "", /does not speak protocol 3/);
});
