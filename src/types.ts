import type { ChunkReply } from "./protocol";
import type { ChunkBits } from "./values";

export type ChunkScheme = "chunk" | "chunks";

export interface ParsedChunkUri {
  scheme: ChunkScheme;
  secure: boolean;
  host: string;
  port: number;
  /** The user, or `""` for none. */
  user: string;
  /** The password, or `""` for none. */
  password: string;
  path: string;
}

export interface ChunkClientOptions {
  host?: string;
  port?: number;
  uri?: string;
  /**
   * The user to log in as (SCRAM-SHA-256); wins over the URI's. Without a
   * user the client sends `HELLO 3` alone, which only a server started with
   * `--auth none` accepts.
   */
  user?: string;
  /** The user's password; wins over the URI's. It never crosses the network. */
  password?: string;
  /**
   * PBKDF2 iterations of the verifiers `createUser` and `setPassword`
   * compute: at least 4096 (the default).
   */
  verifierIterations?: number;
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
   * (`chunk://host:4242/terrain`), with no fallback. Selecting a name
   * does not create its table; a fresh server has no tables.
   */
  table?: string;
  /** HELLO WITH options; unknown names are reported as not applied. */
  helloOptions?: Readonly<Record<string, ChunkValue>>;
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
  /** The most lexical parameter occurrences in one statement. */
  maxParameters: number;
  /** The most chunks one `getArea` call covers. */
  maxAreaChunks: number;
  /** The largest `getArea` reply, in bytes. */
  maxResponseBytes: number;
  /** The largest `scanChunks` limit. */
  maxScanLimit: number;
  /**
   * The SCRAM server-final message (`v=<signature>`), which the client has
   * checked; null for a login without a user.
   */
  serverSignature: string | null;
  connectionId?: bigint;
  features?: string[];
  options?: Record<string, ChunkValue>;
  notApplied?: Record<string, { reason: string }>;
  idleTimeoutMs?: number;
  limits?: Record<string, number>;

}

/** A right on a table: `ADMIN` includes `WRITE`, which includes `READ`. */
export type ChunkRight = "READ" | "WRITE" | "ADMIN";

/** One named schema or permissions statement, applied once by the server. */
export interface ChunkMigration {
  name: string;
  statement: string;
}

/** The outcome of one successfully acknowledged migration step. */
export interface ChunkMigrationResult {
  name: string;
  status: "applied" | "skipped";
}

/** A user as `listUsers` reports it. */
export interface ChunkUser {
  name: string;
  /** The user may create, alter and drop users and grant rights. */
  managesUsers: boolean;
  /** Rights by table name; `"*"` stands for every table. */
  grants: Record<string, ChunkRight>;
}

export interface ChunkCreateUserOptions {
  /** The user may manage users and rights. Default false. */
  managesUsers?: boolean;
}

