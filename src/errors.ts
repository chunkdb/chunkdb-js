import type { ChunkErrorPhase } from "./types";

export interface ChunkErrorOptions {
  phase: ChunkErrorPhase;
  code?: string;
  command?: string;
  cause?: unknown;
}

export class ChunkError extends Error {
  readonly phase: ChunkErrorPhase;
  readonly code?: string;
  /** The statement's verb, for example `"SET BLOCK"`. */
  readonly command?: string;

  constructor(message: string, options: ChunkErrorOptions) {
    super(message);
    this.name = new.target.name;
    this.phase = options.phase;
    this.code = options.code;
    this.command = options.command;
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

/** A `-ERR <CODE> <message>` reply. */
export class ChunkServerError extends ChunkError {
  readonly serverCode: string;
  readonly serverMessage: string;

  constructor(serverCode: string, serverMessage: string, options: Omit<ChunkErrorOptions, "code">) {
    super(`chunkdb server error ${serverCode}: ${serverMessage}`, {
      ...options,
      code: serverCode,
    });
    this.serverCode = serverCode;
    this.serverMessage = serverMessage;
  }
}

/**
 * `AUTH_REQUIRED` (the server needs a user and password) or `AUTH_FAILED`
 * (a wrong password or an unknown user).
 */
export class ChunkAuthError extends ChunkServerError {}

/** `PERMISSION_DENIED`: the user lacks the right the statement needs; nothing changed. */
export class ChunkPermissionError extends ChunkServerError {}

/**
 * `VERSION_MISMATCH`: an `ifVersion` write found the chunk at another
 * version and changed nothing.
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

export class ChunkTlsError extends ChunkError {}
