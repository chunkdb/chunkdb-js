import { isUtf8 } from "node:buffer";
import { ChunkProtocolError } from "./errors";
import type { ChunkReply } from "./protocol";
import { mapOf, uint64Of } from "./schema";
import type { ChunkConnectionInfo } from "./types";

export function connectionId(value: bigint): string {
  if (typeof value !== "bigint" || value <= 0n || value > (1n << 64n) - 1n) {
    throw new TypeError("connection ID must be a positive uint64 bigint");
  }
  return value.toString();
}

export function parseConnections(reply: ChunkReply): ChunkConnectionInfo[] {
  const command = "SHOW CONNECTIONS";
  const bad = (): never => { throw new ChunkProtocolError("invalid connection listing", { phase: "protocol", command }); };
  if (reply.type !== "array") return bad();
  const seen = new Set<bigint>();
  return reply.items.map((item) => {
    const fields = mapOf(item, command);
    const idReply = fields.get("id");
    if (idReply === undefined) return bad();
    const id = uint64Of(idReply, "connection ID", command, false);
    if (seen.has(id)) return bad();
    seen.add(id);
    const text = (key: string, nullable: boolean): string | null => {
      const value = fields.get(key);
      if (nullable && value?.type === "null") return null;
      if (value?.type !== "bulk" || !isUtf8(value.value)) return bad();
      return value.value.toString("utf8");
    };
    return { id, user: text("user", true), peer: text("peer", false)!, state: text("state", false)!, statement: text("statement", true) };
  });
}

export function controlAcknowledgment(reply: ChunkReply, key: string, command: string): boolean {
  const value = mapOf(reply, command).get(key);
  if (value?.type !== "boolean") throw new ChunkProtocolError(`invalid ${key} acknowledgment`, { phase: "protocol", command });
  return value.value;
}
