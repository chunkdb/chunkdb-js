// Per-block extra data: one opaque value of 1 or more bits per present block,
// on a table with `extra_max_block_bits` above 0.
//
// A value is `bit_length` bits in `ceil(bit_length / 8)` bytes; bit n is bit
// n % 8 of byte n / 8, least significant first, and padding bits in the last
// byte are zero on output and ignored on input. The EXTRA section of
// `CHUNKGET ... STATE EXTRA` and `CHUNKPUT ... STATE EXTRA` lists a chunk's
// values in strictly ascending block index:
//
//   block_index u32le, bit_length u32le, ceil(bit_length / 8) value bytes

import { ChunkProtocolError } from "./errors";
import type { ChunkExtraValue } from "./types";

// Most bits one value can have: a value that fills a 16 MiB chunk cap.
const EXTRA_MAX_BLOCK_BITS = 134_217_664;
const ENTRY_HEADER_BYTES = 8;

function lastByteMask(bitLength: number): number {
  const used = bitLength % 8;
  return used === 0 ? 0xff : 0xff >> (8 - used);
}

function asBuffer(bytes: Uint8Array): Buffer {
  return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function requestError(message: string, command?: string): ChunkProtocolError {
  return new ChunkProtocolError(command === undefined ? message : `${command} ${message}`, {
    phase: "request",
    command,
  });
}

function responseError(message: string, command?: string): ChunkProtocolError {
  return new ChunkProtocolError(command === undefined ? message : `${command} ${message}`, {
    phase: "protocol",
    command,
  });
}

/** Throws unless `value` holds 1 to EXTRA_MAX_BLOCK_BITS bits in exactly ceil(bitLength / 8) bytes. */
export function checkExtraValue(value: ChunkExtraValue, command?: string): void {
  const { bitLength, bytes } = value;
  if (!Number.isSafeInteger(bitLength) || bitLength < 1 || bitLength > EXTRA_MAX_BLOCK_BITS) {
    throw requestError(`extra data bitLength must be an integer from 1 to ${EXTRA_MAX_BLOCK_BITS}`, command);
  }
  if (!(bytes instanceof Uint8Array)) {
    throw requestError("extra data bytes must be a Uint8Array", command);
  }
  if (bytes.length !== Math.ceil(bitLength / 8)) {
    throw requestError(
      `extra data of ${bitLength} bits takes ${Math.ceil(bitLength / 8)} bytes, got ${bytes.length}`,
      command,
    );
  }
}

function checkBlockCount(blockCount: number): void {
  if (!Number.isSafeInteger(blockCount) || blockCount < 1) {
    throw new TypeError("blockCount must be a positive integer");
  }
}

/**
 * The EXTRA section of a chunk with `blockCount` blocks
 * (`chunkWidthBlocks * chunkHeightBlocks`) from its values by block index.
 * Padding bits are written as zero.
 */
export function encodeExtraSection(extra: ReadonlyMap<number, ChunkExtraValue>, blockCount: number): Buffer {
  checkBlockCount(blockCount);
  return encodeSection(extra, blockCount);
}

/**
 * The values by block index in the EXTRA section of a chunk with
 * `blockCount` blocks. Throws a `ChunkProtocolError` for an entry past the
 * end of the section, block indexes out of range or not strictly ascending,
 * a 0-bit value, or set padding bits. The values' bytes are views of
 * `section`.
 */
export function decodeExtraSection(section: Uint8Array, blockCount: number): Map<number, ChunkExtraValue> {
  checkBlockCount(blockCount);
  return decodeSection(section, blockCount);
}

export function encodeSection(
  extra: ReadonlyMap<number, ChunkExtraValue>,
  blockCount: number,
  command?: string,
): Buffer {
  const entries = [...extra.entries()];
  let size = 0;
  for (const [blockIndex, value] of entries) {
    if (!Number.isSafeInteger(blockIndex) || blockIndex < 0 || blockIndex >= blockCount) {
      throw requestError(`extra data block index must be an integer from 0 to ${blockCount - 1}, got ${blockIndex}`, command);
    }
    checkExtraValue(value, command);
    size += ENTRY_HEADER_BYTES + value.bytes.length;
  }
  entries.sort((a, b) => a[0] - b[0]);
  const out = Buffer.alloc(size);
  let at = 0;
  for (const [blockIndex, { bitLength, bytes }] of entries) {
    out.writeUInt32LE(blockIndex, at);
    out.writeUInt32LE(bitLength, at + 4);
    out.set(bytes, at + ENTRY_HEADER_BYTES);
    at += ENTRY_HEADER_BYTES + bytes.length;
    out[at - 1] &= lastByteMask(bitLength);
  }
  return out;
}

export function decodeSection(
  section: Uint8Array,
  blockCount: number,
  command?: string,
): Map<number, ChunkExtraValue> {
  const data = asBuffer(section);
  const extra = new Map<number, ChunkExtraValue>();
  let previous = -1;
  let at = 0;
  while (at < data.length) {
    if (data.length - at < ENTRY_HEADER_BYTES) {
      throw responseError("extra data entry header extends past the section", command);
    }
    const blockIndex = data.readUInt32LE(at);
    const bitLength = data.readUInt32LE(at + 4);
    if (blockIndex >= blockCount) {
      throw responseError(`extra data for block index ${blockIndex}, the chunk has ${blockCount} blocks`, command);
    }
    if (blockIndex <= previous) {
      throw responseError(`extra data block indexes are not strictly ascending (${blockIndex} after ${previous})`, command);
    }
    if (bitLength === 0) {
      throw responseError(`extra data of block index ${blockIndex} has 0 bits`, command);
    }
    const valueBytes = Math.ceil(bitLength / 8);
    const begin = at + ENTRY_HEADER_BYTES;
    if (data.length - begin < valueBytes) {
      throw responseError("extra data value extends past the section", command);
    }
    const bytes = data.subarray(begin, begin + valueBytes);
    if ((bytes[valueBytes - 1] & ~lastByteMask(bitLength)) !== 0) {
      throw responseError(`extra data of block index ${blockIndex} has set bits past its bit length`, command);
    }
    extra.set(blockIndex, { bitLength, bytes });
    previous = blockIndex;
    at = begin + valueBytes;
  }
  return extra;
}

// An XGET reply: bit_length u32le, then the value bytes.
export function decodeExtraValue(reply: Buffer, command: string): ChunkExtraValue {
  if (reply.length < 4) {
    throw responseError(`returned ${reply.length} bytes, expected at least 4`, command);
  }
  const bitLength = reply.readUInt32LE(0);
  const bytes = reply.subarray(4);
  if (bitLength === 0 || bytes.length !== Math.ceil(bitLength / 8)) {
    throw responseError(`returned ${bytes.length} value bytes for ${bitLength} bits`, command);
  }
  if ((bytes[bytes.length - 1] & ~lastByteMask(bitLength)) !== 0) {
    throw responseError("returned set bits past the value's bit length", command);
  }
  return { bitLength, bytes };
}

// A history event's extra data: `<bit_length>:<hex>`.
export function decodeExtraText(text: string, command: string): ChunkExtraValue {
  const match = /^([0-9]+):((?:[0-9a-fA-F]{2})+)$/.exec(text);
  const bitLength = match === null ? 0 : Number(match[1]);
  if (match === null || !Number.isSafeInteger(bitLength) || bitLength < 1 || bitLength > EXTRA_MAX_BLOCK_BITS) {
    throw responseError(`returned invalid extra data: ${text}`, command);
  }
  const bytes = Buffer.from(match[2], "hex");
  if (bytes.length !== Math.ceil(bitLength / 8)) {
    throw responseError(`returned ${bytes.length} extra data bytes for ${bitLength} bits`, command);
  }
  if ((bytes[bytes.length - 1] & ~lastByteMask(bitLength)) !== 0) {
    throw responseError("returned extra data with set bits past its bit length", command);
  }
  return { bitLength, bytes };
}
