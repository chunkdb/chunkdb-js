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
import { parseFrame, parseInfoPayload, serializeCommand, type ChunkFrame } from "./protocol";
import { formatChunkUri, parseChunkUri } from "./uri";
import type { ChunkBlockState, ChunkClientOptions, ChunkInfo, ParsedChunkUri } from "./types";

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
}

interface PendingRequest {
  command: string;
  timer: NodeJS.Timeout;
  resolve: (frame: ChunkFrame) => void;
  reject: (error: Error) => void;
}

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4242;
const DEFAULT_TIMEOUT_MS = 5000;

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
  private pending: PendingRequest | null = null;
  private connectPromise: Promise<this> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private buffer = Buffer.alloc(0);
  private connected = false;
  private disposed = false;

  constructor(options: ChunkClientOptions = {}) {
    this.options = resolveOptions(options);
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
    this.socket = null;
    this.connected = false;
    this.failPending(new ChunkConnectionError("connection closed", { phase: "connect" }));

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

  setChunk(cx: number, cy: number, bits: string): Promise<void> {
    return this.enqueue(async () => {
      if (!/^[01]+$/.test(bits)) {
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

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = async () => operation();
    const result = this.queue.then(run, run) as Promise<T>;
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async connectInternal(): Promise<this> {
    const socket = await this.openSocket();
    this.socket = socket;
    this.connected = true;

    socket.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.drainFrames();
    });

    socket.on("error", (error) => {
      this.connected = false;
      if (this.socket === socket) {
        this.socket = null;
      }
      this.failPending(this.wrapTransportError(error, this.options.secure ? "tls" : "connect"));
    });

    socket.on("close", () => {
      this.connected = false;
      if (this.socket === socket) {
        this.socket = null;
      }
      this.failPending(new ChunkConnectionError("connection closed", { phase: "connect" }));
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
        if (this.pending?.command === command) {
          this.pending = null;
        }
        socket.destroy();
        reject(
          new ChunkTimeoutError(`command timeout after ${this.options.commandTimeoutMs}ms`, {
            phase: "timeout",
            command,
          }),
        );
      }, this.options.commandTimeoutMs);

      this.pending = {
        command,
        timer,
        resolve,
        reject,
      };
      this.drainFrames();
    });

    await new Promise<void>((resolve, reject) => {
      socket.write(serializeCommand([command, ...args]), (error) => {
        if (!error) {
          resolve();
          return;
        }
        this.failPending(this.wrapTransportError(error, "request", command));
        reject(this.wrapTransportError(error, "request", command));
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
    if (this.pending === null) {
      return;
    }

    const parsed = parseFrame(this.buffer);
    if (parsed === null) {
      return;
    }

    this.buffer = this.buffer.subarray(parsed.bytesConsumed);
    const pending = this.pending;
    this.pending = null;
    clearTimeout(pending.timer);
    pending.resolve(parsed.frame);
  }

  private failPending(error: Error): void {
    if (this.pending === null) {
      return;
    }
    const pending = this.pending;
    this.pending = null;
    clearTimeout(pending.timer);
    pending.reject(error);
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
