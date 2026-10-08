// The chunk form of `GET CHUNK`, `GET AREA` and `SET CHUNK` (docs/CQL.md,
// "Chunks and areas"; STORAGE_FORMAT.md Section 2): the chunk version (u64
// little-endian), the schema version its columns follow (u64, as DESCRIBE
// reports it), the presence bitmap (one bit per block, lowest bit first),
// per fixed-width column its values (`width` bits per block, lowest bit
// first, padded to a byte) and for a NULL column its validity bits (padded
// to a byte), then the text and bytes values as entries of column id (u32),
// block index (u32), length (u32) and the bytes, in ascending (column id,
// block index).

import { ChunkProtocolError } from "./errors";
import type { TableLayout } from "./schema";
import type { ChunkColumn, ChunkState, ChunkStateInput, ChunkTableSchema, ChunkValue } from "./types";
import {
  StaleSchemaError,
  decodeFixedValue,
  encodeFixedValue,
  encodeVarValue,
  fixedWidth,
  requestError,
} from "./values";

// The chunk version and the schema version.
const HEADER_BYTES = 16;
const ENTRY_HEADER_BYTES = 12;

export function blockCount(layout: TableLayout): number {
  return layout.schema.chunk.width * layout.schema.chunk.height;
}

function presenceBytes(blocks: number): number {
  return Math.ceil(blocks / 8);
}

/** Bytes of a column's part of the payload: its values, then its validity bits. */
function sectionBytes(column: ChunkColumn, blocks: number): number {
  const width = fixedWidth(column.type);
  if (width === 0) {
    return 0;
  }
  return Math.ceil((blocks * width) / 8) + (column.nullable ? Math.ceil(blocks / 8) : 0);
}

/** The largest chunk form `SET CHUNK` takes for this table. */
export function chunkFormLimit(layout: TableLayout): number {
  const blocks = blockCount(layout);
  let payload = 0;
  for (const column of layout.schema.columns) {
    payload += sectionBytes(column, blocks);
  }
  return HEADER_BYTES + presenceBytes(blocks) + payload + layout.schema.options.varMaxChunkBytes;
}

function getBit(data: Uint8Array, bit: number): boolean {
  return ((data[bit >> 3] >> (bit & 7)) & 1) === 1;
}

function setBit(data: Uint8Array, bit: number): void {
  data[bit >> 3] |= 1 << (bit & 7);
}

// `width` bits of `data` from bit `offset`, as ceil(width / 8) bytes.
function readBits(data: Uint8Array, offset: number, width: number): Uint8Array {
  const out = new Uint8Array(Math.ceil(width / 8));
  if ((offset & 7) === 0) {
    out.set(data.subarray(offset >> 3, (offset >> 3) + out.length));
    if ((width & 7) !== 0) {
      out[out.length - 1] &= (1 << (width & 7)) - 1;
    }
    return out;
  }
  for (let i = 0; i < width; i += 1) {
    if (getBit(data, offset + i)) {
      setBit(out, i);
    }
  }
  return out;
}

// Writes `width` bits of `value` to zeroed bits of `data` from bit `offset`.
function writeBits(data: Uint8Array, offset: number, value: Uint8Array, width: number): void {
  if ((offset & 7) === 0 && (width & 7) === 0) {
    data.set(value.subarray(0, width >> 3), offset >> 3);
    return;
  }
  for (let i = 0; i < width; i += 1) {
    if (getBit(value, i)) {
      setBit(data, offset + i);
    }
  }
}

function readU32(data: Uint8Array, at: number): number {
  return (data[at] | (data[at + 1] << 8) | (data[at + 2] << 16) | (data[at + 3] << 24)) >>> 0;
}

/**
 * Decodes a chunk form holding `indexes` (schema indexes, in the order the
 * statement named them).
 */
