import test from "node:test";
import assert from "node:assert/strict";
import { parseFormBlockSpans, parseFormChunkColumns, parseSectionedForm, serializeSectionedForm } from "../src/chunk-sections";
import { decodeSectionedChunk, encodeSectionedChunk, sectionedBlockCount } from "../src/sectioned-chunk";
import { parseColumnType } from "../src/values";
import { parseDescribe } from "../src/schema";
import type { TableLayout } from "../src/schema";
import type { ChunkColumn } from "../src/types";
import { parseReply } from "../src/protocol";
import { describeReply } from "./fake-server";

// Literal bytes shared with the C++ and Go contract fixtures.
const golden = Buffer.from("434b4346010000002a0000000000000007000000000000000b0000000000000003000000" +
  "010000004800000001000000020000004900000002000000060000004b00000004000000" + "070b1600000000", "hex");

// Construct malformed inputs without using the validating serializer.
function fixture(sections: Array<[number, Buffer]>): Buffer {
  const data = Buffer.alloc(36 + 12 * sections.length + sections.reduce((n, [, bytes]) => n + bytes.length, 0));
  data.write("CKCF");
  data.writeUInt16LE(1, 4);
  data.writeBigUInt64LE(42n, 8);
  data.writeBigUInt64LE(7n, 16);
  data.writeBigUInt64LE(11n, 24);
  data.writeUInt16LE(sections.length, 32);
  let offset = 36 + 12 * sections.length;
  for (const [index, [kind, bytes]] of sections.entries()) {
    const at = 36 + 12 * index;
    data.writeUInt16LE(kind, at);
    data.writeUInt32LE(offset, at + 4);
    data.writeUInt32LE(bytes.length, at + 8);
    data.set(bytes, offset);
    offset += bytes.length;
  }
  return data;
}

test("checked envelope matches literal bytes and rejects every truncation", () => {
  const form = parseSectionedForm(golden, golden.length, true);
  assert.deepEqual([form.flags, form.version, form.schemaVersion, form.commitTimeMs], [0, 42n, 7n, 11n]);
  assert.deepEqual(form.sections.get(2), Buffer.from([11, 22]));
  assert.deepEqual(serializeSectionedForm(form, golden.length), golden);
  for (let end = 0; end < golden.length; end += 1) assert.throws(() => parseSectionedForm(golden.subarray(0, end)), `truncation ${end}`);
  assert.throws(() => parseSectionedForm(golden, golden.length - 1));
  assert.throws(() => serializeSectionedForm(form, golden.length - 1));
  for (const [at, value] of [[0, 0xc3], [4, 2], [6, 4], [16, 0], [32, 65], [34, 1], [38, 1], [40, 71], [40, 73], [44, 255], [48, 1], [52, 72], [56, 0]]) {
    const bad = Buffer.from(golden);
    bad[at] = value;
    assert.throws(() => parseSectionedForm(bad), `corruption ${at}=${value}`);
  }
  assert.throws(() => parseSectionedForm(Buffer.concat([golden, Buffer.alloc(1)])));
  for (const flags of [2, 3]) {
    const data = Buffer.from(golden);
    data.writeUInt16LE(flags, 6);
    assert.throws(() => parseSectionedForm(data));
    data.writeBigUInt64LE(0n, 8);
    data.writeBigUInt64LE(0n, 24);
    assert.equal(parseSectionedForm(data).flags, flags);
  }
  const max = Buffer.from(golden);
  for (const at of [8, 16, 24]) max.writeBigUInt64LE(0xffff_ffff_ffff_ffffn, at);
  assert.equal(parseSectionedForm(max).version, 0xffff_ffff_ffff_ffffn);
  assert.deepEqual(serializeSectionedForm(parseSectionedForm(max)), max);
});

