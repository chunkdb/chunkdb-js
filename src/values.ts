import { ChunkProtocolError } from "./errors";
import type { ChunkReply } from "./protocol";
import type { ChunkColumn, ChunkColumnType, ChunkValue } from "./types";

/** A `bits(N)` value: N bits, bit 0 first (as CQL's `b'..'` writes them). */
export class ChunkBits {
  readonly length: number;
  private readonly data: Uint8Array;

  /**
   * `bytes` holds `ceil(length / 8)` bytes, bit `i` in bit `i % 8` of byte
   * `i / 8`; bits past `length` must be zero. Without it every bit is 0.
   */
  constructor(length: number, bytes?: Uint8Array) {
    if (!Number.isSafeInteger(length) || length < 1) {
      throw new RangeError("a bits value has at least one bit");
    }
    const size = Math.ceil(length / 8);
    if (bytes === undefined) {
      this.data = new Uint8Array(size);
    } else {
      if (bytes.length !== size) {
        throw new RangeError(`${length} bits take ${size} bytes, got ${bytes.length}`);
      }
      if (length % 8 !== 0 && bytes[size - 1] >> (length % 8) !== 0) {
        throw new RangeError(`the bytes have bits set past bit ${length - 1}`);
      }
      this.data = Uint8Array.from(bytes);
    }
    this.length = length;
  }

  /** `"1010"`: bit 0 is the first digit. */
  static from(digits: string): ChunkBits {
    if (!/^[01]+$/.test(digits)) {
      throw new RangeError("a bit string holds only 0 and 1");
    }
    const bits = new ChunkBits(digits.length);
    for (let i = 0; i < digits.length; i += 1) {
      if (digits[i] === "1") {
        bits.set(i, true);
      }
    }
    return bits;
  }

  get(index: number): boolean {
    this.check(index);
    return ((this.data[index >> 3] >> (index & 7)) & 1) === 1;
  }

  set(index: number, value: boolean): void {
    this.check(index);
    if (value) {
      this.data[index >> 3] |= 1 << (index & 7);
    } else {
      this.data[index >> 3] &= ~(1 << (index & 7));
    }
  }

  /** A copy of the bytes, as the constructor takes them. */
  toBytes(): Uint8Array {
    return Uint8Array.from(this.data);
  }

  /** The bits as digits, bit 0 first. */
  toString(): string {
    let digits = "";
    for (let i = 0; i < this.length; i += 1) {
      digits += this.get(i) ? "1" : "0";
    }
    return digits;
  }

  equals(other: ChunkBits): boolean {
    return other.length === this.length && other.data.every((byte, i) => byte === this.data[i]);
  }

  private check(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= this.length) {
      throw new RangeError(`bit ${index} is outside 0..${this.length - 1}`);
    }
  }
}

/** Thrown when a reply does not fit the cached schema; the client refreshes it and retries once. */
export class StaleSchemaError extends ChunkProtocolError {}

export function requestError(message: string, command?: string): ChunkProtocolError {
  return new ChunkProtocolError(message, { phase: "request", command });
}

const NAME = /^[a-z_][a-z0-9_]*$/;

/** Table, column and option names: `[a-z_][a-z0-9_]*`. */
export function checkName(name: string, what: string): string {
  if (typeof name !== "string" || !NAME.test(name)) {
    throw requestError(`${what} must match [a-z_][a-z0-9_]*, got ${JSON.stringify(name)}`);
  }
  return name;
}

export function checkCoordinate(value: number, what: string): number {
  if (!Number.isSafeInteger(value)) {
    throw requestError(`${what} must be a safe integer, got ${String(value)}`);
  }
  return value;
}

const MAX_U64 = (1n << 64n) - 1n;

export function checkVersion(version: bigint): bigint {
  if (typeof version !== "bigint" || version < 0n || version > MAX_U64) {
    throw requestError("ifVersion must be a bigint from 0 to 2^64 - 1");
  }
  return version;
}

