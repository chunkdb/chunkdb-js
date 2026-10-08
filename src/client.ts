import { AsyncLocalStorage } from "node:async_hooks";
import net from "node:net";
import tls from "node:tls";

import {
  ChunkAuthError,
  ChunkConnectionError,
  ChunkProtocolError,
  ChunkSchemaMismatchError,
  ChunkServerError,
  ChunkTimeoutError,
  ChunkTlsError,
  ChunkVersionMismatchError,
  type ChunkError,
} from "./errors";
import { chunkFormLimit, decodeChunkForm, encodeChunkForm } from "./chunk-form";
import { encodeStatement, ReplyReader, type ChunkParameter, type ChunkReply, type ErrorReply } from "./protocol";
import { integerOf, mapOf, parseDescribe, parseServerInfo, textOf, type TableLayout } from "./schema";
import { formatChunkUri, parseChunkUri, tableFromUriPath } from "./uri";
import type {
  ChunkArea,
  ChunkAreaEntry,
  ChunkAreaRawEntry,
  ChunkClientOptions,
  ChunkColumnDefinition,
  ChunkColumnType,
  ChunkCoord,
  ChunkReadOptions,
  ChunkRow,
  ChunkScanOptions,
  ChunkScanPage,
  ChunkServerInfo,
  ChunkState,
  ChunkStateInput,
  ChunkTableChange,
  ChunkTableDefinition,
  ChunkTableOption,
  ChunkTableOptions,
  ChunkTableSchema,
  ChunkValue,
  ChunkWriteOptions,
  ParsedChunkUri,
} from "./types";
import {
  StaleSchemaError,
  checkCoordinate,
  checkName,
  checkVersion,
  encodeParameter,
  formatColumnType,
  formatLiteral,
  parseColumnType,
  requestError,
  valueFromReply,
} from "./values";

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
  table: string;
}

// The place of one operation in the order statements are written: it
// writes only after the operation started before it wrote its statement (or
// ended).
interface SendTurn {
  previous: Promise<void>;
  release: () => void;
}

interface PendingRequest {
  timer: NodeJS.Timeout;
  resolve: (reply: ChunkReply) => void;
  reject: (error: Error) => void;
}

const PROTOCOL_VERSION = 3;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4242;
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_TABLE = "default";

// Server messages (src/engine_cql.cpp) that mean the cached schema is out
// of date: a parameter frame of the wrong size for its column, or a column
// the table no longer has.
const WRONG_SIZE = /^\$[0-9]+ for column .+ must be [0-9]+ bytes, got [0-9]+$/;
const NO_COLUMN = /^the table has no column /;
const TABLE_STATEMENT = /^\s*(?:create|alter|drop)\s+table\s+([a-z_][a-z0-9_]*)/i;

const TABLE_OPTION_NAMES: Record<keyof ChunkTableOptions, string> = {
  durabilityMode: "durability_mode",
  checkpointUpdates: "checkpoint_updates",
  checkpointWalBytes: "checkpoint_wal_bytes",
  walGroupCommitUpdates: "wal_group_commit_updates",
  checkpointCompression: "checkpoint_compression",
  varMaxChunkBytes: "var_max_chunk_bytes",
};

// Error replies after which the server closes the connection: a request it
// cannot frame (BAD_REQUEST), and a statement with parameters refused before
// its frames are read, which could not be told apart from the next
// statement (src/server_connection.cpp, CommandEngine::PlanParameters).
function closesConnection(reply: ErrorReply, withParameters: boolean): boolean {
  if (reply.code === "BAD_REQUEST") {
    return true;
  }
  return (
    withParameters &&
    (["SYNTAX", "NO_TABLE"].includes(reply.code) ||
      (reply.code === "INVALID_ARGUMENT" && NO_COLUMN.test(reply.message)))
  );
}

/** The table a `CREATE` / `ALTER` / `DROP TABLE` statement names, or null. */
export function tableOfStatement(statement: string): string | null {
  return TABLE_STATEMENT.exec(statement)?.[1] ?? null;
}

// The verb of a statement, for errors: "SET BLOCK", "PING", ...
function commandOf(statement: string): string {
  const words = statement.trim().split(/\s+/, 2).map((word) => word.toUpperCase());
  return ["GET", "SET", "DELETE", "CREATE", "ALTER", "DROP", "SHOW", "SCAN", "FLUSH"].includes(words[0])
    ? words.join(" ")
    : words[0];
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
  const named =
    options.table !== undefined && options.table !== "" ? options.table : tableFromUriPath(parsed?.path ?? "/");
  return {
    host,
    port,
    token,
    secure,
    connectTimeoutMs: options.connectTimeoutMs ?? DEFAULT_TIMEOUT_MS,
    commandTimeoutMs: options.commandTimeoutMs ?? DEFAULT_TIMEOUT_MS,
    tlsInsecure: options.tlsInsecure ?? false,
    tlsServerName: options.tlsServerName,
    ca: options.ca,
    cert: options.cert,
    key: options.key,
    pipelineDepth: Math.max(1, options.pipelineDepth ?? 1),
    table: named ?? DEFAULT_TABLE,
    uri: {
      scheme: secure ? "chunks" : "chunk",
      secure,
      host,
      port,
      token,
      path: named === null ? "/" : `/${encodeURIComponent(named)}`,
    },
  };
}

