import { ChunkProtocolError } from "./errors";
import type { ChunkReply } from "./protocol";
import type { ChunkColumn, ChunkServerInfo, ChunkSize, ChunkTableSchema } from "./types";
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
  if (reply.type !== "array" || reply.items.length !== 2) {
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
    throw new ChunkProtocolError(`malformed ${command} reply: column ${name} has type ${typeName}`, {
      phase: "protocol",
      command,
      cause: error,
    });
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
export function parseColumns(reply: ChunkReply, command: string): ChunkColumn[] {
  if (reply.type !== "array" || reply.items.length === 0) {
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
  const version = integerOf(field(entries, "version", command), "version", command);
  return {
    schema: {
      table: textOf(field(entries, "table", command), "table", command),
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
      },
    },
    ids: parsed.map(({ id }) => id),
  };
}
