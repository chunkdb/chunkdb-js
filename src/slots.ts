import { ChunkProtocolError } from "./errors";
import type { ChunkReply } from "./protocol";
import { textOf } from "./schema";
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
    return { table, name, epoch: epoch.toLowerCase(), acked: uint64("acked"), retainedBytes: uint64("retained_bytes"), lost: lost.value };
  });
}