function itemsOf(reply: ChunkReply, command: string): ChunkReply[] {
  if (reply.type !== "array") {
    throw new ChunkProtocolError(`expected an array reply to ${command}, got ${reply.type}`, {
      phase: "protocol",
      command,
    });
  }
  return reply.items;
}

function expectOk(reply: ChunkReply, command: string, value = "OK"): void {
  if (reply.type !== "simple" || reply.value !== value) {
    throw new ChunkProtocolError(`expected +${value} from ${command}`, { phase: "protocol", command });
  }
}

function versionOf(reply: ChunkReply, command: string): bigint {
  if (reply.type !== "integer" || reply.value < 0n) {
    throw new ChunkProtocolError(`expected a chunk version from ${command}`, { phase: "protocol", command });
  }
  return reply.value;
}

function bulkOf(reply: ChunkReply, command: string): Buffer {
  if (reply.type !== "bulk") {
    throw new ChunkProtocolError(`expected a bulk reply to ${command}, got ${reply.type}`, {
      phase: "protocol",
      command,
    });
  }
  return reply.value;
}

function coordOf(reply: ChunkReply, command: string): ChunkCoord {
  if (reply.type !== "array" || reply.items.length < 2) {
    throw new ChunkProtocolError(`expected chunk coordinates in the ${command} reply`, { phase: "protocol", command });
  }
  return { cx: integerOf(reply.items[0], "cx", command), cy: integerOf(reply.items[1], "cy", command) };
}

function ifVersionClause(ifVersion: bigint | undefined): string {
  return ifVersion === undefined ? "" : ` IF VERSION ${checkVersion(ifVersion)}`;
}

function typeText(type: string | ChunkColumnType): string {
  try {
    return formatColumnType(typeof type === "string" ? parseColumnType(type) : type);
  } catch (error) {
    throw requestError(error instanceof Error ? error.message : String(error));
  }
}

function columnDefinition(column: ChunkColumnDefinition): string {
  let text = `${checkName(column.name, "a column name")} ${typeText(column.type)}`;
  if (column.nullable === true) {
    text += " NULL";
  }
  if (column.required === true) {
    text += " REQUIRED";
  }
  if (column.default !== undefined) {
    text += ` DEFAULT ${formatLiteral(column.default)}`;
  }
  return text;
}

function optionAssignment(option: keyof ChunkTableOptions, value: string | number): string {
  const name = TABLE_OPTION_NAMES[option];
  if (name === undefined) {
    throw requestError(`unknown table option ${String(option)}`);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw requestError(`${String(option)} takes a non-negative integer`);
    }
    return `${name} = ${value}`;
  }
  return `${name} = ${formatLiteral(value)}`;
}

function areaClause(area: ChunkArea): string {
  if ("radius" in area) {
    if (!Number.isSafeInteger(area.radius) || area.radius < 0) {
      throw requestError("radius must be a non-negative integer");
    }
    return `AROUND ${checkCoordinate(area.cx, "cx")} ${checkCoordinate(area.cy, "cy")} RADIUS ${area.radius}`;
  }
  return (
    `${checkCoordinate(area.cx0, "cx0")} ${checkCoordinate(area.cy0, "cy0")} TO ` +
    `${checkCoordinate(area.cx1, "cx1")} ${checkCoordinate(area.cy1, "cy1")}`
  );
}

function columnsClause(names: readonly string[]): string {
  return names.length === 0 ? "" : ` COLUMNS ${names.join(", ")}`;
}

// Schema indexes of `names`, or of every column. A name the cached schema
// does not have makes the client refresh it once.
function columnIndexes(layout: TableLayout, names: readonly string[] | undefined): number[] {
  const columns = layout.schema.columns;
  if (names === undefined || names.length === 0) {
    return columns.map((_, index) => index);
  }
  return names.map((name) => {
    checkName(name, "a column name");
    const index = columns.findIndex((column) => column.name === name);
    if (index === -1) {
      throw new StaleSchemaError(`table ${layout.schema.table} has no column ${name}`, { phase: "request" });
    }
    return index;
  });
}

