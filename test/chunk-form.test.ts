import test from "node:test";
import assert from "node:assert/strict";

import { ChunkBits, ChunkProtocolError, emptyChunk, formatColumnType, parseColumnType } from "../src/index";
import type { ChunkColumn, ChunkTableSchema, ChunkValue } from "../src/index";
import { chunkFormLimit, decodeChunkForm, encodeChunkForm } from "../src/chunk-form";
import { encodeSectionedChunk } from "../src/sectioned-chunk";
import { FormSection, parseSectionedForm } from "../src/chunk-sections";
import type { TableLayout } from "../src/schema";

function column(name: string, typeName: string, nullable = false): ChunkColumn {
  const type = parseColumnType(typeName);
  return { name, type, typeName: formatColumnType(type), nullable, required: false, default: null };
}

function layout(
  columns: ChunkColumn[],
  width: number,
  height: number,
  ids: number[] = columns.map((_, i) => i + 1),
): TableLayout {
  const schema: ChunkTableSchema = {
    table: "t",
    version: 1,
    columns,
    chunk: { width, height },
    large: { width: 8, height: 8 },
    options: {
      durabilityMode: "relaxed",
      checkpointUpdates: 256,
      checkpointWalBytes: 1048576,
      walGroupCommitUpdates: 8,
      checkpointCompression: "none",
      varMaxChunkBytes: 1048576,
      feedBufferBytes: 67108864,
      slotMaxBytes: 1073741824,
    },
  };
  return { schema, ids };
}

const all = (l: TableLayout) => l.schema.columns.map((_, i) => i);

// The table of the server's own CQL tests (tests/cql_engine_tests.cpp).
const world = layout(
  [
    column("id", "u10"),
    column("temp", "i8", true),
    column("solid", "bool"),
    column("h", "f32"),
    column("d", "f64"),
    column("mask", "bits(3)", true),
    column("name", "text(16)", true),
    column("blob", "bytes(4)"),
  ],
  4,
  4,
);

test("checked forms decode by schema and earlier binary forms are refused", () => {
  // GET CHUNK 0 0 FROM w of `CREATE TABLE w (a u8, s text(8) NULL,
  // b bytes(4)) CHUNK 2 x 2` after `SET BLOCK 0 0 IN w a = 1, s = 'hi',
  // b = x'5a'`, as chunkdb_server answered it.
  const w = layout([column("a", "u8"), column("s", "text(8)", true), column("b", "bytes(4)")], 2, 2);
  const legacy = Buffer.from(
    "0200000000000000" + "0100000000000000" + "01" + "01000000" +
      "020000000000000002000000" + "6869" + "030000000000000001000000" + "5a",
    "hex",
  );
  assert.throws(() => decodeChunkForm(w, legacy, all(w)), ChunkProtocolError);
  const form = encodeSectionedChunk(w, { present: [true, false, false, false], columns: { a: [1, null, null, null], s: ["hi", null, null, null], b: [Buffer.from("Z"), null, null, null] } }, all(w), { version: 2n });
  assert.equal(form.subarray(0, 4).toString(), "CKCF");
  const state = decodeChunkForm(w, form, all(w));
  assert.equal(state.version, 2n);
  assert.equal(state.schemaVersion, 1);
  assert.equal(state.width, 2);
  assert.deepEqual(state.present, [true, false, false, false]);
  assert.deepEqual(state.columns.a, [1, null, null, null]);
  assert.deepEqual(state.columns.s, ["hi", null, null, null]);
  assert.deepEqual(state.columns.b, [Buffer.from("Z"), null, null, null]);
  // Encoding gives the same bytes, with the version field zero.
  assert.deepEqual(encodeChunkForm(w, state), Buffer.concat([form.subarray(0, 8), Buffer.alloc(8), form.subarray(16, 24), Buffer.alloc(8), form.subarray(32)]));
  // A form of another schema version means the cached schema is out of date.
  const other = Buffer.from(form);
  other.writeBigUInt64LE(2n, 16);
  assert.throws(() => decodeChunkForm(w, other, all(w)), /schema version mismatch/);
});

