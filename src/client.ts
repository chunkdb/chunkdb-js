import { AsyncLocalStorage } from "node:async_hooks";
import net from "node:net";
import tls from "node:tls";

import {
  ChunkAuthError,
  ChunkConnectionError,
  ChunkNotRetainedError,
  ChunkProtocolError,
  ChunkServerError,
  ChunkTimeoutError,
  ChunkTlsError,
  type ChunkError,
} from "./errors";
import {
  parseFrame,
  parseInfoPayload,
  serializeCommand,
  type BulkFrame,
  type ChunkFrame,
  type NullFrame,
} from "./protocol";
import { formatChunkUri, parseChunkUri, tableFromUriPath } from "./uri";
import { checkExtraValue, decodeExtraText, decodeExtraValue, decodeSection, encodeSection } from "./extra";
import type {
  ChunkBatchOperation,
  ChunkChunkState,
  ChunkChunkStateExtra,
  ChunkChunkStateExtraInput,
  ChunkChunkStateInput,
  ChunkClientOptions,
  ChunkCoordPair,
  ChunkExtraValue,
  ChunkGetOptions,
  ChunkGetStateOptions,
  ChunkHelloInfo,
  ChunkHistoryEvent,
  ChunkHistoryOptions,
  ChunkHistoryPage,
  ChunkHistoryPoint,
  ChunkInfo,
  ChunkMutationResult,
  ChunkPutOptions,
  ChunkRangeEntry,
  ChunkReadOptions,
  ChunkScanResult,
  ChunkTableCreateOptions,
  ChunkTableInfo,
  ChunkTableOptions,
  ChunkWriteOptions,
  ParsedChunkUri,
} from "./types";
import { zrleCompress, zrleDecompress } from "./zrle";

type TransportSocket = net.Socket | tls.TLSSocket;

interface ResolvedOptions {
  host: string;
  port: number;
  token: string;
  secure: boolean;
  connectTimeoutMs: number;
  commandTimeoutMs: number;
  tlsInsecure: boolean;
  tlsServerName?: string;
  ca?: string | Buffer;
  cert?: string | Buffer;
  key?: string | Buffer;
  uri: ParsedChunkUri;
  pipelineDepth: number;
  table: string | null;
}

interface PendingRequest {
  command: string;
  timer: NodeJS.Timeout;
  resolve: (frame: ChunkFrame) => void;
  reject: (error: Error) => void;
}

const CRLF = Buffer.from("\r\n", "utf8");
const PROTOCOL_VERSION = 2;
const MAX_VERSION = (1n << 64n) - 1n;
const MAX_BLOCK_INDEX = 2 ** 32 - 1;

interface ChunkGeometryInfo {
  blockBits: number;
  chunkPayloadBytes: number;
  presenceBytes: number;
  blockCount: number;
}

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4242;
const DEFAULT_TIMEOUT_MS = 5000;

function isBitString(bits: string): boolean {
  return /^[01]+$/.test(bits);
}

function bulkText(item: BulkFrame | NullFrame, command: string): string {
  if (item.type !== "bulk") {
    throw new ChunkProtocolError(`unexpected null item in ${command} response`, {
      phase: "protocol",
      command,
    });
  }
  return item.value.toString("utf8");
}

function parseCoordinate(token: string, command: string): number {
  const value = Number.parseInt(token, 10);
  if (!Number.isSafeInteger(value) || String(value) !== token) {
    throw new ChunkProtocolError(`invalid coordinate in ${command} response: ${token}`, {
      phase: "protocol",
      command,
    });
  }
  return value;
}

function parseCoordPair(text: string, command: string): ChunkCoordPair {
  const parts = text.split(" ");
  if (parts.length !== 2) {
    throw new ChunkProtocolError(`unexpected ${command} coordinates: ${text}`, {
      phase: "protocol",
      command,
    });
  }
  return { cx: parseCoordinate(parts[0], command), cy: parseCoordinate(parts[1], command) };
}

// Payload commands (CHUNKPUT, XPUT) whose header the server cannot parse are
// refused without reading the bytes and the connection closes, so their
// arguments are checked first.
function checkSafeIntegers(command: string, values: Array<readonly [string, number]>): void {
  for (const [name, value] of values) {
    if (!Number.isSafeInteger(value)) {
      throw new ChunkProtocolError(`${command} ${name} must be a safe integer`, {
        phase: "request",
        command,
      });
    }
  }
}

function parseVersionText(text: string, command: string, name = "version"): bigint {
  if (!/^[0-9]+$/.test(text)) {
    throw new ChunkProtocolError(`invalid ${name} in ${command} response: ${text}`, {
      phase: "protocol",
      command,
    });
  }
  return BigInt(text);
}

function versionArgument(version: bigint, command: string, name = "ifVersion"): string {
  if (typeof version !== "bigint" || version < 0n || version > MAX_VERSION) {
    throw new ChunkProtocolError(`${command} ${name} must be an unsigned 64-bit bigint`, {
      phase: "request",
      command,
    });
  }
  return version.toString();
}

function requestError(message: string, command: string): ChunkProtocolError {
  return new ChunkProtocolError(`${command} ${message}`, { phase: "request", command });
}

function responseError(message: string, command: string): ChunkProtocolError {
  return new ChunkProtocolError(message, { phase: "protocol", command });
}

// A history cursor: `<revision>` or `<revision>:<block_index>`.
function isHistoryCursor(text: string): boolean {
  const match = /^([0-9]+)(?::([0-9]+))?$/.exec(text);
  return (
    match !== null &&
    BigInt(match[1]) <= MAX_VERSION &&
    (match[2] === undefined || Number(match[2]) <= MAX_BLOCK_INDEX)
  );
}

function cursorArgument(cursor: string | bigint, name: string, command: string): string {
  if (typeof cursor === "bigint") {
    return versionArgument(cursor, command, name);
  }
  // Checked in full: a cursor is a single argument of the request line.
  if (typeof cursor !== "string" || !isHistoryCursor(cursor)) {
    throw requestError(`${name} must be a cursor (<revision> or <revision>:<block_index>) or a bigint revision`, command);
  }
  return cursor;
}

function timeArgument(ms: number, name: string, command: string): number {
  if (!Number.isSafeInteger(ms) || ms < 0) {
    throw requestError(`${name} must be a non-negative integer of milliseconds`, command);
  }
  return ms;
}

// TAG <hex>: 1 to `maxTagBytes` (the server's max_tag_bytes) bytes. The
// table's own limit is checked by the server.
function tagHex(tag: Uint8Array, maxTagBytes: number, command: string): string {
  if (!(tag instanceof Uint8Array) || tag.length < 1 || tag.length > maxTagBytes) {
    throw requestError(`tag must be a Uint8Array of 1 to ${maxTagBytes} bytes`, command);
  }
  return Buffer.from(tag.buffer, tag.byteOffset, tag.byteLength).toString("hex");
}

// AT <revision> | AT TIME <ms>
function historyPointArgs(at: ChunkHistoryPoint, command: string): string[] {
  const { revision, timeMs } = (at ?? {}) as { revision?: bigint; timeMs?: number };
  if ((revision === undefined) === (timeMs === undefined)) {
    throw requestError("at must be { revision } or { timeMs }", command);
  }
  return revision !== undefined
    ? ["AT", versionArgument(revision, command, "at.revision")]
    : ["AT", "TIME", String(timeArgument(timeMs!, "at.timeMs", command))];
}

