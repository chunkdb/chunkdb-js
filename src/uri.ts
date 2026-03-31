import { ChunkConnectionError } from "./errors";
import type { ChunkScheme, ParsedChunkUri } from "./types";

const DEFAULT_PORT = 4242;

export function parseChunkUri(uri: string): ParsedChunkUri {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch (error) {
    throw new ChunkConnectionError(`invalid chunk URI: ${uri}`, {
      phase: "connect",
      cause: error,
    });
  }

  const scheme = parsed.protocol.slice(0, -1) as ChunkScheme;
  if (scheme !== "chunk" && scheme !== "chunks") {
    throw new ChunkConnectionError(
      `unsupported chunk URI scheme: ${parsed.protocol.slice(0, -1)}`,
      { phase: "connect" },
    );
  }

  if (!parsed.hostname) {
    throw new ChunkConnectionError("chunk URI requires a host", { phase: "connect" });
  }

  const port = parsed.port === "" ? DEFAULT_PORT : Number(parsed.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new ChunkConnectionError(`invalid chunk URI port: ${parsed.port}`, {
      phase: "connect",
    });
  }

  return {
    scheme,
    secure: scheme === "chunks",
    host: parsed.hostname,
    port,
    token: decodeURIComponent(parsed.username),
    path: parsed.pathname === "" ? "/" : parsed.pathname,
  };
}

export function formatChunkUri(uri: ParsedChunkUri): string {
  const scheme = uri.secure ? "chunks" : uri.scheme;
  const auth = uri.token === "" ? "" : `${encodeURIComponent(uri.token)}@`;
  const host = uri.host.includes(":") ? `[${uri.host}]` : uri.host;
  const path = uri.path === "" ? "/" : uri.path;
  return `${scheme}://${auth}${host}:${uri.port}${path}`;
}
