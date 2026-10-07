export type ChunkScheme = "chunk" | "chunks";

export interface ParsedChunkUri {
  scheme: ChunkScheme;
  secure: boolean;
  host: string;
  port: number;
  token: string;
  path: string;
}

export interface ChunkClientOptions {
  host?: string;
  port?: number;
  uri?: string;
  /** Sent as `HELLO 2 AUTH <token>` when the connection opens. */
  token?: string;
  connectTimeoutMs?: number;
  commandTimeoutMs?: number;
  tls?: boolean;
  tlsInsecure?: boolean;
  tlsServerName?: string;
  ca?: string | Buffer;
  cert?: string | Buffer;
  key?: string | Buffer;
  /** Max concurrent in-flight requests per connection. Default 1 (sequential). */
  pipelineDepth?: number;
  /**
   * Table the connection works on; named in `HELLO` when connecting and
   * reconnecting. Defaults to the URI path (`chunk://host:4242/terrain`),
   * then to the server's `default` table.
   */
  table?: string;
}

export interface ChunkPoolOptions extends ChunkClientOptions {
  maxConnections: number;
  minConnections?: number;
  acquireTimeoutMs?: number;
}

export type ChunkDurabilityMode = "relaxed" | "fsync-wal" | "fsync-checkpoint";
export type ChunkCheckpointCompression = "none" | "zrle";

/** Table options; omitted fields keep their current (or the server's default) value. */
export interface ChunkTableOptions {
  durabilityMode?: ChunkDurabilityMode;
  checkpointUpdates?: number;
  checkpointWalBytes?: number;
  walGroupCommitUpdates?: number;
  checkpointCompression?: ChunkCheckpointCompression;
  /**
   * Longest extra data value one block can carry, in bits. Setting it turns
   * extra data on for good; afterwards it can only be raised.
   */
  extraMaxBlockBits?: number;
  /**
   * Most extra data one chunk can hold, in bytes: 8 per value plus its bytes.
   * Server default 65536; can only be raised.
   */
  extraMaxChunkBytes?: number;
}

/** Geometry and options of a new table. Geometry is fixed once created. */
export interface ChunkTableCreateOptions extends ChunkTableOptions {
  blockBits: number;
  /** Default 16. */
  chunkWidthBlocks?: number;
  /** Default 16. */
  chunkHeightBlocks?: number;
  /** Default 8. */
  largeChunkWidthChunks?: number;
  /** Default 8. */
  largeChunkHeightChunks?: number;
}

export interface ChunkTableInfo {
  name: string;
  /** Changes when a table is dropped and created again under the same name. */
  storeId: string;
  blockBits: number;
  chunkWidthBlocks: number;
  chunkHeightBlocks: number;
  largeChunkWidthChunks: number;
  largeChunkHeightChunks: number;
  durabilityMode: string;
  checkpointUpdates: number;
  checkpointWalBytes: number;
  walGroupCommitUpdates: number;
  checkpointCompression: string;
  /** Longest extra data value of a block, in bits; 0 when the table has no extra data. */
  extraMaxBlockBits: number;
  /** Most extra data one chunk can hold, in bytes; 0 when the table has no extra data. */
  extraMaxChunkBytes: number;
  /** Every key/value line of the reply. */
  values: Record<string, string>;
}

/** The server's `HELLO` reply. */
export interface ChunkHelloInfo {
  protocol: number;
  serverVersion: string;
  /** Optional features, for example `"zrle"` and `"extra-data"`. */
  capabilities: string[];
  maxLineBytes: number;
  /** Most chunks one `chunkRange` / `chunkRadius` call may cover. */
  maxAreaChunks: number;
  /** Largest `chunkRange` / `chunkRadius` response, in bytes. */
  maxResponseBytes: number;
  maxScanLimit: number;
  maxBatchOps: number;
  /**
   * Most extra data any chunk can hold, in bytes; it bounds `xput` values and
   * EXTRA sections. 0 when the server has no extra data.
   */
  maxExtraChunkBytes: number;
  /** The connection's table, or null when it has none (no `default`). */
  table: ChunkTableInfo | null;
  /** Every key/value line of the reply. */
  values: Record<string, string>;
}

export interface ChunkInfo {
  raw: string;
  values: Record<string, string>;
}

/**
 * A chunk's binary state: the packed block payload and the presence bitmap
 * (one bit per block, set when the block is explicitly present).
 */
export interface ChunkChunkStateInput {
  payload: Buffer;
  presence: Buffer;
}

export interface ChunkChunkState extends ChunkChunkStateInput {
  /** True when any block is explicitly present. */
  exists: boolean;
}

export interface ChunkGetOptions {
  /** Transfer the chunk zrle-compressed; the result is decompressed. */
  zrle?: boolean;
}

export interface ChunkGetStateOptions extends ChunkGetOptions {
  /** Also read the chunk's extra data (a table with extra data only). */
  extra?: boolean;
}

/**
 * A block's extra data: `bitLength` bits (at least 1) held in
 * `ceil(bitLength / 8)` bytes. Bit `n` is `bytes[n >> 3] >> (n & 7) & 1`;
 * padding bits in the last byte are ignored on input and zero on output.
 */
export interface ChunkExtraValue {
  bitLength: number;
  bytes: Uint8Array;
}

/**
 * A chunk state with all of its extra data, by block index
 * (`localY * chunkWidthBlocks + localX`).
 */
export interface ChunkChunkStateExtraInput extends ChunkChunkStateInput {
  extra: ReadonlyMap<number, ChunkExtraValue>;
}

export interface ChunkChunkStateExtra extends ChunkChunkState {
  extra: Map<number, ChunkExtraValue>;
}

export interface ChunkPutOptions {
  /** Write only if the chunk's current version equals this one. */
  ifVersion?: bigint;
  /** Send the chunk zrle-compressed when that is smaller. */
  zrle?: boolean;
}

export interface ChunkCoordPair {
  cx: number;
  cy: number;
}

export interface ChunkScanResult {
  coords: ChunkCoordPair[];
  /** Pass back as the cursor of the next chunkScan call; null when done. */
  nextCursor: ChunkCoordPair | null;
}

export interface ChunkRangeEntry extends ChunkChunkStateInput {
  cx: number;
  cy: number;
}

export type ChunkBatchOperation =
  | { type: "set"; x: number; y: number; bits: string }
  | { type: "unset"; x: number; y: number }
  /** Sets the block's extra data; `bits` is `0`/`1` text, character `n` is bit `n`. */
  | { type: "xput"; x: number; y: number; bits: string }
  | { type: "xdel"; x: number; y: number };

export interface ChunkMutationResult {
  ok: boolean;
  /**
   * On success: the chunk version after the mutation.
   * On version mismatch (ok === false): the current chunk version.
   * Versions are opaque tokens; they change on every content mutation and
   * survive eviction and restart.
   */
  version: bigint;
}

export type ChunkErrorPhase =
  | "connect"
  | "auth"
  | "request"
  | "response"
  | "timeout"
  | "protocol"
  | "tls";