export interface ChunkVerifierOptions {
  /** PBKDF2 iterations, at least 4096 (the default). */
  iterations?: number;
  /** The salt, at least 16 bytes; 16 random bytes by default. */
  salt?: Uint8Array;
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

/** Exact schema version: number within the safe range, bigint above it. */
export type ChunkSchemaVersion = number | bigint;

export interface ChunkBlockMetadata {
  version: bigint | null;
  schemaVersion: bigint;
  row: ChunkRow | null;
}
export interface ChunkAreaMetadata<T> { schemaVersion: bigint; entries: T[] }
export interface ChunkFeatureStatus { enabled: string[]; compat: bigint; roCompat: bigint; incompat: bigint }
export interface ChunkStatus { directory: ChunkFeatureStatus; tables: Array<ChunkFeatureStatus & { name: string }>; activationPending: boolean }

export interface ChunkPosition {
  epoch: string;
  revision: bigint;
}

/** An absolute block coordinate, or an exact chunk/offset address beyond int64. */
export type ChunkWatchCoordinate = bigint | { chunk: bigint; offset: number };

export interface ChunkWatchOptions {
  /** Durable slot name; created separately with createSlot. */
  slot?: string;
  /** Inclusive chunk coordinates. */
  area?: { cx0: number; cy0: number; cx1: number; cy1: number };
  area3D?: ChunkBox3D;
  after?: ChunkPosition;
  columns?: readonly string[];
  noBefore?: boolean;
  chunks?: boolean;
  ackTimeoutMs?: number;
  takeover?: boolean;
}

/** Filters persisted when a durable slot is created. */
export interface ChunkSlotOptions {
  area?: ChunkWatchOptions["area"];
  area3D?: ChunkBox3D;
  columns?: readonly string[];
  noBefore?: boolean;
  chunks?: boolean;
  ifNotExists?: boolean;
}

/** A durable slot's written acknowledgement, retained history and filter identity. */
export interface ChunkSlot {
  table: string;
  name: string;
  epoch: string;
  acked: bigint;
  retainedBytes: bigint;
  lost: boolean;
  filters?: { area: bigint[] | null; columns: Array<string | null> | null; columnIds: bigint[] | null; noBefore: boolean; chunks: boolean };
  lostReason?: string | null;
}

export interface ChunkChangeEvent {
  kind: "change";
  position: ChunkPosition;
  commitTimeMs: bigint;
  user: string | null;
  schemaVersion: ChunkSchemaVersion;
  blocks: Array<{
    x: ChunkWatchCoordinate;
    y: ChunkWatchCoordinate;
    z?: ChunkWatchCoordinate;
    before: ChunkRow | null;
    after: ChunkRow | null;
  }>;
  tag?: Buffer | null;
  txn?: bigint | null;
  chunkChanges?: Array<{ cx: bigint; cy: bigint; cz?: bigint; before: ChunkRow | null; after: ChunkRow | null }>;
}

export interface ChunkSchemaEvent {
  kind: "schema";
  position: ChunkPosition;
  version: ChunkSchemaVersion;
  columns: ChunkColumn[];
  dims?: number;
  chunkColumns?: ChunkColumn[];
}

export interface ChunkResyncEvent {
  kind: "resync";
  position: ChunkPosition;
  parentEpoch?: string | null;
  forkRevision?: bigint | null;
}

export interface ChunkProgressEvent { kind: "progress"; position: ChunkPosition }
export interface ChunkChunksEvent {
  kind: "chunks";
  position: ChunkPosition;
  commitTimeMs: bigint;
  user: string | null;
  schemaVersion: ChunkSchemaVersion;
  chunks: Array<{ cx: bigint; cy: bigint; cz?: bigint; version: bigint; form: Buffer | null }>;
  tag: Buffer | null;
  txn: bigint | null;
}
export interface ChunkCatalogEvent {
  kind: "catalog";
  position: ChunkPosition;
  commitTimeMs: bigint;
  user: string | null;
  events: Array<{ kind: string; action: string | null; name: string | null; table: string | null; data: ChunkReply | null }>;
  txn: bigint | null;
}
export type ChunkWatchEvent = ChunkChangeEvent | ChunkSchemaEvent | ChunkResyncEvent | ChunkProgressEvent | ChunkChunksEvent | ChunkCatalogEvent;

export type ChunkColumnType =
  | { readonly kind: "u"; readonly bits: number }
  | { readonly kind: "i"; readonly bits: number }
  | { readonly kind: "bool" }
  | { readonly kind: "f32" }
  | { readonly kind: "f64" }
  | { readonly kind: "bits"; readonly length: number }
  | { readonly kind: "text"; readonly maxBytes: number }
  | { readonly kind: "bytes"; readonly maxBytes: number }
  | { readonly kind: "unknown"; readonly name: string };

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
  depth?: number;
}

export type ChunkDurabilityMode = "relaxed" | "fsync-wal" | "fsync-checkpoint";
export type ChunkCheckpointCompression = "none" | "zrle";

/** Table options; the server's CQL reference describes them. */
export interface ChunkTableOptions {
  durabilityMode?: ChunkDurabilityMode;
  checkpointUpdates?: number;
  checkpointWalBytes?: number;
  walGroupCommitUpdates?: number;
  checkpointCompression?: ChunkCheckpointCompression;
  /** The most bytes of `text` and `bytes` values in one chunk. */
  varMaxChunkBytes?: number;
  /** In-memory change-feed byte budget for this table. */
  feedBufferBytes?: number;
  /** Durable-slot retained byte budget for this table. */
  slotMaxBytes?: number;
}

/** A table's options as `describe` reports them. */
export interface ChunkTableOptionValues {
  durabilityMode: string;
  checkpointUpdates: number;
  checkpointWalBytes: number;
  walGroupCommitUpdates: number;
  checkpointCompression: string;
  varMaxChunkBytes: number;
  feedBufferBytes: number;
  slotMaxBytes: number;
}