/** Parses `"u10"`, `"i8"`, `"bool"`, `"f32"`, `"f64"`, `"bits(N)"`, `"text(N)"`, `"bytes(N)"`. */
export function parseColumnType(text: string): ChunkColumnType {
  const word = text.trim().toLowerCase();
  if (word === "bool" || word === "f32" || word === "f64") {
    return { kind: word };
  }
  const integer = /^([ui])([0-9]+)$/.exec(word);
  if (integer !== null) {
    const bits = Number(integer[2]);
    const min = integer[1] === "u" ? 1 : 2;
    if (bits < min || bits > 64) {
      throw new RangeError(`${integer[1]}N takes N from ${min} to 64: ${text}`);
    }
    return { kind: integer[1] === "u" ? "u" : "i", bits };
  }
  const sized = /^(bits|text|bytes)\(\s*([0-9]+)\s*\)$/.exec(word);
  if (sized !== null) {
    const size = Number(sized[2]);
    if (!Number.isSafeInteger(size) || size < 1) {
      throw new RangeError(`${sized[1]}(N) takes N of at least 1: ${text}`);
    }
    if (sized[1] === "bits") {
      return { kind: "bits", length: size };
    }
    return { kind: sized[1] === "text" ? "text" : "bytes", maxBytes: size };
  }
  throw new RangeError(`not a column type: ${text}`);
}

export function formatColumnType(type: ChunkColumnType): string {
  switch (type.kind) {
    case "u":
    case "i":
      return `${type.kind}${type.bits}`;
    case "bool":
    case "f32":
    case "f64":
      return type.kind;
    case "bits":
      return `bits(${type.length})`;
    case "text":
    case "bytes":
      return `${type.kind}(${type.maxBytes})`;
  }
}

/** Bits a value of `type` takes in a chunk's payload; 0 for text and bytes. */
export function fixedWidth(type: ChunkColumnType): number {
  switch (type.kind) {
    case "u":
    case "i":
      return type.bits;
    case "bool":
      return 1;
    case "f32":
      return 32;
    case "f64":
      return 64;
    case "bits":
      return type.length;
    case "text":
    case "bytes":
      return 0;
  }
}

// Integers of more than 53 bits are bigints, so a column's values have one
// JavaScript type.
function isWide(type: ChunkColumnType): boolean {
  return (type.kind === "u" || type.kind === "i") && type.bits > 53;
}

const F32_MAX = 3.4028234663852886e38;
// Code points U+D800..U+DFFF that are not part of a pair.
const LONE_SURROGATE = /\p{Cs}/u;

function describeColumn(column: ChunkColumn): string {
  return `column ${column.name} (${column.typeName})`;
}

/** The integer in `value` for a `uN` or `iN` column, range-checked. */
function integerOf(column: ChunkColumn, bits: number, signed: boolean, value: ChunkValue): bigint {
  let integer: bigint;
  if (typeof value === "bigint") {
    integer = value;
  } else if (typeof value === "number" && Number.isSafeInteger(value)) {
    integer = BigInt(value);
  } else {
    throw requestError(`${describeColumn(column)} takes an integer (a safe-integer number or a bigint)`);
  }
  const min = signed ? -(1n << BigInt(bits - 1)) : 0n;
  const max = signed ? (1n << BigInt(bits - 1)) - 1n : (1n << BigInt(bits)) - 1n;
  if (integer < min || integer > max) {
    throw requestError(`${describeColumn(column)} holds ${min}..${max}, got ${integer}`);
  }
  return integer;
}

/** The UTF-8 bytes of a text value, checked against the column. */
function textBytes(column: ChunkColumn, maxBytes: number, value: ChunkValue): Buffer {
  if (typeof value !== "string") {
    throw requestError(`${describeColumn(column)} takes a string`);
  }
  if (LONE_SURROGATE.test(value)) {
    throw requestError(`${describeColumn(column)}: the string is not valid UTF-16 (a lone surrogate)`);
  }
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > maxBytes) {
    throw requestError(`${describeColumn(column)} holds at most ${maxBytes} bytes, got ${bytes.length}`);
  }
  return bytes;
}

