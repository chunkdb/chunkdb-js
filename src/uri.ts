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

  const user = decodeUserinfo(parsed.username, "user");
  const password = decodeUserinfo(parsed.password, "password");
  if (user === "" && password !== "") {
    throw new ChunkConnectionError("chunk URI has a password without a user", { phase: "connect" });
  }

  return {
    scheme,
    secure: scheme === "chunks",
    host: parsed.hostname,
    port,
    user,
    password,
    path: parsed.pathname === "" ? "/" : parsed.pathname,
  };
}

function decodeUserinfo(text: string, what: string): string {
  try {
    return decodeURIComponent(text);
  } catch (error) {
    throw new ChunkConnectionError(`chunk URI ${what} has an invalid % escape`, { phase: "connect", cause: error });
  }
}

/**
 * The table a URI path names: `/terrain` -> `"terrain"`, `/` -> `null` (the
 * server's `default` table). Throws for a path with more than one segment.
 */
export function tableFromUriPath(path: string): string | null {
  const name = path.startsWith("/") ? path.slice(1) : path;
  if (name === "") {
    return null;
  }
  if (name.includes("/")) {
    throw new ChunkConnectionError(`chunk URI path must name one table: ${path}`, {
      phase: "connect",
    });
  }
  return decodeURIComponent(name);
}

export function formatChunkUri(uri: ParsedChunkUri): string {
  const scheme = uri.secure ? "chunks" : uri.scheme;
  let auth = "";
  if (uri.user !== "") {
    auth = encodeURIComponent(uri.user);
    if (uri.password !== "") {
      auth += `:${encodeURIComponent(uri.password)}`;
    }
    auth += "@";
  }
  const host = uri.host.includes(":") ? `[${uri.host}]` : uri.host;
  const path = uri.path === "" ? "/" : uri.path;
  return `${scheme}://${auth}${host}:${uri.port}${path}`;
}