function historyOptionArgs(options: ChunkHistoryOptions, info: ChunkHelloInfo, command: string): Array<string | number> {
  const args: Array<string | number> = [];
  if (options.limit !== undefined) {
    if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > info.maxHistoryLimit) {
      throw requestError(`limit must be an integer from 1 to ${info.maxHistoryLimit}`, command);
    }
    args.push("LIMIT", options.limit);
  }
  if (options.order !== undefined) {
    if (options.order !== "asc" && options.order !== "desc") {
      throw requestError('order must be "asc" or "desc"', command);
    }
    args.push(options.order === "asc" ? "ASC" : "DESC");
  }
  if (options.after !== undefined) {
    args.push("AFTER", cursorArgument(options.after, "after", command));
  }
  if (options.before !== undefined) {
    args.push("BEFORE", cursorArgument(options.before, "before", command));
  }
  if (options.since !== undefined) {
    args.push("SINCE", timeArgument(options.since, "since", command));
  }
  if (options.until !== undefined) {
    args.push("UNTIL", timeArgument(options.until, "until", command));
  }
  if (options.tag !== undefined) {
    args.push("TAG", tagHex(options.tag, info.maxTagBytes, command));
  }
  return args;
}

// One event: `<revision> <time_ms> <x> <y> <before> <after> <before_extra>
// <after_extra> <tag>`, `-` for an absent block, no extra data or no tag.
function parseHistoryEvent(text: string, blockBits: number, command: string): ChunkHistoryEvent {
  const fields = text.split(" ");
  if (fields.length !== 9) {
    throw responseError(`unexpected ${command} event: ${text}`, command);
  }
  const [revision, timeMs, x, y, before, after, beforeExtra, afterExtra, tag] = fields;
  const time = Number(timeMs);
  if (!/^[0-9]+$/.test(timeMs) || !Number.isSafeInteger(time)) {
    throw responseError(`invalid time in ${command} response: ${timeMs}`, command);
  }
  const bits = (field: string): string | null => {
    if (field === "-") {
      return null;
    }
    if (field.length !== blockBits || !isBitString(field)) {
      throw responseError(`invalid block bits in ${command} response: ${field}`, command);
    }
    return field;
  };
  const extra = (field: string) => (field === "-" ? null : decodeExtraText(field, command));
  if (tag !== "-" && !/^(?:[0-9a-fA-F]{2})+$/.test(tag)) {
    throw responseError(`invalid tag in ${command} response: ${tag}`, command);
  }
  return {
    revision: parseVersionText(revision, command, "revision"),
    timeMs: time,
    x: parseCoordinate(x, command),
    y: parseCoordinate(y, command),
    before: bits(before),
    after: bits(after),
    beforeExtra: extra(beforeExtra),
    afterExtra: extra(afterExtra),
    tag: tag === "-" ? null : Buffer.from(tag, "hex"),
  };
}

// `END` or `CURSOR <cursor>`, then one item per event.
function parseHistoryPage(items: string[], blockBits: number, command: string): ChunkHistoryPage {
  if (items.length === 0) {
    throw responseError(`empty ${command} response`, command);
  }
  const header = items[0];
  let cursor: string | null = null;
  if (header.startsWith("CURSOR ")) {
    cursor = header.slice("CURSOR ".length);
    if (!isHistoryCursor(cursor)) {
      throw responseError(`invalid cursor in ${command} response: ${cursor}`, command);
    }
  } else if (header !== "END") {
    throw responseError(`unexpected ${command} header: ${header}`, command);
  }
  return { events: items.slice(1).map((item) => parseHistoryEvent(item, blockBits, command)), cursor };
}

/**
 * Every event of a history window, page by page until `END`: each cursor
 * moves the window's edge in the listing direction (`after` ascending,
 * `before` descending). Pages may be short or empty.
 */
export async function* followHistory(
  read: (options: ChunkHistoryOptions) => Promise<ChunkHistoryPage>,
  options: ChunkHistoryOptions,
): AsyncGenerator<ChunkHistoryEvent, void, undefined> {
  let next: ChunkHistoryOptions = { ...options };
  for (;;) {
    const page = await read(next);
    yield* page.events;
    if (page.cursor === null) {
      return;
    }
    next = options.order === "asc" ? { ...next, after: page.cursor } : { ...next, before: page.cursor };
  }
}

// Chunk bytes from the server, checked against the table's sizes.
function decodeChunkBytes(body: Buffer, expected: number, zrle: boolean, command: string): Buffer {
  if (zrle) {
    try {
      return zrleDecompress(body, expected);
    } catch (error) {
      throw new ChunkProtocolError(
        `invalid ${command} ZRLE payload: ${error instanceof Error ? error.message : String(error)}`,
        { phase: "protocol", command },
      );
    }
  }
  if (body.length !== expected) {
    throw new ChunkProtocolError(`${command} returned ${body.length} bytes, expected ${expected}`, {
      phase: "protocol",
      command,
    });
  }
  return body;
}

// A STATE EXTRA reply: the state followed by an EXTRA section of at most
// `maxSectionBytes`, which also bounds ZRLE decompression.
function decodeChunkStateExtraBytes(
  body: Buffer,
  stateBytes: number,
  maxSectionBytes: number,
  zrle: boolean,
  command: string,
): Buffer {
  const maxBytes = stateBytes + maxSectionBytes;
  if (zrle) {
    // The decoded size the encoding declares, checked before decoding. A
    // body too short to declare one fails in zrleDecompress.
    const declared = body.length >= 5 ? body.readUInt32LE(1) : stateBytes;
    if (declared < stateBytes || declared > maxBytes) {
      throw new ChunkProtocolError(
        `invalid ${command} ZRLE payload: it declares ${declared} bytes, expected ${stateBytes} to ${maxBytes}`,
        { phase: "protocol", command },
      );
    }
    return decodeChunkBytes(body, declared, true, command);
  }
  if (body.length < stateBytes || body.length > maxBytes) {
    throw new ChunkProtocolError(
      `${command} returned ${body.length} bytes, expected ${stateBytes} to ${maxBytes}`,
      { phase: "protocol", command },
    );
  }
  return body;
}

function splitChunkState(bytes: Buffer, geometry: ChunkGeometryInfo): ChunkChunkState {
  const payload = bytes.subarray(0, geometry.chunkPayloadBytes);
  const presence = bytes.subarray(geometry.chunkPayloadBytes);
  return { exists: presence.some((byte) => byte !== 0), payload, presence };
}

function resolveTlsServerName(options: ResolvedOptions): string | undefined {
  if (options.tlsServerName !== undefined && options.tlsServerName !== "") {
    return options.tlsServerName;
  }
  return net.isIP(options.host) === 0 ? options.host : undefined;
}

function resolveOptions(options: ChunkClientOptions = {}): ResolvedOptions {
  const parsed = options.uri ? parseChunkUri(options.uri) : null;
  const secure = options.tls ?? parsed?.secure ?? false;
  const host = options.host ?? parsed?.host ?? DEFAULT_HOST;
  const port = options.port ?? parsed?.port ?? DEFAULT_PORT;
  const token = options.token ?? parsed?.token ?? "";
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const table =
    options.table !== undefined && options.table !== ""
      ? options.table
      : tableFromUriPath(parsed?.path ?? "/");

  return {
    host,
    port,
    token,
    secure,
    connectTimeoutMs,
    commandTimeoutMs,
    tlsInsecure: options.tlsInsecure ?? false,
    tlsServerName: options.tlsServerName,
    ca: options.ca,
    cert: options.cert,
    key: options.key,
    pipelineDepth: Math.max(1, options.pipelineDepth ?? 1),
    table,
    uri: {
      scheme: secure ? "chunks" : "chunk",
      secure,
      host,
      port,
      token,
      path: table === null ? "/" : `/${encodeURIComponent(table)}`,
    },
  };
}

const TABLE_OPTION_KEYS: Array<[keyof ChunkTableOptions, string]> = [
  ["durabilityMode", "durability_mode"],
  ["checkpointUpdates", "checkpoint_updates"],
  ["checkpointWalBytes", "checkpoint_wal_bytes"],
  ["walGroupCommitUpdates", "wal_group_commit_updates"],
  ["checkpointCompression", "checkpoint_compression"],
  ["extraMaxBlockBits", "extra_max_block_bits"],
  ["extraMaxChunkBytes", "extra_max_chunk_bytes"],
  ["history", "history"],
  ["historyMaxAgeMs", "history_max_age_ms"],
  ["historyMaxChunkBytes", "history_max_chunk_bytes"],
  ["historyMaxTagBytes", "history_max_tag_bytes"],
];

