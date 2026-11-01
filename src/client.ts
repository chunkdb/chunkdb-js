import { AsyncLocalStorage } from "node:async_hooks";
import net from "node:net";
import tls from "node:tls";

import {
  ChunkAuthError,
  ChunkConditionFailedError,
  ChunkBusyError,
  ChunkDiskFullError,
  ChunkRateLimitedError,
  ChunkOutcomeUnknownError,
  ChunkMigrationMismatchError,
  ChunkSlotBusyError,
  ChunkCheckFailedError,
  ChunkCancelledError,
  ChunkStatementTimeoutError,
  ChunkKilledError,
  ChunkUnknownCommandError,
  parseErrorFields,
  ChunkConflictError,
  ChunkConnectionError,
  ChunkMigrationError,
  ChunkPermissionError,
  ChunkProtocolError,
  ChunkSchemaMismatchError,
  ChunkServerError,
  ChunkTimeoutError,
  ChunkTlsError,
  ChunkVersionMismatchError,
  type ChunkError,
} from "./errors";
import { chunkFormLimit, decodeChunkForm, encodeChunkForm } from "./chunk-form";
import { decodeSectionedChunk, encodeSectionedChunk, sectionedChunkFormLimit } from "./sectioned-chunk";
import { parseSectionedForm } from "./chunk-sections";
import { decodeChunkScanPage } from "./chunk-scan";
import { encodeStatement, ReplyReader, type ChunkParameter, type ChunkReply, type ErrorReply, type PushReply } from "./protocol";
import { filterClause, ChunkWatch, kWatchAck, kWatchPause, kWatchStream } from "./watch";
import { parseSlots, slotName } from "./slots";
import {
  MIN_SCRAM_ITERATIONS,
  finishScramLogin,
  scramSignatureMatches,
  scramVerifierAsync,
  startScramLogin,
  type ScramFinal,
  type ScramLogin,
} from "./scram";
import { integerOf, mapOf, parseDescribe, parseServerInfo, parseStatus, uint64Of, textOf, type TableLayout } from "./schema";
import { formatChunkUri, parseChunkUri, tableFromUriPath } from "./uri";
import type {
  ChunkAxis,
  ChunkArea3D,
  ChunkAreaEntry3D,
  ChunkAreaRawEntry3D,
  ChunkCoord3D,
  ChunkScanDataOptions,
  ChunkScanOptions3D,
  ChunkScanEntry,
  ChunkScanEntry3D,
  ChunkScanDataPage,
  ChunkScanPage3D,
  ChunkBlockMetadata,
  ChunkAreaMetadata,
  ChunkStatus,
  ChunkArea,
  ChunkAreaEntry,
  ChunkAreaRawEntry,
  ChunkClientOptions,
  ChunkColumnDefinition,
  ChunkColumnType,
  ChunkCoord,
  ChunkCreateUserOptions,
  ChunkMigration,
  ChunkMigrationResult,
  ChunkReadOptions,
  ChunkRight,
  ChunkRow,
  ChunkScanOptions,
  ChunkScanPage,
  ChunkServerInfo,
  ChunkSlot,
  ChunkSlotOptions,
  ChunkState,
  ChunkStateInput,
  ChunkTableChange,
  ChunkTableDefinition,
  ChunkTableOption,
  ChunkTableOptions,
  ChunkTableSchema,
  ChunkTransaction,
  ChunkTransactionOptions,
  ChunkUser,
  ChunkValue,
  ChunkWriteOptions,
  ChunkWatchOptions,
  ParsedChunkUri,
} from "./types";
import {
  StaleSchemaError,
  checkCoordinate,
  checkInt64Coordinate as axis3D,
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
  user: string;
  password: string;
  verifierIterations: number;
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
  helloOptions?: Readonly<Record<string, ChunkValue>>;
}

// The place of one operation in the order statements are written: it
// writes only after the operation started before it wrote its statement (or
// ended).
interface SendTurn {
  previous: Promise<void>;
  release: () => void;
  // The transaction attempt the operation belongs to.
  tx?: TransactionAttempt;
}

// One run of a transaction's callback (ChunkClient.transaction).
//
// The server keeps a transaction per connection, so the attempt holds the
// client's whole connection: it starts once every operation in flight has
// ended, and plain operations called meanwhile wait until it ends. Its own
// statements, the DESCRIBE of a schema it has not cached included, run one
// at a time on that connection and never reconnect.
interface TransactionAttempt {
  readonly owner: ChunkClient;
  // False once the callback settled: the handle then refuses calls.
  open: boolean;
  // The connection BEGIN went out on; the attempt uses no other one.
  socket: TransportSocket | null;
  // The server holds the attempt's transaction, open or ended by CONFLICT,
  // until ROLLBACK or COMMIT.
  began: boolean;
  // Settles when the statements called so far have settled.
  chain: Promise<void>;
  // CONFLICT or a lost connection ended the transaction: every later
  // statement of the attempt fails with it without being sent.
  failure: Error | null;
}

