import type { ChunkErrorPhase, ChunkMigration, ChunkMigrationResult } from "./types.js";

export type ChunkRetryClass = "reread" | "rerun" | "backoff" | "unknown_outcome" | "fatal";

export function retryClassOf(code: string): ChunkRetryClass {
  if (["VERSION_MISMATCH", "CONDITION_FAILED", "SCHEMA_MISMATCH"].includes(code)) return "reread";
  if (code === "CONFLICT") return "rerun";
  if (["BUSY", "DISK_FULL", "RATE_LIMITED"].includes(code)) return "backoff";
  return code === "OUTCOME_UNKNOWN" ? "unknown_outcome" : "fatal";
}

/** Leading `key=value` tokens of any key name; malformed percent escapes remain opaque diagnostics. */
export function parseErrorFields(message: string): { keys: Record<string, string>; message: string } {
  const entries: Array<[string, string]> = [];
  let remaining = message;
  while (true) {
    const match = /^([^\s=]+)=([^\s]*)(?:\s+|$)/.exec(remaining);
    if (match === null) break;
    let value = match[2];
    try { value = decodeURIComponent(value); }
    catch (error) { if (!(error instanceof URIError)) throw error; }
    entries.push([match[1], value]);
    remaining = remaining.slice(match[0].length);
  }
  return { keys: Object.fromEntries(entries), message: remaining };
}

export interface ChunkErrorOptions {
  phase: ChunkErrorPhase;
  code?: string;
  command?: string;
  cause?: unknown;
  retryClass?: ChunkRetryClass;
}

export class ChunkError extends Error {
  readonly phase: ChunkErrorPhase;
  readonly code?: string;
  /** The statement's verb, for example `"SET BLOCK"`. */
  readonly command?: string;
  /**
   * `"unknown_outcome"` on a connection, TLS or timeout error of a request
   * that was written before its reply was lost: it may have applied. Never
   * retry it automatically. Undefined on other client errors.
   */
  readonly retryClass?: ChunkRetryClass;

  constructor(message: string, options: ChunkErrorOptions) {
    super(message);
    this.name = new.target.name;
    this.phase = options.phase;
    this.code = options.code;
    this.command = options.command;
    this.retryClass = options.retryClass;
    if (options.cause !== undefined) {
      Object.defineProperty(this, "cause", {
        value: options.cause,
        configurable: true,
        enumerable: false,
        writable: true,
      });
    }
  }
}

export class ChunkConnectionError extends ChunkError {}

export class ChunkTimeoutError extends ChunkError {}

export class ChunkProtocolError extends ChunkError {}

/** A migration stopped at this step; earlier results remain applied. */
export class ChunkMigrationError extends ChunkError {
  readonly migration: Readonly<ChunkMigration>;
  /** Zero-based position in the supplied list. */
  readonly index: number;
  readonly results: readonly ChunkMigrationResult[];

  constructor(migration: ChunkMigration, index: number, results: readonly ChunkMigrationResult[], cause: unknown) {
    super(`migration ${JSON.stringify(migration.name)} at step ${index + 1} failed: ${cause instanceof Error ? cause.message : String(cause)}`, {
      phase: cause instanceof ChunkError ? cause.phase : "request",
      code: cause instanceof ChunkError ? cause.code : undefined,
      command: "MIGRATE",
      retryClass: cause instanceof ChunkError ? cause.retryClass : undefined,
      cause,
    });
    this.migration = Object.freeze({ ...migration });
    this.index = index;
    this.results = Object.freeze(results.map((result) => Object.freeze({ ...result })));
  }
}

/** A `-ERR <CODE> <message>` reply. */
export class ChunkServerError extends ChunkError {
  readonly serverCode: string;
  readonly serverMessage: string;
  readonly retryClass: ChunkRetryClass;
  readonly keys: Readonly<Record<string, string>>;
  /** Free text after structured keys, independent of retry classification. */
  readonly detail: string;
  readonly current?: bigint;
  readonly floor?: bigint;
  readonly expected?: bigint;
  readonly actual?: bigint;
  readonly revision?: bigint;
  readonly connectionId?: bigint;
  readonly retryAfterMs?: bigint;
  readonly reason?: string;
  readonly table?: string;
  readonly column?: string;
  readonly epoch?: string;
  readonly stage?: string;

