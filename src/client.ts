import net from "node:net";
import tls from "node:tls";

import {
  ChunkAuthError,
  ChunkConnectionError,
  ChunkProtocolError,
  ChunkServerError,
  ChunkTimeoutError,
  ChunkTlsError,
  type ChunkError,
} from "./errors";
import { parseFrame, parseInfoPayload, serializeCommand, type BulkFrame, type ChunkFrame } from "./protocol";
import { formatChunkUri, parseChunkUri } from "./uri";
import type {
  ChunkBatchOperation,
  ChunkBlockState,
  ChunkChunkState,
  ChunkChunkStateInput,
  ChunkClientOptions,
  ChunkCoordPair,
  ChunkInfo,
  ChunkMutationResult,
  ChunkRangeEntry,
  ChunkScanResult,
  ParsedChunkUri,
} from "./types";
import { zrleDecompress } from "./zrle";

type TransportSocket = net.Socket | tls.TLSSocket;

interface ResolvedOptions {
  host: string;
  port: number;
  token: string;
  secure: boolean;
  autoAuth: boolean;
  connectTimeoutMs: number;
  commandTimeoutMs: number;
  tlsInsecure: boolean;
  tlsServerName?: string;
  ca?: string | Buffer;
  cert?: string | Buffer;
  key?: string | Buffer;
  uri: ParsedChunkUri;
  pipelineDepth: number;
}

interface PendingRequest {
  command: string;
  timer: NodeJS.Timeout;
  resolve: (frame: ChunkFrame) => void;
  reject: (error: Error) => void;
}

interface ChunkGeometryInfo {
  chunkPayloadBits: number;
  chunkBlockCount: number;
  chunkPayloadBytes: number;
  presenceBytes: number;
}

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4242;
const DEFAULT_TIMEOUT_MS = 5000;

function isBitString(bits: string): boolean {
  return /^[01]+$/.test(bits);
}

function parseChunkStateText(text: string, command: string): { bits: string; presence: string } {
  const separator = text.indexOf("|");
  if (separator <= 0 || separator !== text.lastIndexOf("|") || separator === text.length - 1) {
    throw new ChunkProtocolError(`unexpected ${command} STATE payload`, {
      phase: "protocol",
      command,
    });
  }

  const bits = text.slice(0, separator);
  const presence = text.slice(separator + 1);
  if (!isBitString(bits) || !isBitString(presence)) {
    throw new ChunkProtocolError(`unexpected ${command} STATE payload`, {
      phase: "protocol",
      command,
    });
  }

  return { bits, presence };
}

function resolveTlsServerName(options: ResolvedOptions): string | undefined {
  if (options.tlsServerName !== undefined && options.tlsServerName !== "") {
    return options.tlsServerName;
  }
  return net.isIP(options.host) === 0 ? options.host : undefined;
}

function resolveOptions(options: ChunkClientOptions = {}): ResolvedOptions {
  const parsed = options.uri ? parseChunkUri(options.uri) : null;
  const secure = options.tls ?? parsed?.secure ?? false;
  const host = options.host ?? parsed?.host ?? DEFAULT_HOST;
  const port = options.port ?? parsed?.port ?? DEFAULT_PORT;
  const token = options.token ?? parsed?.token ?? "";
  const autoAuth = options.autoAuth ?? token !== "";
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    host,
    port,
    token,
    secure,
    autoAuth,
    connectTimeoutMs,
    commandTimeoutMs,
    tlsInsecure: options.tlsInsecure ?? false,
    tlsServerName: options.tlsServerName,
    ca: options.ca,
    cert: options.cert,
    key: options.key,
    pipelineDepth: Math.max(1, options.pipelineDepth ?? 1),
    uri: {
      scheme: secure ? "chunks" : "chunk",
      secure,
      host,
      port,
      token,
      path: parsed?.path ?? "/",
    },
  };
}

export class ChunkClient {
  private readonly options: ResolvedOptions;
  private socket: TransportSocket | null = null;
  private pendingQueue: PendingRequest[] = [];
  private connectPromise: Promise<this> | null = null;
  private buffer = Buffer.alloc(0);
  private connected = false;
  private disposed = false;
  private geometryInfo: ChunkGeometryInfo | null = null;

