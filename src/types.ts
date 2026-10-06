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
  /** Every key/value line of the reply. */
  values: Record<string, string>;
}

/** The server's `HELLO` reply. */
export interface ChunkHelloInfo {
  protocol: number;
  serverVersion: string;
  /** Optional features, for example `"zrle"`. */
  capabilities: string[];
  maxLineBytes: number;
  /** Most chunks one `chunkRange` / `chunkRadius` call may cover. */
  maxAreaChunks: number;
  /** Largest `chunkRange` / `chunkRadius` response, in bytes. */
  maxResponseBytes: number;
  maxScanLimit: number;
  maxBatchOps: number;
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
  | { type: "unset"; x: number; y: number };

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
