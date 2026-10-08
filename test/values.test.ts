import test from "node:test";
import assert from "node:assert/strict";

import { ChunkBits, ChunkProtocolError, encodeParameter, formatColumnType, parseColumnType } from "../src/index";
import type { ChunkColumn, ChunkColumnType, ChunkValue } from "../src/index";
import { formatLiteral, valueFromReply } from "../src/values";

function column(typeName: string, nullable = false): ChunkColumn {
  const type = parseColumnType(typeName);
  return { name: "c", type, typeName: formatColumnType(type), nullable, required: false, default: null };
}

function hex(bytes: Uint8Array | null): string | null {
  return bytes === null ? null : Buffer.from(bytes).toString("hex");
}

test("column types parse and format", () => {
  const cases: Array<[string, ChunkColumnType]> = [
    ["u1", { kind: "u", bits: 1 }],
    ["u64", { kind: "u", bits: 64 }],
    ["i2", { kind: "i", bits: 2 }],
    ["i64", { kind: "i", bits: 64 }],
    ["bool", { kind: "bool" }],
    ["f32", { kind: "f32" }],
    ["f64", { kind: "f64" }],
    ["bits(16)", { kind: "bits", length: 16 }],
    ["text(256)", { kind: "text", maxBytes: 256 }],
    ["bytes(4)", { kind: "bytes", maxBytes: 4 }],
  ];
  for (const [text, type] of cases) {
    assert.deepEqual(parseColumnType(text), type, text);
    assert.equal(formatColumnType(type), text);
  }
  assert.deepEqual(parseColumnType("TEXT( 8 )"), { kind: "text", maxBytes: 8 });
  for (const bad of ["u0", "u65", "i1", "bits(0)", "text", "f16", "x8", "text(-1)"]) {
    assert.throws(() => parseColumnType(bad), RangeError, bad);
  }
});

test("integer parameters are 8 bytes little-endian, range-checked by the column", () => {
  assert.equal(hex(encodeParameter(column("u10"), 7)), "0700000000000000");
  assert.equal(hex(encodeParameter(column("u10"), 1023n)), "ff03000000000000");
  assert.equal(hex(encodeParameter(column("i8"), -100)), "9cffffffffffffff");
  assert.equal(hex(encodeParameter(column("u64"), (1n << 64n) - 1n)), "ffffffffffffffff");
  assert.equal(hex(encodeParameter(column("i64"), -(1n << 63n))), "0000000000000080");
  for (const [type, value] of [
    ["u10", 1024],
    ["u10", -1],
    ["i8", 128],
    ["i8", -129],
    ["u64", 1n << 64n],
    ["i64", 1n << 63n],
    ["u8", 1.5],
    ["u64", 2 ** 60],
    ["u8", "1"],
    ["u8", true],
  ] as Array<[string, ChunkValue]>) {
    assert.throws(() => encodeParameter(column(type), value), ChunkProtocolError, `${type} ${String(value)}`);
  }
});

test("bool, float, bits, text and bytes parameters", () => {
  assert.equal(hex(encodeParameter(column("bool"), true)), "01");
  assert.equal(hex(encodeParameter(column("bool"), false)), "00");
  assert.throws(() => encodeParameter(column("bool"), 1), ChunkProtocolError);
  assert.equal(hex(encodeParameter(column("f32"), 2.5)), "00002040");
  assert.equal(hex(encodeParameter(column("f64"), 0.25)), "000000000000d03f");
  assert.equal(hex(encodeParameter(column("f32"), Number.NEGATIVE_INFINITY)), "000080ff");
  assert.equal(hex(encodeParameter(column("f64"), Number.NaN))?.length, 16);
  assert.throws(() => encodeParameter(column("f32"), 1e39), /does not hold/);
  assert.equal(hex(encodeParameter(column("f64"), 1e39)), Buffer.from(new Float64Array([1e39]).buffer).toString("hex"));
  assert.equal(hex(encodeParameter(column("bits(3)"), ChunkBits.from("101"))), "05");
  assert.equal(hex(encodeParameter(column("bits(12)"), ChunkBits.from("101000000001"))), "0508");
  assert.throws(() => encodeParameter(column("bits(3)"), ChunkBits.from("1")), /takes 3 bits/);
  assert.throws(() => encodeParameter(column("bits(3)"), "101"), /ChunkBits/);
  assert.equal(hex(encodeParameter(column("text(8)"), "h\ri")), "680d69");
  assert.equal(hex(encodeParameter(column("text(5)"), "é€")), "c3a9e282ac");
  assert.throws(() => encodeParameter(column("text(4)"), "€€"), /at most 4 bytes/);
  assert.throws(() => encodeParameter(column("text(4)"), "\ud800"), /lone surrogate/);
  assert.equal(hex(encodeParameter(column("bytes(4)"), Uint8Array.of(0, 13, 10, 255))), "000d0aff");
  assert.throws(() => encodeParameter(column("bytes(2)"), Uint8Array.of(1, 2, 3)), /at most 2 bytes/);
});

