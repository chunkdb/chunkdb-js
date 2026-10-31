import { ChunkProtocolError } from "./errors";
import type { ChunkReply } from "./protocol";
import type { ChunkColumn, ChunkServerInfo, ChunkSize, ChunkTableSchema, ChunkValue, ChunkSchemaVersion, ChunkFeatureStatus, ChunkStatus } from "./types";
import { formatColumnType, parseColumnType, valueFromReply } from "./values";

/** A table schema and what the chunk form needs beyond `DESCRIBE`'s public fields. */
export interface TableLayout {
  schema: ChunkTableSchema;
  /**
   * Per column, its id from `DESCRIBE`: the chunk form's `text` and `bytes`
   * entries name their column by it. Ids are never reused within a table.
   */
  ids: number[];
}

function malformed(what: string, command: string): ChunkProtocolError {
  return new ChunkProtocolError(`malformed ${command} reply: ${what}`, { phase: "protocol", command });
}

/** The entries of a map reply by their string keys. */
export function mapOf(reply: ChunkReply, command: string): Map<string, ChunkReply> {
  if (reply.type !== "map") {
    throw malformed(`expected a map, got ${reply.type}`, command);
  }
  const entries = new Map<string, ChunkReply>();
  for (const [key, value] of reply.entries) {
    if (key.type === "bulk") {
      entries.set(key.value.toString("utf8"), value);
    } else if (key.type === "simple") {
      entries.set(key.value, value);
    } else {
      throw malformed(`a ${key.type} map key`, command);
    }
  }
  return entries;
}

function field(entries: Map<string, ChunkReply>, key: string, command: string): ChunkReply {
  const value = entries.get(key);
  if (value === undefined) {
    throw malformed(`no ${key}`, command);
  }
  return value;
}

export function integerOf(reply: ChunkReply, what: string, command: string): number {
  if (reply.type !== "integer" || reply.value > BigInt(Number.MAX_SAFE_INTEGER) || reply.value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw malformed(`${what} is not an integer`, command);
  }
  return Number(reply.value);
}

export function textOf(reply: ChunkReply, what: string, command: string): string {
  if (reply.type === "bulk") {
    return reply.value.toString("utf8");
  }
  if (reply.type === "simple") {
    return reply.value;
  }
  throw malformed(`${what} is not a string`, command);
}

function booleanOf(reply: ChunkReply, what: string, command: string): boolean {
  if (reply.type !== "boolean") {
    throw malformed(`${what} is not a boolean`, command);
  }
  return reply.value;
}

function sizeOf(reply: ChunkReply, what: string, command: string): ChunkSize {
  if (reply.type !== "array" || reply.items.length < 2) {
    throw malformed(`${what} is not [width, height]`, command);
  }
  return {
    width: integerOf(reply.items[0], what, command),
    height: integerOf(reply.items[1], what, command),
  };
}

export function parseServerInfo(reply: ChunkReply): ChunkServerInfo {
  const command = "HELLO";
  const entries = mapOf(reply, command);
  const integer = (key: string) => integerOf(field(entries, key, command), key, command);
  const signature = field(entries, "server_signature", command);
  return {
    protocol: integer("protocol"),
    serverVersion: textOf(field(entries, "server_version", command), "server_version", command),
    maxLineBytes: integer("max_line_bytes"),
    maxParameters: integer("max_parameters"),
    maxAreaChunks: integer("max_area_chunks"),
    maxResponseBytes: integer("max_response_bytes"),
    maxScanLimit: integer("max_scan_limit"),
    serverSignature: signature.type === "null" ? null : textOf(signature, "server_signature", command),
    ...(entries.has("connection_id") ? { connectionId: uint64Of(field(entries, "connection_id", command), "connection_id", command, false) } : {}),
    ...(entries.has("features") ? { features: stringArray(field(entries, "features", command), command) } : {}),
    ...(entries.has("options") ? { options: Object.fromEntries([...mapOf(field(entries, "options", command), command)].filter(([key]) => ["client_name", "statement_timeout_ms", "default_tag"].includes(key)).map(([key, value]) => [key, optionValue(value, command, key)])) } : {}),
    ...(entries.has("not_applied") ? { notApplied: Object.fromEntries([...mapOf(field(entries, "not_applied", command), command)].map(([key, value]) => [key, { reason: textOf(field(mapOf(value, command), "reason", command), "reason", command) }])) } : {}),
    ...(entries.has("idle_timeout_ms") ? { idleTimeoutMs: integer("idle_timeout_ms") } : {}),
    ...(entries.has("limits") ? { limits: Object.fromEntries([...mapOf(field(entries, "limits", command), command)].filter(([key]) => ["max_area_chunks", "max_area_response_bytes", "txn_max_written_chunks", "txn_max_read_chunks", "max_watches", "max_returning_rows", "max_expression_nodes"].includes(key)).map(([key, value]) => [key, integerOf(value, key, command)])) } : {}),
  };
}

function parseColumn(reply: ChunkReply, command: string): { column: ChunkColumn; id: number } {
  const entries = mapOf(reply, command);
  const name = textOf(field(entries, "name", command), "a column name", command);
  const typeName = textOf(field(entries, "type", command), `the type of ${name}`, command);
  let type;
  try {
    type = parseColumnType(typeName);
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    type = { kind: "unknown" as const, name: typeName };
  }
  const column: ChunkColumn = {
    name,
    type,
    typeName: formatColumnType(type),
    nullable: booleanOf(field(entries, "null", command), `null of ${name}`, command),
    required: booleanOf(field(entries, "required", command), `required of ${name}`, command),
    default: null,
  };
  column.default = valueFromReply(column, field(entries, "default", command));
  return { column, id: integerOf(field(entries, "id", command), `the id of ${name}`, command) };
}

