import {
  ChunkConnectionError,
  ChunkTimeoutError,
  ChunkTlsError,
} from "./errors";
import { ChunkClient, tableOfStatement } from "./client";
import type { ChunkParameter, ChunkReply } from "./protocol";
import type {
  ChunkArea,
  ChunkAreaEntry,
  ChunkAreaRawEntry,
  ChunkClientOptions,
  ChunkCoord,
  ChunkCreateUserOptions,
  ChunkPoolOptions,
  ChunkReadOptions,
  ChunkRight,
  ChunkRow,
  ChunkScanOptions,
  ChunkScanPage,
  ChunkState,
  ChunkStateInput,
  ChunkTableChange,
  ChunkTableDefinition,
  ChunkTableSchema,
  ChunkUser,
  ChunkValue,
  ChunkWriteOptions,
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
    user: options.user,
    password: options.password,
    verifierIterations: options.verifierIterations,
    connectTimeoutMs: options.connectTimeoutMs,
    commandTimeoutMs: options.commandTimeoutMs,
    tls: options.tls,
    tlsInsecure: options.tlsInsecure,
    tlsServerName: options.tlsServerName,
    ca: options.ca,
    cert: options.cert,
    key: options.key,
    table: options.table,
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

  /** `ChunkClient.execute` on a pooled connection. */
  async execute(statement: string, parameters: readonly ChunkParameter[] = []): Promise<ChunkReply> {
    const table = tableOfStatement(statement);
    try {
      return await this.withClient(async (client) => await client.execute(statement, parameters));
    } finally {
      if (table !== null) {
        this.clearSchemaCache(table.toLowerCase());
      }
    }
  }

  describe(table?: string): Promise<ChunkTableSchema> {
    return this.withClient(async (client) => await client.describe(table));
  }

  /** Forgets cached schemas on every pooled connection. */
  clearSchemaCache(table?: string): void {
    for (const client of this.clients) {
      client.clearSchemaCache(table);
    }
  }

  listTables(): Promise<string[]> {
    return this.withClient(async (client) => await client.listTables());
  }

  createTable(name: string, definition: ChunkTableDefinition): Promise<void> {
    return this.tableStatement(name, async (client) => await client.createTable(name, definition));
  }

  alterTable(name: string, change: ChunkTableChange): Promise<void> {
    return this.tableStatement(name, async (client) => await client.alterTable(name, change));
  }

  dropTable(name: string): Promise<void> {
    return this.tableStatement(name, async (client) => await client.dropTable(name));
  }

  getBlock(x: number, y: number, options: ChunkReadOptions = {}): Promise<ChunkRow | null> {
    return this.withClient(async (client) => await client.getBlock(x, y, options));
  }

  setBlock(x: number, y: number, values: Readonly<Record<string, ChunkValue>>, options: ChunkWriteOptions = {}): Promise<bigint> {
    return this.withClient(async (client) => await client.setBlock(x, y, values, options));
  }

  deleteBlock(x: number, y: number, options: ChunkWriteOptions = {}): Promise<bigint> {
    return this.withClient(async (client) => await client.deleteBlock(x, y, options));
  }

  getChunk(cx: number, cy: number, options: ChunkReadOptions = {}): Promise<ChunkState> {
    return this.withClient(async (client) => await client.getChunk(cx, cy, options));
  }

  getChunkRaw(cx: number, cy: number, options: ChunkReadOptions = {}): Promise<Buffer> {
    return this.withClient(async (client) => await client.getChunkRaw(cx, cy, options));
  }

  setChunk(cx: number, cy: number, state: ChunkStateInput, options: ChunkWriteOptions = {}): Promise<bigint> {
    return this.withClient(async (client) => await client.setChunk(cx, cy, state, options));
  }

  setChunkRaw(cx: number, cy: number, form: Uint8Array, options: ChunkWriteOptions = {}): Promise<bigint> {
    return this.withClient(async (client) => await client.setChunkRaw(cx, cy, form, options));
  }

  getArea(area: ChunkArea, options: ChunkReadOptions = {}): Promise<ChunkAreaEntry[]> {
    return this.withClient(async (client) => await client.getArea(area, options));
  }

  getAreaRaw(area: ChunkArea, options: ChunkReadOptions = {}): Promise<ChunkAreaRawEntry[]> {
    return this.withClient(async (client) => await client.getAreaRaw(area, options));
  }

  scanChunks(options: ChunkScanOptions = {}): Promise<ChunkScanPage> {
    return this.withClient(async (client) => await client.scanChunks(options));
  }

  /** Every chunk that has a present block, one pooled call per page. */
  async *scanAllChunks(options: Omit<ChunkScanOptions, "after"> = {}): AsyncGenerator<ChunkCoord, void, undefined> {
    let after: ChunkCoord | undefined;
    while (true) {
      const page = await this.scanChunks({ ...options, after });
      yield* page.chunks;
      if (!page.more || page.chunks.length === 0) {
        return;
      }
      after = page.chunks[page.chunks.length - 1];
    }
  }

  ping(): Promise<"PONG"> {
    return this.withClient(async (client) => await client.ping());
  }

  flushWal(): Promise<void> {
    return this.withClient(async (client) => await client.flushWal());
  }

  metrics(): Promise<string> {
    return this.withClient(async (client) => await client.metrics());
  }

  createUser(name: string, password: string, options: ChunkCreateUserOptions = {}): Promise<void> {
    return this.withClient(async (client) => await client.createUser(name, password, options));
  }

  setPassword(name: string, password: string): Promise<void> {
    return this.withClient(async (client) => await client.setPassword(name, password));
  }

  setManagesUsers(name: string, managesUsers: boolean): Promise<void> {
    return this.withClient(async (client) => await client.setManagesUsers(name, managesUsers));
  }

  dropUser(name: string): Promise<void> {
    return this.withClient(async (client) => await client.dropUser(name));
  }

  grant(right: ChunkRight, table: string, user: string): Promise<void> {
    return this.withClient(async (client) => await client.grant(right, table, user));
  }

  revoke(right: ChunkRight, table: string, user: string): Promise<void> {
    return this.withClient(async (client) => await client.revoke(right, table, user));
  }

  listUsers(): Promise<ChunkUser[]> {
    return this.withClient(async (client) => await client.listUsers());
  }

  // A table statement changes the schema every pooled connection cached.
  private async tableStatement(name: string, statement: (client: ChunkClient) => Promise<void>): Promise<void> {
    try {
      await this.withClient(statement);
    } finally {
      this.clearSchemaCache(name);
    }
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
