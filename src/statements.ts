import { ChunkProtocolError } from "./errors.js";
import type { ChunkReply } from "./protocol.js";
import { epochOf, mapOf, textOf, uint64Of } from "./schema.js";
import type {
  ChunkAggregateFunction,
  ChunkAggregateResult,
  ChunkAggregateRow,
  ChunkAggregateSelector,
  ChunkAggregateValue,
  ChunkAxis,
  ChunkBackupResult,
  ChunkMigrationRecord,
  ChunkRestoreResult,
  ChunkTableStats,
  ChunkUserLimits,
} from "./types.js";
import { checkInt64Coordinate, checkName, formatLiteral, requestError } from "./values.js";

const AGGREGATE = "AGGREGATE";
const AGGREGATE_FUNCTIONS = new Set(["count", "sum", "min", "max", "avg"]);

function malformed(message: string, command: string): never {
  throw new ChunkProtocolError(`malformed ${command} reply: ${message}`, { phase: "protocol", command });
}

function point(values: readonly ChunkAxis[], names: readonly string[]): string {
  return values.map((value, index) => checkInt64Coordinate(value, names[index]).toString()).join(" ");
}

/** The selector of an AGGREGATE statement: `CHUNK ...`, `AREA ... TO ...` or `AREA AROUND ... RADIUS ...`. */
export function aggregateSelector(selector: ChunkAggregateSelector): string {
  if ("chunk" in selector) {
    const chunk = selector.chunk;
    if (chunk.length !== 2 && chunk.length !== 3) throw requestError("a chunk needs two or three coordinates", AGGREGATE);
    return `CHUNK ${point(chunk, ["cx", "cy", "cz"])}`;
  }
  if ("radius" in selector) {
    const radius = checkInt64Coordinate(selector.radius, "radius");
    if (radius < 0n) throw requestError("radius must be non-negative", AGGREGATE);
    const center = "cz" in selector ? [selector.cx, selector.cy, selector.cz] : [selector.cx, selector.cy];
    return `AREA AROUND ${point(center, ["cx", "cy", "cz"])} RADIUS ${radius}`;
  }
  const [from, to] = "cz0" in selector
    ? [[selector.cx0, selector.cy0, selector.cz0], [selector.cx1, selector.cy1, selector.cz1]]
    : [[selector.cx0, selector.cy0], [selector.cx1, selector.cy1]];
  return `AREA ${point(from, ["cx0", "cy0", "cz0"])} TO ${point(to, ["cx1", "cy1", "cz1"])}`;
}

/** The function list of an AGGREGATE statement. */
export function aggregateFunctions(functions: readonly ChunkAggregateFunction[]): string {
  if (functions.length === 0) throw requestError("AGGREGATE needs at least one function", AGGREGATE);
  return functions.map((item) => {
    if (!AGGREGATE_FUNCTIONS.has(item.fn)) throw requestError(`unknown aggregate function ${JSON.stringify(item.fn)}`, AGGREGATE);
    if (item.fn === "count") return "COUNT(*)";
    return `${item.fn.toUpperCase()}(${checkName(item.column, "a column name")})`;
  }).join(", ");
}

function aggregateValue(reply: ChunkReply, command: string): ChunkAggregateValue {
  switch (reply.type) {
    case "integer":
    case "double":
      return reply.value;
    case "null":
      return null;
    default:
      return malformed(`a ${reply.type} result`, command);
  }
}

export function parseAggregate(reply: ChunkReply, count: number): ChunkAggregateResult {
  if (reply.type !== "map" || reply.entries.length !== count) return malformed(`expected a map of ${count} results`, AGGREGATE);
  const result: ChunkAggregateResult = {};
  for (const [key, value] of reply.entries) {
    const name = textOf(key, "function name", AGGREGATE);
    if (Object.hasOwn(result, name)) return malformed(`duplicate ${name}`, AGGREGATE);
    result[name] = aggregateValue(value, AGGREGATE);
  }
  return result;
}

export function parseAggregateRows(reply: ChunkReply, count: number): ChunkAggregateRow[] {
  if (reply.type !== "array") return malformed("expected an array of rows", AGGREGATE);
  return reply.items.map((item) => {
    if (item.type !== "array") return malformed("expected a row", AGGREGATE);
    const dims = item.items.length - count;
    if (dims !== 2 && dims !== 3) return malformed("a row with the wrong length", AGGREGATE);
    const axes = item.items.slice(0, dims).map((axis) => {
      if (axis.type !== "integer") return malformed("a non-integer coordinate", AGGREGATE);
      return axis.value;
    });
    const values = item.items.slice(dims).map((value) => aggregateValue(value, AGGREGATE));
    return { cx: axes[0], cy: axes[1], ...(dims === 3 ? { cz: axes[2] } : {}), values };
  });
}

