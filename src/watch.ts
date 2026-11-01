import type { ChunkClient } from "./client";
import { ChunkConnectionError, ChunkProtocolError } from "./errors";
import type { ChunkReply, PushReply } from "./protocol";
import { integerOf, mapOf, parseColumns, schemaVersionOf, textOf } from "./schema";
import { slotName } from "./slots";
import type {
  ChunkColumn,
  ChunkPosition,
  ChunkRow,
  ChunkWatchCoordinate,
  ChunkWatchEvent,
  ChunkWatchOptions,
  ChunkTableSchema,
  ChunkSchemaVersion,
} from "./types";
import { ChunkBits, checkCoordinate, checkInt64Coordinate, checkName, requestError, valueFromReply } from "./values";

// Internal stream access; ordinary operations never switch their connection to WATCH.
export const kWatchStream = Symbol("watchStream");
export const kWatchPause = Symbol("watchPause");
export const kWatchAck = Symbol("watchAck");

const MAX_UINT64 = (1n << 64n) - 1n;
const MIN_INT64 = -(1n << 63n);
const MAX_INT64 = (1n << 63n) - 1n;

function malformed(message: string): ChunkProtocolError {
  return new ChunkProtocolError(`malformed WATCH event: ${message}`, { phase: "protocol", command: "WATCH" });
}

function unsigned(reply: ChunkReply, what: string): bigint {
  if (reply.type !== "integer" || reply.value < 0n || reply.value > MAX_UINT64) {
    throw malformed(`${what} is not uint64`);
  }
  return reply.value;
}

function epochOf(reply: ChunkReply): string {
  const epoch = textOf(reply, "epoch", "WATCH");
  if (!/^[0-9a-f]{32}$/i.test(epoch)) {
    throw malformed("epoch is not 32 hex digits");
  }
  return epoch.toLowerCase();
}

function copyColumns(columns: readonly ChunkColumn[]): ChunkColumn[] {
  return columns.map((column) => ({
    ...column,
    type: { ...column.type },
    default: column.default instanceof ChunkBits ? new ChunkBits(column.default.length, column.default.toBytes()) :
      column.default instanceof Uint8Array ? Buffer.from(column.default) : column.default,
  }));
}

function coordinate(reply: ChunkReply): ChunkWatchCoordinate {
  if (reply.type === "integer" && reply.value >= MIN_INT64 && reply.value <= MAX_INT64) {
    return reply.value;
  }
  if (reply.type === "array" && reply.items.length >= 2) {
    const [chunk, local] = reply.items;
    if (chunk.type === "integer" && chunk.value >= MIN_INT64 && chunk.value <= MAX_INT64) {
      const offset = unsigned(local, "coordinate offset");
      if (offset <= 0xffff_ffffn) {
        return { chunk: chunk.value, offset: Number(offset) };
      }
    }
  }
  throw malformed("coordinate is not int64 or [chunk, offset]");
}

function statementOf(table: string, options: ChunkWatchOptions): string {
  let statement = `WATCH ${checkName(table, "a table name")}`;
  if (options.slot !== undefined) statement += ` SLOT ${slotName(options.slot)}`;
  if (options.takeover) {
    if (options.slot === undefined) throw requestError("TAKEOVER requires a slot", "WATCH");
    statement += " TAKEOVER";
  }
  statement += filterClause(options);
  if (options.ackTimeoutMs !== undefined) {
    if (options.slot === undefined || !Number.isSafeInteger(options.ackTimeoutMs) || options.ackTimeoutMs <= 0) {
      throw requestError("ACK TIMEOUT requires a slot and positive milliseconds", "WATCH");
    }
    statement += ` ACK TIMEOUT ${options.ackTimeoutMs}`;
  }
  if (options.after !== undefined) {
    const { epoch, revision } = options.after;
    if (!/^[0-9a-f]{32}$/i.test(epoch) || typeof revision !== "bigint" || revision < 0n || revision > MAX_UINT64) {
      throw requestError("WATCH after needs a 32-digit hex epoch and uint64 revision", "WATCH");
    }
    statement += ` AFTER ${epoch} ${revision}`;
  }
  return statement;
}