test("every column type round-trips through the chunk form", () => {
  const state = emptyChunk(world.schema);
  const set = (block: number, values: Record<string, ChunkValue>) => {
    state.present[block] = true;
    for (const name of Object.keys(state.columns)) {
      state.columns[name][block] = values[name] ?? (name === "blob" ? Buffer.alloc(0) : name === "id" || name === "h" || name === "d" ? 0 : name === "solid" ? false : null);
    }
  };
  set(0, { id: 1023, temp: -128, solid: true, h: 1.5, d: -0.25, mask: ChunkBits.from("101"), name: "it's", blob: Buffer.from([0, 13, 10, 255]) });
  set(5, { id: 3, temp: 127, h: Number.NEGATIVE_INFINITY, d: Number.NaN, name: "", blob: Buffer.from("ab") });
  set(15, { id: 512, mask: ChunkBits.from("011"), name: "€" });
  const form = encodeChunkForm(world, state);
  // version, presence, then id 20 bytes, temp 16 + 2, solid 2, h 64, d 128,
  // mask 6 + 2, then the text and bytes entries.
  assert.equal(form.length, 244 + 2 + 20 + 18 + 2 + 64 + 128 + 8 + (12 + 4) + (12 + 0) + (12 + 3) + (12 + 4) + (12 + 2));
  const back = decodeChunkForm(world, form, all(world));
  assert.deepEqual(back.present, state.present);
  for (const name of ["id", "temp", "solid", "h", "name", "blob"]) {
    assert.deepEqual(back.columns[name], state.columns[name].map((v, i) => (state.present[i] ? v : null)), name);
  }
  assert.ok(Number.isNaN(back.columns.d[5] as number));
  assert.equal(back.columns.d[0], -0.25);
  assert.equal((back.columns.mask[0] as ChunkBits).toString(), "101");
  assert.equal((back.columns.mask[15] as ChunkBits).toString(), "011");
  assert.equal(back.columns.mask[5], null);
  // u10 values pack at 10 bits each: block 15 holds bits 150..159 of the id
  // section, which starts after the versions and presence (byte 18).
  const fixed = parseSectionedForm(form).sections.get(FormSection.fixed)!;
  assert.equal(((fixed[18] | (fixed[19] << 8)) >> 6) & 0x3ff, 512);
  assert.equal((fixed[0] | (fixed[1] << 8)) & 0x3ff, 1023);
});

test("COLUMNS forms hold the named sections in the named order", () => {
  const state = emptyChunk(world.schema);
  state.present[1] = true;
  for (const name of Object.keys(state.columns)) {
    state.columns[name][1] = { id: 4, temp: -1, solid: false, h: 0, d: 0, mask: ChunkBits.from("111"), name: "ab", blob: Uint8Array.of(1) }[name] ?? null;
  }
  const form = encodeSectionedChunk(world, state, [1, 0, 6]);
  const decoded = decodeChunkForm(world, form, [1, 0, 6]);
  assert.deepEqual(Object.keys(decoded.columns), ["temp", "id", "name"]);
  assert.deepEqual(decoded.columns.temp.slice(0, 2), [null, -1]);
  assert.deepEqual(decoded.columns.id.slice(0, 2), [null, 4]);
  assert.deepEqual(decoded.columns.name.slice(0, 2), [null, "ab"]);
});

test("NULL and empty values of text and bytes columns", () => {
  const state = emptyChunk(world.schema);
  state.present[0] = true;
  state.columns.id[0] = 1;
  state.columns.solid[0] = false;
  state.columns.h[0] = 0;
  state.columns.d[0] = 0;
  state.columns.name[0] = null;
  // An empty value in a column that cannot be NULL is no entry.
  state.columns.blob[0] = Buffer.alloc(0);
  const form = encodeChunkForm(world, state);
  assert.equal(form.length, 232 + 2 + 20 + 18 + 2 + 64 + 128 + 8);
  const back = decodeChunkForm(world, form, all(world));
  assert.equal(back.columns.name[0], null);
  assert.deepEqual(back.columns.blob[0], Buffer.alloc(0));
  // An empty value of a NULL column is an entry and stays empty, not NULL.
  state.columns.name[0] = "";
  assert.equal(decodeChunkForm(world, encodeChunkForm(world, state), all(world)).columns.name[0], "");
});