function bytesOf(column: ChunkColumn, maxBytes: number, value: ChunkValue): Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw requestError(`${describeColumn(column)} takes a Uint8Array`);
  }
  if (value.length > maxBytes) {
    throw requestError(`${describeColumn(column)} holds at most ${maxBytes} bytes, got ${value.length}`);
  }
  return value;
}

function bitsOf(column: ChunkColumn, length: number, value: ChunkValue): ChunkBits {
  if (!(value instanceof ChunkBits)) {
    throw requestError(`${describeColumn(column)} takes a ChunkBits`);
  }
  if (value.length !== length) {
    throw requestError(`${describeColumn(column)} takes ${length} bits, got ${value.length}`);
  }
  return value;
}

function floatOf(column: ChunkColumn, f32: boolean, value: ChunkValue): number {
  if (typeof value !== "number") {
    throw requestError(`${describeColumn(column)} takes a number`);
  }
  if (f32 && Number.isFinite(value) && Math.abs(value) > F32_MAX) {
    throw requestError(`${describeColumn(column)} does not hold ${value}`);
  }
  return value;
}

function checkNull(column: ChunkColumn): null {
  if (!column.nullable) {
    throw requestError(`${describeColumn(column)} cannot be NULL`);
  }
  return null;
}

function littleEndian(value: bigint, bytes: number): Buffer {
  const out = Buffer.alloc(bytes);
  let rest = BigInt.asUintN(bytes * 8, value);
  for (let i = 0; i < bytes; i += 1) {
    out[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return out;
}

/**
 * A value as a parameter frame (docs/PROTOCOL.md "Parameters"): `uN` and
 * `iN` 8 bytes little-endian, `bool` 1 byte, `f32` / `f64` IEEE 754
 * little-endian, `bits(N)` `ceil(N / 8)` bytes, text UTF-8, bytes as they
 * are; null for NULL. Throws before anything is sent when the value does not
 * fit the column.
 */
export function encodeParameter(column: ChunkColumn, value: ChunkValue): Uint8Array | null {
  if (value === null) {
    return checkNull(column);
  }
  const type = column.type;
  switch (type.kind) {
    case "u":
    case "i":
      return littleEndian(integerOf(column, type.bits, type.kind === "i", value), 8);
    case "bool":
      if (typeof value !== "boolean") {
        throw requestError(`${describeColumn(column)} takes a boolean`);
      }
      return Buffer.from([value ? 1 : 0]);
    case "f32": {
      const out = Buffer.alloc(4);
      out.writeFloatLE(floatOf(column, true, value));
      return out;
    }
    case "f64": {
      const out = Buffer.alloc(8);
      out.writeDoubleLE(floatOf(column, false, value));
      return out;
    }
    case "bits":
      return bitsOf(column, type.length, value).toBytes();
    case "text":
      return textBytes(column, type.maxBytes, value);
    case "bytes":
      return bytesOf(column, type.maxBytes, value);
  }
}

/**
 * The fixed-width bits of a non-null value: `ceil(width / 8)` bytes, the
 * lowest bit first, as a chunk's payload holds them.
 */
export function encodeFixedValue(column: ChunkColumn, value: ChunkValue): Uint8Array {
  const type = column.type;
  switch (type.kind) {
    case "u":
    case "i":
      return littleEndian(integerOf(column, type.bits, type.kind === "i", value), Math.ceil(type.bits / 8));
    case "bool":
      if (typeof value !== "boolean") {
        throw requestError(`${describeColumn(column)} takes a boolean`);
      }
      return Uint8Array.of(value ? 1 : 0);
    case "f32":
    case "f64":
      return encodeParameter(column, value) as Uint8Array;
    case "bits":
      return bitsOf(column, type.length, value).toBytes();
    case "text":
    case "bytes":
      throw new TypeError(`${describeColumn(column)} is not fixed-width`);
  }
}

/** The bytes of a non-null text or bytes value, checked against the column. */
export function encodeVarValue(column: ChunkColumn, value: ChunkValue): Uint8Array {
  const type = column.type;
  if (type.kind === "text") {
    return textBytes(column, type.maxBytes, value);
  }
  if (type.kind === "bytes") {
    return bytesOf(column, type.maxBytes, value);
  }
  throw new TypeError(`${describeColumn(column)} is not text or bytes`);
}

function integerValue(type: ChunkColumnType, integer: bigint): number | bigint {
  return isWide(type) ? integer : Number(integer);
}

/** A fixed-width value from its payload bits (`ceil(width / 8)` bytes, the lowest bit first). */
export function decodeFixedValue(column: ChunkColumn, bytes: Uint8Array): ChunkValue {
  const type = column.type;
  switch (type.kind) {
    case "u":
    case "i": {
      let raw = 0n;
      for (let i = bytes.length - 1; i >= 0; i -= 1) {
        raw = (raw << 8n) | BigInt(bytes[i]);
      }
      return integerValue(type, type.kind === "i" ? BigInt.asIntN(type.bits, raw) : raw);
    }
    case "bool":
      return bytes[0] === 1;
    case "f32":
      return Buffer.from(bytes.buffer, bytes.byteOffset, 4).readFloatLE(0);
    case "f64":
      return Buffer.from(bytes.buffer, bytes.byteOffset, 8).readDoubleLE(0);
    case "bits":
      return new ChunkBits(type.length, bytes);
    case "text":
    case "bytes":
      throw new TypeError(`${describeColumn(column)} is not fixed-width`);
  }
}

function mismatch(column: ChunkColumn, reply: ChunkReply): StaleSchemaError {
  return new StaleSchemaError(`a ${reply.type} reply does not fit ${describeColumn(column)}`, {
    phase: "protocol",
  });
}

/** A typed reply value read by its column's type. */
export function valueFromReply(column: ChunkColumn, reply: ChunkReply): ChunkValue {
  if (reply.type === "null") {
    return null;
  }
  const type = column.type;
  switch (type.kind) {
    case "u":
    case "i":
      if (reply.type !== "integer") {
        throw mismatch(column, reply);
      }
      return integerValue(type, reply.value);
    case "bool":
      if (reply.type !== "boolean") {
        throw mismatch(column, reply);
      }
      return reply.value;
    case "f32":
    case "f64":
      if (reply.type !== "double") {
        throw mismatch(column, reply);
      }
      // The server writes the shortest text of the f32 value.
      return type.kind === "f32" ? Math.fround(reply.value) : reply.value;
    case "bits":
      if (reply.type !== "bulk" || reply.value.length !== Math.ceil(type.length / 8)) {
        throw mismatch(column, reply);
      }
      return new ChunkBits(type.length, reply.value);
    case "text":
      if (reply.type !== "bulk") {
        throw mismatch(column, reply);
      }
      return reply.value.toString("utf8");
    case "bytes":
      if (reply.type !== "bulk") {
        throw mismatch(column, reply);
      }
      return reply.value;
  }
}

/** A value as a CQL literal, for `DEFAULT` (where parameters are not allowed). */
export function formatLiteral(value: ChunkValue): string {
  if (value === null) {
    return "NULL";
  }
  if (typeof value === "boolean") {
    return value ? "TRUE" : "FALSE";
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "number") {
    if (Number.isNaN(value)) {
      return "nan";
    }
    if (!Number.isFinite(value)) {
      return value > 0 ? "inf" : "-inf";
    }
    return String(value);
  }
  if (typeof value === "string") {
    if (value.includes("\r") || value.includes("\n")) {
      throw requestError("a text literal cannot contain CR or LF; the statement is one line");
    }
    return `'${value.replace(/'/g, "''")}'`;
  }
  if (value instanceof ChunkBits) {
    return `b'${value.toString()}'`;
  }
  return `x'${Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("hex")}'`;
}