interface OperationWaiter {
  run: () => void;
  reject: (err: Error) => void;
  // A transaction, which waits until no operation is in flight.
  exclusive?: boolean;
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
const DEFAULT_TABLE = "";
const DEFAULT_TRANSACTION_RETRIES = 5;

const TABLE_STATEMENT = /^\s*(?:migrate\s+'[a-z_][a-z0-9_]{0,62}'\s+)?(?:create|alter|drop)\s+table\s+([a-z_][a-z0-9_]*)/i;
const RIGHTS: readonly ChunkRight[] = ["READ", "WRITE", "ADMIN"];
// The statements of the login, sent while connecting.
const HANDSHAKE = new Set(["HELLO", "AUTH"]);
const PUSH_KINDS = new Set(["schema", "change", "progress", "resync", "chunks", "catalog"]);

const TABLE_OPTION_NAMES: Record<keyof ChunkTableOptions, string> = {
  durabilityMode: "durability_mode",
  checkpointUpdates: "checkpoint_updates",
  checkpointWalBytes: "checkpoint_wal_bytes",
  walGroupCommitUpdates: "wal_group_commit_updates",
  checkpointCompression: "checkpoint_compression",
  varMaxChunkBytes: "var_max_chunk_bytes",
  feedBufferBytes: "feed_buffer_bytes",
  slotMaxBytes: "slot_max_bytes",
};

// Framing failures close the connection; semantic failures have drained their frames.
function closesConnection(reply: ErrorReply, _withParameters: boolean): boolean {
  return reply.code === "BAD_REQUEST" || reply.code === "PROTOCOL";
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
  const user = options.user ?? parsed?.user ?? "";
  const password = options.password ?? parsed?.password ?? "";
  if (user === "" && password !== "") {
    throw new ChunkConnectionError("a password needs a user", { phase: "connect" });
  }
  if (user !== "") {
    checkName(user, "a user name");
  }
  const verifierIterations = options.verifierIterations ?? MIN_SCRAM_ITERATIONS;
  if (!Number.isSafeInteger(verifierIterations) || verifierIterations < MIN_SCRAM_ITERATIONS) {
    throw new TypeError(`verifierIterations must be an integer of at least ${MIN_SCRAM_ITERATIONS}`);
  }
  const named =
    options.table !== undefined && options.table !== "" ? options.table : tableFromUriPath(parsed?.path ?? "/");
  return {
    host,
    port,
    user,
    password,
    verifierIterations,
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
    helloOptions: options.helloOptions,
    uri: {
      scheme: secure ? "chunks" : "chunk",
      secure,
      host,
      port,
      user,
      // uri() never shows the password.
      password: "",
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
  return uint64Of(reply, "chunk version", command);
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

function rightOf(right: ChunkRight, command: string): ChunkRight {
  if (!RIGHTS.includes(right)) {
    throw requestError(`a right is READ, WRITE or ADMIN, got ${JSON.stringify(right)}`, command);
  }
  return right;
}

function grantTable(table: string, command: string): string {
  return table === "*" ? table : checkName(table, `a table name (or "*") in ${command}`);
}

function userOf(reply: ChunkReply, command: string): ChunkUser {
  const entries = mapOf(reply, command);
  const name = entries.get("name");
  const managesUsers = entries.get("manages_users");
  const grantsReply = entries.get("grants");
  if (name === undefined || managesUsers?.type !== "boolean" || grantsReply === undefined) {
    throw new ChunkProtocolError(`malformed ${command} reply`, { phase: "protocol", command });
  }
  // fromEntries defines every table as its own key, `__proto__` included.
  const grants = Object.fromEntries(
    [...mapOf(grantsReply, command)].map(([table, right]): [string, ChunkRight] => {
      const text = textOf(right, `the right on ${table}`, command);
      const known = RIGHTS.find((candidate) => candidate === text);
      if (known === undefined) {
        throw new ChunkProtocolError(`malformed ${command} reply: unknown right ${text}`, { phase: "protocol", command });
      }
      return [table, known];
    }),
  );
  return { name: textOf(name, "a user name", command), managesUsers: managesUsers.value, grants };
}

function writeClause(options: ChunkWriteOptions, command: string, chunk = false): string {
  if (options.ifAbsent !== undefined && typeof options.ifAbsent !== "boolean") throw requestError("ifAbsent must be a boolean", command);
  if (options.ifAbsent === true) {
    if (!chunk || options.ifVersion !== undefined) throw requestError("ifAbsent needs a chunk write without ifVersion", command);
    return " IF ABSENT";
  }
  return options.ifVersion === undefined ? "" : ` IF VERSION ${checkVersion(options.ifVersion)}`;
}

type GridPoint = readonly [number, number] | readonly [ChunkAxis, ChunkAxis, ChunkAxis];

function pointClause(point: GridPoint): string {
  return point.length === 2 ? `${checkCoordinate(point[0], "x")} ${checkCoordinate(point[1], "y")}` :
    point.map((value, i) => axis3D(value, ["x", "y", "z"][i]).toString()).join(" ");
}

function axisReply(reply: ChunkReply, name: string, command: string): bigint {
  if (reply.type !== "integer" || reply.value < -(1n << 63n) || reply.value > (1n << 63n) - 1n) throw new ChunkProtocolError(`invalid ${name} coordinate`, { phase: "protocol", command });
  return reply.value;
}

function isTransportError(error: unknown): error is ChunkError {
  return error instanceof ChunkConnectionError || error instanceof ChunkTimeoutError || error instanceof ChunkTlsError;
}

// Errors of statements a transaction did not send because its connection
// had closed, which rolled the transaction back.
const unsent = new WeakSet<Error>();

function transactionLost(command: string): ChunkConnectionError {
  const error = new ChunkConnectionError(
    `the connection closed during the transaction, before ${command}; the server rolled the transaction back`,
    { phase: "connect", command },
  );
  unsent.add(error);
  return error;
}

// A COMMIT whose connection failed after it was sent may or may not have
// been applied.
function commitError(error: unknown): unknown {
  if (!isTransportError(error) || unsent.has(error)) {
    return error;
  }
  const message = `the outcome of COMMIT is unknown: ${error.message}`;
  const options = { phase: error.phase, command: "COMMIT", code: error.code, cause: error };
  if (error instanceof ChunkTimeoutError) {
    return new ChunkTimeoutError(message, options);
  }
  return error instanceof ChunkTlsError ? new ChunkTlsError(message, options) : new ChunkConnectionError(message, options);
}

// A short random pause before a transaction runs again, so that
// transactions conflicting with each other do not keep meeting: up to 1 ms
// after the first conflict, doubling to at most 16 ms.
function conflictPause(conflicts: number): Promise<void> {
  const ms = Math.random() * Math.min(16, 2 ** (conflicts - 1));
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function noIfVersion(options: ChunkWriteOptions | undefined, command: string): void {
  if (options?.ifVersion !== undefined) {
    throw requestError("ifVersion is not taken inside a transaction: COMMIT checks every chunk the transaction read or wrote", command);
  }
  if (options?.ifAbsent === true) throw requestError("ifAbsent is not taken inside a transaction: COMMIT checks every chunk the transaction read or wrote", command);
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

function areaClause3D(area: ChunkArea3D): string {
  if ("radius" in area) {
    const radius = axis3D(area.radius, "radius");
    if (radius < 0n) throw requestError("radius must be non-negative", "GET AREA");
    return `AROUND ${pointClause([area.cx, area.cy, area.cz])} RADIUS ${radius}`;
  }
  return `${pointClause([area.cx0, area.cy0, area.cz0])} TO ${pointClause([area.cx1, area.cy1, area.cz1])}`;
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
  private connectAbort: (() => void) | null = null;
  private readonly reader = new ReplyReader();
  private connected = false;
  private disposed = false;
  private info: ChunkServerInfo | null = null;
  private watchReceiver: ((reply: PushReply) => void) | null = null;
  private watchAckError: ((error: Error) => void) | null = null;
  private watchFailure: ((error: Error) => void) | null = null;
  private watchPaused = false;
  private watchStarted = false;
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
  private readonly opWaiters: OperationWaiter[] = [];
  // The transaction attempt holding the connection.
  private holder: TransactionAttempt | null = null;
  // The attempt whose callback is running, for refusing plain calls on this
  // client from inside it: they would wait for the transaction to end.
  private readonly callbackScope = new AsyncLocalStorage<TransactionAttempt>();

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
    this.connectAbort?.();
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
   * Runs named steps in order at each application start. Stops at the first
   * error with a ChunkMigrationError containing that step and earlier results.
   * Names and statement text must stay unchanged after a step is applied.
   */
  async migrate(migrations: readonly ChunkMigration[]): Promise<ChunkMigrationResult[]> {
    const results: ChunkMigrationResult[] = [];
    for (const [index, migration] of migrations.entries()) {
      try {
        checkName(migration.name, "a migration name");
        if (migration.name.length > 63) throw requestError("a migration name takes at most 63 bytes", "MIGRATE");
        if (typeof migration.statement !== "string" || /[\r\n\0]/.test(migration.statement)) {
          throw requestError("a migration statement must be one line without CR, LF or NUL", "MIGRATE");
        }
        const statement = migration.statement.replace(/^[ \t]+|[ \t]+$/g, "");
        if (statement === "") throw requestError("a migration needs one statement", "MIGRATE");
        if (/\$[0-9]+/.test(statement.replace(/'(?:[^']|'')*'/g, ""))) {
          throw requestError("a migration statement cannot take parameters", "MIGRATE");
        }
        const reply = await this.execute(`MIGRATE '${migration.name}' ${statement}`);
        if (reply.type !== "simple" || (reply.value !== "applied" && reply.value !== "skipped")) {
          throw new ChunkProtocolError("malformed MIGRATE reply: expected applied or skipped", { phase: "protocol", command: "MIGRATE" });
        }
        results.push({ name: migration.name, status: reply.value });
      } catch (cause) {
        throw new ChunkMigrationError(migration, index, results, cause);
      }
    }
    return results;
  }

  /**
   * The table's schema (`DESCRIBE`). This also refreshes the client's cached
   * schema, which encodes parameters and decodes values and chunk forms.
   */
  describe(table?: string): Promise<ChunkTableSchema> {
    return this.enqueue(async () => (await this.refreshLayout(this.tableOf({ table }))).schema);
  }

  /** Changes on a dedicated connection with the same transport and login options. */
  watch(table: string, options: ChunkWatchOptions = {}): Promise<ChunkWatch> {
    if (this.disposed) return Promise.reject(new ChunkConnectionError("client is closed", { phase: "connect" }));
    return ChunkWatch.open(() => new ChunkClient({ ...this.options, uri: undefined, tls: this.options.secure }), table, options);
  }

  /** @internal */
  async [kWatchStream](statement: string, receive: (reply: PushReply) => void, failed: (error: Error) => void,
    rejectedAck?: (error: Error) => void): Promise<ChunkReply> {
    await this.connect();
    this.watchReceiver = receive;
    this.watchFailure = failed;
    this.watchAckError = rejectedAck ?? null;
    return this.execute(statement);
  }

  /** @internal ACK has no success reply and never reconnects its stream. */
  [kWatchAck](revision: bigint): Promise<void> {
    return this.enqueue(async () => {
      const turn = this.sendTurns.getStore();
      await turn?.previous;
      const socket = this.socket;
      if (socket === null || !this.watchStarted || this.watchReceiver === null) {
        throw new ChunkConnectionError("watch connection is not available", { phase: "request", command: "ACK" });
      }
      await new Promise<void>((resolve, reject) => {
        const finish = (error?: Error) => {
          clearTimeout(timer);
          socket.off("close", closed);
          if (error !== undefined) reject(error); else resolve();
        };
        const closed = () => finish(new ChunkConnectionError("connection closed during ACK", { phase: "request", command: "ACK" }));
        const timer = setTimeout(() => {
          const error = new ChunkTimeoutError("ACK write timed out", { phase: "timeout", command: "ACK" });
          this.clearConnectionState(error); socket.destroy(); finish(error);
        }, this.options.commandTimeoutMs);
        socket.once("close", closed);
        socket.write(encodeStatement(`ACK ${revision}`, []), (cause) => {
          if (cause) {
            const error = this.wrapTransportError(cause, "request", "ACK");
            this.clearConnectionState(error); socket.destroy(); finish(error);
          } else finish();
        });
      });
    });
  }

  /** @internal */
  [kWatchPause](paused: boolean): void {
    this.watchPaused = paused;
    if (paused) this.socket?.pause();
    else {
      this.drainReplies();
      if (!this.watchPaused) this.socket?.resume();
    }
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

  /** Enables a directory feature explicitly; requires ADMIN on `*`. */
  enableFeature(name: string): Promise<void> {
    return this.enqueue(async () => {
      const statement = `ENABLE FEATURE ${checkName(name, "a feature name")}`;
      expectOk(await this.run(statement, [], "ENABLE FEATURE"), "ENABLE FEATURE");
    });
  }

  /** Protected directory and table feature masks; requires ADMIN on `*`. */
  showStatus(): Promise<ChunkStatus> {
    return this.enqueue(async () => parseStatus(await this.run("SHOW STATUS", [], "SHOW STATUS")));
  }

  /** Creates a durable slot; requires ADMIN on the table. */
  createSlot(table: string, name: string, options: ChunkSlotOptions = {}): Promise<void> {
    return this.enqueue(async () => {
      const statement = `CREATE SLOT ${options.ifNotExists ? "IF NOT EXISTS " : ""}${slotName(name)} ON ${checkName(table, "a table name")}${filterClause(options)}`;
      expectOk(await this.run(statement, [], "CREATE SLOT"), "CREATE SLOT");
    });
  }

  /** Drops a durable slot and its retention claim; requires ADMIN. */
  dropSlot(table: string, name: string): Promise<void> {
    return this.enqueue(async () => {
      const statement = `DROP SLOT ${slotName(name)} ON ${checkName(table, "a table name")}`;
      expectOk(await this.run(statement, [], "DROP SLOT"), "DROP SLOT");
    });
  }

  /** Lists visible slots, including lost slots; acked is the written position. */
  listSlots(table?: string): Promise<ChunkSlot[]> {
    return this.enqueue(async () => {
      const statement = `SHOW SLOTS${table === undefined ? "" : ` ON ${checkName(table, "a table name")}`}`;
      return parseSlots(await this.run(statement, [], "SHOW SLOTS"));
    });
  }

  /** `CREATE TABLE`. The chunk and large-chunk sizes are fixed once created. */
  createTable(name: string, definition: ChunkTableDefinition): Promise<void> {
    return this.enqueue(async () => {
      checkName(name, "a table name");
      if (definition.columns.length === 0) {
        throw requestError("a table needs at least one column", "CREATE TABLE");
      }
      const dims = definition.chunk.depth === undefined ? 2 : 3;
      const size = (what: string, value: { width: number; height: number; depth?: number }) => {
        if ((value.depth === undefined ? 2 : 3) !== dims) throw requestError(`${what} needs ${dims} dimensions`, "CREATE TABLE");
        const sides = [value.width, value.height, ...(dims === 3 ? [value.depth!] : [])];
        for (const n of sides) {
          if (!Number.isSafeInteger(n) || n < 1 || n > (what === "chunk" ? 4096 : 1_000_000)) {
            throw requestError(`${what} sizes are positive integers`, "CREATE TABLE");
          }
        }
        return sides.join(" x ");
      };
      if (definition.chunk.width * definition.chunk.height * (definition.chunk.depth ?? 1) > 1_048_576) {
        throw requestError("a chunk has at most 1048576 blocks", "CREATE TABLE");
      }
      let statement =
        `CREATE TABLE ${name} (${definition.columns.map(columnDefinition).join(", ")})` +
        ` CHUNK ${size("chunk", definition.chunk)}`;
      if (definition.large !== undefined) {
        statement += ` LARGE ${size("large chunk", definition.large)}`;
      }
      if (definition.chunkColumns !== undefined && definition.chunkColumns.length !== 0) {
        statement += ` CHUNK COLUMNS (${definition.chunkColumns.map(columnDefinition).join(", ")})`;
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
        case "addChunkColumn":
          clause = `ADD CHUNK COLUMN ${change.ifNotExists === true ? "IF NOT EXISTS " : ""}${columnDefinition(change.column)}`;
          break;
        case "dropChunkColumn":
          clause = `DROP CHUNK COLUMN ${change.ifExists === true ? "IF EXISTS " : ""}${checkName(change.column, "a column name")}`;
          break;
        case "renameChunkColumn":
          clause = `RENAME CHUNK COLUMN ${checkName(change.column, "a column name")} TO ${checkName(change.to, "a column name")}`;
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
    return this.enqueue(() => this.getBlockOp([x, y], options));
  }

  /** Row, chunk version and schema version from one read boundary. */
  getBlockWithMetadata(x: number, y: number, options: ChunkReadOptions = {}): Promise<ChunkBlockMetadata> {
    return this.enqueue(() => this.getBlockWithMetadataOp([x, y], options));
  }

  /**
   * Sets columns of a block; a new block takes defaults for the others.
   * Values travel as parameters. Resolves the chunk version after the write.
   */
  setBlock(x: number, y: number, values: Readonly<Record<string, ChunkValue>>, options: ChunkWriteOptions = {}): Promise<bigint> {
    return this.enqueue(async () => versionOf(await this.setBlockOp([x, y], values, options), "SET BLOCK"));
  }

  /** Deletes a block. Resolves the chunk version after it. */
  deleteBlock(x: number, y: number, options: ChunkWriteOptions = {}): Promise<bigint> {
    return this.enqueue(async () => versionOf(await this.deleteBlockOp([x, y], options), "DELETE BLOCK"));
  }

  /**
   * A chunk decoded by the table's schema: its version, which blocks are
   * present, and per column the values of the present blocks. A never-written
   * chunk is null; a written empty chunk keeps its form and version until collected.
   */
  getChunk(cx: number, cy: number, options: ChunkReadOptions = {}): Promise<ChunkState | null> {
    return this.enqueue(() => this.getChunkOp([cx, cy], options));
  }

  /** The chunk form as the server sends it, or null for a never-written chunk. */
  getChunkRaw(cx: number, cy: number, options: ChunkReadOptions = {}): Promise<Buffer | null> {
    return this.enqueue(() => this.getChunkRawOp([cx, cy], options));
  }

  /**
   * Replaces every column of the chunk with `state`, encoded by the table's
   * schema: a state from `getChunk`, or one built from `emptyChunk(schema)`.
   * Values of absent blocks are not sent. Resolves the chunk version after
   * the write.
   */
  setChunk(cx: number, cy: number, state: ChunkStateInput, options: ChunkWriteOptions = {}): Promise<bigint> {
    return this.enqueue(async () => versionOf(await this.setChunkOp([cx, cy], state, options), "SET CHUNK"));
  }

  /**
   * Writes a chunk form of every column (as `getChunkRaw` without `columns`
   * returns it); its chunk version is not read. A form of another schema
   * version than the table's rejects with `ChunkSchemaMismatchError`.
   */
  setChunkRaw(cx: number, cy: number, form: Uint8Array, options: ChunkWriteOptions = {}): Promise<bigint> {
    return this.enqueue(async () => versionOf(await this.setChunkRawOp([cx, cy], form, options), "SET CHUNK"));
  }

  /** Read a block at explicit three-axis coordinates without rounding int64 values. */
  getBlock3D(x: ChunkAxis, y: ChunkAxis, z: ChunkAxis, options: ChunkReadOptions = {}): Promise<ChunkRow | null> {
    return this.enqueue(() => this.getBlockOp([x, y, z], options));
  }

  getBlock3DWithMetadata(x: ChunkAxis, y: ChunkAxis, z: ChunkAxis, options: ChunkReadOptions = {}): Promise<ChunkBlockMetadata> {
    return this.enqueue(() => this.getBlockWithMetadataOp([x, y, z], options));
  }

  setBlock3D(x: ChunkAxis, y: ChunkAxis, z: ChunkAxis, values: Readonly<Record<string, ChunkValue>>, options: ChunkWriteOptions = {}): Promise<bigint> {
    return this.enqueue(async () => versionOf(await this.setBlockOp([x, y, z], values, options), "SET BLOCK"));
  }

  deleteBlock3D(x: ChunkAxis, y: ChunkAxis, z: ChunkAxis, options: ChunkWriteOptions = {}): Promise<bigint> {
    return this.enqueue(async () => versionOf(await this.deleteBlockOp([x, y, z], options), "DELETE BLOCK"));
  }

  getChunk3D(cx: ChunkAxis, cy: ChunkAxis, cz: ChunkAxis, options: ChunkReadOptions = {}): Promise<ChunkState | null> {
    return this.enqueue(() => this.getChunkOp([cx, cy, cz], options));
  }

  getChunkRaw3D(cx: ChunkAxis, cy: ChunkAxis, cz: ChunkAxis, options: ChunkReadOptions = {}): Promise<Buffer | null> {
    return this.enqueue(() => this.getChunkRawOp([cx, cy, cz], options));
  }

  setChunk3D(cx: ChunkAxis, cy: ChunkAxis, cz: ChunkAxis, state: ChunkStateInput, options: ChunkWriteOptions = {}): Promise<bigint> {
    return this.enqueue(async () => versionOf(await this.setChunkOp([cx, cy, cz], state, options), "SET CHUNK"));
  }

  setChunkRaw3D(cx: ChunkAxis, cy: ChunkAxis, cz: ChunkAxis, form: Uint8Array, options: ChunkWriteOptions = {}): Promise<bigint> {
    return this.enqueue(async () => versionOf(await this.setChunkRawOp([cx, cy, cz], form, options), "SET CHUNK"));
  }

  /** Replace selected block columns and presence while preserving chunk metadata. */
  setChunkColumns(cx: number, cy: number, columns: readonly string[], state: ChunkStateInput, options: ChunkWriteOptions = {}): Promise<bigint> {
    return this.enqueue(async () => versionOf(await this.setChunkColumnsOp([cx, cy], columns, state, options), "SET CHUNK"));
  }

  setChunkColumns3D(cx: ChunkAxis, cy: ChunkAxis, cz: ChunkAxis, columns: readonly string[], state: ChunkStateInput, options: ChunkWriteOptions = {}): Promise<bigint> {
    return this.enqueue(async () => versionOf(await this.setChunkColumnsOp([cx, cy, cz], columns, state, options), "SET CHUNK"));
  }

  /** Update named chunk columns without changing block values. */
  setChunkMetadata(cx: number, cy: number, values: Readonly<ChunkRow>, options: ChunkWriteOptions = {}): Promise<bigint> {
    return this.enqueue(async () => versionOf(await this.setChunkMetadataOp([cx, cy], values, options), "SET CHUNK"));
  }

  setChunkMetadata3D(cx: ChunkAxis, cy: ChunkAxis, cz: ChunkAxis, values: Readonly<ChunkRow>, options: ChunkWriteOptions = {}): Promise<bigint> {
    return this.enqueue(async () => versionOf(await this.setChunkMetadataOp([cx, cy, cz], values, options), "SET CHUNK"));
  }

  getArea3D(area: ChunkArea3D, options: ChunkReadOptions = {}): Promise<ChunkAreaEntry3D[]> {
    return this.enqueue(async () => (await this.getArea3DOp(area, options, false, false)).entries);
  }

  getAreaRaw3D(area: ChunkArea3D, options: ChunkReadOptions = {}): Promise<ChunkAreaRawEntry3D[]> {
    return this.enqueue(async () => (await this.getArea3DOp(area, options, true, false)).entries);
  }

  getArea3DWithSchema(area: ChunkArea3D, options: ChunkReadOptions = {}): Promise<ChunkAreaMetadata<ChunkAreaEntry3D>> {
    return this.enqueue(() => this.getArea3DOp(area, options, false, true));
  }

  getAreaRaw3DWithSchema(area: ChunkArea3D, options: ChunkReadOptions = {}): Promise<ChunkAreaMetadata<ChunkAreaRawEntry3D>> {
    return this.enqueue(() => this.getArea3DOp(area, options, true, true));
  }

  /**
   * The chunks of an area that have a present block, in ascending `cx` then
   * `cy`, decoded by the table's schema. An area covers at most
   * `maxAreaChunks` chunks.
   */
  getArea(area: ChunkArea, options: ChunkReadOptions = {}): Promise<ChunkAreaEntry[]> {
    return this.enqueue(() => this.getAreaOp(area, options));
  }

  getAreaWithSchema(area: ChunkArea, options: ChunkReadOptions = {}): Promise<ChunkAreaMetadata<ChunkAreaEntry>> {
    return this.enqueue(() => this.getAreaWithSchemaOp(area, options, false));
  }

  getAreaRawWithSchema(area: ChunkArea, options: ChunkReadOptions = {}): Promise<ChunkAreaMetadata<ChunkAreaRawEntry>> {
    return this.enqueue(() => this.getAreaWithSchemaOp(area, options, true));
  }

  /** `getArea` with each chunk as the server sends its form. */
  getAreaRaw(area: ChunkArea, options: ChunkReadOptions = {}): Promise<ChunkAreaRawEntry[]> {
    return this.enqueue(() => this.getAreaRawOp(area, options));
  }

  /**
   * Runs `fn` in a transaction and resolves the version `COMMIT` gave every
   * chunk it wrote, or null when it wrote nothing. `fn` reads and writes
   * through `tx`; its reads see one snapshot of the table, and its writes
   * apply together at `COMMIT` or not at all.
   *
   * When the transaction ends with `CONFLICT` (another write changed what it
   * read or wrote, or a server limit ended it), nothing of it is applied and
   * `fn` runs again in a new transaction, after a pause of a few
   * milliseconds, up to `retries` times; then the `ChunkConflictError`
   * rejects. When `fn` throws, the transaction is rolled back and the error
   * rejects without running again. `fn` may run more than once, so it
   * should not have other effects until the returned promise resolves.
   *
   * The transaction holds this client's connection: it starts once the
   * calls in flight have ended, and calls made meanwhile wait until it ends.
   * Inside `fn` use `tx`; calls on this client from inside it are refused.
   */
  async transaction(
    fn: (tx: ChunkTransaction) => unknown,
    options: ChunkTransactionOptions = {},
  ): Promise<bigint | null> {
    const retries = options.retries ?? DEFAULT_TRANSACTION_RETRIES;
    if (!Number.isSafeInteger(retries) || retries < 0) {
      throw new TypeError("retries must be a non-negative integer");
    }
    if (this.inCallback()) {
      throw requestError("transactions do not nest: use the transaction's tx inside its callback");
    }
    let conflicts = 0;
    while (true) {
      // Connecting rejects the operations waiting for the connection, so
      // the attempt connects before it waits for it.
      await this.connect();
      const tx: TransactionAttempt = {
        owner: this,
        open: true,
        socket: null,
        began: false,
        chain: Promise.resolve(),
        failure: null,
      };
      await this.hold(tx);
      let error: unknown;
      try {
        return await this.runAttempt(tx, fn);
      } catch (caught) {
        error = caught;
      } finally {
        this.holder = null;
        this.releaseEnqueueSlot();
      }
      if (error instanceof ChunkConflictError && conflicts < retries) {
        conflicts += 1;
        await conflictPause(conflicts);
        continue;
      }
      throw error;
    }
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

  /** Scan retained two-dimensional versions and optional complete forms. */
  scanChunksWithOptions(options: ChunkScanDataOptions = {}): Promise<ChunkScanDataPage> {
    return this.enqueue(async () => {
      const after = options.after === undefined ? undefined : [BigInt(checkCoordinate(options.after.cx, "after.cx")), BigInt(checkCoordinate(options.after.cy, "after.cy"))];
      const page = await this.scanChunksDataOp(options, 2, after);
      return { ...page, chunks: page.chunks.map(({ cx, cy, cz: _cz, ...chunk }): ChunkScanEntry => ({ ...chunk,
        cx: integerOf({ type: "integer", value: cx }, "cx", "SCAN CHUNKS"), cy: integerOf({ type: "integer", value: cy }, "cy", "SCAN CHUNKS") })) };
    });
  }

  /** Three-dimensional scans retain exact coordinates and tombstone versions. */
  scanChunks3D(options: ChunkScanOptions3D = {}): Promise<ChunkScanPage3D> {
    return this.enqueue(() => {
      const after = options.after === undefined ? undefined : [axis3D(options.after.cx, "after.cx"), axis3D(options.after.cy, "after.cy"), axis3D(options.after.cz, "after.cz")];
      return this.scanChunksDataOp(options, 3, after);
    });
  }

  async *scanAllChunks3D(options: Omit<ChunkScanOptions3D, "after" | "since" | "withData" | "columns"> = {}): AsyncGenerator<ChunkCoord3D, void, undefined> {
    let after: ChunkCoord3D | undefined;
    let epoch = options.epoch;
    while (true) {
      const page = await this.scanChunks3D({ table: options.table, limit: options.limit, epoch, after });
      epoch ??= page.epoch;
      for (const { cx, cy, cz } of page.chunks) { after = { cx, cy, cz }; yield { cx, cy, cz }; }
      if (!page.more) return;
    }
  }

  private async scanChunksDataOp(options: Omit<ChunkScanDataOptions, "after">, dims: 2 | 3, after: readonly bigint[] | undefined): Promise<ChunkScanPage3D> {
    const command = "SCAN CHUNKS", table = this.tableOf(options);
    if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 1)) throw requestError("limit must be a positive integer", command);
    if (options.since !== undefined && (typeof options.since !== "bigint" || options.since < 0n || options.since > (1n << 64n) - 1n)) throw requestError("since must be a uint64 bigint", command);
    if (options.withData !== undefined && typeof options.withData !== "boolean") throw requestError("withData must be a boolean", command);
    if (options.columns !== undefined && options.withData !== true) throw requestError("column projections need WITH DATA", command);
    if (options.epoch !== undefined && (typeof options.epoch !== "string" || !/^[0-9a-f]{32}$/i.test(options.epoch))) throw requestError("epoch must be 32 hex digits", command);
    const epoch = options.epoch?.toLowerCase();
    return this.withLayout(table, false, async (layout) => {
      if ((layout.schema.dims ?? 2) !== dims) throw requestError(`table ${table} needs ${layout.schema.dims ?? 2} coordinates`, command);
      if (epoch !== undefined && layout.schema.epoch?.toLowerCase() !== epoch) throw requestError("scan position belongs to another table epoch", command);
      const indexes = columnIndexes(layout, options.columns);
      let statement = `SCAN CHUNKS FROM ${table}`;
      if (after !== undefined) statement += ` AFTER ${after.join(" ")}`;
      if (options.since !== undefined) statement += ` SINCE ${options.since}`;
      if (options.limit !== undefined) statement += ` LIMIT ${options.limit}`;
      if (options.withData) statement += ` WITH DATA${columnsClause(options.columns ?? [])}`;
      const reply = await this.run(statement, [], command);
      return decodeChunkScanPage(layout, reply, { dims, after, since: options.since, limit: options.limit, withData: options.withData === true, epoch, indexes });
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

  /**
   * `CREATE USER`. The client computes the SCRAM verifier from the password
   * and sends only the verifier. Needs `MANAGES USERS`.
   */
  createUser(name: string, password: string, options: ChunkCreateUserOptions = {}): Promise<void> {
    return this.enqueue(async () => {
      checkName(name, "a user name");
      const verifier = await this.verifier(password);
      const manages = options.managesUsers === true ? " MANAGES USERS" : "";
      expectOk(await this.run(`CREATE USER ${name} VERIFIER $1${manages}`, [verifier], "CREATE USER"), "CREATE USER");
    });
  }

  /**
   * `ALTER USER ... VERIFIER`: a new password, sent as its verifier. Users
   * may change their own; others need `MANAGES USERS`. The client keeps
   * logging in with the password it was given.
   */
  setPassword(name: string, password: string): Promise<void> {
    return this.enqueue(async () => {
      checkName(name, "a user name");
      const verifier = await this.verifier(password);
      expectOk(await this.run(`ALTER USER ${name} VERIFIER $1`, [verifier], "ALTER USER"), "ALTER USER");
    });
  }

  /** `ALTER USER ... [NO] MANAGES USERS`. */
  setManagesUsers(name: string, managesUsers: boolean): Promise<void> {
    return this.enqueue(async () => {
      checkName(name, "a user name");
      const clause = managesUsers ? "MANAGES USERS" : "NO MANAGES USERS";
      expectOk(await this.run(`ALTER USER ${name} ${clause}`, [], "ALTER USER"), "ALTER USER");
    });
  }

  /** `DROP USER`. */
  dropUser(name: string): Promise<void> {
    return this.enqueue(async () => {
      checkName(name, "a user name");
      expectOk(await this.run(`DROP USER ${name}`, [], "DROP USER"), "DROP USER");
    });
  }

  /** `GRANT <right> ON <table> TO <user>`; `"*"` stands for every table, those created later included. */
  grant(right: ChunkRight, table: string, user: string): Promise<void> {
    return this.enqueue(async () => {
      const statement = `GRANT ${rightOf(right, "GRANT")} ON ${grantTable(table, "GRANT")} TO ${checkName(user, "a user name")}`;
      expectOk(await this.run(statement, [], "GRANT"), "GRANT");
    });
  }

  /** `REVOKE <right> ON <table> FROM <user>`: takes away the right and those above it. */
  revoke(right: ChunkRight, table: string, user: string): Promise<void> {
    return this.enqueue(async () => {
      const statement = `REVOKE ${rightOf(right, "REVOKE")} ON ${grantTable(table, "REVOKE")} FROM ${checkName(user, "a user name")}`;
      expectOk(await this.run(statement, [], "REVOKE"), "REVOKE");
    });
  }

  /** Users with their rights (`SHOW USERS`). Needs `MANAGES USERS`. */
  listUsers(): Promise<ChunkUser[]> {
    return this.enqueue(async () => {
      const command = "SHOW USERS";
      return itemsOf(await this.run(command, [], command), command).map((item) => userOf(item, command));
    });
  }

  private async verifier(password: string): Promise<Buffer> {
    if (typeof password !== "string") {
      throw requestError("a password is a string");
    }
    return Buffer.from(await scramVerifierAsync(password, { iterations: this.options.verifierIterations }), "utf8");
  }

  // The statements of the block, chunk and area methods, shared by this
  // client's calls and a transaction's. Writes resolve the reply: a version,
  // or null inside a transaction.

  private async getBlockOp(point: GridPoint, options: ChunkReadOptions): Promise<ChunkRow | null> {
    const table = this.tableOf(options);
    const at = pointClause(point);
    return await this.withLayout(table, false, async (layout) => {
      const indexes = columnIndexes(layout, options.columns);
      const names = indexes.map((index) => layout.schema.columns[index].name);
      const reply = await this.run(`GET BLOCK ${at} FROM ${table}${columnsClause(names)}`, [], "GET BLOCK");
      if (reply.type === "null") {
        return null;
      }
      if (reply.type !== "array" || reply.items.length < indexes.length) {
        throw new StaleSchemaError(`GET BLOCK answered ${reply.type === "array" ? reply.items.length : reply.type} values for ${indexes.length} columns`, {
          phase: "protocol",
          command: "GET BLOCK",
        });
      }
      return Object.fromEntries(indexes.map((index, i) => {
        const column = layout.schema.columns[index];
        return [column.name, valueFromReply(column, reply.items[i])];
      }));
    });
  }

  private async getBlockWithMetadataOp(point: GridPoint, options: ChunkReadOptions): Promise<ChunkBlockMetadata> {
    const table = this.tableOf(options);
    return this.withLayout(table, false, async (layout) => {
      const indexes = columnIndexes(layout, options.columns);
      const names = indexes.map((index) => layout.schema.columns[index].name);
      const statement = `GET BLOCK ${pointClause(point)} FROM ${table}${columnsClause(names)} WITH VERSION WITH SCHEMA`;
      const reply = await this.run(statement, [], "GET BLOCK");
      const items = itemsOf(reply, "GET BLOCK");
      if (items.length < 3) throw new ChunkProtocolError("GET BLOCK metadata is missing fields", { phase: "protocol", command: "GET BLOCK" });
      const version = items[0].type === "null" ? null : uint64Of(items[0], "version", "GET BLOCK");
      const schemaVersion = uint64Of(items[1], "schema version", "GET BLOCK");
      this.checkReadSchema(layout, schemaVersion);
      const values = items[2];
      if (values.type === "null") return { version, schemaVersion, row: null };
      if (values.type !== "array" || values.items.length < indexes.length) throw new StaleSchemaError("GET BLOCK row does not match schema", { phase: "protocol", command: "GET BLOCK" });
      const row = Object.fromEntries(indexes.map((index, i) => [layout.schema.columns[index].name, valueFromReply(layout.schema.columns[index], values.items[i])]));
      return { version, schemaVersion, row };
    });
  }

  private checkReadSchema(layout: TableLayout, version: bigint): void {
    if (version !== BigInt(layout.schema.version)) throw new StaleSchemaError("read metadata differs from cached schema", { phase: "protocol" });
  }

  private async setBlockOp(
    point: GridPoint,
    values: Readonly<Record<string, ChunkValue>>,
    options: ChunkWriteOptions,
  ): Promise<ChunkReply> {
    const table = this.tableOf(options);
    const at = pointClause(point);
    const condition = writeClause(options, "SET BLOCK");
    const names = Object.keys(values);
    if (names.length === 0) {
      throw requestError("setBlock needs at least one column", "SET BLOCK");
    }
    return await this.withLayout(table, true, async (layout) => {
      const indexes = columnIndexes(layout, names);
      const parameters = indexes.map((index, i) => encodeParameter(layout.schema.columns[index], values[names[i]]));
      const assignments = names.map((name, i) => `${name} = $${i + 1}`).join(", ");
      return await this.run(`SET BLOCK ${at} IN ${table} ${assignments}${condition}`, parameters, "SET BLOCK");
    });
  }

  private async deleteBlockOp(point: GridPoint, options: ChunkWriteOptions): Promise<ChunkReply> {
    const table = this.tableOf(options);
    const statement =
      `DELETE BLOCK ${pointClause(point)} FROM ${table}` + writeClause(options, "DELETE BLOCK");
    return await this.run(statement, [], "DELETE BLOCK");
  }

  private async getChunkOp(point: GridPoint, options: ChunkReadOptions): Promise<ChunkState | null> {
    const table = this.tableOf(options);
    const at = pointClause(point);
    return await this.withLayout(table, false, async (layout) => {
      const indexes = columnIndexes(layout, options.columns);
      const names = indexes.map((index) => layout.schema.columns[index].name);
      const reply = await this.run(`GET CHUNK ${at} FROM ${table}${columnsClause(names)}`, [], "GET CHUNK");
      return reply.type === "null" ? null : point.length === 3 ? decodeSectionedChunk(layout, bulkOf(reply, "GET CHUNK"), indexes) : decodeChunkForm(layout, bulkOf(reply, "GET CHUNK"), indexes);
    });
  }

  private async getChunkRawOp(point: GridPoint, options: ChunkReadOptions): Promise<Buffer | null> {
    const table = this.tableOf(options);
    const names = (options.columns ?? []).map((name) => checkName(name, "a column name"));
    const statement = `GET CHUNK ${pointClause(point)} FROM ${table}${columnsClause(names)}`;
    const reply = await this.run(statement, [], "GET CHUNK");
    return reply.type === "null" ? null : bulkOf(reply, "GET CHUNK");
  }

  private async setChunkOp(point: GridPoint, state: ChunkStateInput, options: ChunkWriteOptions): Promise<ChunkReply> {
    const table = this.tableOf(options);
    const statement =
      `SET CHUNK ${pointClause(point)} IN ${table} $1` + writeClause(options, "SET CHUNK", true);
    return await this.withLayout(table, true, async (layout) => {
      const writeLayout = { ...layout, schema: { ...layout.schema, options: { ...layout.schema.options, varMaxChunkBytes: 64 * 1024 * 1024 } } };
      const form = point.length === 3 ? encodeSectionedChunk(writeLayout, state) : encodeChunkForm(writeLayout, state);
      return await this.run(statement, [form], "SET CHUNK");
    }, true);
  }

  private async setChunkRawOp(point: GridPoint, form: Uint8Array, options: ChunkWriteOptions): Promise<ChunkReply> {
    const table = this.tableOf(options);
    const statement =
      `SET CHUNK ${pointClause(point)} IN ${table} $1` + writeClause(options, "SET CHUNK", true);
    if (!(form instanceof Uint8Array)) {
      throw requestError("setChunkRaw takes the chunk form as a Uint8Array", "SET CHUNK");
    }
    // A longer frame than the table takes closes the connection.
    return await this.withLayout(table, true, async (layout) => {
      const limit = point.length === 3 ? sectionedChunkFormLimit(layout) : chunkFormLimit(layout);
      if (form.length > limit) {
        throw new StaleSchemaError(`a chunk form of ${table} takes at most ${limit} bytes, got ${form.length}`, {
          phase: "request",
          command: "SET CHUNK",
        });
      }
      if (point.length === 3) parseSectionedForm(form, limit, true);
      return await this.run(statement, [form], "SET CHUNK");
    });
  }

  private async setChunkColumnsOp(point: GridPoint, columns: readonly string[], state: ChunkStateInput, options: ChunkWriteOptions): Promise<ChunkReply> {
    const table = this.tableOf(options), at = pointClause(point), condition = writeClause(options, "SET CHUNK", true);
    if (columns.length === 0) throw requestError("a block-column mutation needs columns", "SET CHUNK");
    return this.withLayout(table, true, async (layout) => {
      const indexes = columnIndexes(layout, columns);
      const names = indexes.map((index) => layout.schema.columns[index].name);
      const writeLayout = { ...layout, schema: { ...layout.schema, options: { ...layout.schema.options, varMaxChunkBytes: 64 * 1024 * 1024 } } };
      const form = encodeSectionedChunk(writeLayout, state, indexes, {}, "preserve");
      return this.run(`SET CHUNK ${at} IN ${table}${columnsClause(names)} $1${condition}`, [form], "SET CHUNK");
    }, true);
  }

  private async setChunkMetadataOp(point: GridPoint, values: Readonly<ChunkRow>, options: ChunkWriteOptions): Promise<ChunkReply> {
    const table = this.tableOf(options), at = pointClause(point), condition = writeClause(options, "SET CHUNK", true);
    const names = Object.keys(values);
    if (names.length === 0) throw requestError("META needs at least one chunk column", "SET CHUNK");
    names.forEach((name) => checkName(name, "a chunk column name"));
    return this.withLayout(table, true, async (layout) => {
      const parameters = names.map((name) => {
        const column = layout.schema.chunkColumns?.find((column) => column.name === name);
        if (column === undefined) throw new StaleSchemaError(`table ${table} has no chunk column ${name}`, { phase: "request", command: "SET CHUNK" });
        return encodeParameter(column, values[name]);
      });
      const assignments = names.map((name, i) => `${name} = $${i + 1}`).join(", ");
      return this.run(`SET CHUNK ${at} IN ${table} META ${assignments}${condition}`, parameters, "SET CHUNK");
    }, true);
  }

  private getArea3DOp(area: ChunkArea3D, options: ChunkReadOptions, raw: false, withSchema: false): Promise<{ entries: ChunkAreaEntry3D[] }>;
  private getArea3DOp(area: ChunkArea3D, options: ChunkReadOptions, raw: true, withSchema: false): Promise<{ entries: ChunkAreaRawEntry3D[] }>;
  private getArea3DOp(area: ChunkArea3D, options: ChunkReadOptions, raw: false, withSchema: true): Promise<ChunkAreaMetadata<ChunkAreaEntry3D>>;
  private getArea3DOp(area: ChunkArea3D, options: ChunkReadOptions, raw: true, withSchema: true): Promise<ChunkAreaMetadata<ChunkAreaRawEntry3D>>;
  private async getArea3DOp(area: ChunkArea3D, options: ChunkReadOptions, raw: boolean, withSchema: boolean): Promise<{ entries: Array<ChunkAreaEntry3D | ChunkAreaRawEntry3D>; schemaVersion?: bigint }> {
    const table = this.tableOf(options), clause = areaClause3D(area);
    return this.withLayout(table, false, async (layout) => {
      if (layout.schema.dims !== 3) throw requestError(`table ${table} is not three-dimensional`, "GET AREA");
      const indexes = columnIndexes(layout, options.columns), names = indexes.map((index) => layout.schema.columns[index].name);
      let reply = await this.run(`GET AREA ${clause} FROM ${table}${columnsClause(names)}${withSchema ? " WITH SCHEMA" : ""}`, [], "GET AREA");
      let schemaVersion: bigint | undefined;
      if (withSchema) {
        const fields = itemsOf(reply, "GET AREA");
        if (fields.length < 2) throw new ChunkProtocolError("GET AREA metadata is missing fields", { phase: "protocol", command: "GET AREA" });
        schemaVersion = uint64Of(fields[0], "schema version", "GET AREA");
        this.checkReadSchema(layout, schemaVersion);
        reply = fields[1];
      }
      const entries = itemsOf(reply, "GET AREA").map((item) => {
        const fields = itemsOf(item, "GET AREA");
        if (fields.length < 4) throw new ChunkProtocolError("GET AREA entry needs three coordinates and a form", { phase: "protocol", command: "GET AREA" });
        const point = { cx: axisReply(fields[0], "cx", "GET AREA"), cy: axisReply(fields[1], "cy", "GET AREA"), cz: axisReply(fields[2], "cz", "GET AREA") };
        const form = bulkOf(fields[3], "GET AREA");
        return raw ? { ...point, chunk: form } : { ...point, chunk: decodeSectionedChunk(layout, form, indexes) };
      });
      return { entries, ...(schemaVersion === undefined ? {} : { schemaVersion }) };
    });
  }

  private async getAreaOp(area: ChunkArea, options: ChunkReadOptions): Promise<ChunkAreaEntry[]> {
    const table = this.tableOf(options);
    const clause = areaClause(area);
    return await this.withLayout(table, false, async (layout) => {
      const indexes = columnIndexes(layout, options.columns);
      const names = indexes.map((index) => layout.schema.columns[index].name);
      const reply = await this.run(`GET AREA ${clause} FROM ${table}${columnsClause(names)}`, [], "GET AREA");
      return this.areaEntries(reply, layout.schema.dims).map(({ cx, cy, cz, chunk }) => ({
        cx,
        cy,
        ...(cz === undefined ? {} : { cz }),
        chunk: decodeChunkForm(layout, chunk, indexes),
      }));
    });
  }

  private getAreaWithSchemaOp(area: ChunkArea, options: ChunkReadOptions, raw: false): Promise<ChunkAreaMetadata<ChunkAreaEntry>>;
  private getAreaWithSchemaOp(area: ChunkArea, options: ChunkReadOptions, raw: true): Promise<ChunkAreaMetadata<ChunkAreaRawEntry>>;
  private async getAreaWithSchemaOp(area: ChunkArea, options: ChunkReadOptions, raw: boolean): Promise<ChunkAreaMetadata<ChunkAreaEntry | ChunkAreaRawEntry>> {
    const table = this.tableOf(options);
    return this.withLayout(table, false, async (layout) => {
      const indexes = columnIndexes(layout, options.columns);
      const names = indexes.map((index) => layout.schema.columns[index].name);
      const reply = await this.run(`GET AREA ${areaClause(area)} FROM ${table}${columnsClause(names)} WITH SCHEMA`, [], "GET AREA");
      const items = itemsOf(reply, "GET AREA");
      if (items.length < 2) throw new ChunkProtocolError("GET AREA metadata is missing fields", { phase: "protocol", command: "GET AREA" });
      const schemaVersion = uint64Of(items[0], "schema version", "GET AREA");
      this.checkReadSchema(layout, schemaVersion);
      const entries = this.areaEntries(items[1], layout.schema.dims);
      return { schemaVersion, entries: raw ? entries : entries.map(({ cx, cy, cz, chunk }) => ({ cx, cy, ...(cz === undefined ? {} : { cz }), chunk: decodeChunkForm(layout, chunk, indexes) })) };
    });
  }

  private async getAreaRawOp(area: ChunkArea, options: ChunkReadOptions): Promise<ChunkAreaRawEntry[]> {
    const table = this.tableOf(options);
    return this.withLayout(table, false, async (layout) => {
      const names = (options.columns ?? []).map((name) => checkName(name, "a column name"));
      const reply = await this.run(`GET AREA ${areaClause(area)} FROM ${table}${columnsClause(names)}`, [], "GET AREA");
      return this.areaEntries(reply, layout.schema.dims);
    });
  }

  // BEGIN, the callback of one attempt, then COMMIT; ROLLBACK when it
  // throws or a statement met CONFLICT.
  private async runAttempt(tx: TransactionAttempt, fn: (tx: ChunkTransaction) => unknown): Promise<bigint | null> {
    expectOk(await this.transactionStatement(tx, "BEGIN"), "BEGIN");
    tx.began = true;
    const handle = this.transactionHandle(tx);
    try {
      await this.callbackScope.run(tx, () => fn(handle));
    } catch (error) {
      await this.closeAttempt(tx);
      await this.rollback(tx);
      throw error;
    }
    await this.closeAttempt(tx);
    if (tx.failure !== null) {
      // The callback caught the failure; a transaction ended by CONFLICT
      // still answers it to every statement until ROLLBACK.
      await this.rollback(tx);
      throw tx.failure;
    }
    tx.began = false;
    let reply: ChunkReply;
    try {
      reply = await this.transactionStatement(tx, "COMMIT");
    } catch (error) {
      throw commitError(error);
    }
    return reply.type === "null" ? null : versionOf(reply, "COMMIT");
  }

  // Refuses further calls on the attempt's handle and waits for the
  // statements already called, which a statement left unawaited may still
  // be running.
  private async closeAttempt(tx: TransactionAttempt): Promise<void> {
    tx.open = false;
    await tx.chain;
  }

  private async rollback(tx: TransactionAttempt): Promise<void> {
    if (!tx.began) {
      return;
    }
    tx.began = false;
    try {
      expectOk(await this.transactionStatement(tx, "ROLLBACK"), "ROLLBACK");
    } catch (error) {
      // The server rolls back the transaction of a connection that closes:
      // closing it leaves no transaction open whatever ROLLBACK met, and the
      // next call or attempt reconnects. The caller gets the attempt's error.
      const socket = tx.socket;
      if (socket !== null && this.socket === socket) {
        this.clearConnectionState(
          new ChunkConnectionError("connection closed after a failed ROLLBACK", { phase: "response", command: "ROLLBACK", cause: error }),
        );
        socket.destroy();
      }
    }
  }

  // BEGIN, COMMIT or ROLLBACK, sent while none of the attempt's statements
  // is in flight.
  private transactionStatement(tx: TransactionAttempt, statement: string): Promise<ChunkReply> {
    const turn: SendTurn = { previous: Promise.resolve(), release: () => {}, tx };
    return this.sendTurns.run(turn, () => this.run(statement, [], statement));
  }

  private transactionHandle(tx: TransactionAttempt): ChunkTransaction {
    const call = <T>(operation: () => Promise<T>) => this.enqueueTransaction(tx, operation);
    const write = async (options: ChunkWriteOptions, command: string, operation: () => Promise<ChunkReply>): Promise<void> => {
      noIfVersion(options, command);
      const reply = await call(operation);
      if (reply.type !== "null") {
        throw new ChunkProtocolError(`expected _ from ${command} inside a transaction, got ${reply.type}`, {
          phase: "protocol",
          command,
        });
      }
    };
    return {
      getBlock: (x, y, options = {}) => call(() => this.getBlockOp([x, y], options)),
      getBlockWithMetadata: (x, y, options = {}) => call(() => this.getBlockWithMetadataOp([x, y], options)),
      setBlock: (x, y, values, options = {}) => write(options, "SET BLOCK", () => this.setBlockOp([x, y], values, options)),
      deleteBlock: (x, y, options = {}) => write(options, "DELETE BLOCK", () => this.deleteBlockOp([x, y], options)),
      getChunk: (cx, cy, options = {}) => call(() => this.getChunkOp([cx, cy], options)),
      getChunkRaw: (cx, cy, options = {}) => call(() => this.getChunkRawOp([cx, cy], options)),
      setChunk: (cx, cy, state, options = {}) => write(options, "SET CHUNK", () => this.setChunkOp([cx, cy], state, options)),
      setChunkRaw: (cx, cy, form, options = {}) => write(options, "SET CHUNK", () => this.setChunkRawOp([cx, cy], form, options)),
      getArea: (area, options = {}) => call(() => this.getAreaOp(area, options)),
      getAreaRaw: (area, options = {}) => call(() => this.getAreaRawOp(area, options)),
      getAreaWithSchema: (area, options = {}) => call(() => this.getAreaWithSchemaOp(area, options, false)),
      getAreaRawWithSchema: (area, options = {}) => call(() => this.getAreaWithSchemaOp(area, options, true)),
      getBlock3D: (x, y, z, options = {}) => call(() => this.getBlockOp([x, y, z], options)),
      getBlock3DWithMetadata: (x, y, z, options = {}) => call(() => this.getBlockWithMetadataOp([x, y, z], options)),
      setBlock3D: (x, y, z, values, options = {}) => write(options, "SET BLOCK", () => this.setBlockOp([x, y, z], values, options)),
      deleteBlock3D: (x, y, z, options = {}) => write(options, "DELETE BLOCK", () => this.deleteBlockOp([x, y, z], options)),
      getChunk3D: (x, y, z, options = {}) => call(() => this.getChunkOp([x, y, z], options)),
      getChunkRaw3D: (x, y, z, options = {}) => call(() => this.getChunkRawOp([x, y, z], options)),
      setChunk3D: (x, y, z, state, options = {}) => write(options, "SET CHUNK", () => this.setChunkOp([x, y, z], state, options)),
      setChunkRaw3D: (x, y, z, form, options = {}) => write(options, "SET CHUNK", () => this.setChunkRawOp([x, y, z], form, options)),
      getArea3D: (area, options = {}) => call(async () => (await this.getArea3DOp(area, options, false, false)).entries),
      getAreaRaw3D: (area, options = {}) => call(async () => (await this.getArea3DOp(area, options, true, false)).entries),
      getArea3DWithSchema: (area, options = {}) => call(() => this.getArea3DOp(area, options, false, true)),
      getAreaRaw3DWithSchema: (area, options = {}) => call(() => this.getArea3DOp(area, options, true, true)),
      setChunkColumns: (x, y, columns, state, options = {}) => write(options, "SET CHUNK", () => this.setChunkColumnsOp([x, y], columns, state, options)),
      setChunkColumns3D: (x, y, z, columns, state, options = {}) => write(options, "SET CHUNK", () => this.setChunkColumnsOp([x, y, z], columns, state, options)),
      setChunkMetadata: (x, y, values, options = {}) => write(options, "SET CHUNK", () => this.setChunkMetadataOp([x, y], values, options)),
      setChunkMetadata3D: (x, y, z, values, options = {}) => write(options, "SET CHUNK", () => this.setChunkMetadataOp([x, y, z], values, options)),
    };
  }

  // Runs one statement of a transaction after those called before it have
  // settled. The server keeps a transaction ended by CONFLICT on the
  // connection, answering CONFLICT to every statement until ROLLBACK, so a
  // statement sent behind the conflict would not run outside it either; one
  // at a time, the client knows of the conflict before the next statement
  // and does not send it.
  private enqueueTransaction<T>(tx: TransactionAttempt, operation: () => Promise<T>): Promise<T> {
    if (!tx.open) {
      return Promise.reject(requestError("the transaction has ended: its tx works only inside its callback"));
    }
    const result = tx.chain.then(() => {
      if (tx.failure !== null) {
        throw tx.failure;
      }
      const turn: SendTurn = { previous: Promise.resolve(), release: () => {}, tx };
      return this.sendTurns.run(turn, async () => {
        try {
          return await operation();
        } catch (error) {
          if (error instanceof ChunkConflictError) {
            // The server ended the transaction; ROLLBACK closes it.
            tx.failure ??= error;
          } else if (isTransportError(error)) {
            // The connection closed, which rolled the transaction back.
            tx.failure ??= error;
            tx.began = false;
          }
          throw error;
        }
      });
    });
    tx.chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  // Waits until no operation is in flight, then holds the connection for
  // the attempt (see TransactionAttempt).
  private hold(tx: TransactionAttempt): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const run = () => {
        this.holder = tx;
        resolve();
      };
      if (this.opWaiters.length === 0 && this.holder === null && this.activeOps === 0) {
        run();
      } else {
        this.opWaiters.push({ run, reject, exclusive: true });
      }
    });
  }

  private inCallback(): boolean {
    const scope = this.callbackScope.getStore();
    return scope !== undefined && scope.owner === this && scope.open;
  }

  private tableOf(options: ChunkTableOption | undefined): string {
    const table = options?.table ?? this.options.table;
    if (table === "") throw requestError("name a table through the URI path, table option or method");
    return checkName(table, "a table name");
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

  private areaEntries(reply: ChunkReply, dims = 2): ChunkAreaRawEntry[] {
    const command = "GET AREA";
    if (dims !== 2 && dims !== 3) throw new ChunkProtocolError("unsupported GET AREA dimensions", { phase: "protocol", command });
    return itemsOf(reply, command).map((item) => {
      if (item.type !== "array" || item.items.length < dims + 1) {
        throw new ChunkProtocolError("malformed GET AREA entry", { phase: "protocol", command });
      }
      const z = dims === 3 ? item.items[2] : undefined;
      if (z !== undefined && (z.type !== "integer" || z.value < -(1n << 63n) || z.value >= (1n << 63n))) throw new ChunkProtocolError("invalid GET AREA z coordinate", { phase: "protocol", command });
      return { ...coordOf(item, command), ...(z?.type === "integer" ? { cz: z.value } : {}), chunk: bulkOf(item.items[dims], command) };
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

  private isStaleSchema(error: unknown, _write: boolean): boolean {
    return error instanceof StaleSchemaError || error instanceof ChunkSchemaMismatchError;
  }

  private forgetAfter(table: string, error: unknown, write: boolean): void {
    if (
      error instanceof ChunkServerError &&
      error.serverCode === "NO_TABLE"
    ) {
      this.forget(table);
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.inCallback()) {
      return Promise.reject(
        requestError("this client is running a transaction: inside its callback use tx, or another client"),
      );
    }
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
      if (this.opWaiters.length === 0 && this.holder === null && this.activeOps < this.maxPipeline) {
        run();
      } else {
        this.opWaiters.push({ run, reject });
      }
    });
  }

  // Starts waiting operations in order while there is room: a transaction
  // once no operation is in flight, then nothing until it ends.
  private releaseEnqueueSlot(): void {
    while (this.opWaiters.length > 0 && this.holder === null) {
      if (this.activeOps >= (this.opWaiters[0].exclusive === true ? 1 : this.maxPipeline)) {
        return;
      }
      this.opWaiters.shift()!.run();
    }
  }

  private async connectInternal(): Promise<this> {
    // Calls queued behind the one that started this connect wait for it.
    this.clearConnectionState(undefined, true);
    this.info = null;
    const socket = await this.openSocket();
    if (this.disposed) {
      socket.destroy();
      throw new ChunkConnectionError("client is closed", { phase: "connect" });
    }
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
        this.clearConnectionState(new ChunkConnectionError(
          "connection closed; check the server log and that chunk:// uses plaintext and chunks:// uses TLS", { phase: "connect" }));
      }
    });

    // A failed handshake (failed login, older server) must not leave the
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

  // HELLO is the first statement on every connection; with a user it starts
  // the SCRAM-SHA-256 login, which AUTH finishes. Both are sent outside the
  // pipeline queue: operations waiting for the connection hold its slots.
  private async hello(): Promise<void> {
    const user = this.options.user;
    let login: ScramLogin | null = null;
    let reply: ChunkReply;
    const options = Object.entries(this.options.helloOptions ?? {});
    const withClause = options.length === 0 ? "" : " WITH " + options.map(([name, value]) => `${checkName(name.toLowerCase(), "a HELLO option")} = ${formatLiteral(value)}`).join(", ");
    if (user === "") {
      reply = await this.send(`HELLO ${PROTOCOL_VERSION}${withClause}`, [], "HELLO");
    } else {
      login = startScramLogin(user);
      reply = await this.send(`HELLO ${PROTOCOL_VERSION} USER ${user} $1${withClause}`, [Buffer.from(login.first, "utf8")], "HELLO");
    }
    if (reply.type === "error") {
      // An older chunkdb answers `-ERR PROTOCOL expected HELLO 2`; a 1.x
      // server does not know HELLO.
      const older = /^expected HELLO ([0-9]+)/.exec(reply.message);
      if (
        (reply.code === "PROTOCOL" && older !== null && older[1] !== String(PROTOCOL_VERSION)) ||
        reply.code === "UNKNOWN_COMMAND"
      ) {
        const speaks = older === null ? "an older protocol (chunkdb 1.x)" : `the older protocol ${older[1]}`;
        throw new ChunkProtocolError(
          `the server speaks ${speaks}; this client needs a chunkdb server of protocol ${PROTOCOL_VERSION}`,
          { phase: "protocol", command: "HELLO", cause: this.serverError(reply, "HELLO") },
        );
      }
      throw this.serverError(reply, "HELLO");
    }
    let expected: ScramFinal | null = null;
    if (login !== null) {
      if (reply.type !== "simple" || !reply.value.startsWith("SCRAM ")) {
        throw new ChunkProtocolError(`expected +SCRAM from HELLO, got ${reply.type}`, { phase: "protocol", command: "HELLO" });
      }
      try {
        expected = await finishScramLogin(login, this.options.password, reply.value.slice("SCRAM ".length));
      } catch (error) {
        throw new ChunkProtocolError(error instanceof Error ? error.message : String(error), {
          phase: "protocol",
          command: "HELLO",
          cause: error,
        });
      }
      reply = await this.send("AUTH $1", [Buffer.from(expected.message, "utf8")], "AUTH");
      if (reply.type === "error") {
        throw this.serverError(reply, "AUTH");
      }
    }
    const info = parseServerInfo(reply);
    if (info.protocol !== PROTOCOL_VERSION) {
      throw new ChunkProtocolError(`the server answered protocol ${info.protocol}, expected ${PROTOCOL_VERSION}`, {
        phase: "protocol",
        command: "HELLO",
      });
    }
    // The signature proves the server holds the user's verifier: a server
    // that does not could otherwise pose as the real one.
    if (expected !== null && (info.serverSignature === null || !scramSignatureMatches(expected.serverSignature, info.serverSignature))) {
      throw new ChunkConnectionError(
        "the server could not prove it knows the password (SCRAM server signature mismatch)",
        { phase: "auth", command: "AUTH" },
      );
    }
    this.info = info;
  }

  private serverError(reply: ErrorReply, command: string): ChunkError {
    if (reply.code === "AUTH_FAILED" || reply.code === "AUTH_REQUIRED") {
      return new ChunkAuthError(reply.code, reply.message, {
        phase: HANDSHAKE.has(command) ? "auth" : "response",
        command,
      });
    }
    if (reply.code === "PERMISSION_DENIED") {
      return new ChunkPermissionError(reply.code, reply.message, { phase: "response", command });
    }
    const fields = parseErrorFields(reply.message).keys;
    const current = fields.current;
    if (reply.code === "VERSION_MISMATCH" || reply.code === "SCHEMA_MISMATCH") {
      if (!/^[0-9]+$/.test(current ?? "") || BigInt(current) > (1n << 64n) - 1n) {
        return new ChunkProtocolError(`unexpected ${reply.code} metadata: ${reply.message}`, { phase: "protocol", command });
      }
      return reply.code === "VERSION_MISMATCH"
        ? new ChunkVersionMismatchError(reply.message, BigInt(current), { phase: "response", command })
        : new ChunkSchemaMismatchError(reply.message, BigInt(current), { phase: "response", command });
    }
    if (reply.code === "CONFLICT") {
      return new ChunkConflictError(reply.message, fields.reason ?? reply.message.split(" ", 1)[0], { phase: "response", command });
    }
    const classes: Record<string, typeof ChunkServerError> = {
      CONDITION_FAILED: ChunkConditionFailedError, BUSY: ChunkBusyError, DISK_FULL: ChunkDiskFullError,
      RATE_LIMITED: ChunkRateLimitedError, OUTCOME_UNKNOWN: ChunkOutcomeUnknownError,
      MIGRATION_MISMATCH: ChunkMigrationMismatchError, SLOT_BUSY: ChunkSlotBusyError,
      CHECK_FAILED: ChunkCheckFailedError, CANCELLED: ChunkCancelledError,
      TIMEOUT: ChunkStatementTimeoutError, KILLED: ChunkKilledError, UNKNOWN_COMMAND: ChunkUnknownCommandError,
    };
    const ErrorClass = Object.hasOwn(classes, reply.code) ? classes[reply.code] : undefined;
    if (ErrorClass !== undefined) return new ErrorClass(reply.code, reply.message, { phase: "response", command });
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
    // HELLO and AUTH are sent while connecting, outside the operations' order.
    const turn = HANDSHAKE.has(command) ? undefined : this.sendTurns.getStore();
    if (turn !== undefined) {
      await turn.previous;
    }
    // After BEGIN a transaction's statements go to its connection only: on
    // a new one they would run outside the transaction.
    const tx = turn?.tx;
    if (tx?.socket != null) {
      if (this.socket !== tx.socket) {
        throw transactionLost(command);
      }
    } else {
      await this.ensureConnected();
    }
    const socket = this.socket;
    if (socket === null) {
      throw new ChunkConnectionError("connection is not available", { phase: "connect", command });
    }
    if (tx !== undefined && command === "BEGIN") {
      tx.socket = socket;
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
          new ChunkTimeoutError(`${command} command timeout after ${this.options.commandTimeoutMs}ms; check the server and network, then adjust commandTimeoutMs if needed`, {
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
    while (this.pendingQueue.length > 0 || !this.watchPaused) {
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
      if (reply.type === "push") {
        const head = reply.items[0];
        const kind = head?.type === "bulk" ? head.value.toString("utf8") : head?.type === "simple" ? head.value : null;
        if (kind !== null && !PUSH_KINDS.has(kind)) continue;
        if (this.watchReceiver === null) continue;
        if (!this.watchStarted) {
          const socket = this.socket;
          this.clearConnectionState(new ChunkProtocolError("WATCH push preceded its start reply", { phase: "protocol", command: "WATCH" }));
          socket?.destroy();
          return;
        }
        this.watchReceiver(reply);
        continue;
      }
      if (reply.type === "error" && reply.code === "INVALID_ARGUMENT" && this.watchStarted && this.watchAckError !== null) {
        this.watchAckError(this.serverError(reply, "ACK"));
        continue;
      }
      if (this.pendingQueue.length === 0) {
        const error = reply.type === "error" ? this.serverError(reply, "WATCH") :
          new ChunkProtocolError("unexpected non-push WATCH reply", { phase: "protocol", command: "WATCH" });
        const socket = this.socket;
        this.clearConnectionState(error);
        socket?.destroy();
        return;
      }
      const pending = this.pendingQueue.shift()!;
      if (this.watchReceiver !== null) this.watchStarted = true;
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
        reject(new ChunkTimeoutError(`connection timeout after ${timeoutMs}ms to ${this.options.host}:${this.options.port}; check the address, firewall and chunk:// versus chunks://, then adjust connectTimeoutMs if needed`, { phase: "timeout", command: "CONNECT" }));
      }, timeoutMs);

      const cleanup = () => {
        clearTimeout(timer);
        socket?.off("error", onError);
        if (this.connectAbort === abort) this.connectAbort = null;
      };

      const abort = () => {
        cleanup();
        socket?.destroy();
        reject(new ChunkConnectionError("connection closed while connecting", { phase: "connect" }));
      };
      this.connectAbort = abort;

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

  // Resets the connection. Operations still waiting to start are rejected
  // unless `keepWaiters` is set: a new connection is about to serve them.
  private clearConnectionState(error?: Error, keepWaiters = false): void {
    const failed = this.watchFailure;
    this.watchReceiver = null;
    this.watchFailure = null;
    this.watchAckError = null;
    this.watchPaused = false;
    this.watchStarted = false;
    if (failed !== null && error !== undefined) this.disposed = true;
    this.reader.clear();
    this.connected = false;
    this.socket = null;
    const connErr = error ?? new ChunkConnectionError("connection closed", { phase: "connect" });
    // Reject enqueue waiters that haven't started yet
    if (!keepWaiters) {
      const waiters = this.opWaiters.splice(0);
      for (const w of waiters) w.reject(connErr);
    }
    if (error !== undefined) {
      this.failAllPending(error);
      failed?.(error);
    }
  }

  private wrapTransportError(error: unknown, phase: "connect" | "request" | "tls", command?: string): ChunkError {
    const original = error instanceof Error ? error.message : String(error);
    const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined;
    const message = code === "ECONNREFUSED"
      ? `connection refused at ${this.options.host}:${this.options.port}; start the server and check its listen address and port (${original})`
      : phase === "tls"
        ? `TLS connection failed; use chunks:// with a TLS-enabled server and check the CA certificate and server name (${original})`
        : `${original}; check the server address, network and server log`;
    if (phase === "tls") {
      return new ChunkTlsError(message, { phase, command, code, cause: error });
    }
    return new ChunkConnectionError(message, { phase, command, code, cause: error });
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
