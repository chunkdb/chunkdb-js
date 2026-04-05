import {
  ChunkConnectionError,
  ChunkTimeoutError,
  ChunkTlsError,
} from "./errors";
import { ChunkClient } from "./client";
import type {
  ChunkBlockState,
  ChunkChunkState,
  ChunkChunkStateInput,
  ChunkClientOptions,
  ChunkInfo,
  ChunkPoolOptions,
} from "./types";

interface ResolvedPoolOptions {
  maxConnections: number;
  minConnections: number;
  acquireTimeoutMs: number;
}

interface Waiter {
  timer: NodeJS.Timeout;
  resolve: (client: ChunkClient) => void;
  reject: (error: Error) => void;
}

const DEFAULT_TIMEOUT_MS = 5000;
const kWarmPool = Symbol("warmPool");

function requireInteger(name: string, value: number, { allowZero }: { allowZero: boolean }): number {
  if (!Number.isInteger(value) || value < 0 || (!allowZero && value === 0)) {
    throw new TypeError(`${name} must be ${allowZero ? ">= 0" : "> 0"}`);
  }
  return value;
}

function resolvePoolOptions(options: ChunkPoolOptions): ResolvedPoolOptions {
  const maxConnections = requireInteger("maxConnections", options.maxConnections, { allowZero: false });
  const minConnections = requireInteger("minConnections", options.minConnections ?? 0, { allowZero: true });
  if (minConnections > maxConnections) {
    throw new TypeError("minConnections must be <= maxConnections");
  }

  return {
    maxConnections,
    minConnections,
    acquireTimeoutMs: requireInteger(
      "acquireTimeoutMs",
      options.acquireTimeoutMs ?? options.commandTimeoutMs ?? DEFAULT_TIMEOUT_MS,
      { allowZero: false },
    ),
  };
}

function toClientOptions(options: ChunkPoolOptions): ChunkClientOptions {
  return {
    host: options.host,
    port: options.port,
    uri: options.uri,
    token: options.token,
    autoAuth: options.autoAuth,
    connectTimeoutMs: options.connectTimeoutMs,
    commandTimeoutMs: options.commandTimeoutMs,
    tls: options.tls,
    tlsInsecure: options.tlsInsecure,
    tlsServerName: options.tlsServerName,
    ca: options.ca,
    cert: options.cert,
    key: options.key,
  };
}

function isTransportFailure(error: unknown): boolean {
  return (
    error instanceof ChunkConnectionError ||
    error instanceof ChunkTimeoutError ||
    error instanceof ChunkTlsError
  );
}

export class ChunkPool {
  private readonly options: ResolvedPoolOptions;
  private readonly clientOptions: ChunkClientOptions;
  private readonly clients = new Set<ChunkClient>();
  private readonly idleClients: ChunkClient[] = [];
  private readonly waiters: Waiter[] = [];
  private activeLeases = 0;
  private drainingCloses = 0;
  private closing = false;
  private closePromise: Promise<void> | null = null;
  private closeResolve: (() => void) | null = null;

  constructor(options: ChunkPoolOptions) {
    this.options = resolvePoolOptions(options);
    this.clientOptions = toClientOptions(options);
  }

  async [kWarmPool](): Promise<this> {
    if (this.options.minConnections === 0) {
      return this;
    }

    const warmedClients: ChunkClient[] = [];
    try {
      for (let i = 0; i < this.options.minConnections; i += 1) {
        const client = this.createClient();
        warmedClients.push(client);
      }
      await Promise.all(warmedClients.map(async (client) => {
        await client.connect();
      }));
      this.idleClients.push(...warmedClients);
      return this;
    } catch (error) {
      for (const client of warmedClients) {
        this.clients.delete(client);
        await this.drainClient(client);
      }
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.closePromise !== null) {
      return this.closePromise;
    }

    this.closing = true;
    const closeError = new ChunkConnectionError("pool is closing", { phase: "connect" });
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(closeError);
    }

    const idleClients = this.idleClients.splice(0);
    for (const client of idleClients) {
      this.clients.delete(client);
    }

    this.closePromise = (async () => {
      await Promise.all(idleClients.map(async (client) => {
        await this.drainClient(client);
      }));

      if (this.activeLeases === 0 && this.clients.size === 0 && this.drainingCloses === 0) {
        return;
      }

      await new Promise<void>((resolve) => {
        this.closeResolve = resolve;
        this.maybeFinishClose();
      });
    })();