export class ChunkClient {
  private readonly options: ResolvedOptions;
  private socket: TransportSocket | null = null;
  private pendingQueue: PendingRequest[] = [];
  private connectPromise: Promise<this> | null = null;
  private readonly reader = new ReplyReader();
  private connected = false;
  private disposed = false;
  private info: ChunkServerInfo | null = null;
  // DESCRIBE replies by table: how parameters and chunk forms are encoded.
  private readonly schemas = new Map<string, TableLayout>();
  // DESCRIBE statements in flight, which concurrent operations share.
  private readonly schemaFetches = new Map<string, Promise<TableLayout>>();

  // Pipeline concurrency tracking
  private activeOps = 0;
  private readonly maxPipeline: number;
  // Statements reach the wire in the order their operations started,
  // whatever each awaits first (such as a DESCRIBE for its schema).
  private readonly sendTurns = new AsyncLocalStorage<SendTurn>();
  private lastSendTurn: Promise<void> = Promise.resolve();
  private readonly opWaiters: Array<{ run: () => void; reject: (err: Error) => void }> = [];

  constructor(options: ChunkClientOptions = {}) {
    this.options = resolveOptions(options);
    this.maxPipeline = this.options.pipelineDepth;
  }

  uri(): string {
    return formatChunkUri(this.options.uri);
  }

  /** The table of calls that do not name one. */
  defaultTable(): string {
    return this.options.table;
  }

