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

export class ChunkAuthError extends ChunkServerError {}

/**
 * `NOT_RETAINED`: a history read reaches before what the table keeps, which
 * starts at revision `start`.
 */
export class ChunkNotRetainedError extends ChunkServerError {
  readonly start: bigint;

  constructor(serverMessage: string, start: bigint, options: Omit<ChunkErrorOptions, "code">) {
    super("NOT_RETAINED", serverMessage, options);
    this.start = start;
  }
}

export class ChunkTlsError extends ChunkError {}
