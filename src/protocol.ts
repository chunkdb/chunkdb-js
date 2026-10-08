import { ChunkProtocolError } from "./errors";

// RESP3 replies (docs/PROTOCOL.md "Replies"). Integers are bigints: a `uN`
// value may be above the i64 range, and nothing is lost on the way.
export interface SimpleReply {
  type: "simple";
  value: string;
}

/** `-ERR <CODE> <message>`; `ChunkClient` turns it into a thrown error. */
export interface ErrorReply {
  type: "error";
  code: string;
  message: string;
}

export interface IntegerReply {
  type: "integer";
  value: bigint;
}

/** `,<n>`, including `inf`, `-inf` and `nan`. */
export interface DoubleReply {
  type: "double";
  value: number;
}

export interface BooleanReply {
  type: "boolean";
  value: boolean;
}

/** `_`: NULL, or an absent block. */
export interface NullReply {
  type: "null";
}

export interface BulkReply {
  type: "bulk";
  value: Buffer;
}

export interface ArrayReply {
  type: "array";
  items: ChunkReply[];
}

export interface MapReply {
  type: "map";
  entries: Array<[ChunkReply, ChunkReply]>;
}

export type ChunkReply =
  | SimpleReply
  | ErrorReply
  | IntegerReply
  | DoubleReply
  | BooleanReply
  | NullReply
  | BulkReply
  | ArrayReply
  | MapReply;

/** A parameter frame: the value's bytes, or null for `NULL`. */
export type ChunkParameter = Uint8Array | null;

const CR = 0x0d;
const LF = 0x0a;
const CRLF = Buffer.from("\r\n", "latin1");
const NULL_FRAME = Buffer.from("$-1\r\n", "latin1");

/**
 * The bytes of one statement and its parameter frames. A statement is one
 * line: CR or LF in it is refused before anything is sent.
 */
export function encodeStatement(statement: string, parameters: readonly ChunkParameter[] = []): Buffer {
  if (statement.includes("\r") || statement.includes("\n")) {
    throw new ChunkProtocolError("a statement is one line: it cannot contain CR or LF", {
      phase: "request",
    });
  }
  const parts: Buffer[] = [Buffer.from(statement, "utf8"), CRLF];
  for (const parameter of parameters) {
    if (parameter === null) {
      parts.push(NULL_FRAME);
      continue;
    }
    parts.push(
      Buffer.from(`$${parameter.length}\r\n`, "latin1"),
      Buffer.from(parameter.buffer, parameter.byteOffset, parameter.byteLength),
      CRLF,
    );
  }
  return Buffer.concat(parts);
}

/** More bytes are needed: at least `need` from the start of the reply. */
interface Incomplete {
  need: number;
}

function protocolError(message: string): ChunkProtocolError {
  return new ChunkProtocolError(message, { phase: "protocol" });
}

// The index of the CR of the CR LF ending the line that starts at `start`,
// or -1 when it has not arrived.
function lineEnd(buffer: Buffer, start: number): number {
  const at = buffer.indexOf(LF, start);
  if (at === -1) {
    return -1;
  }
  if (at === start || buffer[at - 1] !== CR) {
    throw protocolError("a reply line must end with CR LF");
  }
  return at - 1;
}

function lengthOf(text: string, what: string): number {
  if (!/^(0|[1-9][0-9]*)$/.test(text)) {
    throw protocolError(`invalid ${what} length: ${text}`);
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value)) {
    throw protocolError(`invalid ${what} length: ${text}`);
  }
  return value;
}

// Finds where the reply starting at `start` ends without building it, so a
// large reply is built once, after its last byte arrived.
function scanReply(buffer: Buffer, start: number): number | Incomplete {
  if (start >= buffer.length) {
    return { need: start + 1 };
  }
  const end = lineEnd(buffer, start);
  if (end === -1) {
    return { need: buffer.length + 1 };
  }
  const prefix = buffer[start];
  const text = buffer.toString("latin1", start + 1, end);
  const next = end + 2;
  switch (prefix) {
    case 0x2b: // +
    case 0x2d: // -
    case 0x3a: // :
    case 0x2c: // ,
    case 0x23: // #
    case 0x5f: // _
      return next;
    case 0x24: {
      // $
      if (text === "-1") {
        return next;
      }
      const length = lengthOf(text, "bulk");
      const after = next + length + 2;
      return buffer.length < after ? { need: after } : after;
    }
    case 0x2a: // *
    case 0x25: {
      // %
      if (prefix === 0x2a && text === "-1") {
        return next;
      }
      const count = lengthOf(text, prefix === 0x2a ? "array" : "map") * (prefix === 0x25 ? 2 : 1);
      let at = next;
      for (let i = 0; i < count; i += 1) {
        const scanned = scanReply(buffer, at);
        if (typeof scanned !== "number") {
          return scanned;
        }
        at = scanned;
      }
      return at;
    }
    default:
      throw protocolError(`unexpected reply type '${String.fromCharCode(prefix)}'`);
  }
}