  /** The server's `HELLO 3` reply for the current connection; null before connecting. */
  serverInfo(): ChunkServerInfo | null {
    return this.info;
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

  /**
   * Sends one statement with its parameter frames (`$1` ... `$n`, each the
   * value's bytes or null for NULL) and resolves the reply. An error reply
   * rejects with `ChunkServerError`. A statement that creates, alters or
   * drops a table clears that table's cached schema.
   */
  execute(statement: string, parameters: readonly ChunkParameter[] = []): Promise<ChunkReply> {
    return this.enqueue(async () => {
      const table = tableOfStatement(statement);
      try {
        return await this.run(statement, parameters, commandOf(statement));
      } finally {
        if (table !== null) {
          this.forget(table.toLowerCase());
        }
      }
    });
  }

  /**
   * The table's schema (`DESCRIBE`). This also refreshes the client's cached
   * schema, which encodes parameters and decodes values and chunk forms.
   */
  describe(table?: string): Promise<ChunkTableSchema> {
    return this.enqueue(async () => (await this.refreshLayout(this.tableOf({ table }))).schema);
  }

  /** Forgets the cached schema of `table`, or of every table. */
  clearSchemaCache(table?: string): void {
    if (table === undefined) {
      this.schemas.clear();
      this.schemaFetches.clear();
    } else {
      this.forget(table);
    }
  }

  /** Table names, in ascending order (`SHOW TABLES`). */
  listTables(): Promise<string[]> {
    return this.enqueue(async () => {
      const reply = await this.run("SHOW TABLES", [], "SHOW TABLES");
      return itemsOf(reply, "SHOW TABLES").map((item) => textOf(item, "a table name", "SHOW TABLES"));
    });
  }

  /** `CREATE TABLE`. The chunk and large-chunk sizes are fixed once created. */
  createTable(name: string, definition: ChunkTableDefinition): Promise<void> {
    return this.enqueue(async () => {
      checkName(name, "a table name");
      if (definition.columns.length === 0) {
        throw requestError("a table needs at least one column", "CREATE TABLE");
      }
      const size = (what: string, value: { width: number; height: number }) => {
        for (const n of [value.width, value.height]) {
          if (!Number.isSafeInteger(n) || n < 1) {
            throw requestError(`${what} sizes are positive integers`, "CREATE TABLE");
          }
        }
        return `${value.width} x ${value.height}`;
      };
      let statement =
        `CREATE TABLE ${name} (${definition.columns.map(columnDefinition).join(", ")})` +
        ` CHUNK ${size("chunk", definition.chunk)}`;
      if (definition.large !== undefined) {
        statement += ` LARGE ${size("large chunk", definition.large)}`;
      }
      const options = Object.entries(definition.options ?? {}).filter(([, value]) => value !== undefined);
      if (options.length > 0) {
        statement +=
          " WITH " +
          options.map(([key, value]) => optionAssignment(key as keyof ChunkTableOptions, value as string | number)).join(", ");
      }
      await this.tableStatement(name, statement, "CREATE TABLE");
    });
  }

  /** `ALTER TABLE`: one column change or option. */
  alterTable(name: string, change: ChunkTableChange): Promise<void> {
    return this.enqueue(async () => {
      checkName(name, "a table name");
      let clause: string;
      switch (change.kind) {
        case "addColumn":
          clause = `ADD COLUMN ${columnDefinition(change.column)}`;
          break;
        case "dropColumn":
          clause = `DROP COLUMN ${checkName(change.column, "a column name")}`;
          break;
        case "renameColumn":
          clause = `RENAME COLUMN ${checkName(change.column, "a column name")} TO ${checkName(change.to, "a column name")}`;
          break;
        case "alterColumnType":
          clause = `ALTER COLUMN ${checkName(change.column, "a column name")} TYPE ${typeText(change.type)}`;
          if (change.using !== undefined) {
            if (!["clamp", "default", "truncate"].includes(change.using)) {
              throw requestError(`unknown conversion ${String(change.using)}`, "ALTER TABLE");
            }
            clause += ` USING ${change.using.toUpperCase()}`;
          }
          break;
        case "setOption":
          clause = `SET ${optionAssignment(change.option, change.value)}`;
          break;
        default:
          throw requestError("unknown table change", "ALTER TABLE");
      }
      await this.tableStatement(name, `ALTER TABLE ${name} ${clause}`, "ALTER TABLE");
    });
  }

  /** `DROP TABLE`: deletes the table and its data. Irreversible. */
  dropTable(name: string): Promise<void> {
    return this.enqueue(async () => {
      checkName(name, "a table name");
      await this.tableStatement(name, `DROP TABLE ${name}`, "DROP TABLE");
    });
  }

  /** A block's values by column name, or null when the block is absent. */
  getBlock(x: number, y: number, options: ChunkReadOptions = {}): Promise<ChunkRow | null> {
    return this.enqueue(async () => {
      const table = this.tableOf(options);
      const at = `${checkCoordinate(x, "x")} ${checkCoordinate(y, "y")}`;
      return await this.withLayout(table, false, async (layout) => {
        const indexes = columnIndexes(layout, options.columns);
        const names = indexes.map((index) => layout.schema.columns[index].name);
        const reply = await this.run(`GET BLOCK ${at} FROM ${table}${columnsClause(names)}`, [], "GET BLOCK");
        if (reply.type === "null") {
          return null;
        }
        if (reply.type !== "array" || reply.items.length !== indexes.length) {
          throw new StaleSchemaError(`GET BLOCK answered ${reply.type === "array" ? reply.items.length : reply.type} values for ${indexes.length} columns`, {
            phase: "protocol",
            command: "GET BLOCK",
          });
        }
        const row: ChunkRow = {};
        indexes.forEach((index, i) => {
          const column = layout.schema.columns[index];
          row[column.name] = valueFromReply(column, reply.items[i]);
        });
        return row;
      });
    });
  }

  /**
   * Sets columns of a block; a new block takes defaults for the others.
   * Values travel as parameters. Resolves the chunk version after the write.
   */
  setBlock(x: number, y: number, values: Readonly<Record<string, ChunkValue>>, options: ChunkWriteOptions = {}): Promise<bigint> {
    return this.enqueue(async () => {
      const table = this.tableOf(options);
      const at = `${checkCoordinate(x, "x")} ${checkCoordinate(y, "y")}`;
      const condition = ifVersionClause(options.ifVersion);
      const names = Object.keys(values);
      if (names.length === 0) {
        throw requestError("setBlock needs at least one column", "SET BLOCK");
      }
      return await this.withLayout(table, true, async (layout) => {
        const indexes = columnIndexes(layout, names);
        const parameters = indexes.map((index, i) => encodeParameter(layout.schema.columns[index], values[names[i]]));
        const assignments = names.map((name, i) => `${name} = $${i + 1}`).join(", ");
        const reply = await this.run(`SET BLOCK ${at} IN ${table} ${assignments}${condition}`, parameters, "SET BLOCK");
        return versionOf(reply, "SET BLOCK");
      });
    });
  }

  /** Deletes a block. Resolves the chunk version after it. */
  deleteBlock(x: number, y: number, options: ChunkWriteOptions = {}): Promise<bigint> {
    return this.enqueue(async () => {
      const table = this.tableOf(options);
      const statement =
        `DELETE BLOCK ${checkCoordinate(x, "x")} ${checkCoordinate(y, "y")} FROM ${table}` +
        ifVersionClause(options.ifVersion);
      return versionOf(await this.run(statement, [], "DELETE BLOCK"), "DELETE BLOCK");
    });
  }

  /**
   * A chunk decoded by the table's schema: its version, which blocks are
   * present, and per column the values of the present blocks. A chunk
   * without blocks reads as an empty state with its version.
   */
  getChunk(cx: number, cy: number, options: ChunkReadOptions = {}): Promise<ChunkState> {
    return this.enqueue(async () => {
      const table = this.tableOf(options);
      const at = `${checkCoordinate(cx, "cx")} ${checkCoordinate(cy, "cy")}`;
      return await this.withLayout(table, false, async (layout) => {
        const indexes = columnIndexes(layout, options.columns);
        const names = indexes.map((index) => layout.schema.columns[index].name);
        const reply = await this.run(`GET CHUNK ${at} FROM ${table}${columnsClause(names)}`, [], "GET CHUNK");
        return decodeChunkForm(layout, bulkOf(reply, "GET CHUNK"), indexes);
      });
    });
  }

  /** The chunk form as the server sends it (docs/CQL.md), for copying chunks. */
  getChunkRaw(cx: number, cy: number, options: ChunkReadOptions = {}): Promise<Buffer> {
    return this.enqueue(async () => {
      const table = this.tableOf(options);
      const names = (options.columns ?? []).map((name) => checkName(name, "a column name"));
      const statement = `GET CHUNK ${checkCoordinate(cx, "cx")} ${checkCoordinate(cy, "cy")} FROM ${table}${columnsClause(names)}`;
      return bulkOf(await this.run(statement, [], "GET CHUNK"), "GET CHUNK");
    });
  }

  /**
   * Replaces every column of the chunk with `state`, encoded by the table's
   * schema: a state from `getChunk`, or one built from `emptyChunk(schema)`.
   * Values of absent blocks are not sent. Resolves the chunk version after
   * the write.
   */
  setChunk(cx: number, cy: number, state: ChunkStateInput, options: ChunkWriteOptions = {}): Promise<bigint> {
    return this.enqueue(async () => {
      const table = this.tableOf(options);
      const statement =
        `SET CHUNK ${checkCoordinate(cx, "cx")} ${checkCoordinate(cy, "cy")} IN ${table} $1` +
        ifVersionClause(options.ifVersion);
      return await this.withLayout(table, true, async (layout) => {
        const form = encodeChunkForm(layout, state);
        return versionOf(await this.run(statement, [form], "SET CHUNK"), "SET CHUNK");
      }, true);
    });
  }

  /**
   * Writes a chunk form of every column (as `getChunkRaw` without `columns`
   * returns it); its chunk version is not read. A form of another schema
   * version than the table's rejects with `ChunkSchemaMismatchError`.
   */
  setChunkRaw(cx: number, cy: number, form: Uint8Array, options: ChunkWriteOptions = {}): Promise<bigint> {
    return this.enqueue(async () => {
      const table = this.tableOf(options);
      const statement =
        `SET CHUNK ${checkCoordinate(cx, "cx")} ${checkCoordinate(cy, "cy")} IN ${table} $1` +
        ifVersionClause(options.ifVersion);
      if (!(form instanceof Uint8Array)) {
        throw requestError("setChunkRaw takes the chunk form as a Uint8Array", "SET CHUNK");
      }
      // A longer frame than the table takes closes the connection.
      return await this.withLayout(table, true, async (layout) => {
        const limit = chunkFormLimit(layout);
        if (form.length > limit) {
          throw new StaleSchemaError(`a chunk form of ${table} takes at most ${limit} bytes, got ${form.length}`, {
            phase: "request",
            command: "SET CHUNK",
          });
        }
        return versionOf(await this.run(statement, [form], "SET CHUNK"), "SET CHUNK");
      });
    });
  }

  /**
   * The chunks of an area that have a present block, in ascending `cx` then
   * `cy`, decoded by the table's schema. An area covers at most
   * `maxAreaChunks` chunks.
   */
  getArea(area: ChunkArea, options: ChunkReadOptions = {}): Promise<ChunkAreaEntry[]> {
    return this.enqueue(async () => {
      const table = this.tableOf(options);
      const clause = areaClause(area);
      return await this.withLayout(table, false, async (layout) => {
        const indexes = columnIndexes(layout, options.columns);
        const names = indexes.map((index) => layout.schema.columns[index].name);
        const reply = await this.run(`GET AREA ${clause} FROM ${table}${columnsClause(names)}`, [], "GET AREA");
        return this.areaEntries(reply).map(({ cx, cy, chunk }) => ({
          cx,
          cy,
          chunk: decodeChunkForm(layout, chunk, indexes),
        }));
      });
    });
  }

  /** `getArea` with each chunk as the server sends its form. */
  getAreaRaw(area: ChunkArea, options: ChunkReadOptions = {}): Promise<ChunkAreaRawEntry[]> {
    return this.enqueue(async () => {
      const table = this.tableOf(options);
      const names = (options.columns ?? []).map((name) => checkName(name, "a column name"));
      const reply = await this.run(`GET AREA ${areaClause(area)} FROM ${table}${columnsClause(names)}`, [], "GET AREA");
      return this.areaEntries(reply);
    });
  }

  /** One page of the chunks that have a present block (`SCAN CHUNKS`). */
  scanChunks(options: ChunkScanOptions = {}): Promise<ChunkScanPage> {
    return this.enqueue(async () => {
      const table = this.tableOf(options);
      let statement = `SCAN CHUNKS FROM ${table}`;
      if (options.after !== undefined) {
        statement += ` AFTER ${checkCoordinate(options.after.cx, "after.cx")} ${checkCoordinate(options.after.cy, "after.cy")}`;
      }
      if (options.limit !== undefined) {
        if (!Number.isSafeInteger(options.limit) || options.limit < 1) {
          throw requestError("limit must be a positive integer", "SCAN CHUNKS");
        }
        statement += ` LIMIT ${options.limit}`;
      }
      const command = "SCAN CHUNKS";
      const entries = mapOf(await this.run(statement, [], command), command);
      const chunks = entries.get("chunks");
      const more = entries.get("more");
      if (chunks?.type !== "array" || more?.type !== "boolean") {
        throw new ChunkProtocolError("malformed SCAN CHUNKS reply", { phase: "protocol", command });
      }
      return { chunks: chunks.items.map((item) => coordOf(item, command)), more: more.value };
    });
  }

  /** Every chunk that has a present block, page by page (`limit` per page). */
  async *scanAllChunks(options: Omit<ChunkScanOptions, "after"> = {}): AsyncGenerator<ChunkCoord, void, undefined> {
    let after: ChunkCoord | undefined;
    while (true) {
      const page = await this.scanChunks({ ...options, after });
      yield* page.chunks;
      if (!page.more || page.chunks.length === 0) {
        return;
      }
      after = page.chunks[page.chunks.length - 1];
    }
  }

  ping(): Promise<"PONG"> {
    return this.enqueue(async () => {
      expectOk(await this.run("PING", [], "PING"), "PING", "PONG");
      return "PONG" as const;
    });
  }

  /** Resolves once every write acknowledged before it is durable (`FLUSH WAL`). */
  flushWal(): Promise<void> {
    return this.enqueue(async () => {
      expectOk(await this.run("FLUSH WAL", [], "FLUSH WAL"), "FLUSH WAL");
    });
  }

  /** The server's metrics in Prometheus text format (`SHOW METRICS`). */
  metrics(): Promise<string> {
    return this.enqueue(async () => bulkOf(await this.run("SHOW METRICS", [], "SHOW METRICS"), "SHOW METRICS").toString("utf8"));
  }

  private tableOf(options: ChunkTableOption | undefined): string {
    return checkName(options?.table ?? this.options.table, "a table name");
  }

  private async tableStatement(table: string, statement: string, command: string): Promise<void> {
    try {
      expectOk(await this.run(statement, [], command), command);
    } finally {
      this.forget(table);
    }
  }

  private forget(table: string): void {
    this.schemas.delete(table);
    this.schemaFetches.delete(table);
  }

  private areaEntries(reply: ChunkReply): ChunkAreaRawEntry[] {
    const command = "GET AREA";
    return itemsOf(reply, command).map((item) => {
      if (item.type !== "array" || item.items.length !== 3) {
        throw new ChunkProtocolError("malformed GET AREA entry", { phase: "protocol", command });
      }
      return { ...coordOf(item, command), chunk: bulkOf(item.items[2], command) };
    });
  }

  private async refreshLayout(table: string): Promise<TableLayout> {
    const fetch = this.run(`DESCRIBE ${table}`, [], "DESCRIBE", false).then(parseDescribe);
    this.schemaFetches.set(table, fetch);
    // A table statement sent meanwhile drops the fetch: its reply is not cached.
    const current = () => this.schemaFetches.get(table) === fetch;
    try {
      const layout = await fetch;
      if (current()) {
        this.schemas.set(table, layout);
      }
      return layout;
    } catch (error) {
      if (current()) {
        this.schemas.delete(table);
      }
      throw error;
    } finally {
      if (current()) {
        this.schemaFetches.delete(table);
      }
    }
  }

  // The cached schema, the one being fetched, or a new DESCRIBE.
  private async layoutOf(table: string): Promise<TableLayout> {
    return this.schemas.get(table) ?? (await (this.schemaFetches.get(table) ?? this.refreshLayout(table)));
  }

  // Runs `operation` with the table's cached schema (fetched if there is
  // none). When the reply shows the schema is out of date, it refreshes the
  // schema once and runs `operation` again.
  // `encodes` is true when `operation` encodes a chunk form from the
  // schema: SCHEMA_MISMATCH then means the schema changed.
  private async withLayout<T>(
    table: string,
    write: boolean,
    operation: (layout: TableLayout) => Promise<T>,
    encodes = false,
  ): Promise<T> {
    const layout = await this.layoutOf(table);
    try {
      return await operation(layout);
    } catch (error) {
      if (!this.isStaleSchema(error, write) && !(encodes && error instanceof ChunkSchemaMismatchError)) {
        this.forgetAfter(table, error, write);
        throw error;
      }
    }
    const fresh = await this.refreshLayout(table);
    try {
      return await operation(fresh);
    } catch (error) {
      this.forgetAfter(table, error, write);
      throw error;
    }
  }

  private isStaleSchema(error: unknown, write: boolean): boolean {
    if (error instanceof StaleSchemaError) {
      return true;
    }
    if (!(error instanceof ChunkServerError) || error.serverCode !== "INVALID_ARGUMENT") {
      return false;
    }
    const message = error.serverMessage;
    // A write with parameters naming a column the table no longer has is
    // refused before its frames are read, and the server closes the
    // connection: it is not retried.
    return WRONG_SIZE.test(message) || (!write && NO_COLUMN.test(message));
  }

  private forgetAfter(table: string, error: unknown, write: boolean): void {
    if (
      error instanceof ChunkServerError &&
      (error.serverCode === "NO_TABLE" || (write && error.serverCode === "INVALID_ARGUMENT" && NO_COLUMN.test(error.serverMessage)))
    ) {
      this.forget(table);
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const run = () => {
        this.activeOps += 1;
        let release!: () => void;
        const done = new Promise<void>((resolveTurn) => {
          release = resolveTurn;
        });
        const turn: SendTurn = { previous: this.lastSendTurn, release };
        this.lastSendTurn = done;
        const finish = () => {
          release();
          this.activeOps -= 1;
          this.releaseEnqueueSlot();
        };
        this.sendTurns.run(turn, operation).then(
          (value) => {
            finish();
            resolve(value);
          },
          (err: unknown) => {
            finish();
            reject(err);
          },
        );
      };
      if (this.opWaiters.length === 0 && this.activeOps < this.maxPipeline) {
        run();
      } else {
        this.opWaiters.push({ run, reject });
      }
    });
  }

