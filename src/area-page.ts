import { ChunkProtocolError } from "./errors";
import type { ChunkReply } from "./protocol";
import type { ReplyLimits } from "./protocol";
import type { ChunkArea2D, ChunkArea3D, ChunkAreaPageOptions, ChunkAreaPageOptions3D } from "./types";
import { requestError } from "./values";

const MIN = -(1n << 63n), MAX = (1n << 63n) - 1n;
type Point = bigint[];
type Area = ChunkArea2D | ChunkArea3D;
type Options = ChunkAreaPageOptions | ChunkAreaPageOptions3D;

/** Inspect valid raw area clauses without confusing column or table identifiers with them. */
export function rawAreaReplyOptions(statement: string): { shape?: ReplyLimits["shape"]; limit?: number } {
  const words = (statement.match(/"(?:[^"]|"")*"|'(?:[^']|'')*'|[a-zA-Z_][a-zA-Z_0-9]*|-?[0-9]+|[^\s]/g) ?? []).map((word) => word.startsWith('"') || word.startsWith("'") ? "?" : word.toUpperCase());
  const from = words.indexOf("FROM", 2);
  if (from < 0 || from + 1 >= words.length) return {};
  let at = from + 2;
  if (words[at] === "COLUMNS") { at += 2; if (at > words.length) return {}; while (words[at] === ",") { at += 2; if (at > words.length) return {}; } }
  let page = false, schema = false, limit: number | undefined;
  while (at < words.length) {
    if (words[at] === "LIMIT") {
      if (!/^[0-9]+$/.test(words[at + 1] ?? "")) return {};
      const parsed = Number(words[at + 1]);
      if (Number.isSafeInteger(parsed) && parsed > 0) limit = parsed;
      page = true; at += 2;
    } else if (words[at] === "AFTER") {
      page = true; at += 1; let axes = 0;
      while (/^[+-]?[0-9]+$/.test(words[at] ?? "")) { at += 1; axes += 1; }
      if (axes !== 2 && axes !== 3) return {};
    } else if (words[at] === "WITH" && words[at + 1] === "SCHEMA") { schema = true; at += 2; }
    else return {};
  }
  return { shape: schema ? page ? "schemaPage" : "schemaRows" : page ? "page" : "rows", limit };
}
export interface AreaPageRequest {
  dims: 2 | 3;
  first: Point;
  last: Point;
  radius?: bigint;
  after?: Point;
  limit?: number;
  options: Options;
  clause: string;
}

function axis(value: unknown): bigint {
  if (typeof value !== "bigint" && (typeof value !== "number" || !Number.isSafeInteger(value))) throw requestError("GET AREA coordinates must be int64 values", "GET AREA");
  const result = BigInt(value);
  if (result < MIN || result > MAX) throw requestError("GET AREA coordinate is outside int64", "GET AREA");
  return result;
}

/** Copy before entering a client or pool queue; cursors never alias caller state. */
export function copyAreaPageArguments<A extends Area, O extends Options>(area: A, options: O): { area: A; options: O } {
  return { area: { ...area }, options: { ...options, ...(options.after === undefined ? {} : { after: { ...options.after } }), ...(options.columns === undefined ? {} : { columns: [...options.columns] }) } };
}

export function captureAreaPage(area: Area, options: Options, dims: 2 | 3): AreaPageRequest {
  ({ area, options } = copyAreaPageArguments(area, options));
  const record = area as unknown as Record<string, unknown>, axes = ["cx", "cy", "cz"].slice(0, dims);
  if (dims === 2 && ("cz" in record || "cz0" in record || "cz1" in record)) throw requestError("GET AREA requires two coordinate axes", "GET AREA");
  const around = "radius" in record;
  const first = axes.map((name) => axis(record[around ? name : `${name}0`]));
  const last = around ? [...first] : axes.map((name) => axis(record[`${name}1`]));
  if (first.some((value, i) => value > last[i])) throw requestError("GET AREA endpoints must be ordered", "GET AREA");
  const radius = around ? axis(record.radius) : undefined;
  if (radius !== undefined && radius < 0n) throw requestError("GET AREA radius must be nonnegative", "GET AREA");
  const limit = options.limit;
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit <= 0)) throw requestError("GET AREA limit must be a positive safe integer", "GET AREA");
  let after: Point | undefined;
  if (options.after !== undefined) {
    const cursor = options.after as unknown as Record<string, unknown>;
    if (dims === 2 && "cz" in cursor) throw requestError("GET AREA cursor has the wrong coordinate arity", "GET AREA");
    after = axes.map((name) => axis(cursor[name]));
  }
  const request = { dims, first, last, radius, after, limit, options,
    clause: around ? `AROUND ${first.join(" ")} RADIUS ${radius}` : `${first.join(" ")} TO ${last.join(" ")}` };
  if (after !== undefined && !contains(request, after)) throw requestError("GET AREA cursor is outside the selector", "GET AREA");
  return request;
}