/** The `DESCRIBE` reply. */
export interface ChunkTableSchema {
  table: string;
  /** The schema version; every column change writes a new one. */
  version: ChunkSchemaVersion;
  columns: ChunkColumn[];
  /** Blocks per chunk. */
  chunk: ChunkSize;
  /** Chunks per large chunk. */
  large: ChunkSize;
  options: ChunkTableOptionValues;
  epoch?: string;
  revision?: bigint | null;
  dims?: number;
  chunkColumns?: ChunkColumn[];
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
  chunkColumns?: readonly ChunkColumnDefinition[];
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
  | { kind: "addChunkColumn"; column: ChunkColumnDefinition; ifNotExists?: boolean }
  | { kind: "dropChunkColumn"; column: string; ifExists?: boolean }
  | { kind: "renameChunkColumn"; column: string; to: string }
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
  readonly metadata?: Readonly<ChunkRow>;
  readonly unknownSections?: ReadonlyMap<number, Uint8Array>;
}

export interface ChunkState extends ChunkStateInput {
  /** The chunk version this state was read at. */
  version: bigint;
  /** The schema version (`describe(table).version`) the columns follow. */
  schemaVersion: ChunkSchemaVersion;
  /** Blocks per row. */
  width: number;
  height: number;
  depth?: number;
  commitTimeMs?: bigint;
  projected?: boolean;
  private?: boolean;
  present: boolean[];
  columns: Record<string, ChunkValue[]>;
}

export interface ChunkCoord {
  cx: number;
  cy: number;
}

/** An exact int64 coordinate, supplied as bigint or a safe integer number. */
export type ChunkAxis = number | bigint;

export interface ChunkPoint3D { cx: ChunkAxis; cy: ChunkAxis; cz: ChunkAxis }
export interface ChunkCoord3D { cx: bigint; cy: bigint; cz: bigint }
export interface ChunkBox3D { cx0: ChunkAxis; cy0: ChunkAxis; cz0: ChunkAxis; cx1: ChunkAxis; cy1: ChunkAxis; cz1: ChunkAxis }

/** An inclusive box or ball of three-dimensional chunk coordinates. */
export type ChunkArea3D =
  | ChunkBox3D
  | { cx: ChunkAxis; cy: ChunkAxis; cz: ChunkAxis; radius: ChunkAxis };

export interface ChunkAreaEntry3D extends ChunkCoord3D { chunk: ChunkState }
export interface ChunkAreaRawEntry3D extends ChunkCoord3D { chunk: Buffer }

/** A rectangle of chunks, corners included, or the chunks within `radius` of a chunk. */
export type ChunkArea =
  | { cx0: number; cy0: number; cx1: number; cy1: number }
  | { cx: number; cy: number; radius: number };

export interface ChunkAreaEntry extends ChunkCoord {
  cz?: bigint;
  chunk: ChunkState;
}

export interface ChunkAreaRawEntry extends ChunkCoord {
  cz?: bigint;
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
  /** Chunk writes only; tombstones count as absent and metadata-only chunks remain present. */
  ifAbsent?: boolean;
}

export interface ChunkScanOptions extends ChunkTableOption {
  /** Start after this chunk: the last one of the previous page. */
  after?: ChunkCoord;
  /** Chunks per page, 1 to `maxScanLimit`; the server's maximum by default. */
  limit?: number;
}

export interface ChunkScanDataOptions extends ChunkScanOptions {
  since?: bigint;
  /** Bind a resumed scan to the table lifetime returned by its previous page. */
  epoch?: string;
  withData?: boolean;
  columns?: readonly string[];
}

export interface ChunkScanOptions3D extends Omit<ChunkScanDataOptions, "after"> { after?: ChunkPoint3D }

export interface ChunkScanEntry extends ChunkCoord {
  version: bigint;
  /** Present only with WITH DATA; null represents a retained tombstone. */
  chunk?: ChunkState | null;
  deleted?: boolean;
}

export interface ChunkScanEntry3D extends ChunkCoord3D {
  version: bigint;
  chunk?: ChunkState | null;
  deleted?: boolean;
}

export interface ChunkScanDataPage {
  chunks: ChunkScanEntry[];
  more: boolean;
  epoch: string;
  position: bigint | null;
  retainedDeletionFloor: bigint;
}

export interface ChunkScanPage3D extends Omit<ChunkScanDataPage, "chunks"> { chunks: ChunkScanEntry3D[] }

export interface ChunkTransactionOptions {
  /** How many times a transaction that ends with `CONFLICT` runs again; 5 by default. */
  retries?: number;
}

/**
 * The statements of one transaction (`transaction()`). Reads see one snapshot
 * of the table and the transaction's own writes; writes apply together at
 * `COMMIT`, so they resolve nothing. A transaction covers one table, the one
 * its first call names. `ifVersion` is not taken: `COMMIT` checks every
 * chunk the transaction read or wrote.
 */