  private releaseEnqueueSlot(): void {
    while (this.opWaiters.length > 0 && this.activeOps < this.maxPipeline) {
      this.opWaiters.shift()!.run();
    }
  }

  private async connectInternal(): Promise<this> {
    this.clearConnectionState();
    this.info = null;
    const socket = await this.openSocket();
    this.socket = socket;
    this.connected = true;

    socket.on("data", (chunk: Buffer) => {
      if (this.socket !== socket) {
        return;
      }
      this.reader.push(chunk);
      this.drainReplies();
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

    // A failed handshake (bad token, older server) must not leave the
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

  // HELLO is the first statement on every connection. It is sent outside the
  // pipeline queue: operations waiting for the connection hold its slots.
  private async hello(): Promise<void> {
    const token = this.options.token;
    if (token !== "" && !/^[\x21-\x7e]+$/.test(token)) {
      throw new ChunkProtocolError("a token is printable ASCII without spaces", { phase: "auth", command: "HELLO" });
    }
    const reply = await this.send(token === "" ? `HELLO ${PROTOCOL_VERSION}` : `HELLO ${PROTOCOL_VERSION} AUTH ${token}`, []);
    if (reply.type === "error") {
      // An older chunkdb answers `-ERR PROTOCOL expected HELLO 2`; a 1.x
      // server does not know HELLO, and one that requires a token answers
      // AUTH_REQUIRED although HELLO carried it.
      const older = /^expected HELLO ([0-9]+)/.exec(reply.message);
      if (
        (reply.code === "PROTOCOL" && older !== null && older[1] !== String(PROTOCOL_VERSION)) ||
        reply.code === "UNKNOWN_COMMAND" ||
        (reply.code === "AUTH_REQUIRED" && token !== "")
      ) {
        const speaks = older === null ? "an older protocol (chunkdb 1.x)" : `the older protocol ${older[1]}`;
        throw new ChunkProtocolError(
          `the server speaks ${speaks}; this client needs a chunkdb server of protocol ${PROTOCOL_VERSION}`,
          { phase: "protocol", command: "HELLO", cause: this.serverError(reply, "HELLO") },
        );
      }
      throw this.serverError(reply, "HELLO");
    }
    const info = parseServerInfo(reply);
    if (info.protocol !== PROTOCOL_VERSION) {
      throw new ChunkProtocolError(`the server answered protocol ${info.protocol}, expected ${PROTOCOL_VERSION}`, {
        phase: "protocol",
        command: "HELLO",
      });
    }
    this.info = info;
  }

  private serverError(reply: ErrorReply, command: string): ChunkError {
    if (reply.code === "AUTH_FAILED" || reply.code === "AUTH_REQUIRED") {
      return new ChunkAuthError(reply.code, reply.message, {
        phase: command === "HELLO" ? "auth" : "response",
        command,
      });
    }
    if (reply.code === "VERSION_MISMATCH") {
      const current = /^current=([0-9]+)$/.exec(reply.message);
      if (current === null) {
        return new ChunkProtocolError(`unexpected VERSION_MISMATCH message: ${reply.message}`, {
          phase: "protocol",
          command,
        });
      }
      return new ChunkVersionMismatchError(reply.message, BigInt(current[1]), { phase: "response", command });
    }
    if (reply.code === "SCHEMA_MISMATCH") {
      const current = /^current=([0-9]+)(?: |$)/.exec(reply.message);
      if (current === null) {
        return new ChunkProtocolError(`unexpected SCHEMA_MISMATCH message: ${reply.message}`, {
          phase: "protocol",
          command,
        });
      }
      return new ChunkSchemaMismatchError(reply.message, BigInt(current[1]), { phase: "response", command });
    }
    return new ChunkServerError(reply.code, reply.message, { phase: "response", command });
  }

  // One statement; an error reply rejects. `main` is false for a statement
  // an operation sends before its own (a DESCRIBE), which keeps its turn.
  private async run(
    statement: string,
    parameters: readonly ChunkParameter[],
    command: string,
    main = true,
  ): Promise<ChunkReply> {
    const reply = await this.send(statement, parameters, command, main);
    if (reply.type === "error") {
      throw this.serverError(reply, command);
    }
    return reply;
  }

  private async send(
    statement: string,
    parameters: readonly ChunkParameter[],
    command = "HELLO",
    main = true,
  ): Promise<ChunkReply> {
    // Checked before connecting: nothing is sent for a statement that
    // cannot be framed.
    let wire: Buffer;
    try {
      wire = encodeStatement(statement, parameters);
    } catch (error) {
      if (error instanceof ChunkProtocolError) {
        throw new ChunkProtocolError(error.message, { phase: "request", command });
      }
      throw error;
    }
    // HELLO is sent while connecting, outside the operations' order.
    const turn = command === "HELLO" ? undefined : this.sendTurns.getStore();
    if (turn !== undefined) {
      await turn.previous;
    }
    await this.ensureConnected();
    const socket = this.socket;
    if (socket === null) {
      throw new ChunkConnectionError("connection is not available", { phase: "connect", command });
    }
    // A longer line, or more frames, make the server close the connection.
    if (this.info !== null) {
      const lineBytes = Buffer.byteLength(statement, "utf8") + 2;
      if (lineBytes > this.info.maxLineBytes) {
        throw requestError(`the statement takes ${lineBytes} bytes, the server takes at most ${this.info.maxLineBytes}`, command);
      }
      if (parameters.length > this.info.maxParameters) {
        throw requestError(`the statement has ${parameters.length} parameters, the server takes at most ${this.info.maxParameters}`, command);
      }
    }

    const replyPromise = new Promise<ChunkReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.pendingQueue.findIndex((pending) => pending.timer === timer);
        if (index !== -1) {
          this.pendingQueue.splice(index, 1);
        }
        // The reply may still come: the connection cannot be used further.
        if (this.socket === socket) {
          this.clearConnectionState(
            new ChunkConnectionError(`connection closed after a ${command} timeout`, { phase: "timeout", command }),
          );
        }
        socket.destroy();
        reject(
          new ChunkTimeoutError(`command timeout after ${this.options.commandTimeoutMs}ms`, {
            phase: "timeout",
            command,
          }),
        );
      }, this.options.commandTimeoutMs);
      this.pendingQueue.push({ timer, resolve, reject });
    });