test("reads retain bounded unknown sections and writes reject them", () => {
  const data = fixture([[0, Buffer.alloc(0)], [1, Buffer.from([1])], [6, Buffer.alloc(4)], [99, Buffer.from([0xad, 0, 8])]]);
  const form = parseSectionedForm(data);
  assert.deepEqual(form.sections.get(99), Buffer.from([0xad, 0, 8]));
  assert.throws(() => parseSectionedForm(data, undefined, true), /unknown_form_section/);
  assert.throws(() => serializeSectionedForm(form));
  data.writeUInt32LE(0xffff_ffff, 36 + 3 * 12 + 4);
  assert.throws(() => parseSectionedForm(data));
  for (const sections of [[[1, Buffer.from([1])]], [[6, Buffer.alloc(4)]]] as Array<Array<[number, Buffer]>>) {
    assert.throws(() => parseSectionedForm(fixture(sections)));
  }
});

test("block descriptors bound opaque fixed widths and cover each array exactly", () => {
  const spans = Buffer.alloc(4 + 24 * 3);
  spans.writeUInt32LE(3);
  for (const [index, fields] of [[20, 3, 0, 2, 0, 0], [17, 9, 2, 4, 0, 1], [4, 8, 6, 3, 0, 0]].entries()) {
    fields.forEach((v, i) => spans.writeUInt32LE(v, 4 + index * 24 + 4 * i));
  }
  const sections: Array<[number, Buffer]> = [[1, Buffer.from([7])], [2, Buffer.from([0xe9, 1, 0xff, 1, 4, 0, 11, 22, 33])], [3, Buffer.from([5])], [6, spans]];
  const columns = parseFormBlockSpans(parseSectionedForm(fixture(sections)), 3);
  assert.deepEqual(columns.map(({ id, width }) => [id, width]), [[20, 3], [17, 9], [4, 8]]);
  assert.deepEqual(columns[1].validity, Buffer.from([5]));
  const mutations = [
    (s: typeof sections) => { s[0][1][0] = 255; },
    (s: typeof sections) => { s[1][1][1] = 255; },
    (s: typeof sections) => { s[3][1].writeUInt32LE(20, 4 + 24); },
    (s: typeof sections) => { s[3][1].writeUInt32LE(1, 4 + 24 + 8); },
    (s: typeof sections) => { s[3][1].writeUInt32LE(0, 4 + 24 + 20); },
  ];
  for (const change of mutations) {
    const bad: typeof sections = sections.map(([kind, bytes]) => [kind, Buffer.from(bytes)]);
    change(bad);
    assert.throws(() => parseFormBlockSpans(parseSectionedForm(fixture(bad)), 3));
  }
});

test("chunk metadata distinguishes null from empty and validates all offsets", () => {
  const row = Buffer.alloc(4 + 16 * 3 + 2);
  row.writeUInt32LE(3);
  for (const [index, [id, flags, offset, length]] of [[2, 1, 52, 0], [5, 0, 52, 0], [8, 0, 52, 2]].entries()) {
    const at = 4 + 16 * index;
    row.writeUInt32LE(id, at);
    row.writeUInt16LE(flags, at + 4);
    row.writeUInt32LE(offset, at + 8);
    row.writeUInt32LE(length, at + 12);
  }
  row.set([0xc3, 0xa9], 52);
  const read = (body: Buffer) => parseFormChunkColumns(parseSectionedForm(fixture([[1, Buffer.from([0])], [5, body], [6, Buffer.alloc(4)]])));
  assert.deepEqual(read(row).map(({ id, null: nil, value }) => [id, nil, value.length]), [[2, true, 0], [5, false, 0], [8, false, 2]]);
  for (const [at, value] of [[0, 255], [4, 0], [8, 2], [10, 1], [12, 51], [12, 53], [16, 1], [20, 2], [48, 255]]) {
    const bad = Buffer.from(row);
    bad[at] = value;
    assert.throws(() => read(bad), `row corruption ${at}`);
  }
  assert.throws(() => read(Buffer.alloc(0)));
  assert.throws(() => read(Buffer.concat([row, Buffer.alloc(1)])));
});

function column(name: string, typeName: string, nullable = false): ChunkColumn {
  return { name, type: parseColumnType(typeName), typeName, nullable, required: false, default: null };
}