    return this.closePromise;
  }

  async withClient<T>(fn: (client: ChunkClient) => Promise<T>): Promise<T> {
    const client = await this.acquire();
    let discard = false;
    try {
      return await fn(client);
    } catch (error) {
      discard = isTransportFailure(error);
      throw error;
    } finally {
      await this.release(client, discard);
    }
  }

  ping(): Promise<"PONG"> {
    return this.withClient(async (client) => await client.ping());
  }

  info(): Promise<ChunkInfo> {
    return this.withClient(async (client) => await client.info());
  }

  get(x: number, y: number): Promise<string> {
    return this.withClient(async (client) => await client.get(x, y));
  }

  readBlock(x: number, y: number): Promise<ChunkBlockState> {
    return this.withClient(async (client) => await client.readBlock(x, y));
  }

  exists(x: number, y: number): Promise<boolean> {
    return this.withClient(async (client) => await client.exists(x, y));
  }

  set(x: number, y: number, bits: string): Promise<void> {
    return this.withClient(async (client) => await client.set(x, y, bits));
  }

  unset(x: number, y: number): Promise<void> {
    return this.withClient(async (client) => await client.unset(x, y));
  }

  chunkExists(cx: number, cy: number): Promise<boolean> {
    return this.withClient(async (client) => await client.chunkExists(cx, cy));
  }

  readChunk(cx: number, cy: number): Promise<ChunkChunkState> {
    return this.withClient(async (client) => await client.readChunk(cx, cy));
  }

  setChunk(cx: number, cy: number, bits: string): Promise<void> {
    return this.withClient(async (client) => await client.setChunk(cx, cy, bits));
  }

  setChunkState(cx: number, cy: number, state: ChunkChunkStateInput): Promise<void> {
    return this.withClient(async (client) => await client.setChunkState(cx, cy, state));
  }

  chunk(cx: number, cy: number): Promise<string> {
    return this.withClient(async (client) => await client.chunk(cx, cy));
  }

  chunkbin(cx: number, cy: number): Promise<Buffer> {
    return this.withClient(async (client) => await client.chunkbin(cx, cy));
  }

  chunkbinState(cx: number, cy: number): Promise<Buffer> {
    return this.withClient(async (client) => await client.chunkbinState(cx, cy));
  }

  private createClient(): ChunkClient {
    const client = new ChunkClient(this.clientOptions);
    this.clients.add(client);
    return client;
  }

  private async acquire(): Promise<ChunkClient> {
    if (this.closing) {
      throw new ChunkConnectionError("pool is closing", { phase: "connect" });
    }

    if (this.waiters.length === 0) {
      const idleClient = this.idleClients.shift();
      if (idleClient !== undefined) {
        return await this.activateClient(idleClient);
      }
      if (this.clients.size < this.options.maxConnections) {
        return await this.activateClient(this.createClient());
      }
    }

    return await this.enqueueWaiter();
  }

  private async activateClient(client: ChunkClient): Promise<ChunkClient> {
    this.activeLeases += 1;
    try {
      await client.connect();
      return client;
    } catch (error) {
      this.activeLeases -= 1;
      this.clients.delete(client);
      await this.drainClient(client);
      this.maybeFinishClose();
      this.pumpWaiters();
      throw error;
    }
  }

  private async enqueueWaiter(): Promise<ChunkClient> {
    return await new Promise<ChunkClient>((resolve, reject) => {
      const waiter: Waiter = {
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index !== -1) {
            this.waiters.splice(index, 1);
          }
          reject(
            new ChunkTimeoutError(
              `pool acquire timeout after ${this.options.acquireTimeoutMs}ms`,
              { phase: "timeout", command: "ACQUIRE" },
            ),
          );
        }, this.options.acquireTimeoutMs),
        resolve,
        reject,
      };

      this.waiters.push(waiter);
      this.pumpWaiters();
    });
  }

  private pumpWaiters(): void {
    if (this.closing) {
      return;
    }

    while (this.waiters.length > 0) {
      let client: ChunkClient | null = null;

      const idleClient = this.idleClients.shift();
      if (idleClient !== undefined) {
        client = idleClient;
      } else if (this.clients.size < this.options.maxConnections) {
        client = this.createClient();
      } else {
        return;
      }

      const waiter = this.waiters.shift()!;
      clearTimeout(waiter.timer);
      this.activeLeases += 1;

      const leasedClient = client;
      void (async () => {
        try {
          await leasedClient.connect();
          waiter.resolve(leasedClient);
        } catch (error) {
          this.activeLeases -= 1;
          this.clients.delete(leasedClient);
          await this.drainClient(leasedClient);
          this.maybeFinishClose();
          waiter.reject(error as Error);
          this.pumpWaiters();
        }
      })();
    }
  }

  private async release(client: ChunkClient, discard: boolean): Promise<void> {
    this.activeLeases -= 1;

    if (!this.clients.has(client)) {
      this.maybeFinishClose();
      return;
    }

    if (discard || this.closing) {
      this.clients.delete(client);
      if (!this.closing) {
        this.pumpWaiters();
      }
      await this.drainClient(client);
      this.maybeFinishClose();
      return;
    }

    if (this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      clearTimeout(waiter.timer);
      this.activeLeases += 1;

      const leasedClient = client;
      void (async () => {
        try {
          await leasedClient.connect();
          waiter.resolve(leasedClient);
        } catch (error) {
          this.activeLeases -= 1;
          this.clients.delete(leasedClient);
          await this.drainClient(leasedClient);
          this.maybeFinishClose();
          waiter.reject(error as Error);
          this.pumpWaiters();
        }
      })();
      return;
    }

    this.idleClients.push(client);
    this.maybeFinishClose();
  }

  private maybeFinishClose(): void {
    if (this.closeResolve === null) {
      return;
    }
    if (this.activeLeases !== 0 || this.clients.size !== 0 || this.drainingCloses !== 0) {
      return;
    }

    const resolve = this.closeResolve;
    this.closeResolve = null;
    resolve();
  }

  private async closeClientQuietly(client: ChunkClient): Promise<void> {
    try {
      await client.close();
    } catch {
      // Ignore close failures while draining the pool.
    }
  }

  private async drainClient(client: ChunkClient): Promise<void> {
    this.drainingCloses += 1;
    try {
      await this.closeClientQuietly(client);
    } finally {
      this.drainingCloses -= 1;
      this.maybeFinishClose();
    }
  }
}

export async function connectPool(options: ChunkPoolOptions): Promise<ChunkPool> {
  const pool = new ChunkPool(options);
  return await pool[kWarmPool]();
}