// Builds the reply starting at `start`, which scanReply found complete.
function readReply(buffer: Buffer, start: number): { reply: ChunkReply; end: number } {
  const end = lineEnd(buffer, start);
  const prefix = buffer[start];
  const next = end + 2;
  switch (prefix) {
    case 0x2b:
      return { reply: { type: "simple", value: buffer.toString("utf8", start + 1, end) }, end: next };
    case 0x2d: {
      const line = buffer.toString("utf8", start + 1, end);
      const body = line.startsWith("ERR ") ? line.slice(4) : line;
      const space = body.indexOf(" ");
      return {
        reply: {
          type: "error",
          code: space === -1 ? body : body.slice(0, space),
          message: space === -1 ? "" : body.slice(space + 1),
        },
        end: next,
      };
    }
    case 0x3a: {
      const text = buffer.toString("latin1", start + 1, end);
      if (!/^-?[0-9]+$/.test(text)) {
        throw protocolError(`invalid integer reply: ${text}`);
      }
      return { reply: { type: "integer", value: BigInt(text) }, end: next };
    }
    case 0x2c: {
      const text = buffer.toString("latin1", start + 1, end);
      let value: number;
      if (text === "inf") {
        value = Number.POSITIVE_INFINITY;
      } else if (text === "-inf") {
        value = Number.NEGATIVE_INFINITY;
      } else if (text === "nan") {
        value = Number.NaN;
      } else {
        value = Number(text);
        if (text === "" || Number.isNaN(value)) {
          throw protocolError(`invalid double reply: ${text}`);
        }
      }
      return { reply: { type: "double", value }, end: next };
    }
    case 0x23: {
      const text = buffer.toString("latin1", start + 1, end);
      if (text !== "t" && text !== "f") {
        throw protocolError(`invalid boolean reply: ${text}`);
      }
      return { reply: { type: "boolean", value: text === "t" }, end: next };
    }
    case 0x5f:
      if (end !== start + 1) {
        throw protocolError("invalid null reply");
      }
      return { reply: { type: "null" }, end: next };
    case 0x24: {
      const text = buffer.toString("latin1", start + 1, end);
      if (text === "-1") {
        return { reply: { type: "null" }, end: next };
      }
      const length = lengthOf(text, "bulk");
      if (buffer[next + length] !== CR || buffer[next + length + 1] !== LF) {
        throw protocolError("a bulk reply must end with CR LF");
      }
      // A copy: the receive buffer is reused.
      return {
        reply: { type: "bulk", value: Buffer.from(buffer.subarray(next, next + length)) },
        end: next + length + 2,
      };
    }
    case 0x2a: {
      const text = buffer.toString("latin1", start + 1, end);
      if (text === "-1") {
        return { reply: { type: "null" }, end: next };
      }
      const count = lengthOf(text, "array");
      const items: ChunkReply[] = [];
      let at = next;
      for (let i = 0; i < count; i += 1) {
        const item = readReply(buffer, at);
        items.push(item.reply);
        at = item.end;
      }
      return { reply: { type: "array", items }, end: at };
    }
    case 0x25: {
      const count = lengthOf(buffer.toString("latin1", start + 1, end), "map");
      const entries: Array<[ChunkReply, ChunkReply]> = [];
      let at = next;
      for (let i = 0; i < count; i += 1) {
        const key = readReply(buffer, at);
        const value = readReply(buffer, key.end);
        entries.push([key.reply, value.reply]);
        at = value.end;
      }
      return { reply: { type: "map", entries }, end: at };
    }
    default:
      throw protocolError(`unexpected reply type '${String.fromCharCode(prefix)}'`);
  }
}

/**
 * Reads one reply from the start of `buffer`: the reply and its size, or
 * null when it has not fully arrived. Throws `ChunkProtocolError` for bytes
 * that are not a RESP3 reply.
 */
export function parseReply(buffer: Buffer): { reply: ChunkReply; bytesConsumed: number } | null {
  const scanned = scanReply(buffer, 0);
  if (typeof scanned !== "number") {
    return null;
  }
  const { reply, end } = readReply(buffer, 0);
  return { reply, bytesConsumed: end };
}

/**
 * Received bytes, read reply by reply. Bytes are copied once into a growing
 * buffer, and a reply is only built when all of it arrived.
 */
export class ReplyReader {
  private data = Buffer.alloc(0);
  private start = 0;
  private end = 0;
  // Nothing is parsed before this many bytes (from `start`) arrived.
  private need = 1;

  push(chunk: Buffer): void {
    if (this.end + chunk.length > this.data.length) {
      const used = this.end - this.start;
      const grown = Buffer.allocUnsafe(Math.max(64 * 1024, 2 * (used + chunk.length)));
      this.data.copy(grown, 0, this.start, this.end);
      this.data = grown;
      this.start = 0;
      this.end = used;
    }
    chunk.copy(this.data, this.end);
    this.end += chunk.length;
  }

  /** The next complete reply, or null. */
  next(): ChunkReply | null {
    if (this.end - this.start < this.need) {
      return null;
    }
    const view = this.data.subarray(this.start, this.end);
    const scanned = scanReply(view, 0);
    if (typeof scanned !== "number") {
      this.need = scanned.need;
      return null;
    }
    const { reply } = readReply(view, 0);
    this.start += scanned;
    this.need = 1;
    if (this.start === this.end) {
      this.start = 0;
      this.end = 0;
    }
    return reply;
  }

  clear(): void {
    this.data = Buffer.alloc(0);
    this.start = 0;
    this.end = 0;
    this.need = 1;
  }
}
