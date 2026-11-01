import { ChunkProtocolError, ChunkUnknownColumnTypeError } from "./errors";
import type { TableLayout } from "./schema";
import type { ChunkColumn, ChunkState, ChunkStateInput, ChunkValue } from "./types";
import { ChunkBits, decodeFixedValue, encodeFixedValue, encodeVarValue, fixedWidth, requestError, StaleSchemaError } from "./values";
import { FormFlag, FormSection, parseFormBlockSpans, parseFormChunkColumns, parseSectionedForm, serializeSectionedForm, validFormPadding } from "./chunk-sections";
import type { SectionedForm } from "./chunk-sections";

const MAX_VARIABLE_BYTES = 64 * 1024 * 1024;
const MAX_DECODED_CELLS = 4 * 1024 * 1024;

/** A local materialization refusal after a completely framed response. */
export class AreaDecodeLimitError extends ChunkProtocolError {}

/** Admit a complete typed area before any per-chunk dense arrays are built. */
export function checkAreaDecodedCells(layout: TableLayout, indexes: readonly number[], chunks: number): void {
  const blocks = sectionedBlockCount(layout);
  const cells = blocks * indexes.length + (layout.schema.chunkColumns?.length ?? 0);
  if (!Number.isSafeInteger(chunks) || chunks < 0 || (cells !== 0 && chunks > Math.floor(MAX_DECODED_CELLS / cells))) {
    throw new AreaDecodeLimitError("decoded area exceeds 4194304 column values; select fewer columns, request smaller pages, or read raw forms", { phase: "protocol", command: "GET AREA" });
  }
}

export function sectionedBlockCount(layout: TableLayout): number {
  const { schema } = layout;
  const dims = schema.dims ?? 2;
  const sides = [schema.chunk.width, schema.chunk.height, ...(dims === 3 ? [schema.chunk.depth ?? 0] : [])];
  const count = sides.reduce((a, b) => a * b, 1);
  if ((dims !== 2 && dims !== 3) || sides.some((n) => !Number.isInteger(n) || n <= 0 || n > 4096) || count > 1_048_576 || schema.columns.length > 1024 || (schema.chunkColumns?.length ?? 0) > 1024) {
    throw new ChunkProtocolError("invalid chunk geometry or column count", { phase: "protocol" });
  }
  return count;
}

/** A complete mutation's checked frame bound, including both column domains. */
export function sectionedChunkFormLimit(layout: TableLayout): number {
  const { schema } = layout;
  const blocks = sectionedBlockCount(layout), presence = Math.ceil(blocks / 8);
  let fixed = 0, descriptors = 0, metadata = 0;
  for (const column of schema.columns) {
    if (column.type.kind === "unknown") throw new ChunkUnknownColumnTypeError(
      `cannot size a raw SET CHUNK form: column ${column.name} has unknown type ${column.typeName}; writing requires known column widths`, { phase: "request", command: "SET CHUNK" });
    const width = fixedWidth(column.type);
    if (width !== 0) {
      fixed += Math.ceil(blocks * width / 8) + (column.nullable ? presence : 0);
      descriptors += 1;
    }
  }
  if (fixed > 64 * 1024 * 1024) throw requestError("fixed payload exceeds its hard byte limit", "SET CHUNK");
  for (const column of schema.chunkColumns ?? []) {
    const width = fixedWidth(column.type);
    if (width !== 0) metadata += Math.ceil(width / 8);
  }
  if ((schema.chunkColumns?.length ?? 0) !== 0) metadata += 4 + 16 * schema.chunkColumns!.length;
  const variable = schema.options.varMaxChunkBytes === 0 ? MAX_VARIABLE_BYTES : schema.options.varMaxChunkBytes;
  if (!Number.isSafeInteger(variable) || variable < 0 || variable > MAX_VARIABLE_BYTES) throw requestError("invalid variable byte limit", "SET CHUNK");
  // Only the server knows whether data above a lowered quota is shrinking.
  return 36 + 6 * 12 + presence + fixed + 4 + 24 * descriptors + metadata + MAX_VARIABLE_BYTES;
}

