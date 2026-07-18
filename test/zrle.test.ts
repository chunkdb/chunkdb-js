import test from "node:test";
import assert from "node:assert/strict";

import { zrleCompress, zrleDecompress } from "../src/zrle";

test("zrle round trips sparse, dense, zero, and empty buffers", () => {
  const sparse = Buffer.alloc(1024);
  sparse[3] = 0xab;
  sparse[700] = 0x01;
  const dense = Buffer.from(Array.from({ length: 1024 }, (_, i) => (i * 31 + 7) & 0xff));
  for (const original of [Buffer.alloc(0), Buffer.alloc(512), sparse, dense]) {
    const compressed = zrleCompress(original);
    assert.deepEqual(zrleDecompress(compressed, original.length), original);
  }
});

test("zrle compresses sparse data", () => {
  const sparse = Buffer.alloc(1024);
  sparse[10] = 0xff;
  assert.ok(zrleCompress(sparse).length < sparse.length / 4);
});

test("zrle rejects malformed inputs", () => {
  const sparse = Buffer.alloc(256);
  sparse[0] = 0x42;
  const compressed = zrleCompress(sparse);

  // truncated
  assert.throws(() => zrleDecompress(compressed.subarray(0, compressed.length - 2), 256));
  // declared/expected size mismatch (bomb guard)
  assert.throws(() => zrleDecompress(compressed, 256 * 100));
  // unknown codec id
  const badCodec = Buffer.from(compressed);
  badCodec[0] = 0x7f;
  assert.throws(() => zrleDecompress(badCodec, 256));
  // unknown token
  const badToken = Buffer.from(compressed);
  badToken[5] = 0x09;
  assert.throws(() => zrleDecompress(badToken, 256));
});