export function filterClause(options: Pick<ChunkWatchOptions, "area" | "area3D" | "columns" | "noBefore" | "chunks">): string {
  let statement = "";
  if (options.area !== undefined && options.area3D !== undefined) throw requestError("AREA needs either two or three dimensions", "WATCH");
  if (options.area3D !== undefined) {
    const area = options.area3D;
    const values = [area.cx0, area.cy0, area.cz0, area.cx1, area.cy1, area.cz1].map((value) => checkInt64Coordinate(value, "area coordinate"));
    if (values[0] > values[3] || values[1] > values[4] || values[2] > values[5]) throw requestError("WATCH area bounds are reversed", "WATCH");
    statement += ` AREA ${values.slice(0, 3).join(" ")} TO ${values.slice(3).join(" ")}`;
  }
  if (options.area !== undefined) {
    const area = options.area;
    const values = [area.cx0, area.cy0, area.cx1, area.cy1].map((value) => checkCoordinate(value, "area coordinate"));
    if (area.cx0 > area.cx1 || area.cy0 > area.cy1) {
      throw requestError("WATCH area bounds are reversed", "WATCH");
    }
    statement += ` AREA ${values[0]} ${values[1]} TO ${values[2]} ${values[3]}`;
  }
  if (options.columns !== undefined) {
    if (options.columns.length === 0) throw requestError("COLUMNS requires at least one column", "WATCH");
    statement += " COLUMNS " + options.columns.map((name) => checkName(name, "a column name")).join(", ");
  }
  if (options.noBefore) statement += " NO BEFORE";
  if (options.chunks) statement += " CHUNKS";
  return statement;
}

/** A dedicated change stream. Close it explicitly, or break out of for-await. */
export class ChunkWatch implements AsyncIterableIterator<ChunkWatchEvent> {
  readonly start: ChunkPosition;
  private readonly schemas = new Map<string, { columns: ChunkColumn[]; chunkColumns: ChunkColumn[]; dims: number }>();
  private readonly queued: Array<PushReply | Error> = [];
  private wake: (() => void) | null = null;
  private failure: Error | null = null;
  private closing = false;
  private ended = false;
  private closePromise: Promise<void> | null = null;
  private nextTurn: Promise<void> = Promise.resolve();
  private description: ChunkClient | null = null;
  private available: bigint | null;
  private currentEpoch: string;

  private constructor(
    private readonly stream: ChunkClient,
    private readonly createClient: () => ChunkClient,
    private readonly table: string,
    start: ChunkPosition,
    version: ChunkSchemaVersion,
    columns: ChunkColumn[],
    private readonly slot: boolean,
    private readonly foundation: boolean,
    dims = 2,
    chunkColumns: ChunkColumn[] = [],
    schemaEpoch = start.epoch,
  ) {
    this.start = start;
    this.available = start.revision;
    this.currentEpoch = start.epoch;
    this.schemas.set(this.schemaKey(schemaEpoch, version), { columns, chunkColumns, dims });
  }

