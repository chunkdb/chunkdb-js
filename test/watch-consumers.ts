import { ChunkServerError, type ChunkSchemaEvent, type ChunkWatch, type ChunkWatchEvent } from "../src/index";

type WatchReader = Pick<ChunkWatch, "next" | "start">;

function progressOnly(watch: WatchReader, event: ChunkWatchEvent, group: string): void {
  if (event.kind !== "progress") throw new Error(group + ": unexpected " + event.kind + " while waiting");
  if (event.position.epoch !== watch.start.epoch || typeof event.position.revision !== "bigint" ||
      event.position.revision < 0n || event.position.revision >= (1n << 64n)) {
    throw new Error(group + ": invalid progress position");
  }
}

async function deadline<T>(operation: () => Promise<T>, group: string, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(group + ": timed out waiting for the required event or terminal error")), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

export function schemaAfterProgress(watch: WatchReader, timeoutMs = 5000): Promise<ChunkSchemaEvent> {
  const group = "WATCH schema";
  return deadline(async () => {
    for (let skipped = 0; skipped <= 16; skipped++) {
      const next = await watch.next();
      if (next.done) throw new Error(group + ": stream ended before schema");
      if (next.value.kind === "schema") return next.value;
      progressOnly(watch, next.value, group);
    }
    throw new Error(group + ": more than 16 progress events preceded schema");
  }, group, timeoutMs);
}

export function noTableAfterProgress(watch: WatchReader, timeoutMs = 5000): Promise<void> {
  const group = "WATCH NO_TABLE";
  return deadline(async () => {
    for (let skipped = 0; skipped <= 16; skipped++) {
      let next: IteratorResult<ChunkWatchEvent>;
      try { next = await watch.next(); }
      catch (error) {
        if (error instanceof ChunkServerError && error.serverCode === "NO_TABLE") return;
        throw error;
      }
      if (next.done) throw new Error(group + ": stream ended without NO_TABLE");
      progressOnly(watch, next.value, group);
    }
    throw new Error(group + ": more than 16 progress events preceded NO_TABLE");
  }, group, timeoutMs);
}
