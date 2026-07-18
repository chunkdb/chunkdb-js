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
  token?: string;
  autoAuth?: boolean;
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
}

export interface ChunkPoolOptions extends ChunkClientOptions {
  maxConnections: number;
  minConnections?: number;
  acquireTimeoutMs?: number;
}

export interface ChunkInfo {
  raw: string;
  values: Record<string, string>;
}

export type ChunkBlockState =
  | {
      exists: false;
      bits: null;
    }
  | {
      exists: true;
      bits: string;
    };

export interface ChunkChunkState {
  exists: boolean;
  bits: string;
  presence: string;
}

export interface ChunkChunkStateInput {
  bits: string;
  presence: string;
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

export interface ChunkRangeEntry {
  cx: number;
  cy: number;
  bits: string;
  presence: string;
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
   * whenever the server reloads the chunk (eviction or restart).
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