function bit(data: Uint8Array, offset: number): boolean { return ((data[offset >> 3] >> (offset & 7)) & 1) !== 0; }

function packed(data: Buffer, offset: number, width: number): Buffer {
  const bytes = Buffer.alloc(Math.ceil(width / 8));
  for (let i = 0; i < width; i += 1) if (bit(data, offset + i)) bytes[i >> 3] |= 1 << (i & 7);
  return bytes;
}

function bad(reason: string): never { throw new ChunkProtocolError(`chunk form: ${reason}`, { phase: "protocol" }); }

function put<T>(row: Record<string, T>, name: string, value: T): void {
  Object.defineProperty(row, name, { value, enumerable: true, writable: true, configurable: true });
}

function variableValue(column: ChunkColumn, data: Buffer): ChunkValue {
  if (column.type.kind === "unknown") return Buffer.from(data);
  if (column.type.kind !== "text" && column.type.kind !== "bytes") bad("variable value for a fixed column");
  if (data.length > column.type.maxBytes) bad("variable value exceeds column limit");
  if (column.type.kind === "bytes") return Buffer.from(data);
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return bad("invalid UTF-8 value");
  }
}

/** Decode the section contract; public dispatch changes with the server format. */
export function decodeSectionedChunk(layout: TableLayout, input: Uint8Array, indexes: readonly number[]): ChunkState {
  const { schema } = layout;
  const blocks = sectionedBlockCount(layout);
  const form = parseSectionedForm(input);
  if (form.schemaVersion !== BigInt(schema.version)) throw new StaleSchemaError("chunk form schema version mismatch", { phase: "protocol" });
  if ((form.flags & FormFlag.projected) === 0 && (indexes.length !== schema.columns.length || indexes.some((index, i) => index !== i))) bad("full form read as a partial projection");
  if ((form.flags & FormFlag.projected) !== 0 && indexes.length === 0) bad("empty projection");
  const spans = parseFormBlockSpans(form, blocks);
  if ((form.sections.get(FormSection.fixed)?.length ?? 0) + (form.sections.get(FormSection.validity)?.length ?? 0) > 64 * 1024 * 1024) bad("fixed payload exceeds byte limit");
  const vars = form.sections.get(FormSection.variable) ?? Buffer.alloc(0);
  if (vars.length > MAX_VARIABLE_BYTES) bad("variable data exceeds its hard byte limit");
  const byId = new Map(spans.map((span) => [span.id, span]));
  const ids = new Set<number>(), names = new Set<string>();
  const variables = new Map<number, ChunkColumn>();
  let consumed = 0;
  for (const index of indexes) {
    if (!Number.isInteger(index) || index < 0 || index >= schema.columns.length) bad("invalid projection index");
    const column = schema.columns[index], id = layout.ids[index];
    if (!Number.isInteger(id) || id <= 0 || id > 0xffff_ffff || ids.has(id) || names.has(column.name)) bad("duplicate or invalid block column");
    ids.add(id);
    names.add(column.name);
    const span = byId.get(id);
    const width = column.type.kind === "unknown" ? (span?.width ?? 0) : fixedWidth(column.type);
    if (width !== 0) {
      if (span === undefined || span.width !== width || (span.validity.length !== 0) !== column.nullable || spans[consumed]?.id !== id) bad("fixed descriptor differs from schema or projection");
      consumed += 1;
    } else {
      if (span !== undefined) bad("variable column has fixed descriptor");
      variables.set(id, column);
    }
  }
  if (consumed !== spans.length) bad("unexpected fixed descriptors");
  if (indexes.length !== 0 && blocks > Math.floor(MAX_DECODED_CELLS / indexes.length)) {
    bad("decoded chunk exceeds 4194304 column values; select fewer columns or read the raw form");
  }
  const presence = form.sections.get(FormSection.presence)!;
  const present = Array.from({ length: blocks }, (_, i) => bit(presence, i));
  const columns: Record<string, ChunkValue[]> = {};
  for (const index of indexes) {
    const column = schema.columns[index], span = byId.get(layout.ids[index]);
    const values = new Array<ChunkValue>(blocks).fill(null);
    put(columns, column.name, values);
    for (let i = 0; i < blocks; i += 1) {
      if (!present[i]) continue;
      if (span === undefined) {
        if (!column.nullable) values[i] = column.type.kind === "text" ? "" : Buffer.alloc(0);
      } else if (!column.nullable || bit(span.validity, i)) {
        const raw = packed(span.values, i * span.width, span.width);
        values[i] = column.type.kind === "unknown" ? raw : decodeFixedValue(column, raw);
      }
    }
  }
  let variableBytes = vars.length;
  let previousId = 0, previousBlock = -1;
  for (let offset = 0; offset < vars.length;) {
    if (vars.length - offset < 12) bad("truncated variable entry");
    const id = vars.readUInt32LE(offset), block = vars.readUInt32LE(offset + 4), length = vars.readUInt32LE(offset + 8);
    offset += 12;
    if (length > vars.length - offset) bad("truncated variable value");
    const column = variables.get(id);
    if (column === undefined || block >= blocks || !present[block] || id < previousId || (id === previousId && block <= previousBlock) || (length === 0 && !column.nullable)) bad("unordered, unknown or absent variable entry");
    columns[column.name][block] = variableValue(column, vars.subarray(offset, offset + length));
    offset += length;
    previousId = id;
    previousBlock = block;
  }
  const entries = parseFormChunkColumns(form), metadataColumns = schema.chunkColumns ?? [];
  if (entries.length !== metadataColumns.length || metadataColumns.length !== (layout.chunkColumnIds?.length ?? 0)) bad("metadata differs from schema");
  const metadata = new Map<number, ChunkColumn>();
  const metaNames = new Set<string>();
  metadataColumns.forEach((column, index) => {
    const id = layout.chunkColumnIds![index];
    if (!Number.isInteger(id) || id <= 0 || id > 0xffff_ffff || metadata.has(id) || metaNames.has(column.name)) bad("duplicate or invalid chunk column");
    metadata.set(id, column);
    metaNames.add(column.name);
  });
  const row: Record<string, ChunkValue> = {};
  for (const entry of entries) {
    const column = metadata.get(entry.id);
    if (column === undefined || (entry.null && !column.nullable)) bad("invalid chunk column ID or nullability");
    if (entry.null) put(row, column.name, null);
    else if (column.type.kind === "unknown") put(row, column.name, Buffer.from(entry.value));
    else {
      const width = fixedWidth(column.type);
      if (width !== 0) {
        if (!validFormPadding(entry.value, width)) bad("metadata scalar length or padding");
        put(row, column.name, decodeFixedValue(column, entry.value));
      } else {
        put(row, column.name, variableValue(column, entry.value));
        if (column.nullable || entry.value.length !== 0) variableBytes += 12 + entry.value.length;
      }
    }
  }
  // Lowering a write quota does not invalidate previously stored data.
  if (variableBytes > MAX_VARIABLE_BYTES) bad("combined variable storage exceeds its hard byte limit");
  const unknownSections = new Map<number, Uint8Array>();
  for (const [kind, bytes] of form.sections) if (kind < 1 || kind > 6) unknownSections.set(kind, Buffer.from(bytes));
  return { version: form.version, schemaVersion: schema.version, commitTimeMs: form.commitTimeMs,
    projected: (form.flags & FormFlag.projected) !== 0, private: (form.flags & FormFlag.private) !== 0,
    width: schema.chunk.width, height: schema.chunk.height, depth: schema.dims === 3 ? schema.chunk.depth : 1,
    present, columns, metadata: row, unknownSections };
}