  // Pipeline concurrency tracking
  private activeOps = 0;
  private readonly maxPipeline: number;
  private readonly opWaiters: Array<{ run: () => void; reject: (err: Error) => void }> = [];

  constructor(options: ChunkClientOptions = {}) {
    this.options = resolveOptions(options);
    this.maxPipeline = this.options.pipelineDepth;
  }

  uri(): string {
    return formatChunkUri(this.options.uri);
  }

  async connect(): Promise<this> {
    if (this.disposed) {
      throw new ChunkConnectionError("client is closed", { phase: "connect" });
    }
    if (this.connected) {
      return this;
    }
    if (this.connectPromise !== null) {
      return this.connectPromise;
    }

    this.connectPromise = this.connectInternal().finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  async close(): Promise<void> {
    this.disposed = true;
    const socket = this.socket;
    this.clearConnectionState(new ChunkConnectionError("connection closed", { phase: "connect" }));

    if (socket === null) {
      return;
    }

    await new Promise<void>((resolve) => {
      let finished = false;
      const finish = () => {
        if (finished) {
          return;
        }
        finished = true;
        resolve();
      };

      socket.once("close", finish);
      socket.once("error", finish);
      socket.end();
      setTimeout(() => {
        socket.destroy();
        finish();
      }, 200);
    });
  }

  auth(token?: string): Promise<void> {
    return this.enqueue(async () => {
      const authToken = token ?? this.options.token;
      if (authToken === "") {
        throw new ChunkAuthError("AUTH_FAILED", "token is required", {
          phase: "auth",
          command: "AUTH",
        });
      }
      const frame = await this.sendCommand("AUTH", [authToken]);
      const text = this.expectSimple(frame, "AUTH");
      if (text !== "OK") {
        throw new ChunkProtocolError(`unexpected AUTH response: ${text}`, {
          phase: "protocol",
          command: "AUTH",
        });
      }
    });
  }

  ping(): Promise<"PONG"> {
    return this.enqueue(async () => {
      const frame = await this.sendCommand("PING", []);
      const text = this.expectSimple(frame, "PING");
      if (text !== "PONG") {
        throw new ChunkProtocolError(`unexpected PING response: ${text}`, {
          phase: "protocol",
          command: "PING",
        });
      }
      return "PONG" as const;
    });
  }

  info(): Promise<ChunkInfo> {
    return this.enqueue(async () => {
      const frame = await this.sendCommand("INFO", []);
      const payload = this.expectBulk(frame, "INFO");
      return {
        raw: payload.toString("utf8"),
        values: parseInfoPayload(payload),
      };
    });
  }

  get(x: number, y: number): Promise<string> {
    return this.enqueue(async () => {
      const frame = await this.sendCommand("GET", [x, y]);
      return this.expectBulk(frame, "GET").toString("utf8");
    });
  }

  readBlock(x: number, y: number): Promise<ChunkBlockState> {
    return this.enqueue(async () => {
      const existsFrame = await this.sendCommand("EXISTS", [x, y]);
      const existsText = this.expectSimple(existsFrame, "EXISTS");
      if (existsText === "0") {
        return { exists: false, bits: null };
      }
      if (existsText !== "1") {
        throw new ChunkProtocolError(`unexpected EXISTS response: ${existsText}`, {
          phase: "protocol",
          command: "EXISTS",
        });
      }

      const getFrame = await this.sendCommand("GET", [x, y]);
      return {
        exists: true,
        bits: this.expectBulk(getFrame, "GET").toString("utf8"),
      };
    });
  }

  exists(x: number, y: number): Promise<boolean> {
    return this.enqueue(async () => {
      const frame = await this.sendCommand("EXISTS", [x, y]);
      const text = this.expectSimple(frame, "EXISTS");
      if (text === "1") {
        return true;
      }
      if (text === "0") {
        return false;
      }
      throw new ChunkProtocolError(`unexpected EXISTS response: ${text}`, {
        phase: "protocol",
        command: "EXISTS",
      });
    });
  }

  set(x: number, y: number, bits: string): Promise<void> {
    return this.enqueue(async () => {
      if (!/^[01]+$/.test(bits)) {
        throw new ChunkProtocolError("SET bits must contain only 0 and 1", {
          phase: "request",
          command: "SET",
        });
      }
      const frame = await this.sendCommand("SET", [x, y, bits]);
      const text = this.expectSimple(frame, "SET");
      if (text !== "OK") {
        throw new ChunkProtocolError(`unexpected SET response: ${text}`, {
          phase: "protocol",
          command: "SET",
        });
      }
    });
  }

  unset(x: number, y: number): Promise<void> {
    return this.enqueue(async () => {
      const frame = await this.sendCommand("UNSET", [x, y]);
      const text = this.expectSimple(frame, "UNSET");
      if (text !== "OK") {
        throw new ChunkProtocolError(`unexpected UNSET response: ${text}`, {
          phase: "protocol",
          command: "UNSET",
        });
      }
    });
  }

  mset(blocks: Array<{ x: number; y: number; bits: string }>): Promise<void> {
    return this.enqueue(async () => {
      if (blocks.length === 0) return;
      const args: Array<string | number> = [];
      for (const { x, y, bits } of blocks) {
        if (!isBitString(bits)) {
          throw new ChunkProtocolError("MSET bits must contain only 0 and 1", {
            phase: "request",
            command: "MSET",
          });
        }
        args.push(x, y, bits);
      }
      const frame = await this.sendCommand("MSET", args);
      const text = this.expectSimple(frame, "MSET");
      if (text !== "OK") {
        throw new ChunkProtocolError(`unexpected MSET response: ${text}`, {
          phase: "protocol",
          command: "MSET",
        });
      }
    });
  }

  mget(blocks: Array<{ x: number; y: number }>): Promise<string[]> {
    return this.enqueue(async () => {
      if (blocks.length === 0) return [];
      const args: Array<string | number> = [];
      for (const { x, y } of blocks) {
        args.push(x, y);
      }
      const frame = await this.sendCommand("MGET", args);
      return this.expectArray(frame, "MGET").map((f) => f.value.toString("utf8"));
    });
  }

  chunkExists(cx: number, cy: number): Promise<boolean> {
    return this.enqueue(async () => {
      const frame = await this.sendCommand("CHUNKEXISTS", [cx, cy]);
      const text = this.expectSimple(frame, "CHUNKEXISTS");
      if (text === "1") {
        return true;
      }
      if (text === "0") {
        return false;
      }
      throw new ChunkProtocolError(`unexpected CHUNKEXISTS response: ${text}`, {
        phase: "protocol",
        command: "CHUNKEXISTS",
      });
    });
  }

  readChunk(cx: number, cy: number): Promise<ChunkChunkState> {
    return this.enqueue(async () => {
      const frame = await this.sendCommand("CHUNK", [cx, cy, "STATE"]);
      const payload = this.expectBulk(frame, "CHUNK").toString("utf8");
      const { bits, presence } = parseChunkStateText(payload, "CHUNK");
      return {
        exists: presence.includes("1"),
        bits,
        presence,
      };
    });
  }

  setChunk(cx: number, cy: number, bits: string): Promise<void> {
    return this.enqueue(async () => {
      if (!isBitString(bits)) {
        throw new ChunkProtocolError("CHUNKSET bits must contain only 0 and 1", {
          phase: "request",
          command: "CHUNKSET",
        });
      }
      const frame = await this.sendCommand("CHUNKSET", [cx, cy, bits]);
      const text = this.expectSimple(frame, "CHUNKSET");
      if (text !== "OK") {
        throw new ChunkProtocolError(`unexpected CHUNKSET response: ${text}`, {
          phase: "protocol",
          command: "CHUNKSET",
        });
      }
    });
  }

  setChunkState(cx: number, cy: number, state: ChunkChunkStateInput): Promise<void> {
    return this.enqueue(async () => {
      if (!isBitString(state.bits)) {
        throw new ChunkProtocolError("CHUNKSET STATE payload bits must contain only 0 and 1", {
          phase: "request",
          command: "CHUNKSET",
        });
      }
      if (!isBitString(state.presence)) {
        throw new ChunkProtocolError("CHUNKSET STATE presence bits must contain only 0 and 1", {
          phase: "request",
          command: "CHUNKSET",
        });
      }

      const geometry = await this.ensureChunkGeometry();
      if (state.bits.length !== geometry.chunkPayloadBits) {
        throw new ChunkProtocolError(
          `CHUNKSET STATE payload bits must be ${geometry.chunkPayloadBits} bits`,
          { phase: "request", command: "CHUNKSET" },
        );
      }
      if (state.presence.length !== geometry.chunkBlockCount) {
        throw new ChunkProtocolError(
          `CHUNKSET STATE presence bits must be ${geometry.chunkBlockCount} bits`,
          { phase: "request", command: "CHUNKSET" },
        );
      }

      const frame = await this.sendCommand("CHUNKSET", [cx, cy, "STATE", `${state.bits}|${state.presence}`]);
      const text = this.expectSimple(frame, "CHUNKSET");
      if (text !== "OK") {
        throw new ChunkProtocolError(`unexpected CHUNKSET response: ${text}`, {
          phase: "protocol",
          command: "CHUNKSET",
        });
      }
    });
  }

  chunk(cx: number, cy: number): Promise<string> {
    return this.enqueue(async () => {
      const frame = await this.sendCommand("CHUNK", [cx, cy]);
      return this.expectBulk(frame, "CHUNK").toString("utf8");
    });
  }

  chunkbin(cx: number, cy: number): Promise<Buffer> {
    return this.enqueue(async () => {
      const frame = await this.sendCommand("CHUNKBIN", [cx, cy]);
      return this.expectBulk(frame, "CHUNKBIN");
    });
  }

  chunkbinState(cx: number, cy: number): Promise<Buffer> {
    return this.enqueue(async () => {
      const geometry = await this.ensureChunkGeometry();
      const frame = await this.sendCommand("CHUNKBIN", [cx, cy, "STATE"]);
      const payload = this.expectBulk(frame, "CHUNKBIN");
      if (payload.length !== geometry.chunkPayloadBytes + geometry.presenceBytes) {
        throw new ChunkProtocolError("unexpected CHUNKBIN STATE payload length", {
          phase: "protocol",
          command: "CHUNKBIN",
        });
      }
      return payload;
    });
  }

  chunkbinCompressed(cx: number, cy: number): Promise<Buffer> {
    return this.enqueue(async () => {
      const geometry = await this.ensureChunkGeometry();
      const frame = await this.sendCommand("CHUNKBINC", [cx, cy]);
      const payload = this.expectBulk(frame, "CHUNKBINC");
      try {
        return zrleDecompress(payload, geometry.chunkPayloadBytes);
      } catch (error) {
        throw new ChunkProtocolError(
          `invalid CHUNKBINC payload: ${error instanceof Error ? error.message : String(error)}`,
          { phase: "protocol", command: "CHUNKBINC" },
        );
      }
    });
  }

  chunkbinStateCompressed(cx: number, cy: number): Promise<Buffer> {
    return this.enqueue(async () => {
      const geometry = await this.ensureChunkGeometry();
      const frame = await this.sendCommand("CHUNKBINC", [cx, cy, "STATE"]);
      const payload = this.expectBulk(frame, "CHUNKBINC");
      try {
        return zrleDecompress(payload, geometry.chunkPayloadBytes + geometry.presenceBytes);
      } catch (error) {
        throw new ChunkProtocolError(
          `invalid CHUNKBINC STATE payload: ${error instanceof Error ? error.message : String(error)}`,
          { phase: "protocol", command: "CHUNKBINC" },
        );
      }
    });
  }

  chunkScan(limit: number, cursor?: ChunkCoordPair): Promise<ChunkScanResult> {
    return this.enqueue(async () => {
      const args: Array<string | number> =
        cursor === undefined ? [limit] : [limit, cursor.cx, cursor.cy];
      const frame = await this.sendCommand("CHUNKSCAN", args);
      const items = this.expectArray(frame, "CHUNKSCAN").map((f) => f.value.toString("utf8"));
      if (items.length === 0) {
        throw new ChunkProtocolError("empty CHUNKSCAN response", {
          phase: "protocol",
          command: "CHUNKSCAN",
        });
      }

      const header = items[0];
      let nextCursor: ChunkCoordPair | null = null;
      if (header.startsWith("CURSOR ")) {
        const parts = header.split(" ");
        if (parts.length !== 3) {
          throw new ChunkProtocolError(`unexpected CHUNKSCAN header: ${header}`, {
            phase: "protocol",
            command: "CHUNKSCAN",
          });
        }
        nextCursor = { cx: this.parseCoordToken(parts[1], "CHUNKSCAN"), cy: this.parseCoordToken(parts[2], "CHUNKSCAN") };
      } else if (header !== "END") {
        throw new ChunkProtocolError(`unexpected CHUNKSCAN header: ${header}`, {
          phase: "protocol",
          command: "CHUNKSCAN",
        });
      }

      const coords = items.slice(1).map((item) => {
        const parts = item.split(" ");
        if (parts.length !== 2) {
          throw new ChunkProtocolError(`unexpected CHUNKSCAN entry: ${item}`, {
            phase: "protocol",
            command: "CHUNKSCAN",
          });
        }
        return {
          cx: this.parseCoordToken(parts[0], "CHUNKSCAN"),
          cy: this.parseCoordToken(parts[1], "CHUNKSCAN"),
        };
      });
      return { coords, nextCursor };
    });
  }

  chunkRange(cx0: number, cy0: number, cx1: number, cy1: number): Promise<ChunkRangeEntry[]> {
    return this.enqueue(async () => {
      const frame = await this.sendCommand("CHUNKRANGE", [cx0, cy0, cx1, cy1]);
      return this.expectArray(frame, "CHUNKRANGE").map((f) => {
        const text = f.value.toString("utf8");
        const firstSpace = text.indexOf(" ");
        const secondSpace = text.indexOf(" ", firstSpace + 1);
        if (firstSpace <= 0 || secondSpace <= firstSpace) {
          throw new ChunkProtocolError(`unexpected CHUNKRANGE entry: ${text}`, {
            phase: "protocol",
            command: "CHUNKRANGE",
          });
        }
        const state = parseChunkStateText(text.slice(secondSpace + 1), "CHUNKRANGE");
        return {
          cx: this.parseCoordToken(text.slice(0, firstSpace), "CHUNKRANGE"),
          cy: this.parseCoordToken(text.slice(firstSpace + 1, secondSpace), "CHUNKRANGE"),
          bits: state.bits,
          presence: state.presence,
        };
      });
    });
  }

  chunkRadius(cx: number, cy: number, radiusChunks: number): Promise<ChunkRangeEntry[]> {
    return this.enqueue(async () => {
      const frame = await this.sendCommand("CHUNKRADIUS", [cx, cy, radiusChunks]);
      return this.expectArray(frame, "CHUNKRADIUS").map((f) => {
        const text = f.value.toString("utf8");
        const firstSpace = text.indexOf(" ");
        const secondSpace = text.indexOf(" ", firstSpace + 1);
        if (firstSpace <= 0 || secondSpace <= firstSpace) {
          throw new ChunkProtocolError(`unexpected CHUNKRADIUS entry: ${text}`, {
            phase: "protocol",
            command: "CHUNKRADIUS",
          });
        }
        const state = parseChunkStateText(text.slice(secondSpace + 1), "CHUNKRADIUS");
        return {
          cx: this.parseCoordToken(text.slice(0, firstSpace), "CHUNKRADIUS"),
          cy: this.parseCoordToken(text.slice(firstSpace + 1, secondSpace), "CHUNKRADIUS"),
          bits: state.bits,
          presence: state.presence,
        };
      });
    });
  }

  chunkVersion(cx: number, cy: number): Promise<bigint> {
    return this.enqueue(async () => {
      const frame = await this.sendCommand("CHUNKVER", [cx, cy]);
      return this.parseVersionText(this.expectBulk(frame, "CHUNKVER").toString("utf8"), "CHUNKVER");
    });
  }

  chunkCompareAndSet(
    cx: number,
    cy: number,
    expectedVersion: bigint,
    state: ChunkChunkStateInput,
  ): Promise<ChunkMutationResult> {
    return this.enqueue(async () => {
      try {
        const frame = await this.sendCommand("CHUNKCAS", [
          cx,
          cy,
          expectedVersion.toString(),
          "STATE",
          `${state.bits}|${state.presence}`,
        ]);
        return {
          ok: true,
          version: this.parseVersionText(this.expectBulk(frame, "CHUNKCAS").toString("utf8"), "CHUNKCAS"),
        };
      } catch (error) {
        const mismatch = this.parseVersionMismatch(error, "CHUNKCAS");
        if (mismatch !== null) {
          return mismatch;
        }
        throw error;
      }
    });
  }

  chunkBatch(
    cx: number,
    cy: number,
    operations: ChunkBatchOperation[],
    options: { ifVersion?: bigint } = {},
  ): Promise<ChunkMutationResult> {
    return this.enqueue(async () => {
      if (operations.length === 0) {
        throw new ChunkProtocolError("chunkBatch requires at least one operation", {
          phase: "protocol",
          command: "CHUNKBATCH",
        });
      }
      const args: Array<string | number> = [
        cx,
        cy,
        options.ifVersion === undefined ? "-" : options.ifVersion.toString(),
      ];
      for (const operation of operations) {
        if (operation.type === "set") {
          if (!isBitString(operation.bits)) {
            throw new ChunkProtocolError("chunkBatch set bits must contain only 0 and 1", {
              phase: "protocol",
              command: "CHUNKBATCH",
            });
          }
          args.push("SET", operation.x, operation.y, operation.bits);
        } else {
          args.push("UNSET", operation.x, operation.y);
        }
      }
      try {
        const frame = await this.sendCommand("CHUNKBATCH", args);
        return {
          ok: true,
          version: this.parseVersionText(
            this.expectBulk(frame, "CHUNKBATCH").toString("utf8"),
            "CHUNKBATCH",
          ),
        };
      } catch (error) {
        const mismatch = this.parseVersionMismatch(error, "CHUNKBATCH");
        if (mismatch !== null) {
          return mismatch;
        }
        throw error;
      }
    });
  }

  walFlush(): Promise<void> {
    return this.enqueue(async () => {
      const frame = await this.sendCommand("WALFLUSH", []);
      const text = this.expectSimple(frame, "WALFLUSH");
      if (text !== "OK") {
        throw new ChunkProtocolError(`unexpected WALFLUSH response: ${text}`, {
          phase: "protocol",
          command: "WALFLUSH",
        });
      }
    });
  }

  metrics(): Promise<string> {
    return this.enqueue(async () => {
      const frame = await this.sendCommand("METRICS", []);
      return this.expectBulk(frame, "METRICS").toString("utf8");
    });
  }

  private parseCoordToken(token: string, command: string): number {
    const value = Number.parseInt(token, 10);
    if (!Number.isSafeInteger(value) || String(value) !== token) {
      throw new ChunkProtocolError(`invalid coordinate in ${command} response: ${token}`, {
        phase: "protocol",
        command,
      });
    }
    return value;
  }

  private parseVersionText(text: string, command: string): bigint {
    if (!/^[0-9]+$/.test(text)) {
      throw new ChunkProtocolError(`invalid version in ${command} response: ${text}`, {
        phase: "protocol",
        command,
      });
    }
    return BigInt(text);
  }

  private parseVersionMismatch(error: unknown, command: string): ChunkMutationResult | null {
    if (!(error instanceof ChunkServerError) || error.code !== "VERSION_MISMATCH") {
      return null;
    }
    const match = /current=([0-9]+)/.exec(error.message);
    if (match === null) {
      throw new ChunkProtocolError(`unexpected VERSION_MISMATCH payload for ${command}`, {
        phase: "protocol",
        command,
      });
    }
    return { ok: false, version: BigInt(match[1]) };
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const run = () => {
        this.activeOps += 1;
        operation().then(
          (value) => { this.activeOps -= 1; this.releaseEnqueueSlot(); resolve(value); },
          (err: unknown) => { this.activeOps -= 1; this.releaseEnqueueSlot(); reject(err); },
        );
      };
      if (this.activeOps < this.maxPipeline) {
        run();
      } else {
        this.opWaiters.push({ run, reject });
      }
    });
  }

  private releaseEnqueueSlot(): void {
    if (this.opWaiters.length > 0 && this.activeOps < this.maxPipeline) {
      const waiter = this.opWaiters.shift()!;
      waiter.run();
    }
  }

  private async connectInternal(): Promise<this> {
    this.clearConnectionState();
    const socket = await this.openSocket();
    this.socket = socket;
    this.connected = true;

    socket.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.drainFrames();
    });

    socket.on("error", (error) => {
      if (this.socket === socket) {
        this.clearConnectionState(this.wrapTransportError(error, this.options.secure ? "tls" : "connect"));
      }
    });

    socket.on("close", () => {
      if (this.socket === socket) {
        this.clearConnectionState(new ChunkConnectionError("connection closed", { phase: "connect" }));
      }
    });

    if (this.options.autoAuth && this.options.token !== "") {
      await this.auth(this.options.token);
    }

    return this;
  }

  private async openSocket(): Promise<TransportSocket> {
    const timeoutMs = this.options.connectTimeoutMs;
    return await new Promise<TransportSocket>((resolve, reject) => {
      let socket: TransportSocket | null = null;

      const onError = (error: Error) => {
        cleanup();
        reject(this.wrapTransportError(error, this.options.secure ? "tls" : "connect"));
      };

      const timer = setTimeout(() => {
        cleanup();
        socket?.destroy();
        reject(
          new ChunkTimeoutError(
            `connection timeout after ${timeoutMs}ms`,
            { phase: "timeout", command: "CONNECT" },
          ),
        );
      }, timeoutMs);

      const cleanup = () => {
        clearTimeout(timer);
        socket?.off("error", onError);
      };

      try {
        socket = this.options.secure
          ? tls.connect(
              {
                host: this.options.host,
                port: this.options.port,
                rejectUnauthorized: !this.options.tlsInsecure,
                servername: resolveTlsServerName(this.options),
                ca: this.options.ca,
                cert: this.options.cert,
                key: this.options.key,
              },
              () => {
                cleanup();
                resolve(socket!);
              },
            )
          : net.connect(
              {
                host: this.options.host,
                port: this.options.port,
              },
              () => {
                cleanup();
                resolve(socket!);
              },
            );
      } catch (error) {
        cleanup();
        reject(this.wrapTransportError(error, this.options.secure ? "tls" : "connect"));
        return;
      }

      socket.setNoDelay(true);
      socket.once("error", onError);
    });
  }

  private async ensureConnected(): Promise<void> {
    await this.connect();
    if (this.socket === null) {
      throw new ChunkConnectionError("connection is not available", { phase: "connect" });
    }
  }

  private async sendCommand(command: string, args: Array<string | number>): Promise<ChunkFrame> {
    await this.ensureConnected();
    const socket = this.socket;
    if (socket === null) {
      throw new ChunkConnectionError("connection is not available", { phase: "connect", command });
    }

    const framePromise = new Promise<ChunkFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        // Find by timer reference to avoid closure TDZ issues
        const idx = this.pendingQueue.findIndex((p) => p.timer === timer);
        if (idx !== -1) this.pendingQueue.splice(idx, 1);
        socket.destroy();
        reject(
          new ChunkTimeoutError(`command timeout after ${this.options.commandTimeoutMs}ms`, {
            phase: "timeout",
            command,
          }),
        );
      }, this.options.commandTimeoutMs);

      this.pendingQueue.push({ command, timer, resolve, reject });
      this.drainFrames();
    });

    await new Promise<void>((resolve, reject) => {
      socket.write(serializeCommand([command, ...args]), (error) => {
        if (!error) { resolve(); return; }
        const wrapped = this.wrapTransportError(error, "request", command);
        this.failAllPending(wrapped);
        reject(wrapped);
      });
    });

    const frame = await framePromise;
    if (frame.type === "error") {
      if (frame.code === "AUTH_FAILED") {
        throw new ChunkAuthError(frame.code, frame.message, {
          phase: command === "AUTH" ? "auth" : "response",
          command,
        });
      }
      throw new ChunkServerError(frame.code, frame.message, {
        phase: "response",
        command,
      });
    }
    return frame;
  }

  private drainFrames(): void {
    while (this.pendingQueue.length > 0) {
      const parsed = parseFrame(this.buffer);
      if (parsed === null) return;
      this.buffer = this.buffer.subarray(parsed.bytesConsumed);
      const pending = this.pendingQueue.shift()!;
      clearTimeout(pending.timer);
      pending.resolve(parsed.frame);
    }
  }

  private failAllPending(error: Error): void {
    const queue = this.pendingQueue.splice(0);
    for (const pending of queue) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  private clearConnectionState(error?: Error): void {
    this.buffer = Buffer.alloc(0);
    this.connected = false;
    this.socket = null;
    const connErr = error ?? new ChunkConnectionError("connection closed", { phase: "connect" });
    // Reject enqueue waiters that haven't started yet
    const waiters = this.opWaiters.splice(0);
    for (const w of waiters) w.reject(connErr);
    if (error !== undefined) {
      this.failAllPending(error);
    }
  }

  private expectSimple(frame: ChunkFrame, command: string): string {
    if (frame.type !== "simple") {
      throw new ChunkProtocolError(`expected simple response for ${command}`, {
        phase: "protocol",
        command,
      });
    }
    return frame.value;
  }

  private expectBulk(frame: ChunkFrame, command: string): Buffer {
    if (frame.type !== "bulk") {
      throw new ChunkProtocolError(`expected bulk response for ${command}`, {
        phase: "protocol",
        command,
      });
    }
    return frame.value;
  }

  private expectArray(frame: ChunkFrame, command: string): BulkFrame[] {
    if (frame.type !== "array") {
      throw new ChunkProtocolError(`expected array response for ${command}`, {
        phase: "protocol",
        command,
      });
    }
    return frame.items;
  }

  private async ensureChunkGeometry(): Promise<ChunkGeometryInfo> {
    if (this.geometryInfo !== null) {
      return this.geometryInfo;
    }

    const frame = await this.sendCommand("INFO", []);
    const payload = this.expectBulk(frame, "INFO");
    const values = parseInfoPayload(payload);

    const blockBits = this.parsePositiveInt(values.block_bits, "block_bits");
    const chunkWidth = this.parsePositiveInt(values.chunk_width_blocks, "chunk_width_blocks");
    const chunkHeight = this.parsePositiveInt(values.chunk_height_blocks, "chunk_height_blocks");
    const chunkBlockCount = chunkWidth * chunkHeight;

    this.geometryInfo = {
      chunkPayloadBits: chunkBlockCount * blockBits,
      chunkBlockCount,
      chunkPayloadBytes: Math.ceil((chunkBlockCount * blockBits) / 8),
      presenceBytes: Math.ceil(chunkBlockCount / 8),
    };
    return this.geometryInfo;
  }

  private parsePositiveInt(value: string | undefined, field: string): number {
    const parsed = Number.parseInt(value ?? "", 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new ChunkProtocolError(`INFO missing valid ${field}`, {
        phase: "protocol",
        command: "INFO",
      });
    }
    return parsed;
  }

  private wrapTransportError(error: unknown, phase: "connect" | "request" | "tls", command?: string): ChunkError {
    const message = error instanceof Error ? error.message : String(error);
    if (phase === "tls") {
      return new ChunkTlsError(message, { phase, command, cause: error });
    }
    return new ChunkConnectionError(message, { phase, command, cause: error });
  }
}

export async function connect(options: ChunkClientOptions = {}): Promise<ChunkClient> {
  const client = new ChunkClient(options);
  await client.connect();
  return client;
}

export async function connectUri(
  uri: string,
  overrides: Partial<ChunkClientOptions> = {},
): Promise<ChunkClient> {
  return await connect({ ...overrides, uri });
}