// A count a server without extra data or history does not report: 0 when absent.
function optionalCount(values: Record<string, string>, key: string, command: string): number {
  const text = values[key];
  if (text === undefined) {
    return 0;
  }
  const parsed = Number(text);
  if (!/^[0-9]+$/.test(text) || !Number.isSafeInteger(parsed)) {
    throw new ChunkProtocolError(`${command} has invalid ${key}: ${text}`, { phase: "protocol", command });
  }
  return parsed;
}

// `history` is `on` or `off`; a server without history does not report it.
function historySwitch(values: Record<string, string>, command: string): boolean {
  const text = values.history;
  if (text === undefined || text === "off") {
    return false;
  }
  if (text !== "on") {
    throw new ChunkProtocolError(`${command} has invalid history: ${text}`, { phase: "protocol", command });
  }
  return true;
}

// A revision a server without history does not report: 0n when absent.
function optionalRevision(values: Record<string, string>, key: string, command: string): bigint {
  const text = values[key];
  if (text === undefined) {
    return 0n;
  }
  if (!/^[0-9]+$/.test(text)) {
    throw new ChunkProtocolError(`${command} has invalid ${key}: ${text}`, { phase: "protocol", command });
  }
  return BigInt(text);
}

function tableOptionArgs(options: ChunkTableOptions): Array<string | number> {
  const args: Array<string | number> = [];
  for (const [field, key] of TABLE_OPTION_KEYS) {
    const value = options[field];
    if (value !== undefined) {
      args.push(key, typeof value === "boolean" ? (value ? "on" : "off") : value);
    }
  }
  return args;
}

function parseTableInfo(payload: Buffer, command: string): ChunkTableInfo {
  const values = parseInfoPayload(payload);
  const integer = (key: string): number => {
    const parsed = Number(values[key]);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      throw new ChunkProtocolError(`${command} missing valid ${key}`, {
        phase: "protocol",
        command,
      });
    }
    return parsed;
  };
  const text = (key: string): string => {
    const value = values[key];
    if (value === undefined || value === "") {
      throw new ChunkProtocolError(`${command} missing ${key}`, { phase: "protocol", command });
    }
    return value;
  };
  return {
    name: text("table"),
    storeId: text("store_id"),
    blockBits: integer("block_bits"),
    chunkWidthBlocks: integer("chunk_width_blocks"),
    chunkHeightBlocks: integer("chunk_height_blocks"),
    largeChunkWidthChunks: integer("large_chunk_width_chunks"),
    largeChunkHeightChunks: integer("large_chunk_height_chunks"),
    durabilityMode: text("durability_mode"),
    checkpointUpdates: integer("checkpoint_updates"),
    checkpointWalBytes: integer("checkpoint_wal_bytes"),
    walGroupCommitUpdates: integer("wal_group_commit_updates"),
    checkpointCompression: text("checkpoint_compression"),
    extraMaxBlockBits: optionalCount(values, "extra_max_block_bits", command),
    extraMaxChunkBytes: optionalCount(values, "extra_max_chunk_bytes", command),
    history: historySwitch(values, command),
    historyStart: optionalRevision(values, "history_start", command),
    historyStartTimeMs: optionalCount(values, "history_start_time_ms", command),
    historyMaxAgeMs: optionalCount(values, "history_max_age_ms", command),
    historyMaxChunkBytes: optionalCount(values, "history_max_chunk_bytes", command),
    historyMaxTagBytes: optionalCount(values, "history_max_tag_bytes", command),
    values,
  };
}

function geometryOf(info: { blockBits: number; chunkWidthBlocks: number; chunkHeightBlocks: number }): ChunkGeometryInfo {
  const chunkBlockCount = info.chunkWidthBlocks * info.chunkHeightBlocks;
  return {
    blockBits: info.blockBits,
    chunkPayloadBytes: Math.ceil((chunkBlockCount * info.blockBits) / 8),
    presenceBytes: Math.ceil(chunkBlockCount / 8),
    blockCount: chunkBlockCount,
  };
}

function parseHelloInfo(payload: Buffer): ChunkHelloInfo {
  const values = parseInfoPayload(payload);
  if (values.protocol !== String(PROTOCOL_VERSION)) {
    throw new ChunkProtocolError(
      `server replied with protocol ${values.protocol ?? "(none)"}, expected ${PROTOCOL_VERSION}`,
      { phase: "protocol", command: "HELLO" },
    );
  }
  const integer = (key: string): number => {
    const parsed = Number(values[key]);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      throw new ChunkProtocolError(`HELLO missing valid ${key}`, { phase: "protocol", command: "HELLO" });
    }
    return parsed;
  };
  return {
    protocol: PROTOCOL_VERSION,
    serverVersion: values.server_version ?? "",
    capabilities: (values.capabilities ?? "").split(",").filter((name) => name !== ""),
    maxLineBytes: integer("max_line_bytes"),
    maxAreaChunks: integer("max_area_chunks"),
    maxResponseBytes: integer("max_response_bytes"),
    maxScanLimit: integer("max_scan_limit"),
    maxBatchOps: integer("max_batch_ops"),
    maxExtraChunkBytes: optionalCount(values, "max_extra_chunk_bytes", "HELLO"),
    maxTagBytes: optionalCount(values, "max_tag_bytes", "HELLO"),
    maxHistoryLimit: optionalCount(values, "max_history_limit", "HELLO"),
    // Without a `default` table and without TABLE, the connection has none.
    table: values.table === undefined ? null : parseTableInfo(payload, "HELLO"),
    values,
  };
}


// The place of one operation in the order requests are written (see
// ChunkClient.sendTurns).
interface SendTurn {
  previous: Promise<void>;
  release: () => void;
}

export class ChunkClient {
  private readonly clientOptions: ChunkClientOptions;
  private readonly options: ResolvedOptions;
  private socket: TransportSocket | null = null;
  private pendingQueue: PendingRequest[] = [];
  private connectPromise: Promise<this> | null = null;
  private buffer = Buffer.alloc(0);
  private connected = false;
  private disposed = false;
  private geometryInfo: ChunkGeometryInfo | null = null;
  private helloInfo: ChunkHelloInfo | null = null;
  // The table this connection works on; null means the server's `default`.
  private selectedTable: string | null;

  // Pipeline concurrency tracking
  private activeOps = 0;
  private readonly maxPipeline: number;
  // Requests reach the wire in the order their operations started, whatever
  // each awaits before sending: an operation writes its first request only
  // after the operation started before it wrote its own (or ended).
  private readonly sendTurns = new AsyncLocalStorage<SendTurn>();
  private lastSendTurn: Promise<void> = Promise.resolve();
  private readonly opWaiters: Array<{ run: () => void; reject: (err: Error) => void; exclusive: boolean }> = [];
  // An exclusive operation (USE) runs alone: nothing else is in flight.
  private exclusiveRunning = false;

  constructor(options: ChunkClientOptions = {}) {
    this.clientOptions = { ...options };
    this.options = resolveOptions(options);
    this.maxPipeline = this.options.pipelineDepth;
    this.selectedTable = this.options.table;
  }

  uri(): string {
    return formatChunkUri({
      ...this.options.uri,
      path: this.selectedTable === null ? "/" : `/${encodeURIComponent(this.selectedTable)}`,
    });
  }

  /** The table this connection works on (`"default"` unless one was selected). */
  currentTable(): string {
    return this.selectedTable ?? "default";
  }

  /** Table names, in ascending order. */
  tables(): Promise<string[]> {
    return this.enqueue(async () => {
      const frame = await this.sendCommand("TABLES", []);
      return this.expectArray(frame, "TABLES").map((item) => bulkText(item, "TABLES"));
    });
  }