export function decodeChunkForm(layout: TableLayout, form: Uint8Array, indexes: readonly number[]): ChunkState {
  const { schema } = layout;
  const blocks = blockCount(layout);
  const presenceSize = presenceBytes(blocks);
  const short = (what: string) =>
    new StaleSchemaError(`the chunk form ends inside ${what} (${form.length} bytes)`, { phase: "protocol" });
  if (form.length < HEADER_BYTES + presenceSize) {
    throw short("its header");
  }
  const view = Buffer.from(form.buffer, form.byteOffset, form.byteLength);
  const version = view.readBigUInt64LE(0);
  const schemaVersion = view.readBigUInt64LE(8);
  // A form of another schema version lays its columns out differently.
  if (schemaVersion !== BigInt(schema.version)) {
    throw new StaleSchemaError(
      `the chunk form follows schema version ${schemaVersion}, the cached schema of ${schema.table} is version ${schema.version}`,
      { phase: "protocol" },
    );
  }
  const presence = form.subarray(HEADER_BYTES, HEADER_BYTES + presenceSize);
  const present: boolean[] = [];
  for (let i = 0; i < blocks; i += 1) {
    present.push(getBit(presence, i));
  }
  const columns: Record<string, ChunkValue[]> = {};
  const varColumns: number[] = [];
  let at = HEADER_BYTES + presenceSize;
  for (const index of indexes) {
    const column = schema.columns[index];
    const width = fixedWidth(column.type);
    const values: ChunkValue[] = new Array<ChunkValue>(blocks).fill(null);
    columns[column.name] = values;
    if (width === 0) {
      varColumns.push(index);
      // A present block without an entry holds no value: NULL in a NULL
      // column, the empty value in any other.
      if (!column.nullable) {
        for (let i = 0; i < blocks; i += 1) {
          if (present[i]) {
            values[i] = column.type.kind === "text" ? "" : Buffer.alloc(0);
          }
        }
      }
      continue;
    }
    const size = sectionBytes(column, blocks);
    if (form.length < at + size) {
      throw short(`column ${column.name}`);
    }
    const section = form.subarray(at, at + size);
    const validity = column.nullable ? section.subarray(Math.ceil((blocks * width) / 8)) : null;
    for (let i = 0; i < blocks; i += 1) {
      if (present[i] && (validity === null || getBit(validity, i))) {
        values[i] = decodeFixedValue(column, readBits(section, i * width, width));
      }
    }
    at += size;
  }

  // Entries name their column by its id (DESCRIBE).
  const byId = new Map<number, number>(varColumns.map((index) => [layout.ids[index], index]));
  let previous: [number, number] | null = null;
  while (at < form.length) {
    if (form.length - at < ENTRY_HEADER_BYTES) {
      throw short("a text or bytes entry");
    }
    const id = readU32(form, at);
    const block = readU32(form, at + 4);
    const length = readU32(form, at + 8);
    at += ENTRY_HEADER_BYTES;
    if (form.length - at < length) {
      throw short("a text or bytes value");
    }
    if (previous !== null && (id < previous[0] || (id === previous[0] && block <= previous[1]))) {
      throw new ChunkProtocolError("the chunk form's text and bytes entries are not in ascending order", {
        phase: "protocol",
      });
    }
    previous = [id, block];
    const index = byId.get(id);
    if (index === undefined) {
      throw new StaleSchemaError(`the chunk form holds a value of column id ${id}, which the schema does not name`, {
        phase: "protocol",
      });
    }
    if (block >= blocks || !present[block]) {
      throw new ChunkProtocolError(`the chunk form holds a value of absent block ${block}`, { phase: "protocol" });
    }
    const column = schema.columns[index];
    const bytes = form.subarray(at, at + length);
    columns[column.name][block] = column.type.kind === "text" ? Buffer.from(bytes).toString("utf8") : Buffer.from(bytes);
    at += length;
  }
  return { version, schemaVersion: schema.version, width: schema.chunk.width, height: schema.chunk.height, present, columns };
}

/**
 * The chunk form of `state` for `SET CHUNK`: every column of the schema.
 * Values of absent blocks are not sent.
 */