function typedFixture(): { layout: TableLayout; sections: Array<[number, Buffer]> } {
  const spans = Buffer.alloc(76);
  spans.writeUInt32LE(3);
  for (const [i, fields] of [[20, 3, 0, 2, 0, 0], [17, 9, 2, 4, 0, 1], [4, 8, 6, 3, 0, 0]].entries()) {
    fields.forEach((v, j) => spans.writeUInt32LE(v, 4 + 24 * i + 4 * j));
  }
  const base = parseDescribe(parseReply(Buffer.from(describeReply("u8")))!.reply);
  const layout: TableLayout = { schema: { ...base.schema, dims: 2, version: 7, chunk: { width: 3, height: 1 },
    columns: [column("left", "u3"), { ...column("future", "u8", true), type: { kind: "unknown", name: "future" }, typeName: "future" }, column("right", "u8")] }, ids: [20, 17, 4] };
  return { layout, sections: [[1, Buffer.from([7])], [2, Buffer.from([0xe9, 1, 0xff, 1, 6, 0, 11, 22, 33])], [3, Buffer.from([5])], [6, spans], [99, Buffer.from([0xad])]] };
}

test("opaque fixed column preserves typed neighbours and independent descriptor widths", () => {
  const { layout, sections } = typedFixture();
  const input = fixture(sections);
  const state = decodeSectionedChunk(layout, input, [0, 1, 2]);
  assert.deepEqual([state.version, state.schemaVersion, state.commitTimeMs, state.depth], [42n, 7, 11n, 1]);
  assert.deepEqual(state.columns.left, [1, 5, 7]);
  assert.deepEqual(state.columns.right, [11, 22, 33]);
  assert.deepEqual(state.columns.future, [Buffer.from([255, 1]), null, Buffer.from([1, 0])]);
  input[input.length - 1] = 0;
  assert.deepEqual(state.unknownSections?.get(99), Buffer.from([0xad]));
  sections[3][1].writeUInt32LE(4, 8);
  assert.throws(() => decodeSectionedChunk(layout, fixture(sections), [0, 1, 2]), /differs from schema/);
});

test("metadata and block values share the variable budget with exact null and empty costs", () => {
  const { layout, sections } = typedFixture();
  layout.schema.columns.push(column("label", "text(10)", true));
  layout.ids.push(9);
  layout.schema.chunkColumns = [column("status", "u10"), column("title", "text(10)", true), column("empty", "bytes(3)")];
  layout.chunkColumnIds = [2, 7, 8];
  const vars = Buffer.alloc(14);
  vars.writeUInt32LE(9);
  vars.writeUInt32LE(2, 8);
  vars.write("hi", 12);
  const row = Buffer.alloc(54);
  row.writeUInt32LE(3);
  for (const [i, [id, offset, length]] of [[2, 52, 2], [7, 54, 0], [8, 54, 0]].entries()) {
    const at = 4 + 16 * i;
    row.writeUInt32LE(id, at);
    row.writeUInt32LE(offset, at + 8);
    row.writeUInt32LE(length, at + 12);
  }
  row[52] = 3;
  const all: Array<[number, Buffer]> = [sections[0], sections[1], sections[2], [4, vars], [5, row], sections[3]];
  layout.schema.options.varMaxChunkBytes = 26;
  const read = () => decodeSectionedChunk(layout, fixture(all), [0, 1, 2, 3]);
  assert.deepEqual(read().metadata, { status: 3, title: "", empty: Buffer.alloc(0) });
  assert.equal(read().columns.label[0], "hi");
  layout.schema.options.varMaxChunkBytes = 25;
  assert.deepEqual(read().metadata, { status: 3, title: "", empty: Buffer.alloc(0) });
  row.writeUInt16LE(1, 24);
  layout.schema.options.varMaxChunkBytes = 14;
  assert.equal(read().metadata?.title, null);
  vars[13] = 255;
  assert.throws(read, /UTF-8/);
});