function fieldOf(fields: Map<string, ChunkReply>, key: string, command: string): ChunkReply {
  const value = fields.get(key);
  if (value === undefined) return malformed(`no ${key}`, command);
  return value;
}

export function parseTableStats(reply: ChunkReply): ChunkTableStats {
  const command = "SHOW TABLE STATS";
  const fields = mapOf(reply, command);
  const revision = fieldOf(fields, "revision", command);
  const dims = uint64Of(fieldOf(fields, "dims", command), "dims", command);
  if (dims !== 2n && dims !== 3n) return malformed("dims is not 2 or 3", command);
  return {
    epoch: epochOf(fieldOf(fields, "epoch", command), command),
    revision: revision.type === "null" ? null : uint64Of(revision, "revision", command),
    dims: dims === 2n ? 2 : 3,
    tombstones: uint64Of(fieldOf(fields, "tombstones", command), "tombstones", command),
    retainedDeletionFloor: uint64Of(fieldOf(fields, "retained_deletion_floor", command), "retained_deletion_floor", command),
    ...Object.fromEntries(([["chunks", "chunks"], ["loaded_chunks", "loadedChunks"], ["files", "files"], ["disk_bytes", "diskBytes"], ["slots", "slots"], ["watches", "watches"]] as const)
      .filter(([key]) => fields.has(key)).map(([key, name]) => [name, uint64Of(fieldOf(fields, key, command), key, command)])),
  };
}

export function parseMigrations(reply: ChunkReply): ChunkMigrationRecord[] {
  const command = "SHOW MIGRATIONS";
  if (reply.type !== "array") return malformed("expected an array", command);
  return reply.items.map((item) => {
    const fields = mapOf(item, command);
    const user = fieldOf(fields, "user", command);
    return {
      name: textOf(fieldOf(fields, "name", command), "name", command),
      appliedMs: uint64Of(fieldOf(fields, "applied_ms", command), "applied_ms", command),
      user: user.type === "null" ? null : textOf(user, "user", command),
      statement: textOf(fieldOf(fields, "statement", command), "statement", command),
    };
  });
}

export function parseBackup(reply: ChunkReply): ChunkBackupResult {
  const command = "BACKUP";
  const fields = mapOf(reply, command);
  const cuts = fieldOf(fields, "cuts", command);
  if (cuts.type !== "array") return malformed("cuts is not an array", command);
  return {
    tables: uint64Of(fieldOf(fields, "tables", command), "tables", command),
    files: uint64Of(fieldOf(fields, "files", command), "files", command),
    bytes: uint64Of(fieldOf(fields, "bytes", command), "bytes", command),
    cuts: cuts.items.map((item) => {
      const cut = mapOf(item, command);
      return {
        table: textOf(fieldOf(cut, "table", command), "table", command),
        epoch: epochOf(fieldOf(cut, "epoch", command), command),
        revision: uint64Of(fieldOf(cut, "revision", command), "revision", command),
      };
    }),
  };
}

export function parseRestore(reply: ChunkReply): ChunkRestoreResult {
  const command = "RESTORE TABLE";
  const fields = mapOf(reply, command);
  return {
    table: textOf(fieldOf(fields, "table", command), "table", command),
    epoch: epochOf(fieldOf(fields, "epoch", command), command),
    parentEpoch: epochOf(fieldOf(fields, "parent_epoch", command), command),
    forkRevision: uint64Of(fieldOf(fields, "fork_revision", command), "fork_revision", command),
    files: uint64Of(fieldOf(fields, "files", command), "files", command),
    bytes: uint64Of(fieldOf(fields, "bytes", command), "bytes", command),
  };
}

/** A quoted backup path relative to the server's backup directory. */
export function backupPath(path: string, command: string): string {
  if (typeof path !== "string" || path === "" || /[\0-\x1f\x7f]/.test(path)) {
    throw requestError("a backup path must be a non-empty string without control characters", command);
  }
  return formatLiteral(path);
}

export function revisionOf(value: bigint, what: string, command: string): string {
  if (typeof value !== "bigint" || value < 0n || value > (1n << 64n) - 1n) throw requestError(`${what} must be a uint64 bigint`, command);
  return value.toString();
}

export function userLimitsClause(limits: ChunkUserLimits): string {
  const command = "ALTER USER";
  const parts: string[] = [];
  const add = (name: string, value: number | undefined, max: number): void => {
    if (value === undefined) return;
    if (!Number.isSafeInteger(value) || value < 0 || value > max) throw requestError(`${name} must be an integer from 0 through ${max}`, command);
    parts.push(`${name} = ${value}`);
  };
  add("max_connections", limits.maxConnections, 0xffffffff);
  add("statements_per_sec", limits.statementsPerSec, 65536);
  if (parts.length === 0) throw requestError("LIMIT needs maxConnections or statementsPerSec", command);
  return `LIMIT ${parts.join(", ")}`;
}
