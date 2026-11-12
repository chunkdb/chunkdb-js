// Checked chunk forms carry both column domains and the producing identity.
import type { TableLayout } from "./schema";
import type { ChunkRow, ChunkState, ChunkStateInput, ChunkTableSchema, ChunkValue } from "./types";
import { decodeSectionedChunk, encodeSectionedChunk, sectionedBlockCount, sectionedChunkFormLimit } from "./sectioned-chunk";

export function blockCount(layout: TableLayout): number { return sectionedBlockCount(layout); }

/** The structural bound for a complete checked mutation. */
export function chunkFormLimit(layout: TableLayout): number { return sectionedChunkFormLimit(layout); }

/** Decode a checked form with its complete metadata and selected block columns. */
export function decodeChunkForm(layout: TableLayout, form: Uint8Array, indexes: readonly number[]): ChunkState {
  return decodeSectionedChunk(layout, form, indexes);
}

/** Encode every block column and chunk metadata using the supplied quota. */
export function encodeChunkForm(layout: TableLayout, state: ChunkStateInput): Buffer {
  return encodeSectionedChunk(layout, state);
}

/** A chunk state of `schema`'s table without blocks, to fill and pass to `setChunk`. */
export function emptyChunk(schema: ChunkTableSchema): { present: boolean[]; columns: Record<string, ChunkValue[]>; metadata?: ChunkRow } {
  const blocks = sectionedBlockCount({ schema, ids: [] });
  const columns = Object.fromEntries(schema.columns.map((column) => [column.name, new Array<ChunkValue>(blocks).fill(null)]));
  return { present: new Array<boolean>(blocks).fill(false), columns, ...((schema.chunkColumns?.length ?? 0) !== 0 ? { metadata: {} } : {}) };
}