    socket.write(wire, (error) => {
      if (error) {
        this.failAllPending(this.wrapTransportError(error, "request", command));
      }
    });
    if (turn !== undefined && main) {
      turn.release();
    }
    const reply = await replyPromise;
    if (reply.type === "error" && closesConnection(reply, parameters.length > 0) && this.socket === socket) {
      // The server closes the connection after this reply; nothing more is
      // sent on it, and statements written after it get no reply.
      this.clearConnectionState(
        new ChunkConnectionError(`the server closed the connection after ${reply.code} ${reply.message}`, {
          phase: "response",
          command,
        }),
      );
      socket.destroy();
    }
    return reply;
  }

  private drainReplies(): void {
    while (this.pendingQueue.length > 0) {
      let reply: ChunkReply | null;
      try {
        reply = this.reader.next();
      } catch (error) {
        // The stream cannot be read further.
        const socket = this.socket;
        this.clearConnectionState(error instanceof Error ? error : new Error(String(error)));
        socket?.destroy();
        return;
      }
      if (reply === null) {
        return;
      }
      const pending = this.pendingQueue.shift()!;
      clearTimeout(pending.timer);
      pending.resolve(reply);
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
        reject(new ChunkTimeoutError(`connection timeout after ${timeoutMs}ms`, { phase: "timeout", command: "CONNECT" }));
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
          : net.connect({ host: this.options.host, port: this.options.port }, () => {
              cleanup();
              resolve(socket!);
            });
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

  private failAllPending(error: Error): void {
    const queue = this.pendingQueue.splice(0);
    for (const pending of queue) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  private clearConnectionState(error?: Error): void {
    this.reader.clear();
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

export async function connectUri(uri: string, overrides: Partial<ChunkClientOptions> = {}): Promise<ChunkClient> {
  return await connect({ ...overrides, uri });
}
