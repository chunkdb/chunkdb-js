import { ChunkProtocolError } from "./errors";

const HEADER_BYTES = 36;
const DIRECTORY_BYTES = 12;
const MAX_FORM_BYTES = 0xffff_ffff;

export const FormSection = { presence: 1, fixed: 2, validity: 3, variable: 4, metadata: 5, descriptors: 6 } as const;
export const FormFlag = { projected: 1, private: 2 } as const;

export interface SectionedForm {
  flags: number;
  version: bigint;
  schemaVersion: bigint;
  commitTimeMs: bigint;
  sections: ReadonlyMap<number, Buffer>;
}

function invalid(reason: string): never {
  throw new ChunkProtocolError(`chunk form: ${reason}`, { phase: "protocol" });
}

function validHeader(form: Omit<SectionedForm, "sections">): boolean {
  const uint64 = (value: bigint) => value >= 0n && value <= 0xffff_ffff_ffff_ffffn;
  return Number.isInteger(form.flags) && form.flags >= 0 && form.flags <= 3 &&
    uint64(form.version) && uint64(form.schemaVersion) && form.schemaVersion !== 0n && uint64(form.commitTimeMs) &&
    ((form.flags & FormFlag.private) === 0 || (form.version === 0n && form.commitTimeMs === 0n));
}

/** Validate the complete directory before returning any payload views. */
export function parseSectionedForm(input: Uint8Array, limit = MAX_FORM_BYTES, mutation = false): SectionedForm {
  if (input.length > Math.min(limit, MAX_FORM_BYTES) || input.length < HEADER_BYTES) invalid("truncated header or byte limit exceeded");
  const data = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (!data.subarray(0, 4).equals(Buffer.from("CKCF")) || data.readUInt16LE(4) !== 1) invalid("unsupported header");
  const header = { flags: data.readUInt16LE(6), version: data.readBigUInt64LE(8), schemaVersion: data.readBigUInt64LE(16), commitTimeMs: data.readBigUInt64LE(24) };
  if (!validHeader(header) || data.readUInt16LE(34) !== 0) invalid("invalid flags, schema or private identity");
  const count = data.readUInt16LE(32);
  let next = HEADER_BYTES + DIRECTORY_BYTES * count;
  if (count > 64 || next > data.length) invalid("invalid section count or truncated directory");
  let previous = -1;
  let presence = false;
  let descriptors = false;
  for (let i = 0; i < count; i += 1) {
    const at = HEADER_BYTES + DIRECTORY_BYTES * i;
    const kind = data.readUInt16LE(at);
    const offset = data.readUInt32LE(at + 4);
    const length = data.readUInt32LE(at + 8);
    if (kind <= previous || data.readUInt16LE(at + 2) !== 0) invalid("unordered kinds or section flags");
    if (offset !== next || length > data.length - next) invalid("invalid section bounds");
    if (mutation && (kind < FormSection.presence || kind > FormSection.descriptors)) invalid("unknown_form_section");
    presence ||= kind === FormSection.presence;
    descriptors ||= kind === FormSection.descriptors;
    previous = kind;
    next += length;
  }
  if (next !== data.length || !presence || !descriptors) invalid("missing required sections or trailing bytes");
  const sections = new Map<number, Buffer>();
  for (let i = 0; i < count; i += 1) {
    const at = HEADER_BYTES + DIRECTORY_BYTES * i;
    const offset = data.readUInt32LE(at + 4);
    sections.set(data.readUInt16LE(at), data.subarray(offset, offset + data.readUInt32LE(at + 8)));
  }
  return { ...header, sections };
}

/** Writes accept only understood sections and preserve exact unsigned identities. */
export function serializeSectionedForm(form: SectionedForm, limit = MAX_FORM_BYTES): Buffer {
  if (!validHeader(form) || form.sections.size > 64) invalid("invalid header or section count");
  let total = HEADER_BYTES + DIRECTORY_BYTES * form.sections.size;
  const maximum = Math.min(limit, MAX_FORM_BYTES);
  let previous = 0;
  for (const [kind, bytes] of form.sections) {
    if (!Number.isInteger(kind) || kind <= previous || kind > FormSection.descriptors) invalid("invalid or unknown section kind");
    total += bytes.length;
    if (total > maximum) invalid("byte limit exceeded");
    previous = kind;
  }
  if (total > maximum || !form.sections.has(FormSection.presence) || !form.sections.has(FormSection.descriptors)) invalid("missing required sections or byte limit exceeded");
  const data = Buffer.alloc(total);
  data.write("CKCF");
  data.writeUInt16LE(1, 4);
  data.writeUInt16LE(form.flags, 6);
  data.writeBigUInt64LE(form.version, 8);
  data.writeBigUInt64LE(form.schemaVersion, 16);
  data.writeBigUInt64LE(form.commitTimeMs, 24);
  data.writeUInt16LE(form.sections.size, 32);
  let offset = HEADER_BYTES + DIRECTORY_BYTES * form.sections.size;
  let index = 0;
  for (const [kind, bytes] of form.sections) {
    const at = HEADER_BYTES + DIRECTORY_BYTES * index++;
    data.writeUInt16LE(kind, at);
    data.writeUInt32LE(offset, at + 4);
    data.writeUInt32LE(bytes.length, at + 8);
    data.set(bytes, offset);
    offset += bytes.length;
  }
  return data;
}