export interface ChunkTransaction {
  getBlock(x: number, y: number, options?: ChunkReadOptions): Promise<ChunkRow | null>;
  getBlockWithMetadata(x: number, y: number, options?: ChunkReadOptions): Promise<ChunkBlockMetadata>;
  setBlock(x: number, y: number, values: Readonly<Record<string, ChunkValue>>, options?: ChunkTableOption): Promise<void>;
  deleteBlock(x: number, y: number, options?: ChunkTableOption): Promise<void>;
  getChunk(cx: number, cy: number, options?: ChunkReadOptions): Promise<ChunkState | null>;
  getChunkRaw(cx: number, cy: number, options?: ChunkReadOptions): Promise<Buffer | null>;
  setChunk(cx: number, cy: number, state: ChunkStateInput, options?: ChunkTableOption): Promise<void>;
  setChunkRaw(cx: number, cy: number, form: Uint8Array, options?: ChunkTableOption): Promise<void>;
  getArea(area: ChunkArea, options?: ChunkReadOptions): Promise<ChunkAreaEntry[]>;
  getAreaRaw(area: ChunkArea, options?: ChunkReadOptions): Promise<ChunkAreaRawEntry[]>;
  getAreaWithSchema(area: ChunkArea, options?: ChunkReadOptions): Promise<ChunkAreaMetadata<ChunkAreaEntry>>;
  getAreaRawWithSchema(area: ChunkArea, options?: ChunkReadOptions): Promise<ChunkAreaMetadata<ChunkAreaRawEntry>>;
  getBlock3D(x: ChunkAxis, y: ChunkAxis, z: ChunkAxis, options?: ChunkReadOptions): Promise<ChunkRow | null>;
  getBlock3DWithMetadata(x: ChunkAxis, y: ChunkAxis, z: ChunkAxis, options?: ChunkReadOptions): Promise<ChunkBlockMetadata>;
  setBlock3D(x: ChunkAxis, y: ChunkAxis, z: ChunkAxis, values: Readonly<Record<string, ChunkValue>>, options?: ChunkTableOption): Promise<void>;
  deleteBlock3D(x: ChunkAxis, y: ChunkAxis, z: ChunkAxis, options?: ChunkTableOption): Promise<void>;
  getChunk3D(cx: ChunkAxis, cy: ChunkAxis, cz: ChunkAxis, options?: ChunkReadOptions): Promise<ChunkState | null>;
  getChunkRaw3D(cx: ChunkAxis, cy: ChunkAxis, cz: ChunkAxis, options?: ChunkReadOptions): Promise<Buffer | null>;
  setChunk3D(cx: ChunkAxis, cy: ChunkAxis, cz: ChunkAxis, state: ChunkStateInput, options?: ChunkTableOption): Promise<void>;
  setChunkRaw3D(cx: ChunkAxis, cy: ChunkAxis, cz: ChunkAxis, form: Uint8Array, options?: ChunkTableOption): Promise<void>;
  getArea3D(area: ChunkArea3D, options?: ChunkReadOptions): Promise<ChunkAreaEntry3D[]>;
  getAreaRaw3D(area: ChunkArea3D, options?: ChunkReadOptions): Promise<ChunkAreaRawEntry3D[]>;
  getArea3DWithSchema(area: ChunkArea3D, options?: ChunkReadOptions): Promise<ChunkAreaMetadata<ChunkAreaEntry3D>>;
  getAreaRaw3DWithSchema(area: ChunkArea3D, options?: ChunkReadOptions): Promise<ChunkAreaMetadata<ChunkAreaRawEntry3D>>;
  setChunkColumns(cx: number, cy: number, columns: readonly string[], state: ChunkStateInput, options?: ChunkTableOption): Promise<void>;
  setChunkColumns3D(cx: ChunkAxis, cy: ChunkAxis, cz: ChunkAxis, columns: readonly string[], state: ChunkStateInput, options?: ChunkTableOption): Promise<void>;
  setChunkMetadata(cx: number, cy: number, values: Readonly<ChunkRow>, options?: ChunkTableOption): Promise<void>;
  setChunkMetadata3D(cx: ChunkAxis, cy: ChunkAxis, cz: ChunkAxis, values: Readonly<ChunkRow>, options?: ChunkTableOption): Promise<void>;
}

export type ChunkErrorPhase =
  | "connect"
  | "auth"
  | "request"
  | "response"
  | "timeout"
  | "protocol"
  | "tls";