function baseline(column: ChunkColumn): ChunkValue {
  if (column.default !== null) return column.default;
  if (column.required) throw requestError(`chunk column ${column.name} is REQUIRED`, "SET CHUNK");
  if (column.nullable) return null;
  switch (column.type.kind) {
    case "text": return "";
    case "bytes": return Buffer.alloc(0);
    case "bits": return new ChunkBits(column.type.length);
    case "bool": return false;
    default: return 0;
  }
}

function scalar(column: ChunkColumn, value: ChunkValue): Buffer | null {
  if (column.type.kind === "unknown") throw requestError(`cannot write unknown type ${column.type.name}`, "SET CHUNK");
  if (value === null) {
    if (!column.nullable) throw requestError(`column ${column.name} cannot be NULL`, "SET CHUNK");
    return null;
  }
  return Buffer.from(fixedWidth(column.type) === 0 ? encodeVarValue(column, value) : encodeFixedValue(column, value));
}

export function encodeSectionedChunk(layout: TableLayout, state: ChunkStateInput,
  indexes: readonly number[] = layout.schema.columns.map((_, i) => i),
  identity: Partial<Pick<SectionedForm, "flags" | "version" | "commitTimeMs">> = {},
  metadataMode: "complete" | "preserve" = "complete"): Buffer {
  const { schema } = layout;
  const blocks = sectionedBlockCount(layout);
  const fail = (reason: string): never => { throw requestError(`chunk form: ${reason}`, "SET CHUNK"); };
  if (state.present.length !== blocks || state.present.some((value) => typeof value !== "boolean")) fail("presence differs from geometry");
  if ((state.unknownSections?.size ?? 0) !== 0) fail("unknown_form_section");
  for (const name of Object.keys(state.columns)) if (!schema.columns.some((column) => column.name === name)) fail(`unknown block column ${name}`);
  const seenIds = new Set<number>(), seenNames = new Set<string>();
  let fixedBytes = 0, fixedCount = 0;
  for (const index of indexes) {
    if (!Number.isInteger(index) || index < 0 || index >= schema.columns.length) fail("invalid projection index");
    const column = schema.columns[index], id = layout.ids[index];
    if (!Number.isInteger(id) || id <= 0 || id > 0xffff_ffff || seenIds.has(id) || seenNames.has(column.name)) fail("invalid or duplicate block column");
    seenIds.add(id);
    seenNames.add(column.name);
    const values = Object.hasOwn(state.columns, column.name) ? state.columns[column.name] : undefined;
    if (values === undefined || values.length !== blocks) fail(`missing block column values for ${column.name}`);
    const width = fixedWidth(column.type);
    if (!Number.isInteger(width) || width < 0 || width > 65535) fail("invalid fixed width");
    if (width !== 0) {
      fixedCount += 1;
      fixedBytes += Math.ceil(blocks * width / 8) + (column.nullable ? Math.ceil(blocks / 8) : 0);
    }
  }
  if (fixedBytes > 64 * 1024 * 1024) fail("fixed payload exceeds byte limit");
  const presence = Buffer.alloc(Math.ceil(blocks / 8));
  state.present.forEach((present, i) => { if (present) presence[i >> 3] |= 1 << (i & 7); });
  const fixed: Buffer[] = [], validity: Buffer[] = [];
  const descriptors = Buffer.alloc(4 + 24 * fixedCount);
  descriptors.writeUInt32LE(fixedCount);
  const variables: Array<{ id: number; block: number; bytes: Buffer }> = [];
  let fixedOffset = 0, validityOffset = 0, descriptorIndex = 0, variableBytes = 0;
  const budget = () => { if (variableBytes > schema.options.varMaxChunkBytes) fail("combined variable storage exceeds chunk limit"); };
  for (const index of indexes) {
    const column = schema.columns[index], id = layout.ids[index], width = fixedWidth(column.type);
    const values = width === 0 ? Buffer.alloc(0) : Buffer.alloc(Math.ceil(blocks * width / 8));
    const nulls = width !== 0 && column.nullable ? Buffer.alloc(presence.length) : Buffer.alloc(0);
    for (let block = 0; block < blocks; block += 1) {
      if (!state.present[block]) continue;
      const bytes = scalar(column, state.columns[column.name][block]);
      if (bytes === null) continue;
      if (width === 0) {
        if (bytes.length === 0 && !column.nullable) continue;
        variableBytes += 12 + bytes.length;
        budget();
        variables.push({ id, block, bytes });
      } else {
        for (let i = 0; i < width; i += 1) if (bit(bytes, i)) values[(block * width + i) >> 3] |= 1 << ((block * width + i) & 7);
        if (column.nullable) nulls[block >> 3] |= 1 << (block & 7);
      }
    }
    if (width !== 0) {
      const at = 4 + 24 * descriptorIndex++;
      [id, width, fixedOffset, values.length, nulls.length === 0 ? 0 : validityOffset, nulls.length].forEach((v, j) => descriptors.writeUInt32LE(v, at + 4 * j));
      fixed.push(values);
      validity.push(nulls);
      fixedOffset += values.length;
      validityOffset += nulls.length;
    }
  }
  const parts: Buffer[] = [];
  for (const { id, block, bytes } of variables.sort((a, b) => a.id - b.id || a.block - b.block)) {
    const header = Buffer.alloc(12);
    header.writeUInt32LE(id);
    header.writeUInt32LE(block, 4);
    header.writeUInt32LE(bytes.length, 8);
    parts.push(header, bytes);
  }
  const metadataColumns = metadataMode === "complete" ? schema.chunkColumns ?? [] : [];
  if (metadataMode === "complete" && metadataColumns.length !== (layout.chunkColumnIds?.length ?? 0)) fail("metadata ids differ from schema");
  if (metadataMode === "complete") for (const name of Object.keys(state.metadata ?? {})) if (!metadataColumns.some((column) => column.name === name)) fail(`unknown chunk column ${name}`);
  const rows = metadataColumns.map((column, i) => ({ column, id: layout.chunkColumnIds![i] })).sort((a, b) => a.id - b.id);
  const rowHeader = Buffer.alloc(4 + 16 * rows.length), rowValues: Buffer[] = [];
  rowHeader.writeUInt32LE(rows.length);
  let previousId = 0, rowOffset = rowHeader.length;
  const metaNames = new Set<string>();
  for (const [i, { column, id }] of rows.entries()) {
    if (!Number.isInteger(id) || id <= previousId || id > 0xffff_ffff || metaNames.has(column.name)) fail("invalid or duplicate chunk column");
    previousId = id;
    metaNames.add(column.name);
    const value = state.metadata !== undefined && Object.hasOwn(state.metadata, column.name) ? state.metadata[column.name] : baseline(column);
    const bytes = scalar(column, value);
    const at = 4 + 16 * i;
    rowHeader.writeUInt32LE(id, at);
    rowHeader.writeUInt16LE(bytes === null ? 1 : 0, at + 4);
    rowHeader.writeUInt32LE(rowOffset, at + 8);
    rowHeader.writeUInt32LE(bytes?.length ?? 0, at + 12);
    if (bytes !== null) {
      if (fixedWidth(column.type) === 0 && (column.nullable || bytes.length !== 0)) {
        variableBytes += 12 + bytes.length;
        budget();
      }
      rowValues.push(bytes);
      rowOffset += bytes.length;
    }
  }
  const sections = new Map<number, Buffer>([[FormSection.presence, presence]]);
  if (fixedOffset !== 0) sections.set(FormSection.fixed, Buffer.concat(fixed));
  if (validityOffset !== 0) sections.set(FormSection.validity, Buffer.concat(validity));
  if (parts.length !== 0) sections.set(FormSection.variable, Buffer.concat(parts));
  if (rows.length !== 0) sections.set(FormSection.metadata, Buffer.concat([rowHeader, ...rowValues]));
  sections.set(FormSection.descriptors, descriptors);
  const projected = metadataMode === "preserve" || indexes.length !== schema.columns.length || indexes.some((index, i) => index !== i);
  const flags = identity.flags ?? (projected ? FormFlag.projected : 0);
  if (projected && (flags & FormFlag.projected) === 0) fail("projection flags differ from columns");
  return serializeSectionedForm({ flags, version: identity.version ?? 0n, schemaVersion: BigInt(schema.version), commitTimeMs: identity.commitTimeMs ?? 0n, sections });
}