  tableInfo(name: string): Promise<ChunkTableInfo> {
    return this.enqueue(async () => {
      const frame = await this.sendCommand("TABLEINFO", [name]);
      return parseTableInfo(this.expectBulk(frame, "TABLEINFO"), "TABLEINFO");
    });
  }

  /**
   * Selects the table for this connection (kept across reconnects). An unknown
   * name fails with `NO_TABLE` and keeps the current table.
   */
  use(name: string): Promise<ChunkTableInfo> {
    // USE changes the sizes chunk requests are checked and framed with, so it
    // waits for the requests in flight and holds back new ones until its
    // reply: each request runs entirely on the old or the new table.
    return this.enqueue(async () => await this.useTable(name), true);
  }

  /** Creates a table. Its geometry is fixed; options can change later. */
  createTable(name: string, options: ChunkTableCreateOptions): Promise<void> {
    return this.enqueue(async () => {
      const args: Array<string | number> = [name, "block_bits", options.blockBits];
      const geometry: Array<[number | undefined, string]> = [
        [options.chunkWidthBlocks, "chunk_width_blocks"],
        [options.chunkHeightBlocks, "chunk_height_blocks"],
        [options.largeChunkWidthChunks, "large_chunk_width_chunks"],
        [options.largeChunkHeightChunks, "large_chunk_height_chunks"],
      ];
      for (const [value, key] of geometry) {
        if (value !== undefined) {
          args.push(key, value);
        }
      }
      args.push(...tableOptionArgs(options));
      this.expectOk(await this.sendCommand("TABLECREATE", args), "TABLECREATE");
    });
  }

  /** Changes table options; the server reopens the table. */
  setTableOptions(name: string, options: ChunkTableOptions): Promise<void> {
    return this.enqueue(async () => {
      const args = tableOptionArgs(options);
      if (args.length === 0) {
        throw new TypeError("setTableOptions needs at least one option");
      }
      this.expectOk(await this.sendCommand("TABLESET", [name, ...args]), "TABLESET");
    });
  }

  /** Deletes a table and its data. Irreversible. */
  dropTable(name: string): Promise<void> {
    return this.enqueue(async () => {
      this.expectOk(await this.sendCommand("TABLEDROP", [name]), "TABLEDROP");
    });
  }

  /**
   * A new connected client for `name`, with this client's connection options.
   * Each client has its own connection; close it when done.
   */
  async table(name: string): Promise<ChunkClient> {
    const client = new ChunkClient({ ...this.clientOptions, table: name });
    try {
      await client.connect();
    } catch (error) {
      await client.close();
      throw error;
    }
    return client;
  }