  static async open(createClient: () => ChunkClient, table: string, options: ChunkWatchOptions): Promise<ChunkWatch> {
    const statement = statementOf(table, options);
    const stream = createClient();
    const descriptions = createClient();
    let watch: ChunkWatch | null = null;
    const early: Array<PushReply | Error> = [];
    let earlyFailure: Error | null = null;
    try {
      const schema = await descriptions.describe(table);
      // Ordinary connections occupy statement workers; release this one before WATCH.
      await descriptions.close();
      const reply = await stream[kWatchStream](statement, (push) => {
        if (watch === null) {
          early.push(push);
          if (early.length >= 64) stream[kWatchPause](true);
        } else {
          watch.receive(push);
        }
      }, (error) => {
        if (watch === null) earlyFailure = error;
        else watch.fail(error);
      }, options.slot === undefined ? undefined : (error) => {
        if (watch === null) early.push(error);
        else watch.receive(error);
      });
      let start: ChunkPosition;
      if (reply.type === "map") {
        const fields = mapOf(reply, "WATCH");
        const epoch = fields.get("epoch"), revision = fields.get("revision");
        if (epoch === undefined || revision === undefined) throw malformed("missing WATCH start position");
        start = { epoch: epochOf(epoch), revision: unsigned(revision, "revision") };
      } else {
        if (reply.type !== "simple") throw malformed("WATCH did not answer a position map");
        const match = /^OK ([0-9a-f]{32}) (0|[1-9][0-9]*)$/i.exec(reply.value);
        if (match === null || BigInt(match[2]) > MAX_UINT64) throw malformed("invalid WATCH start position");
        start = { epoch: match[1].toLowerCase(), revision: BigInt(match[2]) };
      }
      watch = new ChunkWatch(stream, createClient, table, start, schema.version, schema.columns,
        options.slot !== undefined, reply.type === "map", schema.dims ?? 2, schema.chunkColumns ?? [], schema.epoch ?? start.epoch);
      for (const push of early) watch.receive(push);
      if (earlyFailure !== null) watch.fail(earlyFailure);
      return watch;
    } catch (error) {
      await Promise.all([stream.close(), descriptions.close()]);
      throw error;
    }
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<ChunkWatchEvent> {
    return this;
  }

  next(): Promise<IteratorResult<ChunkWatchEvent>> {
    const next = this.nextTurn.then(() => this.readNext());
    this.nextTurn = next.then(() => {}, () => {});
    return next;
  }

  async return(): Promise<IteratorResult<ChunkWatchEvent>> {
    await this.close();
    return { done: true, value: undefined };
  }

  /**
   * Sends a slot ACK through the last returned change, chunks, progress or starting position.
   * Completion means written to the socket, not accepted or persisted.
   * The server validates ACK order; rejections are reported by next().
   */
  ack(revision: bigint): Promise<void> {
    if (this.failure !== null) return Promise.reject(this.failure);
    if (this.closing || this.ended) return Promise.reject(new ChunkConnectionError("watch is closed", { phase: "request", command: "ACK" }));
    if (!this.slot) return Promise.reject(requestError("ACK requires a slot watch", "ACK"));
    if (typeof revision !== "bigint" || revision < 0n || revision > MAX_UINT64) {
      return Promise.reject(requestError("ACK needs a uint64 bigint revision", "ACK"));
    }
    if (this.available === null || revision > this.available) {
      return Promise.reject(requestError("ACK exceeds the last returned change, chunks, progress or starting position", "ACK"));
    }
    return this.stream[kWatchAck](revision).catch((error: Error) => {
      this.fail(error);
      throw error;
    });
  }

  /**
   * Drains earlier pushes; for slots, UNWATCH persists accepted ACKs before OK.
   * Discards queued ACK rejections and those received while closing.
   */
  close(): Promise<void> {
    if (this.closePromise !== null) return this.closePromise;
    this.closing = true;
    this.queued.length = 0;
    this.wake?.();
    this.stream[kWatchPause](false);
    this.closePromise = (async () => {
      try {
        if (this.failure === null && !this.ended) {
          const reply = await this.stream.execute("UNWATCH");
          if (reply.type !== "simple" || reply.value !== "OK") throw malformed("UNWATCH did not answer +OK");
        }
      } finally {
        this.ended = true;
        this.wake?.();
        await Promise.all([this.stream.close(), this.description?.close()]);
      }
    })();
    return this.closePromise;
  }

  private receive(push: PushReply | Error): void {
    if (this.closing || this.ended) return;
    this.queued.push(push);
    // Leave subsequent frames in the reader/socket when the consumer is slow.
    if (this.queued.length >= 64) this.stream[kWatchPause](true);
    this.wake?.();
  }

  private fail(error: Error): void {
    if (this.ended || this.closing) return;
    this.failure ??= error;
    this.wake?.();
    // No automatic reconnect: the caller decides which position to resume after.
    void Promise.all([this.stream.close(), this.description?.close()]);
  }

  private async readNext(): Promise<IteratorResult<ChunkWatchEvent>> {
    while (true) {
      if (this.failure !== null) throw this.failure;
      if (this.closing || this.ended) return { done: true, value: undefined };
      const push = this.queued.shift();
      if (push !== undefined) {
        this.stream[kWatchPause](false);
        // A server-rejected ACK does not end a slot stream. It has no success
        // reply, so rejection is reported by next(), which may be called again.
        if (push instanceof Error) throw push;
        try {
          const value = await this.decode(push);
          if (this.closing || this.ended) return { done: true, value: undefined };
          if (value === null) continue;
          if (value.kind === "resync" && value.position.epoch !== this.currentEpoch) {
            if (this.slot) throw malformed("slot resync changed its epoch");
            this.currentEpoch = value.position.epoch;
            this.available = null;
          }
          if (value.kind === "change" || value.kind === "chunks" || value.kind === "progress") {
            if (value.position.epoch !== this.currentEpoch) throw malformed("eligible event changed its epoch");
            if (this.available === null || value.position.revision > this.available) this.available = value.position.revision;
          }
          return { done: false, value };
        } catch (error) {
          if (this.closing) return { done: true, value: undefined };
          const failure = error instanceof Error ? error : new ChunkConnectionError(String(error), { phase: "protocol", command: "WATCH" });
          this.fail(failure);
          throw failure;
        }
      }
      await new Promise<void>((resolve) => { this.wake = resolve; });
      this.wake = null;
    }
  }

  private async decode(push: PushReply): Promise<ChunkWatchEvent | null> {
    const items = push.items;
    if (items.length === 0) throw malformed("missing kind");
    const kind = textOf(items[0], "kind", "WATCH");
    if (!["schema", "change", "progress", "resync", "chunks", "catalog"].includes(kind)) return null;
    if (kind === "schema" && items[1]?.type === "map") {
      const fields = mapOf(items[1], "WATCH");
      const field = (name: string): ChunkReply => fields.get(name) ?? (() => { throw malformed(`schema missing ${name}`); })();
      const position = { epoch: epochOf(field("epoch")), revision: unsigned(field("revision"), "revision") };
      if (position.epoch !== this.currentEpoch) throw malformed("schema event changed its epoch");
      const version = schemaVersionOf(field("schema_version"), "WATCH");
      const dims = integerOf(field("dims"), "dims", "WATCH");
      if (version < 0 || (dims !== 2 && dims !== 3)) throw malformed("invalid schema version or dimensions");
      const columns = parseColumns(field("columns"), "WATCH");
      const chunkColumns = parseColumns(field("chunk_columns"), "WATCH", true);
      this.schemas.set(this.schemaKey(position.epoch, version), { columns: copyColumns(columns), chunkColumns: copyColumns(chunkColumns), dims });
      return { kind, position, version, dims, columns, chunkColumns };
    }
    if (items.length < 3) throw malformed("missing position");
    const position = { epoch: epochOf(items[1]), revision: unsigned(items[2], "revision") };
    if ((kind === "change" || kind === "chunks" || kind === "progress") && position.epoch !== this.currentEpoch) {
      throw malformed("eligible event changed its epoch");
    }
    if (kind === "progress") return { kind, position };
    if (kind === "resync") {
      if (!this.foundation && items.length < 5) return { kind, position };
      if (items.length < 5) throw malformed("missing lineage");
      const parentEpoch = items[3].type === "null" ? null : epochOf(items[3]);
      const forkRevision = items[4].type === "null" ? null : unsigned(items[4], "fork revision");
      if ((parentEpoch === null) !== (forkRevision === null)) throw malformed("partial lineage");
      return { kind, position, parentEpoch, forkRevision };
    }
    if (kind === "schema") {
      if (position.epoch !== this.currentEpoch) throw malformed("schema event changed its epoch");
      if (items.length < 5) throw malformed("missing schema fields");
      const version = schemaVersionOf(items[3], "WATCH");
      if (version < 0) throw malformed("negative schema version");
      const columns = parseColumns(items[4], "WATCH");
      this.schemas.set(this.schemaKey(position.epoch, version), { columns: copyColumns(columns), chunkColumns: [], dims: 2 });
      return { kind, position, version, columns };
    }
    const nullableText = (reply: ChunkReply, name: string) => reply.type === "null" ? null : textOf(reply, name, "WATCH");
    const bytes = (reply: ChunkReply): Buffer | null => {
      if (reply.type === "null") return null;
      if (reply.type !== "bulk") throw malformed("tag/form is not bytes");
      return Buffer.from(reply.value);
    };
    const txn = (reply: ChunkReply) => reply.type === "null" ? null : unsigned(reply, "transaction id");
    if (kind === "catalog") {
      if (items.length < 7 || items[5].type !== "array") throw malformed("missing catalog fields");
      const events = items[5].items.map((item) => {
        const fields = mapOf(item, "WATCH");
        const required = (name: string) => fields.get(name) ?? (() => { throw malformed(`catalog missing ${name}`); })();
        const data = required("data");
        return { kind: textOf(required("kind"), "catalog kind", "WATCH"),
          action: nullableText(required("action"), "action"), name: nullableText(required("name"), "name"),
          table: nullableText(required("table"), "table"), data: data.type === "null" ? null : data };
      });
      return { kind, position, commitTimeMs: unsigned(items[3], "commit time"), user: nullableText(items[4], "user"), events, txn: txn(items[6]) };
    }
    if (items.length < (kind === "chunks" ? 9 : this.foundation ? 10 : 7) || items[6].type !== "array") throw malformed("incorrect event length");
    const commitTimeMs = unsigned(items[3], "commit time");
    const user = nullableText(items[4], "user");
    const schemaVersion = schemaVersionOf(items[5], "WATCH");
    if (schemaVersion < 0) throw malformed("negative schema version");
    let schema = this.schemas.get(this.schemaKey(position.epoch, schemaVersion));
    if (schema === undefined) {
      const described = await this.describe();
      if (described.epoch !== undefined && described.epoch !== position.epoch) throw malformed("described schema changed its epoch");
      if (described.version !== schemaVersion) throw malformed(`schema version ${schemaVersion} is unavailable; re-read state before resuming`);
      schema = { columns: described.columns, chunkColumns: described.chunkColumns ?? [], dims: described.dims ?? 2 };
      this.schemas.set(this.schemaKey(position.epoch, schemaVersion), schema);
    }
    if (schema.dims !== 2 && schema.dims !== 3) throw malformed("unsupported dimensions");
    const dims = schema.dims;
    const row = (reply: ChunkReply, columns: ChunkColumn[]): ChunkRow | null => {
      if (reply.type === "null") return null;
      if (reply.type !== "array" || reply.items.length < columns.length) throw malformed("row does not match its schema");
      return Object.fromEntries(columns.map((column, index) => [column.name, valueFromReply(column, reply.items[index])]));
    };
    const chunkCoordinate = (reply: ChunkReply): bigint => {
      if (reply.type !== "integer" || reply.value < MIN_INT64 || reply.value > MAX_INT64) throw malformed("chunk coordinate is not int64");
      return reply.value;
    };
    if (kind === "chunks") {
      const chunks = items[6].items.map((item) => {
        if (item.type !== "array" || item.items.length < dims + 2) throw malformed("invalid chunk entry");
        return { cx: chunkCoordinate(item.items[0]), cy: chunkCoordinate(item.items[1]),
          ...(dims === 3 ? { cz: chunkCoordinate(item.items[2]) } : {}),
          version: unsigned(item.items[dims], "chunk version"), form: bytes(item.items[dims + 1]) };
      });
      return { kind, position, commitTimeMs, user, schemaVersion, chunks, tag: bytes(items[7]), txn: txn(items[8]) };
    }
    const blocks = items[6].items.map((block) => {
      if (block.type !== "array" || block.items.length < dims + 2) throw malformed("invalid block entry");
      return { x: coordinate(block.items[0]), y: coordinate(block.items[1]),
        ...(dims === 3 ? { z: coordinate(block.items[2]) } : {}), before: row(block.items[dims], schema.columns), after: row(block.items[dims + 1], schema.columns) };
    });
    if (items.length < 10) return { kind: "change", position, commitTimeMs, user, schemaVersion, blocks };
    if (items[9].type !== "array") throw malformed("chunk changes is not an array");
    const chunkChanges = items[9].items.map((entry) => {
      if (entry.type !== "array" || entry.items.length < dims + 2) throw malformed("invalid chunk change");
      return { cx: chunkCoordinate(entry.items[0]), cy: chunkCoordinate(entry.items[1]),
        ...(dims === 3 ? { cz: chunkCoordinate(entry.items[2]) } : {}),
        before: row(entry.items[dims], schema.chunkColumns), after: row(entry.items[dims + 1], schema.chunkColumns) };
    });
    return { kind: "change", position, commitTimeMs, user, schemaVersion, blocks, tag: bytes(items[7]), txn: txn(items[8]), chunkChanges };
  }

  private schemaKey(epoch: string, version: ChunkSchemaVersion): string {
    return epoch + ":" + version;
  }

  private async describe(): Promise<ChunkTableSchema> {
    const client = this.createClient();
    this.description = client;
    try {
      return await client.describe(this.table);
    } finally {
      await client.close();
      if (this.description === client) this.description = null;
    }
  }
}