test("three dimensional geometry and schema preserve the third axis and metadata ids", () => {
  const description = parseReply(Buffer.from(describeReply("u8")))!.reply;
  assert.equal(description.type, "map");
  const bulk = (value: string) => ({ type: "bulk" as const, value: Buffer.from(value) });
  const integer = (value: number) => ({ type: "integer" as const, value: BigInt(value) });
  description.entries.push([bulk("dims"), integer(3)]);
  for (const [name, size] of [["chunk", [2, 2, 2]], ["large", [1_000_000, 8, 8]]] as const) {
    const entry = description.entries.find(([key]) => key.type === "bulk" && key.value.toString() === name)!;
    entry[1] = { type: "array", items: size.map(integer) };
  }
  const layout = parseDescribe(description);
  assert.equal(layout.schema.chunk.depth, 2);
  assert.equal(layout.schema.large.depth, 8);
  assert.equal(layout.schema.large.width, 1_000_000);
  assert.equal(sectionedBlockCount(layout), 8);
  layout.schema.chunk.depth = 0;
  assert.throws(() => sectionedBlockCount(layout));
});

test("stored variable rows use the combined hard limit after lowering the write quota", () => {
  const hard = 64 * 1024 * 1024;
  const { layout } = typedFixture();
  layout.schema.chunk = { width: 1, height: 1 };
  layout.schema.columns = [column("n", "u1"), column("data", `bytes(${hard})`)];
  layout.ids = [1, 2];
  layout.schema.chunkColumns = [column("title", "bytes(1)", true)];
  layout.chunkColumnIds = [3];
  layout.schema.options.varMaxChunkBytes = 25;
  const spans = Buffer.alloc(28);
  [1, 1, 1, 0, 1, 0, 0].forEach((value, i) => spans.writeUInt32LE(value, i * 4));
  const vars = Buffer.alloc(hard - 12);
  vars.writeUInt32LE(2);
  vars.writeUInt32LE(vars.length - 12, 8);
  const row = Buffer.alloc(20);
  row.writeUInt32LE(1);
  row.writeUInt32LE(3, 4);
  row.writeUInt32LE(20, 12);
  const sections: Array<[number, Buffer]> = [[1, Buffer.from([1])], [2, Buffer.from([0])], [4, vars], [5, row], [6, spans]];
  const exact = decodeSectionedChunk(layout, fixture(sections), [0, 1]);
  assert.equal((exact.columns.data[0] as Buffer).length, hard - 24);
  const largerRow = Buffer.concat([row, Buffer.from([0])]);
  largerRow.writeUInt32LE(1, 16);
  sections[3][1] = largerRow;
  assert.throws(() => decodeSectionedChunk(layout, fixture(sections), [0, 1]), /hard byte limit/);
  sections[2][1] = Buffer.alloc(hard + 1);
  assert.throws(() => decodeSectionedChunk(layout, fixture(sections), [0, 1]), /hard byte limit/);
});

test("three dimensional encoder matches literal x-fastest bytes", () => {
  const { layout } = typedFixture();
  layout.schema.dims = 3;
  layout.schema.chunk = { width: 2, height: 2, depth: 2 };
  layout.schema.columns = [column("n", "u8")];
  layout.ids = [1];
  const state = { present: [false, false, false, false, false, true, false, false], columns: { n: [null, null, null, null, null, 9, null, null] } };
  const expected = fixture([[1, Buffer.from([0x20])], [2, Buffer.from([0, 0, 0, 0, 0, 9, 0, 0])],
    [6, Buffer.from("01000000010000000800000000000000080000000000000000000000", "hex")]]);
  const encoded = encodeSectionedChunk(layout, state, undefined, { version: 42n, commitTimeMs: 11n });
  assert.deepEqual(encoded, expected);
  assert.equal(decodeSectionedChunk(layout, encoded, [0]).columns.n[5], 9);
});

