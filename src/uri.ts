import { ChunkConnectionError } from "./errors.js";
import type { ChunkScheme, ParsedChunkUri } from "./types.js";

const DEFAULT_PORT = 4242;

export function parseChunkUri(uri: string): ParsedChunkUri {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch (error) {
    throw new ChunkConnectionError(`invalid chunk URI: ${uri}; use the form chunk://user:password@host:4242/table, or chunks:// for TLS`, {
      phase: "connect",
      cause: error,
    });
  }

  const scheme = parsed.protocol.slice(0, -1) as ChunkScheme;
  if (scheme !== "chunk" && scheme !== "chunks") {
    throw new ChunkConnectionError(
      `unsupported chunk URI scheme: ${parsed.protocol.slice(0, -1)}; use chunk:// or chunks:// (TLS), for example chunk://user:password@host:4242/table`,
      { phase: "connect" },
    );
  }

  if (!parsed.hostname) {
    throw new ChunkConnectionError("chunk URI requires a host, for example chunk://user:password@host:4242/table", { phase: "connect" });
  }

  const port = parsed.port === "" ? DEFAULT_PORT : Number(parsed.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new ChunkConnectionError(`invalid chunk URI port: ${parsed.port}; use a port from 1 to 65535, for example chunk://user:password@host:4242/table`, {
      phase: "connect",
    });
  }

  const user = decodeUserinfo(parsed.username, "user");
  const password = decodeUserinfo(parsed.password, "password");
  if (user === "" && password !== "") {
    throw new ChunkConnectionError("chunk URI has a password without a user; use the form chunk://user:password@host:4242/table", { phase: "connect" });
  }

  // URL keeps the brackets of an IPv6 host; the socket and the TLS server
  // name take the address without them.
  const host = parsed.hostname.startsWith("[") && parsed.hostname.endsWith("]") ? parsed.hostname.slice(1, -1) : parsed.hostname;
  return {
    scheme,
    secure: scheme === "chunks",
    host,
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
    throw new ChunkConnectionError(`chunk URI ${what} has an invalid % escape; percent-encode reserved characters, for example % as %25, @ as %40 and : as %3A`, { phase: "connect", cause: error });
  }
}

/**
 * The table a URI path names: `/terrain` -> `"terrain"`, `/` -> `null` (no table
 * selected). Throws for a path with more than one segment.
 */
export function tableFromUriPath(path: string): string | null {
  const name = path.startsWith("/") ? path.slice(1) : path;
  if (name === "") {
    return null;
  }
  if (name.includes("/")) {
    throw new ChunkConnectionError(`chunk URI path must name one table: ${path}; use the form chunk://user:password@host:4242/table`, {
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