test("NULL is a null frame, only for a NULL column", () => {
  assert.equal(encodeParameter(column("i8", true), null), null);
  assert.equal(encodeParameter(column("text(4)", true), null), null);
  assert.throws(() => encodeParameter(column("i8"), null), /cannot be NULL/);
});

test("reply values are read by the column type", () => {
  assert.equal(valueFromReply(column("u10"), { type: "integer", value: 5n }), 5);
  assert.equal(valueFromReply(column("i8"), { type: "integer", value: -3n }), -3);
  // Columns wider than a safe integer read as bigints, whatever the value.
  assert.equal(valueFromReply(column("u64"), { type: "integer", value: 7n }), 7n);
  assert.equal(valueFromReply(column("u64"), { type: "integer", value: (1n << 64n) - 1n }), (1n << 64n) - 1n);
  assert.equal(valueFromReply(column("i54"), { type: "integer", value: -(1n << 53n) }), -(1n << 53n));
  assert.equal(valueFromReply(column("u53"), { type: "integer", value: 2n ** 53n - 1n }), 2 ** 53 - 1);
  assert.equal(valueFromReply(column("bool"), { type: "boolean", value: true }), true);
  // f32 values are the f32 nearest the server's shortest decimal.
  assert.equal(valueFromReply(column("f32"), { type: "double", value: 0.1 }), Math.fround(0.1));
  assert.equal(valueFromReply(column("f64"), { type: "double", value: 0.1 }), 0.1);
  assert.equal(valueFromReply(column("f64"), { type: "double", value: Number.NEGATIVE_INFINITY }), Number.NEGATIVE_INFINITY);
  assert.equal(valueFromReply(column("text(4)"), { type: "bulk", value: Buffer.from("it's") }), "it's");
  assert.deepEqual(valueFromReply(column("bytes(4)"), { type: "bulk", value: Buffer.from([0, 255]) }), Buffer.from([0, 255]));
  const bits = valueFromReply(column("bits(3)"), { type: "bulk", value: Buffer.from([5]) });
  assert.ok(bits instanceof ChunkBits && bits.toString() === "101");
  assert.equal(valueFromReply(column("i8", true), { type: "null" }), null);
  // A reply that does not fit the column means the schema changed.
  assert.throws(() => valueFromReply(column("u8"), { type: "bulk", value: Buffer.from("x") }), ChunkProtocolError);
  assert.throws(() => valueFromReply(column("bits(9)"), { type: "bulk", value: Buffer.from([1]) }), ChunkProtocolError);
});

test("ChunkBits holds bits lowest first", () => {
  const bits = ChunkBits.from("1011001110110011");
  assert.equal(bits.length, 16);
  assert.equal(bits.toString(), "1011001110110011");
  assert.deepEqual(Buffer.from(bits.toBytes()), Buffer.from([0xcd, 0xcd]));
  assert.ok(bits.get(0) && !bits.get(1));
  bits.set(1, true);
  assert.equal(bits.toString().slice(0, 2), "11");
  assert.ok(new ChunkBits(3, Uint8Array.of(5)).equals(ChunkBits.from("101")));
  assert.throws(() => new ChunkBits(3, Uint8Array.of(8)), /past bit 2/);
  assert.throws(() => new ChunkBits(9, Uint8Array.of(1)), /take 2 bytes/);
  assert.throws(() => ChunkBits.from("12"), RangeError);
  assert.throws(() => bits.get(16), RangeError);
});

test("DEFAULT literals", () => {
  assert.equal(formatLiteral(null), "NULL");
  assert.equal(formatLiteral(true), "TRUE");
  assert.equal(formatLiteral(-12), "-12");
  assert.equal(formatLiteral(18446744073709551615n), "18446744073709551615");
  assert.equal(formatLiteral(1.5), "1.5");
  assert.equal(formatLiteral(2e-7), "2e-7");
  assert.equal(formatLiteral(Number.NaN), "nan");
  assert.equal(formatLiteral(Number.NEGATIVE_INFINITY), "-inf");
  assert.equal(formatLiteral("it's"), "'it''s'");
  assert.equal(formatLiteral(Uint8Array.of(0x0a, 0x0b, 0xff)), "x'0a0bff'");
  assert.equal(formatLiteral(ChunkBits.from("1010")), "b'1010'");
  assert.throws(() => formatLiteral("a\nb"), /CR or LF/);
});