test("metadata encoder resolves omitted defaults and preserves explicit NULL and empty", () => {
  const { layout } = typedFixture();
  layout.schema.chunk = { width: 1, height: 1 };
  layout.schema.columns = [column("n", "u8")];
  layout.ids = [1];
  layout.schema.chunkColumns = [{ ...column("title", "text(10)", true), default: "base" }, column("status", "u10"), column("empty", "bytes(3)")];
  layout.chunkColumnIds = [7, 2, 8];
  const state = { present: [true], columns: { n: [4] } };
  const read = (metadata?: Record<string, null | string | number>) => decodeSectionedChunk(layout, encodeSectionedChunk(layout, { ...state, metadata }), [0]);
  assert.deepEqual(read().metadata, { status: 0, title: "base", empty: Buffer.alloc(0) });
  assert.equal(read({ title: null }).metadata?.title, null);
  assert.equal(read({ title: "" }).metadata?.title, "");
  layout.schema.options.varMaxChunkBytes = 11;
  assert.throws(() => read({ title: "" }), /combined variable storage/);
  layout.schema.options.varMaxChunkBytes = 12;
  assert.equal(read({ title: "" }).metadata?.title, "");
  const row = parseFormChunkColumns(parseSectionedForm(encodeSectionedChunk(layout, { ...state, metadata: { title: "", status: 3 } })));
  assert.deepEqual(row[0].value, Buffer.from([3, 0]));
  layout.schema.chunkColumns[0].required = true;
  layout.schema.chunkColumns[0].default = null;
  assert.throws(() => read(), /REQUIRED/);
  assert.equal(read({ title: null }).metadata?.title, null);
  assert.throws(() => encodeSectionedChunk(layout, { ...state, unknownSections: new Map([[99, Buffer.from([1])]]) }), /unknown_form_section/);
});

test("section values retain prototype-named columns as own fields", () => {
  const { layout } = typedFixture();
  layout.schema.chunk = { width: 1, height: 1 };
  layout.schema.columns = [column("__proto__", "u8")];
  layout.ids = [1];
  layout.schema.chunkColumns = [column("__proto__", "text(8)")];
  layout.chunkColumnIds = [1];
  const state = { present: [true], columns: Object.fromEntries([["__proto__", [8]]]), metadata: Object.fromEntries([["__proto__", "safe"]]) };
  const decoded = decodeSectionedChunk(layout, encodeSectionedChunk(layout, state), [0]);
  assert.equal(Object.hasOwn(decoded.columns, "__proto__"), true);
  assert.deepEqual(decoded.columns.__proto__, [8]);
  assert.equal(Object.hasOwn(decoded.metadata!, "__proto__"), true);
  assert.equal(decoded.metadata!.__proto__, "safe");
  assert.equal(Object.getPrototypeOf(decoded.metadata), Object.prototype);
});

test("block-only mutations preserve required metadata even when selecting every block column", () => {
  const { layout } = typedFixture();
  layout.schema.chunk = { width: 1, height: 1 };
  layout.schema.columns = [column("n", "u8")];
  layout.ids = [1];
  layout.schema.chunkColumns = [{ ...column("title", "text(8)"), required: true }];
  layout.chunkColumnIds = [2];
  const bytes = encodeSectionedChunk(layout, { present: [true], columns: { n: [9] } }, [0], {}, "preserve");
  const form = parseSectionedForm(bytes, undefined, true);
  assert.equal(form.flags, 1);
  assert.equal(form.sections.has(5), false);
  assert.deepEqual(parseFormBlockSpans(form, 1)[0].values, Buffer.from([9]));
  assert.throws(() => decodeSectionedChunk(layout, bytes, [0]), /metadata differs from schema/);
});

test("dense decoded cells are admitted before arrays and respect projections", () => {
  const { layout } = typedFixture();
  layout.schema.chunk = { width: 4096, height: 2 };
  layout.schema.chunkColumns = [];
  layout.schema.columns = Array.from({ length: 513 }, (_, i) => column(`v${i}`, "text(8)", true));
  layout.ids = layout.schema.columns.map((_, i) => i + 1);
  const input = fixture([[1, Buffer.alloc(1024)], [6, Buffer.alloc(4)]]);
  assert.throws(() => decodeSectionedChunk(layout, input, layout.ids.map((_, i) => i)), /column values/);
  input.writeUInt16LE(1, 6);
  const projected = decodeSectionedChunk(layout, input, [0]);
  assert.deepEqual(Object.keys(projected.columns), ["v0"]);
  assert.equal(projected.columns.v0.length, 8192);
});
