import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  missingCommandFromProbe,
  REQUIRED_COMMAND_PROBES,
  resolveServerBinary,
  workspaceServerBinary,
} from "./helpers";

test("plain and TLS resolution fail clearly when the dedicated build is missing", () => {
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
});

test("plain and TLS server resolution use the same dedicated build", () => {
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
});

test("a fully stale server is rejected by every required capability probe", () => {
  for (const probe of REQUIRED_COMMAND_PROBES) {
    assert.equal(
      missingCommandFromProbe(probe, "-ERR UNKNOWN_COMMAND unsupported"),
      probe.split(" ", 1)[0],
    );
  }
});

test("a partially stale server with CHUNKVER but without CHUNKBATCH is rejected", () => {
  assert.equal(missingCommandFromProbe("CHUNKVER", "$1"), undefined);
  assert.equal(
    missingCommandFromProbe(
      "CHUNKBATCH",
      "-ERR UNKNOWN_COMMAND unknown command",
    ),
    "CHUNKBATCH",
  );
});