  async connect(): Promise<this> {
    if (this.disposed) {
      throw new ChunkConnectionError("client is closed", { phase: "connect" });
    }
    if (this.connected) {
      return this;
    }
    if (this.connectPromise !== null) {
      return this.connectPromise;
    }

    this.connectPromise = this.connectInternal().finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  async close(): Promise<void> {
    this.disposed = true;
    const socket = this.socket;
    this.clearConnectionState(new ChunkConnectionError("connection closed", { phase: "connect" }));

    if (socket === null) {
      return;
    }

    await new Promise<void>((resolve) => {
      let finished = false;
      const finish = () => {
        if (finished) {
          return;
        }
        finished = true;
        resolve();
      };

      socket.once("close", finish);
      socket.once("error", finish);
      socket.end();
      setTimeout(() => {
        socket.destroy();
        finish();
      }, 200);
    });
  }

  /** The server's `HELLO` reply for the current connection; null before connecting. */
  serverInfo(): ChunkHelloInfo | null {
    return this.helloInfo;
  }

  ping(): Promise<"PONG"> {
    return this.enqueue(async () => {
      const frame = await this.sendCommand("PING", []);
      const text = this.expectSimple(frame, "PING");
      if (text !== "PONG") {
        throw new ChunkProtocolError(`unexpected PING response: ${text}`, {
          phase: "protocol",
          command: "PING",
        });
      }
      return "PONG" as const;
    });
  }

  info(): Promise<ChunkInfo> {
    return this.enqueue(async () => {
      const frame = await this.sendCommand("INFO", []);
      const payload = this.expectBulk(frame, "INFO");
      return {
        raw: payload.toString("utf8"),
        values: parseInfoPayload(payload),
      };
    });
  }

  /** A block's bits, or null when the block is unset. With `at`, as they were then. */
  get(x: number, y: number, options: ChunkReadOptions = {}): Promise<string | null> {
    return this.enqueue(async () => {
      const at = await this.atArgs(options.at, "GET");
      const frame = await this.sendCommand("GET", [x, y, ...at]);
      return this.expectBulkOrNull(frame, "GET")?.toString("utf8") ?? null;
    });
  }

  set(x: number, y: number, bits: string, options: ChunkWriteOptions = {}): Promise<void> {
    return this.enqueue(async () => {
      if (!isBitString(bits)) {
        throw new ChunkProtocolError("SET bits must contain only 0 and 1", {
          phase: "request",
          command: "SET",
        });
      }
      const tag = await this.tagArgs(options.tag, "SET");
      this.expectOk(await this.sendCommand("SET", [x, y, bits, ...tag]), "SET");
    });
  }

  unset(x: number, y: number, options: ChunkWriteOptions = {}): Promise<void> {
    return this.enqueue(async () => {
      const tag = await this.tagArgs(options.tag, "UNSET");
      this.expectOk(await this.sendCommand("UNSET", [x, y, ...tag]), "UNSET");
    });
  }

  /** With `tag`, every block's event carries it. */
  mset(blocks: Array<{ x: number; y: number; bits: string }>, options: ChunkWriteOptions = {}): Promise<void> {
    return this.enqueue(async () => {
      if (blocks.length === 0) return;
      const args: Array<string | number> = [];
      for (const { x, y, bits } of blocks) {
        if (!isBitString(bits)) {
          throw new ChunkProtocolError("MSET bits must contain only 0 and 1", {
            phase: "request",
            command: "MSET",
          });
        }
        args.push(x, y, bits);
      }
      args.push(...(await this.tagArgs(options.tag, "MSET")));
      this.expectOk(await this.sendCommand("MSET", args), "MSET");
    });
  }

  /** Bits per requested block, in request order; null for an unset block. */
  mget(blocks: Array<{ x: number; y: number }>): Promise<Array<string | null>> {
    return this.enqueue(async () => {
      if (blocks.length === 0) return [];
      const args: Array<string | number> = [];
      for (const { x, y } of blocks) {
        args.push(x, y);
      }
      const frame = await this.sendCommand("MGET", args);
      const items = this.expectArray(frame, "MGET");
      if (items.length !== blocks.length) {
        throw new ChunkProtocolError(
          `MGET returned ${items.length} items for ${blocks.length} blocks`,
          { phase: "protocol", command: "MGET" },
        );
      }
      return items.map((item) => (item.type === "null" ? null : item.value.toString("utf8")));
    });
  }

  chunkExists(cx: number, cy: number): Promise<boolean> {
    return this.enqueue(async () => {
      const frame = await this.sendCommand("CHUNKEXISTS", [cx, cy]);
      const text = this.expectSimple(frame, "CHUNKEXISTS");
      if (text === "1") {
        return true;
      }
      if (text === "0") {
        return false;
      }
      throw new ChunkProtocolError(`unexpected CHUNKEXISTS response: ${text}`, {
        phase: "protocol",
        command: "CHUNKEXISTS",
      });
    });
  }

  /**
   * The chunk's packed block payload. An absent chunk reads as zeros; use
   * `getChunkState` or `chunkExists` to tell it from an all-zero chunk. With
   * `at`, as it was then.
   */
  getChunk(cx: number, cy: number, options: ChunkGetOptions = {}): Promise<Buffer> {
    return this.enqueue(async () => {
      await this.ensureConnected();
      const geometry = this.requireGeometry("CHUNKGET");
      const zrle = options.zrle === true;
      const at = await this.atArgs(options.at, "CHUNKGET");
      const frame = await this.sendCommand("CHUNKGET", [cx, cy, ...(zrle ? ["ZRLE"] : []), ...at]);
      return decodeChunkBytes(this.expectBulk(frame, "CHUNKGET"), geometry.chunkPayloadBytes, zrle, "CHUNKGET");
    });
  }

  /**
   * The chunk's payload and presence bitmap. With `extra`, also all of its
   * extra data by block index (a table with extra data only). With `at`, as
   * it was then.
   */
  getChunkState(cx: number, cy: number, options: ChunkGetStateOptions & { extra: true }): Promise<ChunkChunkStateExtra>;
  getChunkState(cx: number, cy: number, options?: ChunkGetStateOptions): Promise<ChunkChunkState>;
  getChunkState(cx: number, cy: number, options: ChunkGetStateOptions = {}): Promise<ChunkChunkState | ChunkChunkStateExtra> {
    return this.enqueue(async () => {
      await this.ensureConnected();
      const geometry = this.requireGeometry("CHUNKGET");
      const zrle = options.zrle === true;
      const extra = options.extra === true;
      const args: Array<string | number> = [cx, cy, "STATE"];
      if (extra) {
        args.push("EXTRA");
      }
      if (zrle) {
        args.push("ZRLE");
      }
      args.push(...(await this.atArgs(options.at, "CHUNKGET")));
      const body = this.expectBulk(await this.sendCommand("CHUNKGET", args), "CHUNKGET");
      const stateBytes = geometry.chunkPayloadBytes + geometry.presenceBytes;
      if (!extra) {
        return splitChunkState(decodeChunkBytes(body, stateBytes, zrle, "CHUNKGET"), geometry);
      }
      // Bounded by the server's cap, not the table's extra_max_chunk_bytes:
      // another connection may have raised that since this one read it.
      const bytes = decodeChunkStateExtraBytes(body, stateBytes, this.maxExtraChunkBytes(), zrle, "CHUNKGET");
      return {
        ...splitChunkState(bytes.subarray(0, stateBytes), geometry),
        extra: decodeSection(bytes.subarray(stateBytes), geometry.blockCount, "CHUNKGET"),
      };
    });
  }

  /**
   * Replaces the chunk's payload; every block becomes explicitly present.
   * With `ifVersion`, the write applies only if the chunk still has that
   * version; otherwise the result has `ok: false` and the current version.
   */
  putChunk(cx: number, cy: number, payload: Buffer, options: ChunkPutOptions = {}): Promise<ChunkMutationResult> {
    return this.enqueue(async () => {
      await this.ensureConnected();
      const geometry = this.requireGeometry("CHUNKPUT");
      if (payload.length !== geometry.chunkPayloadBytes) {
        throw new ChunkProtocolError(`CHUNKPUT payload must be ${geometry.chunkPayloadBytes} bytes`, {
          phase: "request",
          command: "CHUNKPUT",
        });
      }
      return await this.putChunkBytes(cx, cy, payload, [], options);
    });
  }

  /**
   * Replaces the chunk's payload and presence bitmap; payload bits of absent
   * blocks are stored as zero. With `extra`, also replaces all of the
   * chunk's extra data (each value must belong to a block the new state has
   * present); without, the extra data of blocks that stay present is kept.
   * `ifVersion` works as for `putChunk`.
   */
  putChunkState(
    cx: number,
    cy: number,
    state: ChunkChunkStateInput | ChunkChunkStateExtraInput,
    options: ChunkPutOptions = {},
  ): Promise<ChunkMutationResult> {
    return this.enqueue(async () => {
      await this.ensureConnected();
      const geometry = this.requireGeometry("CHUNKPUT");
      if (state.payload.length !== geometry.chunkPayloadBytes) {
        throw new ChunkProtocolError(`CHUNKPUT STATE payload must be ${geometry.chunkPayloadBytes} bytes`, {
          phase: "request",
          command: "CHUNKPUT",
        });
      }
      if (state.presence.length !== geometry.presenceBytes) {
        throw new ChunkProtocolError(`CHUNKPUT STATE presence must be ${geometry.presenceBytes} bytes`, {
          phase: "request",
          command: "CHUNKPUT",
        });
      }
      const extra = "extra" in state ? state.extra : undefined;
      if (extra === undefined) {
        return await this.putChunkBytes(cx, cy, Buffer.concat([state.payload, state.presence]), ["STATE"], options);
      }
      this.requireExtraData("CHUNKPUT");
      const section = encodeSection(extra, geometry.blockCount, "CHUNKPUT");
      // A longer body is refused unread and closes the connection.
      if (section.length > this.maxExtraChunkBytes()) {
        throw new ChunkProtocolError(
          `CHUNKPUT EXTRA section of ${section.length} bytes exceeds max_extra_chunk_bytes (${this.maxExtraChunkBytes()})`,
          { phase: "request", command: "CHUNKPUT" },
        );
      }
      return await this.putChunkBytes(
        cx,
        cy,
        Buffer.concat([state.payload, state.presence, section]),
        ["STATE", "EXTRA"],
        options,
      );
    });
  }

  /**
   * A block's extra data, or null when it has none. The table must have
   * extra data (`extraMaxBlockBits` above 0).
   */
  xget(x: number, y: number): Promise<ChunkExtraValue | null> {
    return this.enqueue(async () => {
      const reply = this.expectBulkOrNull(await this.sendCommand("XGET", [x, y]), "XGET");
      return reply === null ? null : decodeExtraValue(reply, "XGET");
    });
  }

  /**
   * Sets the extra data of a present block: `bitLength` bits in
   * `ceil(bitLength / 8)` bytes, or every bit of a byte array.
   */
  xput(x: number, y: number, value: ChunkExtraValue | Uint8Array, options: ChunkWriteOptions = {}): Promise<void> {
    return this.enqueue(async () => {
      await this.ensureConnected();
      this.requireGeometry("XPUT");
      this.requireExtraData("XPUT");
      if (value instanceof Uint8Array && value.length === 0) {
        throw new ChunkProtocolError("xput value must not be empty", { phase: "request", command: "XPUT" });
      }
      const extra = value instanceof Uint8Array ? { bitLength: value.length * 8, bytes: value } : value;
      checkSafeIntegers("XPUT", [["x", x], ["y", y]]);
      checkExtraValue(extra, "XPUT");
      const bytes = Buffer.from(extra.bytes.buffer, extra.bytes.byteOffset, extra.bytes.byteLength);
      // A longer value is refused unread and closes the connection.
      const maxValueBytes = this.maxExtraChunkBytes() - 8;
      if (bytes.length > maxValueBytes) {
        throw new ChunkProtocolError(
          `XPUT value of ${bytes.length} bytes exceeds max_extra_chunk_bytes minus 8 (${maxValueBytes})`,
          { phase: "request", command: "XPUT" },
        );
      }
      const tag = await this.tagArgs(options.tag, "XPUT");
      this.expectOk(await this.sendCommand("XPUT", [x, y, extra.bitLength, ...tag, bytes.length], bytes), "XPUT");
    });
  }

  /** Deletes a block's extra data; resolves also when it had none. */
  xdel(x: number, y: number, options: ChunkWriteOptions = {}): Promise<void> {
    return this.enqueue(async () => {
      const tag = await this.tagArgs(options.tag, "XDEL");
      this.expectOk(await this.sendCommand("XDEL", [x, y, ...tag]), "XDEL");
    });
  }

  chunkScan(limit: number, cursor?: ChunkCoordPair): Promise<ChunkScanResult> {
    return this.enqueue(async () => {
      const args: Array<string | number> =
        cursor === undefined ? [limit] : [limit, cursor.cx, cursor.cy];
      const frame = await this.sendCommand("CHUNKSCAN", args);
      const items = this.expectArray(frame, "CHUNKSCAN").map((item) => bulkText(item, "CHUNKSCAN"));
      if (items.length === 0) {
        throw new ChunkProtocolError("empty CHUNKSCAN response", {
          phase: "protocol",
          command: "CHUNKSCAN",
        });
      }

      const header = items[0];
      let nextCursor: ChunkCoordPair | null = null;
      if (header.startsWith("CURSOR ")) {
        nextCursor = parseCoordPair(header.slice("CURSOR ".length), "CHUNKSCAN");
      } else if (header !== "END") {
        throw new ChunkProtocolError(`unexpected CHUNKSCAN header: ${header}`, {
          phase: "protocol",
          command: "CHUNKSCAN",
        });
      }

      const coords = items.slice(1).map((item) => parseCoordPair(item, "CHUNKSCAN"));
      return { coords, nextCursor };
    });
  }

  /** Populated chunks in the rectangle, with payload and presence. With `at`, as they were then. */
  chunkRange(
    cx0: number,
    cy0: number,
    cx1: number,
    cy1: number,
    options: ChunkGetOptions = {},
  ): Promise<ChunkRangeEntry[]> {
    return this.enqueue(async () => await this.readArea("CHUNKRANGE", [cx0, cy0, cx1, cy1], options));
  }

  /** Populated chunks within `radiusChunks` of a chunk, with payload and presence. With `at`, as they were then. */
  chunkRadius(
    cx: number,
    cy: number,
    radiusChunks: number,
    options: ChunkGetOptions = {},
  ): Promise<ChunkRangeEntry[]> {
    return this.enqueue(async () => await this.readArea("CHUNKRADIUS", [cx, cy, radiusChunks], options));
  }

  chunkVersion(cx: number, cy: number): Promise<bigint> {
    return this.enqueue(async () => {
      const frame = await this.sendCommand("CHUNKVER", [cx, cy]);
      return parseVersionText(this.expectBulk(frame, "CHUNKVER").toString("utf8"), "CHUNKVER");
    });
  }

  chunkBatch(
    cx: number,
    cy: number,
    operations: ChunkBatchOperation[],
    options: { ifVersion?: bigint; tag?: Uint8Array } = {},
  ): Promise<ChunkMutationResult> {
    return this.enqueue(async () => {
      if (operations.length === 0) {
        throw new ChunkProtocolError("chunkBatch requires at least one operation", {
          phase: "request",
          command: "CHUNKBATCH",
        });
      }
      const args: Array<string | number> = [cx, cy];
      if (options.ifVersion !== undefined) {
        args.push("IF", versionArgument(options.ifVersion, "CHUNKBATCH"));
      }
      args.push(...(await this.tagArgs(options.tag, "CHUNKBATCH")));
      for (const operation of operations) {
        if (operation.type === "set" || operation.type === "xput") {
          if (!isBitString(operation.bits)) {
            throw new ChunkProtocolError(`chunkBatch ${operation.type} bits must contain only 0 and 1`, {
              phase: "request",
              command: "CHUNKBATCH",
            });
          }
          args.push(operation.type === "set" ? "SET" : "XPUT", operation.x, operation.y, operation.bits);
        } else if (operation.type === "unset" || operation.type === "xdel") {
          args.push(operation.type === "unset" ? "UNSET" : "XDEL", operation.x, operation.y);
        } else {
          throw new ChunkProtocolError(
            `unknown chunkBatch operation type: ${String((operation as { type: unknown }).type)}`,
            { phase: "request", command: "CHUNKBATCH" },
          );
        }
      }
      return await this.versionedWrite("CHUNKBATCH", args);
    });
  }

  /**
   * One page of a block's history, newest first unless `order` is `"asc"`.
   * Pass `cursor` back as `after` (ascending) or `before` (descending) for
   * the next page; null ends the window.
   */
  history(x: number, y: number, options: ChunkHistoryOptions = {}): Promise<ChunkHistoryPage> {
    return this.enqueue(async () => await this.readHistory("HISTORY", [x, y], options));
  }

  /** One page of a chunk's history; see `history`. */
  chunkHistory(cx: number, cy: number, options: ChunkHistoryOptions = {}): Promise<ChunkHistoryPage> {
    return this.enqueue(async () => await this.readHistory("CHUNKHISTORY", [cx, cy], options));
  }

  /** One page of the history of the chunks in a rectangle (at most 256); see `history`. */
  rangeHistory(
    cx0: number,
    cy0: number,
    cx1: number,
    cy1: number,
    options: ChunkHistoryOptions = {},
  ): Promise<ChunkHistoryPage> {
    return this.enqueue(async () => await this.readHistory("RANGEHISTORY", [cx0, cy0, cx1, cy1], options));
  }

  /** Every event of a block's history in the window `options` sets, read page by page. */
  historyEvents(x: number, y: number, options: ChunkHistoryOptions = {}): AsyncIterableIterator<ChunkHistoryEvent> {
    return followHistory(async (page) => await this.history(x, y, page), options);
  }

  /** Every event of a chunk's history in the window `options` sets, read page by page. */
  chunkHistoryEvents(cx: number, cy: number, options: ChunkHistoryOptions = {}): AsyncIterableIterator<ChunkHistoryEvent> {
    return followHistory(async (page) => await this.chunkHistory(cx, cy, page), options);
  }

  /** Every event of a rectangle's history in the window `options` sets, read page by page. */
  rangeHistoryEvents(
    cx0: number,
    cy0: number,
    cx1: number,
    cy1: number,
    options: ChunkHistoryOptions = {},
  ): AsyncIterableIterator<ChunkHistoryEvent> {
    return followHistory(async (page) => await this.rangeHistory(cx0, cy0, cx1, cy1, page), options);
  }

  walFlush(): Promise<void> {
    return this.enqueue(async () => {
      const frame = await this.sendCommand("WALFLUSH", []);
      const text = this.expectSimple(frame, "WALFLUSH");
      if (text !== "OK") {
        throw new ChunkProtocolError(`unexpected WALFLUSH response: ${text}`, {
          phase: "protocol",
          command: "WALFLUSH",
        });
      }
    });
  }

  metrics(): Promise<string> {
    return this.enqueue(async () => {
      const frame = await this.sendCommand("METRICS", []);
      return this.expectBulk(frame, "METRICS").toString("utf8");
    });
  }

  private requireGeometry(command: string): ChunkGeometryInfo {
    if (this.geometryInfo === null) {
      throw new ChunkProtocolError(`${command} needs a table: the server has no default table; select one with use()`, {
        phase: "request",
        command,
      });
    }
    return this.geometryInfo;
  }

  // XPUT and CHUNKPUT ... EXTRA carry bytes after the request line, which a
  // server without extra data would misread, so they go only to a server
  // that lists the capability.
  private requireExtraData(command: string): void {
    if (this.helloInfo?.capabilities.includes("extra-data") !== true) {
      throw new ChunkProtocolError(`${command} needs a server with extra data (capability "extra-data")`, {
        phase: "request",
        command,
      });
    }
  }

  private maxExtraChunkBytes(): number {
    return this.helloInfo?.maxExtraChunkBytes ?? 0;
  }

  // A tag in a CHUNKPUT or XPUT header is something a server without history
  // cannot parse, so it refuses the bytes unread and closes the connection.
  // Tags, AT and history listings go only to a server that lists the
  // capability.
  private requireHistory(command: string): ChunkHelloInfo {
    const info = this.helloInfo;
    if (info === null || !info.capabilities.includes("history")) {
      throw new ChunkProtocolError(`${command} needs a server with block history (capability "history")`, {
        phase: "request",
        command,
      });
    }
    return info;
  }

  private async tagArgs(tag: Uint8Array | undefined, command: string): Promise<string[]> {
    if (tag === undefined) {
      return [];
    }
    await this.ensureConnected();
    return ["TAG", tagHex(tag, this.requireHistory(command).maxTagBytes, command)];
  }

  private async atArgs(at: ChunkHistoryPoint | undefined, command: string): Promise<string[]> {
    if (at === undefined) {
      return [];
    }
    const args = historyPointArgs(at, command);
    await this.ensureConnected();
    this.requireHistory(command);
    return args;
  }

  private async readHistory(
    command: "HISTORY" | "CHUNKHISTORY" | "RANGEHISTORY",
    coords: number[],
    options: ChunkHistoryOptions,
  ): Promise<ChunkHistoryPage> {
    await this.ensureConnected();
    const geometry = this.requireGeometry(command);
    const args = [...coords, ...historyOptionArgs(options, this.requireHistory(command), command)];
    const items = this.expectArray(await this.sendCommand(command, args), command).map((item) => bulkText(item, command));
    return parseHistoryPage(items, geometry.blockBits, command);
  }

  private async putChunkBytes(
    cx: number,
    cy: number,
    bytes: Buffer,
    form: Array<"STATE" | "EXTRA">,
    options: ChunkPutOptions,
  ): Promise<ChunkMutationResult> {
    checkSafeIntegers("CHUNKPUT", [["cx", cx], ["cy", cy]]);
    const tag = await this.tagArgs(options.tag, "CHUNKPUT");
    const args: Array<string | number> = [cx, cy, ...form];
    let body = bytes;
    if (options.zrle === true) {
      const compressed = zrleCompress(bytes);
      if (compressed.length < bytes.length) {
        body = compressed;
        args.push("ZRLE");
      }
    }
    if (options.ifVersion !== undefined) {
      args.push("IF", versionArgument(options.ifVersion, "CHUNKPUT"));
    }
    args.push(...tag, body.length);
    return await this.versionedWrite("CHUNKPUT", args, body);
  }

  // CHUNKPUT and CHUNKBATCH reply with the chunk version, or VERSION_MISMATCH
  // with the current one.
  private async versionedWrite(
    command: string,
    args: Array<string | number>,
    payload?: Buffer,
  ): Promise<ChunkMutationResult> {
    try {
      const frame = await this.sendCommand(command, args, payload);
      return { ok: true, version: parseVersionText(this.expectBulk(frame, command).toString("utf8"), command) };
    } catch (error) {
      if (!(error instanceof ChunkServerError) || error.code !== "VERSION_MISMATCH") {
        throw error;
      }
      const match = /^current=([0-9]+)$/.exec(error.serverMessage);
      if (match === null) {
        throw new ChunkProtocolError(`unexpected VERSION_MISMATCH payload for ${command}`, {
          phase: "protocol",
          command,
        });
      }
      return { ok: false, version: BigInt(match[1]) };
    }
  }

  private async readArea(
    command: "CHUNKRANGE" | "CHUNKRADIUS",
    coords: number[],
    options: ChunkGetOptions,
  ): Promise<ChunkRangeEntry[]> {
    await this.ensureConnected();
    const geometry = this.requireGeometry(command);
    const zrle = options.zrle === true;
    const args: Array<string | number> = [...coords, "STATE"];
    if (zrle) {
      args.push("ZRLE");
    }
    args.push(...(await this.atArgs(options.at, command)));
    const items = this.expectArray(await this.sendCommand(command, args), command);
    if (items.length % 2 !== 0) {
      throw new ChunkProtocolError(`${command} returned an odd number of items`, {
        phase: "protocol",
        command,
      });
    }
    const entries: ChunkRangeEntry[] = [];
    for (let i = 0; i < items.length; i += 2) {
      const { cx, cy } = parseCoordPair(bulkText(items[i], command), command);
      const body = items[i + 1];
      if (body.type !== "bulk") {
        throw new ChunkProtocolError(`${command} returned a null chunk`, { phase: "protocol", command });
      }
      const bytes = decodeChunkBytes(body.value, geometry.chunkPayloadBytes + geometry.presenceBytes, zrle, command);
      const { payload, presence } = splitChunkState(bytes, geometry);
      entries.push({ cx, cy, payload, presence });
    }
    return entries;
  }

  private enqueue<T>(operation: () => Promise<T>, exclusive = false): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const run = () => {
        this.activeOps += 1;
        this.exclusiveRunning = exclusive;
        let releaseTurn!: () => void;
        const turnDone = new Promise<void>((resolveTurn) => { releaseTurn = resolveTurn; });
        const turn: SendTurn = { previous: this.lastSendTurn, release: releaseTurn };
        this.lastSendTurn = turnDone;
        const finish = () => {
          turn.release();
          this.activeOps -= 1;
          if (exclusive) {
            this.exclusiveRunning = false;
          }
          this.releaseEnqueueSlot();
        };
        this.sendTurns.run(turn, operation).then(
          (value) => { finish(); resolve(value); },
          (err: unknown) => { finish(); reject(err); },
        );
      };
      // Waiters start in order, so an exclusive operation is not starved.
      if (this.opWaiters.length === 0 && this.canStart(exclusive)) {
        run();
      } else {
        this.opWaiters.push({ run, reject, exclusive });
      }
    });
  }

  private canStart(exclusive: boolean): boolean {
    if (this.exclusiveRunning) {
      return false;
    }
    return exclusive ? this.activeOps === 0 : this.activeOps < this.maxPipeline;
  }

  private releaseEnqueueSlot(): void {
    while (this.opWaiters.length > 0 && this.canStart(this.opWaiters[0].exclusive)) {
      this.opWaiters.shift()!.run();
    }
  }

  private async connectInternal(): Promise<this> {
    this.clearConnectionState();
    this.helloInfo = null;
    this.geometryInfo = null;
    const socket = await this.openSocket();
    this.socket = socket;
    this.connected = true;

    socket.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.drainFrames();
    });

    socket.on("error", (error) => {
      if (this.socket === socket) {
        this.clearConnectionState(this.wrapTransportError(error, this.options.secure ? "tls" : "connect"));
      }
    });

    socket.on("close", () => {
      if (this.socket === socket) {
        this.clearConnectionState(new ChunkConnectionError("connection closed", { phase: "connect" }));
      }
    });

    // A failed handshake (bad token, missing table) must not leave the
    // socket open behind a client the caller never received.
    try {
      await this.hello();
    } catch (error) {
      if (this.socket === socket) {
        this.clearConnectionState();
      }
      socket.destroy();
      throw error;
    }

    return this;
  }

  // HELLO is the first command on every connection. It is sent outside the
  // pipeline queue: operations waiting for the connection hold its slots.
  private async hello(): Promise<void> {
    const args: Array<string | number> = [PROTOCOL_VERSION];
    if (this.options.token !== "") {
      args.push("AUTH", this.options.token);
    }
    if (this.selectedTable !== null) {
      args.push("TABLE", this.selectedTable);
    }
    let frame: ChunkFrame;
    try {
      frame = await this.sendCommand("HELLO", args);
    } catch (error) {
      // A 1.x server does not know HELLO; one that requires a token answers
      // AUTH_REQUIRED although HELLO carried it, which a protocol 2 server
      // never does.
      if (
        error instanceof ChunkServerError &&
        (error.code === "UNKNOWN_COMMAND" || (error.code === "AUTH_REQUIRED" && this.options.token !== ""))
      ) {
        throw new ChunkProtocolError(
          "server does not speak protocol 2 (chunkdb 1.x); this client needs chunkdb 2.0 or later",
          { phase: "protocol", command: "HELLO", cause: error },
        );
      }
      throw error;
    }
    const info = parseHelloInfo(this.expectBulk(frame, "HELLO"));
    this.helloInfo = info;
    this.geometryInfo = info.table === null ? null : geometryOf(info.table);
  }

  private async useTable(name: string): Promise<ChunkTableInfo> {
    const frame = await this.sendCommand("USE", [name]);
    const info = parseTableInfo(this.expectBulk(frame, "USE"), "USE");
    this.selectedTable = info.name;
    this.geometryInfo = geometryOf(info);
    return info;
  }

  private expectOk(frame: ChunkFrame, command: string): void {
    const text = this.expectSimple(frame, command);
    if (text !== "OK") {
      throw new ChunkProtocolError(`unexpected ${command} response: ${text}`, {
        phase: "protocol",
        command,
      });
    }
  }

  private async openSocket(): Promise<TransportSocket> {
    const timeoutMs = this.options.connectTimeoutMs;
    return await new Promise<TransportSocket>((resolve, reject) => {
      let socket: TransportSocket | null = null;

      const onError = (error: Error) => {
        cleanup();
        reject(this.wrapTransportError(error, this.options.secure ? "tls" : "connect"));
      };

      const timer = setTimeout(() => {
        cleanup();
        socket?.destroy();
        reject(
          new ChunkTimeoutError(
            `connection timeout after ${timeoutMs}ms`,
            { phase: "timeout", command: "CONNECT" },
          ),
        );
      }, timeoutMs);

      const cleanup = () => {
        clearTimeout(timer);
        socket?.off("error", onError);
      };

      try {
        socket = this.options.secure
          ? tls.connect(
              {
                host: this.options.host,
                port: this.options.port,
                rejectUnauthorized: !this.options.tlsInsecure,
                servername: resolveTlsServerName(this.options),
                ca: this.options.ca,
                cert: this.options.cert,
                key: this.options.key,
              },
              () => {
                cleanup();
                resolve(socket!);
              },
            )
          : net.connect(
              {
                host: this.options.host,
                port: this.options.port,
              },
              () => {
                cleanup();
                resolve(socket!);
              },
            );
      } catch (error) {
        cleanup();
        reject(this.wrapTransportError(error, this.options.secure ? "tls" : "connect"));
        return;
      }

      socket.setNoDelay(true);
      socket.once("error", onError);
    });
  }

  private async ensureConnected(): Promise<void> {
    // Connecting (HELLO) is not one of the operations being ordered, and an
    // earlier operation may be waiting for it.
    await this.sendTurns.exit(() => this.connect());
    if (this.socket === null) {
      throw new ChunkConnectionError("connection is not available", { phase: "connect" });
    }
  }

  // `payload`, when given, is written after the request line followed by an
  // empty line (the CHUNKPUT framing); the server reads exactly the byte
  // count declared in the request line.
  private async sendCommand(
    command: string,
    args: Array<string | number>,
    payload?: Buffer,
  ): Promise<ChunkFrame> {
    await this.ensureConnected();
    const turn = this.sendTurns.getStore();
    if (turn !== undefined) {
      await turn.previous;
    }
    const socket = this.socket;
    if (socket === null) {
      throw new ChunkConnectionError("connection is not available", { phase: "connect", command });
    }
    const line = serializeCommand([command, ...args]);
    const maxLineBytes = this.helloInfo?.maxLineBytes ?? 0;
    if (maxLineBytes > 0 && line.length > maxLineBytes) {
      // The server would answer BAD_REQUEST and close the connection.
      throw new ChunkProtocolError(
        `${command} request line of ${line.length} bytes exceeds max_line_bytes (${maxLineBytes})`,
        { phase: "request", command },
      );
    }

    const framePromise = new Promise<ChunkFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        // Find by timer reference to avoid closure TDZ issues
        const idx = this.pendingQueue.findIndex((p) => p.timer === timer);
        if (idx !== -1) this.pendingQueue.splice(idx, 1);
        socket.destroy();
        reject(
          new ChunkTimeoutError(`command timeout after ${this.options.commandTimeoutMs}ms`, {
            phase: "timeout",
            command,
          }),
        );
      }, this.options.commandTimeoutMs);

      this.pendingQueue.push({ command, timer, resolve, reject });
      this.drainFrames();
    });
    // When the write fails, this promise is rejected too but never awaited.
    framePromise.catch(() => undefined);

    await new Promise<void>((resolve, reject) => {
      const wire = payload === undefined ? line : Buffer.concat([line, payload, CRLF]);
      socket.write(wire, (error) => {
        if (!error) { resolve(); return; }
        const wrapped = this.wrapTransportError(error, "request", command);
        this.failAllPending(wrapped);
        reject(wrapped);
      });
      turn?.release();
    });

    const frame = await framePromise;
    if (frame.type === "error") {
      if (frame.code === "AUTH_FAILED" || frame.code === "AUTH_REQUIRED") {
        throw new ChunkAuthError(frame.code, frame.message, {
          phase: command === "HELLO" ? "auth" : "response",
          command,
        });
      }
      if (frame.code === "NOT_RETAINED") {
        const match = /^start=([0-9]+)$/.exec(frame.message);
        if (match === null) {
          throw new ChunkProtocolError(`unexpected NOT_RETAINED payload for ${command}`, {
            phase: "protocol",
            command,
          });
        }
        throw new ChunkNotRetainedError(frame.message, BigInt(match[1]), { phase: "response", command });
      }
      throw new ChunkServerError(frame.code, frame.message, {
        phase: "response",
        command,
      });
    }
    return frame;
  }

  private drainFrames(): void {
    while (this.pendingQueue.length > 0) {
      const parsed = parseFrame(this.buffer);
      if (parsed === null) return;
      this.buffer = this.buffer.subarray(parsed.bytesConsumed);
      const pending = this.pendingQueue.shift()!;
      clearTimeout(pending.timer);
      pending.resolve(parsed.frame);
    }
  }

  private failAllPending(error: Error): void {
    const queue = this.pendingQueue.splice(0);
    for (const pending of queue) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  private clearConnectionState(error?: Error): void {
    this.buffer = Buffer.alloc(0);
    this.connected = false;
    this.socket = null;
    const connErr = error ?? new ChunkConnectionError("connection closed", { phase: "connect" });
    // Reject enqueue waiters that haven't started yet
    const waiters = this.opWaiters.splice(0);
    for (const w of waiters) w.reject(connErr);
    if (error !== undefined) {
      this.failAllPending(error);
    }
  }

  private expectSimple(frame: ChunkFrame, command: string): string {
    if (frame.type !== "simple") {
      throw new ChunkProtocolError(`expected simple response for ${command}`, {
        phase: "protocol",
        command,
      });
    }
    return frame.value;
  }

  private expectBulk(frame: ChunkFrame, command: string): Buffer {
    if (frame.type !== "bulk") {
      throw new ChunkProtocolError(`expected bulk response for ${command}`, {
        phase: "protocol",
        command,
      });
    }
    return frame.value;
  }

  private expectBulkOrNull(frame: ChunkFrame, command: string): Buffer | null {
    if (frame.type === "null") {
      return null;
    }
    return this.expectBulk(frame, command);
  }

  private expectArray(frame: ChunkFrame, command: string): Array<BulkFrame | NullFrame> {
    if (frame.type !== "array") {
      throw new ChunkProtocolError(`expected array response for ${command}`, {
        phase: "protocol",
        command,
      });
    }
    return frame.items;
  }

  private wrapTransportError(error: unknown, phase: "connect" | "request" | "tls", command?: string): ChunkError {
    const message = error instanceof Error ? error.message : String(error);
    if (phase === "tls") {
      return new ChunkTlsError(message, { phase, command, cause: error });
    }
    return new ChunkConnectionError(message, { phase, command, cause: error });
  }
}

export async function connect(options: ChunkClientOptions = {}): Promise<ChunkClient> {
  const client = new ChunkClient(options);
  await client.connect();
  return client;
}

export async function connectUri(
  uri: string,
  overrides: Partial<ChunkClientOptions> = {},
): Promise<ChunkClient> {
  return await connect({ ...overrides, uri });
}