  constructor(serverCode: string, serverMessage: string, options: Omit<ChunkErrorOptions, "code">) {
    super(`chunkdb server error ${serverCode}: ${serverMessage}`, {
      ...options,
      code: serverCode,
    });
    this.serverCode = serverCode;
    this.serverMessage = serverMessage;
    this.retryClass = retryClassOf(serverCode);
    const parsed = parseErrorFields(serverMessage);
    this.keys = Object.freeze(parsed.keys);
    this.detail = parsed.message;
    const integer = (name: string) => /^-?[0-9]+$/.test(parsed.keys[name] ?? "") ? BigInt(parsed.keys[name]) : undefined;
    this.current = integer("current");
    const floor = integer("floor");
    this.floor = floor !== undefined && floor >= 0n && floor <= (1n << 64n) - 1n ? floor : undefined;
    this.expected = integer("expected");
    this.actual = integer("actual");
    this.revision = integer("revision");
    this.connectionId = integer("connection_id");
    this.retryAfterMs = integer("retry_after_ms");
    this.reason = parsed.keys.reason;
    this.table = parsed.keys.table;
    this.column = parsed.keys.column;
    this.epoch = parsed.keys.epoch;
    this.stage = parsed.keys.stage;
  }
}

export class ChunkConditionFailedError extends ChunkServerError {}
export class ChunkBusyError extends ChunkServerError {}
export class ChunkDiskFullError extends ChunkServerError {}
export class ChunkRateLimitedError extends ChunkServerError {}
export class ChunkOutcomeUnknownError extends ChunkServerError {}
export class ChunkMigrationMismatchError extends ChunkServerError {}
export class ChunkSlotBusyError extends ChunkServerError {}
export class ChunkCheckFailedError extends ChunkServerError {}
export class ChunkCancelledError extends ChunkServerError {}
export class ChunkStatementTimeoutError extends ChunkServerError {}
export class ChunkKilledError extends ChunkServerError {}
export class ChunkUnknownCommandError extends ChunkServerError {}
export class ChunkServerProtocolError extends ChunkServerError {}
export class ChunkBadRequestError extends ChunkServerError {}
export class ChunkSyntaxError extends ChunkServerError {}
export class ChunkInvalidArgumentError extends ChunkServerError {}
export class ChunkOutOfRangeError extends ChunkServerError {}
export class ChunkNoTableError extends ChunkServerError {}
export class ChunkTableExistsError extends ChunkServerError {}
export class ChunkSlotLostError extends ChunkServerError {}
export class ChunkResyncRequiredError extends ChunkServerError {}
export class ChunkInternalError extends ChunkServerError {}
/** A legacy packed form cannot locate a column with an unknown width. */
export class ChunkUnknownColumnTypeError extends ChunkProtocolError {}

/**
 * `AUTH_REQUIRED` (the server needs a user and password, or a login bound
 * to its TLS connection) or `AUTH_FAILED` (a wrong password, an unknown
 * user, or with `reason` `channel_binding` a login bound to another TLS
 * connection than the server's).
 */
export class ChunkAuthError extends ChunkServerError {}

/** `PERMISSION_DENIED`: the user lacks the right the statement needs; nothing changed. */
export class ChunkPermissionError extends ChunkServerError {}

/**
 * `VERSION_MISMATCH`: an `ifVersion` write found another version, or an
 * `ifAbsent` write found a populated chunk; nothing changed.
 */
export class ChunkVersionMismatchError extends ChunkServerError {
  /** The chunk's version now. */
  readonly currentVersion: bigint;

  constructor(serverMessage: string, currentVersion: bigint, options: Omit<ChunkErrorOptions, "code">) {
    super("VERSION_MISMATCH", serverMessage, options);
    this.currentVersion = currentVersion;
  }
}

/**
 * `SCHEMA_MISMATCH`: a chunk form was encoded for another schema version
 * than the table's, and nothing changed.
 */
export class ChunkSchemaMismatchError extends ChunkServerError {
  /** The table's schema version now. */
  readonly currentSchemaVersion: bigint;

  constructor(serverMessage: string, currentSchemaVersion: bigint, options: Omit<ChunkErrorOptions, "code">) {
    super("SCHEMA_MISMATCH", serverMessage, options);
    this.currentSchemaVersion = currentSchemaVersion;
  }
}

/**
 * `CONFLICT`: a transaction ended without writing anything; running it
 * again may succeed. `transaction()` runs its callback again by itself.
 */
export class ChunkConflictError extends ChunkServerError {
  /** `chunk_changed`, `duration`, `history_limit` or `table_changed`. */
  readonly reason: string;

  constructor(serverMessage: string, reason: string, options: Omit<ChunkErrorOptions, "code">) {
    super("CONFLICT", serverMessage, options);
    this.reason = reason;
  }
}

export class ChunkTlsError extends ChunkError {}
