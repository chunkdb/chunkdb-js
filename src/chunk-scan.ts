import { ChunkProtocolError } from "./errors";
import type { ChunkReply } from "./protocol";
import { epochOf, mapOf, uint64Of } from "./schema";
import type { TableLayout } from "./schema";
import type { ChunkScanEntry3D, ChunkScanPage3D } from "./types";
import { decodeSectionedChunk } from "./sectioned-chunk";

export interface ScanDecodeOptions {
  dims: 2 | 3;
  after?: readonly bigint[];
  since?: bigint;
  limit?: number;
  withData: boolean;
  epoch?: string;
  indexes: readonly number[];
}

function bad(message: string): never { throw new ChunkProtocolError(message, { phase: "protocol", command: "SCAN CHUNKS" }); }

function axis(reply: ChunkReply): bigint {
  if (reply.type !== "integer" || reply.value < -(1n << 63n) || reply.value > (1n << 63n) - 1n) bad("invalid scan coordinate");
  return reply.value;
}

function less(left: readonly bigint[], right: readonly bigint[]): boolean {
  for (let i = 0; i < left.length; i += 1) if (left[i] !== right[i]) return left[i] < right[i];
  return false;
}

/** Decode retained versions independently from nullable tombstone bodies. */
export function decodeChunkScanPage(layout: TableLayout, reply: ChunkReply, options: ScanDecodeOptions): ChunkScanPage3D {
  const command = "SCAN CHUNKS", fields = mapOf(reply, command);
  const rows = fields.get("chunks"), more = fields.get("more"), epoch = fields.get("epoch"), position = fields.get("position"), floor = fields.get("retained_deletion_floor");
  if (rows?.type !== "array" || more?.type !== "boolean" || epoch === undefined || position === undefined || floor === undefined) bad("missing scan page fields");
  const lifetime = epochOf(epoch, command), retainedDeletionFloor = uint64Of(floor, "retained deletion floor", command);
  if ((options.epoch !== undefined && lifetime !== options.epoch) || (layout.schema.epoch !== undefined && lifetime !== layout.schema.epoch.toLowerCase())) bad("table epoch changed during scan");
  if (options.since !== undefined && options.since < retainedDeletionFloor) bad("scan history precedes the retained deletion floor");
  if (options.limit !== undefined && rows.items.length > options.limit) bad("scan page exceeds the requested limit");
  const frontier = position.type === "null" ? null : uint64Of(position, "completed frontier", command);
  const chunks: ChunkScanEntry3D[] = [];
  let previous = options.after;
  for (const row of rows.items) {
    if (row.type !== "array" || row.items.length < options.dims + 1 + (options.withData ? 1 : 0)) bad("invalid scan entry arity");
    const point = row.items.slice(0, options.dims).map(axis);
    if (previous !== undefined && !less(previous, point)) bad("scan coordinates do not advance in order");
    previous = point;
    const version = uint64Of(row.items[options.dims], "retained chunk version", command, false);
    if (options.since !== undefined && version <= options.since) bad("scan entry does not advance the requested revision");
    const entry: ChunkScanEntry3D = { cx: point[0], cy: point[1], cz: options.dims === 3 ? point[2] : 0n, version };
    if (options.withData) {
      const form = row.items[options.dims + 1];
      entry.deleted = form.type === "null";
      if (form.type === "null") {
        if (options.since === undefined) bad("ordinary scan contains a tombstone");
        entry.chunk = null;
      } else {
        if (form.type !== "bulk") bad("scan data is neither a form nor a tombstone");
        entry.chunk = decodeSectionedChunk(layout, form.value, options.indexes);
        if (entry.chunk.version !== version) bad("chunk form and scan version differ");
      }
    }
    chunks.push(entry);
  }
  if (more.value && chunks.length === 0) bad("empty scan page reports more");
  return { chunks, more: more.value, epoch: lifetime, position: frontier, retainedDeletionFloor };
}