export function encodeChunkForm(layout: TableLayout, state: ChunkStateInput): Buffer {
  const { schema } = layout;
  const blocks = blockCount(layout);
  if (!Array.isArray(state.present) || state.present.length !== blocks) {
    throw requestError(`a chunk of ${schema.table} has ${blocks} blocks: present needs ${blocks} entries`, "SET CHUNK");
  }
  for (const name of Object.keys(state.columns)) {
    if (!schema.columns.some((column) => column.name === name)) {
      throw new StaleSchemaError(`table ${schema.table} has no column ${name}`, { phase: "request", command: "SET CHUNK" });
    }
  }
  const valuesOf = (column: ChunkColumn): readonly ChunkValue[] => {
    const values = state.columns[column.name];
    if (values === undefined) {
      throw new StaleSchemaError(`the chunk state has no values for column ${column.name}`, {
        phase: "request",
        command: "SET CHUNK",
      });
    }
    if (values.length !== blocks) {
      throw requestError(`column ${column.name} needs ${blocks} values, one per block, got ${values.length}`, "SET CHUNK");
    }
    return values;
  };

  const presence = new Uint8Array(presenceBytes(blocks));
  for (let i = 0; i < blocks; i += 1) {
    if (state.present[i] === true) {
      setBit(presence, i);
    }
  }
  // The chunk version is not read; the schema version must be the table's.
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeBigUInt64LE(BigInt(schema.version), 8);
  const parts: Uint8Array[] = [header, presence];
  const entries: Array<{ id: number; column: ChunkColumn; values: readonly ChunkValue[] }> = [];
  schema.columns.forEach((column, index) => {
    const values = valuesOf(column);
    const width = fixedWidth(column.type);
    if (width === 0) {
      entries.push({ id: layout.ids[index], column, values });
      for (let block = 0; block < blocks; block += 1) {
        if (state.present[block] === true && values[block] === null && !column.nullable) {
          throw requestError(`column ${column.name} (${column.typeName}) cannot be NULL (block ${block})`, "SET CHUNK");
        }
      }
      return;
    }
    const section = new Uint8Array(sectionBytes(column, blocks));
    const validityAt = Math.ceil((blocks * width) / 8) * 8;
    for (let block = 0; block < blocks; block += 1) {
      if (state.present[block] !== true) {
        continue;
      }
      const value = values[block];
      if (value === null) {
        if (!column.nullable) {
          throw requestError(`column ${column.name} (${column.typeName}) cannot be NULL (block ${block})`, "SET CHUNK");
        }
        continue;
      }
      writeBits(section, block * width, encodeFixedValue(column, value), width);
      if (column.nullable) {
        setBit(section, validityAt + block);
      }
    }
    parts.push(section);
  });
  entries.sort((a, b) => a.id - b.id);
  let varBytes = 0;
  for (const { id, column, values } of entries) {
    for (let block = 0; block < blocks; block += 1) {
      const value = values[block];
      if (state.present[block] !== true || value === null) {
        continue;
      }
      const bytes = encodeVarValue(column, value);
      // In a column that cannot be NULL the empty value is no entry.
      if (bytes.length === 0 && !column.nullable) {
        continue;
      }
      const header = Buffer.alloc(ENTRY_HEADER_BYTES);
      header.writeUInt32LE(id, 0);
      header.writeUInt32LE(block, 4);
      header.writeUInt32LE(bytes.length, 8);
      parts.push(header, bytes);
      varBytes += ENTRY_HEADER_BYTES + bytes.length;
    }
  }
  if (varBytes > schema.options.varMaxChunkBytes) {
    throw requestError(
      `the chunk's text and bytes values take ${varBytes} bytes, ${schema.table} holds at most ${schema.options.varMaxChunkBytes}`,
      "SET CHUNK",
    );
  }
  return Buffer.concat(parts);
}

/** A chunk state of `schema`'s table without blocks, to fill and pass to `setChunk`. */
export function emptyChunk(schema: ChunkTableSchema): { present: boolean[]; columns: Record<string, ChunkValue[]> } {
  const blocks = schema.chunk.width * schema.chunk.height;
  const columns: Record<string, ChunkValue[]> = {};
  for (const column of schema.columns) {
    columns[column.name] = new Array<ChunkValue>(blocks).fill(null);
  }
  return { present: new Array<boolean>(blocks).fill(false), columns };
}