test("encoding checks the state against the schema", () => {
  const state = emptyChunk(world.schema);
  state.present[0] = true;
  state.columns.id[0] = 1;
  state.columns.solid[0] = false;
  state.columns.h[0] = 0;
  state.columns.d[0] = 0;
  state.columns.blob[0] = Buffer.alloc(0);
  assert.throws(() => encodeChunkForm(world, { ...state, present: state.present.slice(1) }), /presence differs from geometry/);
  state.columns.id[0] = 1024;
  assert.throws(() => encodeChunkForm(world, state), /holds 0\.\.1023/);
  state.columns.id[0] = null;
  assert.throws(() => encodeChunkForm(world, state), /cannot be NULL/);
  state.columns.id[0] = 1;
  const { name: _dropped, ...withoutName } = state.columns;
  assert.throws(() => encodeChunkForm(world, { present: state.present, columns: withoutName }), /missing block column values for name/);
  assert.throws(() => encodeChunkForm(world, { present: state.present, columns: { ...state.columns, extra: [] } }), /unknown block column extra/);
  // Values of absent blocks are not sent.
  state.columns.id[3] = 99999;
  assert.doesNotThrow(() => encodeChunkForm(world, state));
  const small = layout([column("a", "u8"), column("s", "text(8)")], 1, 2);
  small.schema.options.varMaxChunkBytes = 20;
  assert.throws(
    () => encodeChunkForm(small, { present: [true, true], columns: { a: [1, 2], s: ["12345678", "1"] } }),
    /combined variable storage exceeds chunk limit/,
  );
  assert.equal(chunkFormLimit(small), 64 * 1024 * 1024 + 36 + 72 + 1 + 2 + 28);
});

test("text and bytes entries are matched to columns by their DESCRIBE ids", () => {
  // The server's form after `ALTER TABLE w DROP COLUMN s` and `ADD COLUMN t
  // text(4)` on the table above: b keeps id 3, t gets id 4, while their
  // positions are 2 and 3.
  const altered = layout([column("a", "u8"), column("b", "bytes(4)"), column("t", "text(4)")], 2, 2, [1, 3, 4]);
  altered.schema.version = 3;
  const form = encodeSectionedChunk(altered, { present: [true, true, false, false], columns: { a: [1, 0, null, null], b: [Buffer.from("Z"), Buffer.alloc(0), null, null], t: ["", "q", null, null] } }, all(altered), { version: 0x4001n });
  const decoded = decodeChunkForm(altered, form, [0, 1, 2]);
  assert.equal(decoded.version, 0x4001n);
  assert.equal(decoded.schemaVersion, 3);
  assert.deepEqual(decoded.present, [true, true, false, false]);
  assert.deepEqual(decoded.columns.a, [1, 0, null, null]);
  assert.deepEqual(decoded.columns.b, [Buffer.from("Z"), Buffer.alloc(0), null, null]);
  assert.deepEqual(decoded.columns.t, ["", "q", null, null]);
  assert.deepEqual(encodeChunkForm(altered, decoded), Buffer.concat([form.subarray(0, 8), Buffer.alloc(8), form.subarray(16, 24), Buffer.alloc(8), form.subarray(32)]));
  // Ids by position would put Z in t: an id the schema does not name means
  // the cached schema is out of date.
  const byPosition = layout(altered.schema.columns, 2, 2, [1, 2, 3]);
  byPosition.schema.version = 3;
  assert.throws(() => decodeChunkForm(byPosition, form, [0, 1, 2]), /unknown or absent variable entry/);
});

test("a form that does not fit the schema is refused", () => {
  const w = layout([column("a", "u8")], 2, 2);
  const empty = encodeChunkForm(w, emptyChunk(w.schema));
  assert.throws(() => decodeChunkForm(w, Buffer.alloc(8), [0]), ChunkProtocolError);
  assert.deepEqual(decodeChunkForm(w, empty, [0]).columns.a, [null, null, null, null]);
  for (const broken of [empty.subarray(0, 40), Buffer.concat([empty, Buffer.from([0])]), Buffer.from(empty)]) {
    if (broken.length === empty.length) broken.writeUInt32LE(0xffff_ffff, 40);
    assert.throws(() => decodeChunkForm(w, broken, [0]), ChunkProtocolError);
  }
});