/** Column descriptions shared by DESCRIBE and WATCH schema events. */
export function parseColumns(reply: ChunkReply, command: string, allowEmpty = false): ChunkColumn[] {
  if (reply.type !== "array" || (reply.items.length === 0 && !allowEmpty)) {
    throw malformed("columns is not a nonempty array", command);
  }
  const names = new Set<string>();
  const ids = new Set<number>();
  return reply.items.map((item) => {
    const { column, id } = parseColumn(item, command);
    if (id < 0 || id > 0xffff_ffff || names.has(column.name) || ids.has(id)) {
      throw malformed("invalid or duplicate column name/id", command);
    }
    names.add(column.name);
    ids.add(id);
    return column;
  });
}

export function parseDescribe(reply: ChunkReply): TableLayout {
  const command = "DESCRIBE";
  const entries = mapOf(reply, command);
  const columnsReply = field(entries, "columns", command);
  if (columnsReply.type !== "array") {
    throw malformed("columns is not an array", command);
  }
  const parsed = columnsReply.items.map((item) => parseColumn(item, command));
  const options = mapOf(field(entries, "options", command), command);
  const option = (key: string) => field(options, key, command);
  const version = schemaVersionOf(field(entries, "version", command), command);
  return {
    schema: {
      table: textOf(field(entries, "table", command), "table", command),
      ...(entries.has("epoch") ? { epoch: epochOf(field(entries, "epoch", command), command) } : {}),
      ...(entries.has("revision") ? { revision: field(entries, "revision", command).type === "null" ? null : uint64Of(field(entries, "revision", command), "revision", command) } : {}),
      ...(entries.has("dims") ? { dims: integerOf(field(entries, "dims", command), "dims", command) } : {}),
      ...(entries.has("chunk_columns") ? { chunkColumns: parseColumns(field(entries, "chunk_columns", command), command, true) } : {}),
      version,
      columns: parsed.map(({ column }) => column),
      chunk: sizeOf(field(entries, "chunk", command), "chunk", command),
      large: sizeOf(field(entries, "large", command), "large", command),
      options: {
        durabilityMode: textOf(option("durability_mode"), "durability_mode", command),
        checkpointUpdates: integerOf(option("checkpoint_updates"), "checkpoint_updates", command),
        checkpointWalBytes: integerOf(option("checkpoint_wal_bytes"), "checkpoint_wal_bytes", command),
        walGroupCommitUpdates: integerOf(option("wal_group_commit_updates"), "wal_group_commit_updates", command),
        checkpointCompression: textOf(option("checkpoint_compression"), "checkpoint_compression", command),
        varMaxChunkBytes: integerOf(option("var_max_chunk_bytes"), "var_max_chunk_bytes", command),
        feedBufferBytes: integerOf(option("feed_buffer_bytes"), "feed_buffer_bytes", command),
        slotMaxBytes: integerOf(option("slot_max_bytes"), "slot_max_bytes", command),
      },
    },
    ids: parsed.map(({ id }) => id),
  };
}

export function uint64Of(reply: ChunkReply, what: string, command: string, zero = true): bigint {
  if (reply.type !== "integer" || reply.value < (zero ? 0n : 1n) || reply.value > (1n << 64n) - 1n) {
    throw malformed(`${what} is not uint64`, command);
  }
  return reply.value;
}

export function epochOf(reply: ChunkReply, command: string): string {
  const epoch = textOf(reply, "epoch", command);
  if (!/^[0-9a-f]{32}$/i.test(epoch)) throw malformed("invalid epoch", command);
  return epoch.toLowerCase();
}

function stringArray(reply: ChunkReply, command: string): string[] {
  if (reply.type !== "array") throw malformed("expected a string array", command);
  return reply.items.map((item) => textOf(item, "feature", command));
}

function optionValue(reply: ChunkReply, command: string, key: string): ChunkValue {
  if (reply.type === "bulk") return key === "client_name" ? reply.value.toString("utf8") : Buffer.from(reply.value);
  if (reply.type === "null") return null;
  if (["integer", "double", "boolean", "simple"].includes(reply.type) && "value" in reply) {
    if (typeof reply.value === "bigint" && reply.value >= BigInt(Number.MIN_SAFE_INTEGER) && reply.value <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(reply.value);
    return reply.value as ChunkValue;
  }
  throw malformed("invalid session option value", command);
}

export function schemaVersionOf(reply: ChunkReply, command: string): ChunkSchemaVersion {
  const version = uint64Of(reply, "schema version", command);
  return version <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(version) : version;
}

export function parseStatus(reply: ChunkReply): ChunkStatus {
  const command = "SHOW STATUS";
  const entries = mapOf(reply, command);
  const feature = (reply: ChunkReply): ChunkFeatureStatus => {
    const values = mapOf(reply, command);
    return { enabled: stringArray(field(values, "enabled", command), command),
      compat: uint64Of(field(values, "compat", command), "compat", command),
      roCompat: uint64Of(field(values, "ro_compat", command), "ro_compat", command),
      incompat: uint64Of(field(values, "incompat", command), "incompat", command) };
  };
  const tables = field(entries, "tables", command);
  if (tables.type !== "array") throw malformed("tables is not an array", command);
  return { directory: feature(field(entries, "directory", command)), tables: tables.items.map((item) => ({
    name: textOf(field(mapOf(item, command), "name", command), "name", command), ...feature(item),
  })), activationPending: booleanOf(field(entries, "activation_pending", command), "activation_pending", command) };
}
