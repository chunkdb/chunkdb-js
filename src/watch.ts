import type { ChunkClient } from "./client";
import { ChunkConnectionError, ChunkProtocolError } from "./errors";
import type { ChunkReply, PushReply } from "./protocol";
import { integerOf, parseColumns, textOf } from "./schema";
import { slotName } from "./slots";
import type {
  ChunkColumn,
  ChunkPosition,
  ChunkRow,
  ChunkWatchCoordinate,
  ChunkWatchEvent,
  ChunkWatchOptions,
  ChunkTableSchema,
} from "./types";
import { ChunkBits, checkCoordinate, checkName, requestError, valueFromReply } from "./values";

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
  if (reply.type === "array" && reply.items.length === 2) {
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
  if (options.area !== undefined) {
    const area = options.area;
    const values = [area.cx0, area.cy0, area.cx1, area.cy1].map((value) => checkCoordinate(value, "area coordinate"));
    if (area.cx0 > area.cx1 || area.cy0 > area.cy1) {
      throw requestError("WATCH area bounds are reversed", "WATCH");
    }
    statement += ` AREA ${values[0]} ${values[1]} TO ${values[2]} ${values[3]}`;
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

/** A dedicated change stream. Close it explicitly, or break out of for-await. */
export class ChunkWatch implements AsyncIterableIterator<ChunkWatchEvent> {
  readonly start: ChunkPosition;
  private readonly schemas = new Map<number, ChunkColumn[]>();
  private readonly queued: Array<PushReply | Error> = [];
  private wake: (() => void) | null = null;
  private failure: Error | null = null;
  private closing = false;
  private ended = false;
  private closePromise: Promise<void> | null = null;
  private nextTurn: Promise<void> = Promise.resolve();
  private description: ChunkClient | null = null;
  private available: bigint;

  private constructor(
    private readonly stream: ChunkClient,
    private readonly createClient: () => ChunkClient,
    private readonly table: string,
    start: ChunkPosition,
    version: number,
    columns: ChunkColumn[],
    private readonly slot: boolean,
  ) {
    this.start = start;
    this.available = start.revision;
    this.schemas.set(version, columns);
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
      if (reply.type !== "simple") throw malformed("WATCH did not answer +OK epoch revision");
      const match = /^OK ([0-9a-f]{32}) (0|[1-9][0-9]*)$/i.exec(reply.value);
      if (match === null || BigInt(match[2]) > MAX_UINT64) throw malformed("invalid WATCH start position");
      watch = new ChunkWatch(stream, createClient, table, { epoch: match[1].toLowerCase(), revision: BigInt(match[2]) }, schema.version, schema.columns, options.slot !== undefined);
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
   * Sends a slot ACK through the last returned change or starting position.
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
    if (revision > this.available) {
      return Promise.reject(requestError("ACK exceeds the last returned change or starting position", "ACK"));
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
          if (value.kind === "change") this.available = value.position.revision;
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

  private async decode(push: PushReply): Promise<ChunkWatchEvent> {
    const items = push.items;
    if (items.length < 3) throw malformed("missing kind or position");
    const kind = textOf(items[0], "kind", "WATCH");
    const position = { epoch: epochOf(items[1]), revision: unsigned(items[2], "revision") };
    if (kind === "resync" && items.length === 3) return { kind, position };
    if (kind === "schema" && items.length === 5) {
      const version = integerOf(items[3], "schema version", "WATCH");
      if (version < 0) throw malformed("negative schema version");
      const columns = parseColumns(items[4], "WATCH");
      this.schemas.set(version, copyColumns(columns));
      return { kind, position, version, columns };
    }
    if (kind !== "change" || items.length !== 7 || items[6].type !== "array") throw malformed("unknown kind or incorrect event length");
    const commitTimeMs = unsigned(items[3], "commit time");
    const user = items[4].type === "null" ? null : textOf(items[4], "user", "WATCH");
    const schemaVersion = integerOf(items[5], "schema version", "WATCH");
    if (schemaVersion < 0) throw malformed("negative schema version");
    let columns = this.schemas.get(schemaVersion);
    if (columns === undefined) {
      const schema = await this.describe();
      if (schema.version !== schemaVersion) throw malformed(`schema version ${schemaVersion} is unavailable; re-read state before resuming`);
      columns = schema.columns;
      this.schemas.set(schemaVersion, columns);
    }
    const row = (reply: ChunkReply): ChunkRow | null => {
      if (reply.type === "null") return null;
      if (reply.type !== "array" || reply.items.length !== columns.length) throw malformed("row does not match its schema");
      return Object.fromEntries(columns.map((column, index) => [column.name, valueFromReply(column, reply.items[index])]));
    };
    const blocks = items[6].items.map((block) => {
      if (block.type !== "array" || block.items.length !== 4) throw malformed("block is not [x, y, before, after]");
      return { x: coordinate(block.items[0]), y: coordinate(block.items[1]), before: row(block.items[2]), after: row(block.items[3]) };
    });
    return { kind, position, commitTimeMs, user, schemaVersion, blocks };
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
