import type { ChunkParameter } from "./protocol.js";
import type { TableLayout } from "./schema.js";
import type { ChunkArg, ChunkCondition } from "./types.js";
import { StaleSchemaError, encodeParameter, requestError } from "./values.js";

/**
 * A computed value in `setBlock`, such as `expr("coins + $1")`: the server
 * evaluates it against the block as it is when the write applies. Its `$n`
 * parameters are the write's `args`.
 */
export class ChunkExpr {
  readonly text: string;

  constructor(text: string) {
    if (typeof text !== "string" || text.trim() === "") throw requestError("an expression must be a nonempty string");
    this.text = text;
  }
}

/** A computed value for `setBlock`; see `ChunkExpr`. */
export function expr(text: string): ChunkExpr {
  return new ChunkExpr(text);
}

/** Encodes `$n` parameters with the types of the columns they meet. */
export function encodeArgs(layout: TableLayout, args: readonly ChunkArg[] | undefined, command: string): ChunkParameter[] {
  if (args === undefined) return [];
  if (!Array.isArray(args)) throw requestError("args must be an array", command);
  return args.map((arg, i) => {
    if (typeof arg?.column !== "string") throw requestError(`parameter $${i + 1} needs a column name`, command);
    const chunkName = arg.column.startsWith("chunk.") ? arg.column.slice("chunk.".length) : undefined;
    const column = chunkName === undefined
      ? layout.schema.columns.find((c) => c.name === arg.column)
      : (layout.schema.chunkColumns ?? []).find((c) => c.name === chunkName);
    if (column === undefined) {
      throw new StaleSchemaError(`parameter $${i + 1} names column ${arg.column}, which table ${layout.schema.table} does not have`, { phase: "request", command });
    }
    return arg.value === null ? null : encodeParameter(column, arg.value);
  });
}

/** ` WHERE condition`, or nothing without a condition. */
export function whereClause(where: ChunkCondition | undefined, command: string): string {
  if (where === undefined) return "";
  if (typeof where.text !== "string" || where.text.trim() === "") throw requestError("the WHERE condition must be a nonempty string", command);
  return ` WHERE ${where.text}`;
}