export function validFormPadding(data: Uint8Array, bits: number): boolean {
  return data.length === Math.ceil(bits / 8) && (bits % 8 === 0 || (data[data.length - 1] >>> (bits % 8)) === 0);
}

export interface FormBlockSpan { id: number; width: number; values: Buffer; validity: Buffer }

export function parseFormBlockSpans(form: SectionedForm, blocks: number): FormBlockSpan[] {
  const presence = form.sections.get(FormSection.presence) ?? Buffer.alloc(0);
  if (!Number.isInteger(blocks) || blocks <= 0 || blocks > 1_048_576 || !validFormPadding(presence, blocks)) invalid("invalid presence");
  const directory = form.sections.get(FormSection.descriptors);
  if (directory === undefined || directory.length < 4) invalid("truncated block descriptors");
  const count = directory.readUInt32LE(0);
  if (count > 1024 || directory.length !== 4 + 24 * count) invalid("invalid descriptor count or length");
  const values = form.sections.get(FormSection.fixed) ?? Buffer.alloc(0);
  const validity = form.sections.get(FormSection.validity) ?? Buffer.alloc(0);
  const valueSpans: Array<[number, number]> = [];
  const validitySpans: Array<[number, number]> = [];
  const ids = new Set<number>();
  const columns: FormBlockSpan[] = [];
  for (let i = 0; i < count; i += 1) {
    const at = 4 + 24 * i;
    const id = directory.readUInt32LE(at);
    const width = directory.readUInt32LE(at + 4);
    if (id === 0 || ids.has(id) || width === 0 || width > 65535) invalid("invalid descriptor ID or width");
    ids.add(id);
    const vo = directory.readUInt32LE(at + 8), vl = directory.readUInt32LE(at + 12);
    const no = directory.readUInt32LE(at + 16), nl = directory.readUInt32LE(at + 20);
    if (vo > values.length || vl > values.length - vo || no > validity.length || nl > validity.length - no) invalid("descriptor array bounds");
    const v = values.subarray(vo, vo + vl), n = validity.subarray(no, no + nl);
    if (!validFormPadding(v, width * blocks) || (nl !== 0 && !validFormPadding(n, blocks)) || (nl === 0 && no !== 0)) invalid("descriptor array length or padding");
    valueSpans.push([vo, vl]);
    if (nl !== 0) validitySpans.push([no, nl]);
    columns.push({ id, width, values: v, validity: n });
  }
  const covered = (spans: Array<[number, number]>, length: number) => {
    let next = 0;
    for (const [offset, size] of spans.sort((a, b) => a[0] - b[0])) {
      if (offset !== next) return false;
      next += size;
    }
    return next === length;
  };
  if (!covered(valueSpans, values.length) || !covered(validitySpans, validity.length)) invalid("overlap or unused array bytes");
  return columns;
}

export interface FormChunkColumn { id: number; null: boolean; value: Buffer }

export function parseFormChunkColumns(form: SectionedForm): FormChunkColumn[] {
  const body = form.sections.get(FormSection.metadata);
  if (body === undefined) return [];
  if (body.length < 4) invalid("truncated chunk columns");
  const count = body.readUInt32LE(0);
  let next = 4 + 16 * count;
  if (count > 1024 || next > body.length) invalid("invalid chunk column count");
  const columns: FormChunkColumn[] = [];
  let previous = 0;
  for (let i = 0; i < count; i += 1) {
    const at = 4 + 16 * i;
    const id = body.readUInt32LE(at), flags = body.readUInt16LE(at + 4);
    const offset = body.readUInt32LE(at + 8), length = body.readUInt32LE(at + 12);
    if (id <= previous || flags > 1 || body.readUInt16LE(at + 6) !== 0 || offset !== next || length > body.length - next || (flags === 1 && length !== 0)) invalid("invalid chunk column descriptor");
    columns.push({ id, null: flags === 1, value: body.subarray(offset, offset + length) });
    previous = id;
    next += length;
  }
  if (next !== body.length) invalid("trailing chunk column bytes");
  return columns;
}
