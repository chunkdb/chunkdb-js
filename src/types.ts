import type { ChunkBits } from "./values";

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
  /** Sent as `HELLO 3 AUTH <token>` when the connection opens. */
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
   * The table of calls that do not name one. Defaults to the URI path
   * (`chunk://host:4242/terrain`), then to `"default"`.
   */
  table?: string;
}

export interface ChunkPoolOptions extends ChunkClientOptions {
  maxConnections: number;
  minConnections?: number;
  acquireTimeoutMs?: number;
}

/** The server's `HELLO 3` reply. */
export interface ChunkServerInfo {
  protocol: number;
  serverVersion: string;
  /** The longest statement line, terminator included. */
  maxLineBytes: number;
  /** The most `$n` parameters in one statement. */
  maxParameters: number;
  /** The most chunks one `getArea` call covers. */
  maxAreaChunks: number;
  /** The largest `getArea` reply, in bytes. */
  maxResponseBytes: number;
  /** The largest `scanChunks` limit. */
  maxScanLimit: number;
}

/**
 * A column value:
 * - `uN`, `iN`: `number`, or `bigint` for columns wider than a safe integer
 *   (`u54`..`u64`, `i54`..`i64`); writes take either
 * - `bool`: `boolean`
 * - `f32`, `f64`: `number`
 * - `bits(N)`: `ChunkBits`
 * - `text(max)`: `string`
 * - `bytes(max)`: `Uint8Array` (reads return a `Buffer`)
 * - `null`: NULL
 */
export type ChunkValue = number | bigint | boolean | string | Uint8Array | ChunkBits | null;

/** Values by column name. */
export type ChunkRow = Record<string, ChunkValue>;

export type ChunkColumnType =
  | { readonly kind: "u"; readonly bits: number }
  | { readonly kind: "i"; readonly bits: number }
  | { readonly kind: "bool" }
  | { readonly kind: "f32" }
  | { readonly kind: "f64" }
  | { readonly kind: "bits"; readonly length: number }
  | { readonly kind: "text"; readonly maxBytes: number }
  | { readonly kind: "bytes"; readonly maxBytes: number };

/** A column as `describe` reports it. */
export interface ChunkColumn {
  name: string;
  type: ChunkColumnType;
  /** The type as CQL writes it, for example `"u10"` or `"text(16)"`. */
  typeName: string;
  nullable: boolean;
  required: boolean;
  /** The column's `DEFAULT`, or null when it has none. */
  default: ChunkValue;
}

export interface ChunkSize {
  width: number;
  height: number;
}

export type ChunkDurabilityMode = "relaxed" | "fsync-wal" | "fsync-checkpoint";
export type ChunkCheckpointCompression = "none" | "zrle";

/** Table options; the server's documentation (SERVER_FLAGS.md) describes them. */
export interface ChunkTableOptions {
  durabilityMode?: ChunkDurabilityMode;
  checkpointUpdates?: number;
  checkpointWalBytes?: number;
  walGroupCommitUpdates?: number;
  checkpointCompression?: ChunkCheckpointCompression;
  /** The most bytes of `text` and `bytes` values in one chunk. */
  varMaxChunkBytes?: number;
}

/** A table's options as `describe` reports them. */
export interface ChunkTableOptionValues {
  durabilityMode: string;
  checkpointUpdates: number;
  checkpointWalBytes: number;
  walGroupCommitUpdates: number;
  checkpointCompression: string;
  varMaxChunkBytes: number;
}

/** The `DESCRIBE` reply. */
export interface ChunkTableSchema {
  table: string;
  /** The schema version; every column change writes a new one. */
  version: number;
  columns: ChunkColumn[];
  /** Blocks per chunk. */
  chunk: ChunkSize;
  /** Chunks per large chunk. */
  large: ChunkSize;
  options: ChunkTableOptionValues;
}

export interface ChunkColumnDefinition {
  name: string;
  /** `"u10"`, `"text(16)"`, ..., or a `ChunkColumnType`. */
  type: string | ChunkColumnType;
  nullable?: boolean;
  /** A new block must give the column. */
  required?: boolean;
  default?: ChunkValue;
}

export interface ChunkTableDefinition {
  columns: readonly ChunkColumnDefinition[];
  chunk: ChunkSize;
  large?: ChunkSize;
  options?: ChunkTableOptions;
}

export type ChunkTypeConversion = "clamp" | "default" | "truncate";

export type ChunkSetOption = {
  [K in keyof ChunkTableOptions]-?: {
    kind: "setOption";
    option: K;
    value: NonNullable<ChunkTableOptions[K]>;
  };
}[keyof ChunkTableOptions];

/** One `ALTER TABLE` change. */
export type ChunkTableChange =
  | { kind: "addColumn"; column: ChunkColumnDefinition }
  | { kind: "dropColumn"; column: string }
  | { kind: "renameColumn"; column: string; to: string }
  | {
      kind: "alterColumnType";
      column: string;
      type: string | ChunkColumnType;
      /** How values the new type cannot hold convert; without it they are refused. */
      using?: ChunkTypeConversion;
    }
  | ChunkSetOption;

/**
 * A chunk's blocks, block `i` at local `(i % width, floor(i / width))`.
 * `present[i]` tells whether block `i` exists; `columns[name][i]` is its
 * value (null for an absent block).
 */
export interface ChunkStateInput {
  readonly present: readonly boolean[];
  readonly columns: Readonly<Record<string, readonly ChunkValue[]>>;
}

export interface ChunkState extends ChunkStateInput {
  /** The chunk version this state was read at. */
  version: bigint;
  /** The schema version (`describe(table).version`) the columns follow. */
  schemaVersion: number;
  /** Blocks per row. */
  width: number;
  height: number;
  present: boolean[];
  columns: Record<string, ChunkValue[]>;
}

export interface ChunkCoord {
  cx: number;
  cy: number;
}

/** A rectangle of chunks, corners included, or the chunks within `radius` of a chunk. */
export type ChunkArea =
  | { cx0: number; cy0: number; cx1: number; cy1: number }
  | { cx: number; cy: number; radius: number };

export interface ChunkAreaEntry extends ChunkCoord {
  chunk: ChunkState;
}

export interface ChunkAreaRawEntry extends ChunkCoord {
  /** The chunk form (docs/CQL.md). */
  chunk: Buffer;
}

export interface ChunkScanPage {
  chunks: ChunkCoord[];
  /** More chunks follow the last one; pass it as `after` for the next page. */
  more: boolean;
}

export interface ChunkTableOption {
  /** Defaults to the client's table. */
  table?: string;
}

export interface ChunkReadOptions extends ChunkTableOption {
  /** Only these columns; all by default. */
  columns?: readonly string[];
}

export interface ChunkWriteOptions extends ChunkTableOption {
  /**
   * Write only while the chunk is at this version; otherwise the write
   * changes nothing and rejects with `ChunkVersionMismatchError`.
   */
  ifVersion?: bigint;
}

export interface ChunkScanOptions extends ChunkTableOption {
  /** Start after this chunk: the last one of the previous page. */
  after?: ChunkCoord;
  /** Chunks per page, 1 to `maxScanLimit`; the server's maximum by default. */
  limit?: number;
}

export type ChunkErrorPhase =
  | "connect"
  | "auth"
  | "request"
  | "response"
  | "timeout"
  | "protocol"
  | "tls";