function compare(a: Point, b: Point): number {
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

function contains(request: AreaPageRequest, point: Point): boolean {
  if (point.length !== request.dims || point.some((v) => v < MIN || v > MAX)) return false;
  if (request.radius === undefined) return point.every((v, i) => v >= request.first[i] && v <= request.last[i]);
  return point.reduce((sum, v, i) => sum + (v - request.first[i]) ** 2n, 0n) <= request.radius ** 2n;
}

function sqrt(n: bigint): bigint {
  let lo = 0n, hi = 1n << 63n;
  while (lo < hi) { const mid = (lo + hi + 1n) >> 1n; if (mid * mid <= n) lo = mid; else hi = mid - 1n; }
  return lo;
}

function bounds(request: AreaPageRequest, point: Point, at: number): [bigint, bigint] {
  if (request.radius === undefined) return [request.first[at], request.last[at]];
  let remaining = request.radius ** 2n;
  for (let i = 0; i < at; i += 1) remaining -= (point[i] - request.first[i]) ** 2n;
  const radius = sqrt(remaining), center = request.first[at];
  return [center - radius < MIN ? MIN : center - radius, center + radius > MAX ? MAX : center + radius];
}

function firstPoint(request: AreaPageRequest): Point {
  const point: Point = [];
  for (let i = 0; i < request.dims; i += 1) point.push(bounds(request, point, i)[0]);
  return point;
}

function nextPoint(request: AreaPageRequest, previous: Point): Point | null {
  const point = [...previous];
  for (let i = request.dims - 1; i >= 0; i -= 1) {
    if (point[i] < bounds(request, point, i)[1]) {
      point[i] += 1n;
      for (let j = i + 1; j < request.dims; j += 1) point[j] = bounds(request, point, j)[0];
      return point;
    }
  }
  return null;
}

function bad(message: string): never { throw new ChunkProtocolError(`GET AREA page: ${message}`, { phase: "protocol", command: "GET AREA" }); }
function pointOf(reply: ChunkReply, dims: number): Point {
  if (reply.type !== "array" || reply.items.length !== dims) bad("cursor has the wrong coordinate arity");
  return reply.items.map((item) => { if (item.type !== "integer" || item.value < MIN || item.value > MAX) bad("coordinate is outside int64"); return item.value; });
}

/** Validate whole fastest-axis intervals; rectangles need only mixed-radix ranks. */
export function validAreaProgress(request: AreaPageRequest, after: Point | null, limit: number, checkpoint: () => void = () => {}): boolean {
  checkpoint();
  if (after !== null && (!contains(request, after) || (request.after !== undefined && compare(after, request.after) <= 0))) return false;
  if (request.radius === undefined) {
    const rank = (point: Point): bigint => point.reduce((value, axis, i) => value * (request.last[i] - request.first[i] + 1n) + axis - request.first[i], 0n);
    const total = request.first.reduce((value, axis, i) => value * (request.last[i] - axis + 1n), 1n);
    const start = request.after === undefined ? 0n : rank(request.after) + 1n;
    const end = after === null ? total - 1n : rank(after);
    const valid = after === null ? total - start <= BigInt(limit) : end >= start && end - start + 1n <= BigInt(limit) && end + 1n < total;
    checkpoint();
    return valid;
  }
  let point = request.after === undefined ? firstPoint(request) : nextPoint(request, request.after);
  if (point === null) return after === null;
  const end: Point = [];
  for (let axis = 0; axis < request.dims; axis += 1) end.push(after === null ? bounds(request, end, axis)[1] : after[axis]);
  if (compare(end, point) < 0 || (after !== null && nextPoint(request, end) === null)) return false;
  let remaining = BigInt(limit);
  while (point !== null) {
    checkpoint();
    const rowEnd = [...point], fastest = request.dims - 1;
    rowEnd[fastest] = point.slice(0, fastest).every((axis, i) => axis === end[i]) ? end[fastest] : bounds(request, point, fastest)[1];
    const width = rowEnd[fastest] - point[fastest] + 1n;
    if (width <= 0n || width > remaining) return false;
    remaining -= width;
    if (compare(rowEnd, end) === 0) { checkpoint(); return true; }
    point = nextPoint(request, rowEnd);
  }
  return false;
}

export function decodeAreaPage(reply: ChunkReply, request: AreaPageRequest, maxChunks: number, checkpoint: () => void = () => {}): { rows: ChunkReply[]; more: boolean; after: Point | null } {
  checkpoint();
  if (reply.type !== "map") bad("expected a map");
  const fields = new Map<string, ChunkReply>();
  for (const [key, value] of reply.entries) {
    checkpoint();
    const name = key.type === "bulk" ? key.value.toString("utf8") : key.type === "simple" ? key.value : "";
    if (["chunks", "more", "after"].includes(name)) { if (fields.has(name)) bad(`duplicate ${name}`); fields.set(name, value); }
  }
  const chunks = fields.get("chunks"), moreField = fields.get("more"), cursor = fields.get("after");
  if (chunks?.type !== "array" || moreField?.type !== "boolean" || cursor === undefined) bad("missing page fields");
  const limit = request.limit ?? maxChunks;
  if (limit > maxChunks) bad("page limit exceeds the negotiated bound");
  if (chunks.items.length > limit || chunks.items.length > maxChunks) bad("too many returned chunks");
  const after = cursor.type === "null" ? null : pointOf(cursor, request.dims);
  if (after !== null && (!contains(request, after) || (request.after !== undefined && compare(after, request.after) <= 0))) bad("cursor does not advance within the selector");
  if (moreField.value === (after === null)) bad("only unfinished pages have a continuation cursor");
  if (after !== null && nextPoint(request, after) === null) bad("unfinished page has no remaining cells");
  if (!validAreaProgress(request, after, limit, checkpoint)) bad("continuation or completion exceeds the requested cell limit");
  let previous = request.after;
  for (const row of chunks.items) {
    checkpoint();
    if (row.type !== "array" || row.items.length < request.dims + 1) bad("chunk row is missing fields");
    const point = pointOf({ type: "array", items: row.items.slice(0, request.dims) }, request.dims);
    if (!contains(request, point) || (previous !== undefined && compare(point, previous) <= 0) || (after !== null && compare(point, after) > 0)) bad("chunk rows are outside the completed page or unordered");
    if (row.items[request.dims].type !== "bulk") bad("chunk form must be a bulk string");
    previous = point;
  }
  return { rows: chunks.items, more: moreField.value, after };
}
