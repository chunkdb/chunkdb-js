import { ChunkProtocolError } from "./errors";
import type { ChunkReply } from "./protocol";
import { mapOf, textOf, uint64Of } from "./schema";
import type { ChunkSlot } from "./types";
import { checkName, requestError } from "./values";

export function slotName(name: string): string {
  checkName(name, "a slot name");
  if (name.length > 63) throw requestError("a slot name takes at most 63 bytes");
  return `'${name}'`;
}

export function parseSlots(reply: ChunkReply): ChunkSlot[] {
  const command = "SHOW SLOTS";
  const malformed = (message: string): never => {
    throw new ChunkProtocolError(`malformed SHOW SLOTS reply: ${message}`, { phase: "protocol", command });
  };
  if (reply.type !== "array") return malformed("expected an array");
  return reply.items.map((item) => {
    if (item.type !== "map") return malformed("expected a slot map");
    const fields = new Map<string, ChunkReply>();
    for (const [key, value] of item.entries) {
      const name = textOf(key, "field name", command);
      if (fields.has(name)) return malformed(`duplicate field ${name}`);
      fields.set(name, value);
    }
    const field = (name: string): ChunkReply => fields.get(name) ?? malformed(`missing ${name}`);
    const uint64 = (name: string): bigint => {
      const value = field(name);
      if (value.type !== "integer" || value.value < 0n || value.value > (1n << 64n) - 1n) return malformed(`${name} is not uint64`);
      return value.value;
    };
    const table = textOf(field("table"), "table", command);
    const name = textOf(field("name"), "name", command);
    const epoch = textOf(field("epoch"), "epoch", command);
    const lost = field("lost");
    if (!/^[a-z_][a-z0-9_]*$/.test(table) || !/^[a-z_][a-z0-9_]{0,62}$/.test(name)) return malformed("invalid table or slot name");
    if (!/^[0-9a-f]{32}$/i.test(epoch)) return malformed("invalid epoch");
    if (lost.type !== "boolean") return malformed("lost is not a boolean");
    const slot: ChunkSlot = { table, name, epoch: epoch.toLowerCase(), acked: uint64("acked"), retainedBytes: uint64("retained_bytes"), lost: lost.value };
    if (fields.has("lost_reason")) {
      const value = field("lost_reason");
      slot.lostReason = value.type === "null" ? null : textOf(value, "lost_reason", command);
    }
    if (fields.has("filters")) {
      const filters = mapOf(field("filters"), command);
      const required = (key: string): ChunkReply => filters.get(key) ?? malformed(`missing filter ${key}`);
      const list = <T>(key: string, read: (item: ChunkReply) => T): T[] | null => {
        const value = required(key);
        if (value.type === "null") return null;
        if (value.type !== "array") return malformed(`filter ${key} is not an array`);
        return value.items.map(read);
      };
      const area = list("area", (item) => {
        if (item.type !== "integer" || item.value < -(1n << 63n) || item.value >= (1n << 63n)) return malformed("area coordinate is not int64");
        return item.value;
      });
      if (area !== null && (area.length < 4 || area.length % 2 !== 0)) return malformed("area needs lower and upper axes");
      if (area !== null && area.some((value, i) => i < area.length / 2 && value > area[i + area.length / 2])) return malformed("area bounds reversed");
      const columns = list("columns", (item) => item.type === "null" ? null : textOf(item, "column name", command));
      const columnIds = list("column_ids", (item) => uint64Of(item, "column id", command));
      if ((columns === null) !== (columnIds === null) || columns?.length !== columnIds?.length) return malformed("column names and ids do not align");
      const bool = (key: string) => { const value = required(key); if (value.type !== "boolean") return malformed(`${key} is not boolean`); return value.value; };
      slot.filters = { area, columns, columnIds, noBefore: bool("no_before"), chunks: bool("chunks") };
    }
    return slot;
  });
}
