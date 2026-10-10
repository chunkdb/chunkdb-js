import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import net, { type Socket } from "node:net";

// The HELLO 3 reply; `signature` is the SCRAM server-final message, null
// without a user.
export function helloReply(signature: string | null): string {
  const entries: Array<[string, string]> = [
    ["protocol", ":3"],
    ["server_version", "$4\r\ntest"],
    ["max_line_bytes", ":65536"],
    ["max_parameters", ":65535"],
    ["max_area_chunks", ":256"],
    ["max_response_bytes", ":67108864"],
    ["max_scan_limit", ":1024"],
    ["server_signature", signature === null ? "_" : `$${signature.length}\r\n${signature}`],
  ];
  return `%${entries.length}\r\n${entries.map(([key, value]) => `$${key.length}\r\n${key}\r\n${value}\r\n`).join("")}`;
}

export const FAKE_HELLO = helloReply(null);

// DESCRIBE of `t (id u10 REQUIRED, h <hType>)`, 4 x 4 blocks.
export function describeReply(hType: string): string {
  const bulk = (text: string) => `$${Buffer.byteLength(text)}\r\n${text}\r\n`;
  const column = (id: number, name: string, type: string, required: boolean) =>
    `%6\r\n${bulk("id")}:${id}\r\n${bulk("name")}${bulk(name)}${bulk("type")}${bulk(type)}${bulk("null")}#f\r\n` +
    `${bulk("required")}${required ? "#t" : "#f"}\r\n${bulk("default")}_\r\n`;
  return (
    `%6\r\n${bulk("table")}${bulk("t")}${bulk("version")}:1\r\n${bulk("columns")}*2\r\n` +
    column(1, "id", "u10", true) +
    column(2, "h", hType, false) +
    `${bulk("chunk")}*2\r\n:4\r\n:4\r\n${bulk("large")}*2\r\n:8\r\n:8\r\n${bulk("options")}%8\r\n` +
    `${bulk("durability_mode")}${bulk("relaxed")}${bulk("checkpoint_updates")}:256\r\n` +
    `${bulk("checkpoint_wal_bytes")}:1048576\r\n${bulk("wal_group_commit_updates")}:8\r\n` +
    `${bulk("checkpoint_compression")}${bulk("none")}${bulk("var_max_chunk_bytes")}:1048576\r\n` +
    `${bulk("feed_buffer_bytes")}:67108864\r\n${bulk("slot_max_bytes")}:1073741824\r\n`
  );
}

/**
 * The server side of a SCRAM-SHA-256 login for one user and password, as
 * chunkdb runs it: answers `HELLO 3 USER` and `AUTH`, or null for any other
 * statement. `signature` replaces the server signature it sends.
 */
export function scramResponder(user: string, password: string, options: { signature?: string } = {}) {
  const salt = randomBytes(16);
  const salted = pbkdf2Sync(password, salt, 4096, 32, "sha256");
  const hmac = (key: Buffer, text: string) => createHmac("sha256", key).update(text).digest();
  const storedKey = createHash("sha256").update(hmac(salted, "Client Key")).digest();
  const serverKey = hmac(salted, "Server Key");
  let pending: { bare: string; serverFirst: string; nonce: string } | null = null;
  return (request: FakeRequest): string | null => {
    if (request.line === `HELLO 3 USER ${user} $1`) {
      const first = request.frames[0]?.toString("utf8") ?? "";
      const match = /^n,,(n=([^,]*),r=(.+))$/.exec(first);
      if (match === null || match[2] !== user) {
        return "-ERR INVALID_ARGUMENT bad client-first message\r\n";
      }
      const nonce = match[3] + randomBytes(18).toString("base64");
      pending = { bare: match[1], nonce, serverFirst: `r=${nonce},s=${salt.toString("base64")},i=4096` };
      return `+SCRAM ${pending.serverFirst}\r\n`;
    }
    if (request.line === "AUTH $1" && pending !== null) {
      const final = request.frames[0]?.toString("utf8") ?? "";
      const prefix = `c=biws,r=${pending.nonce},p=`;
      const authMessage = `${pending.bare},${pending.serverFirst},${prefix.slice(0, -3)}`;
      pending = null;
      if (!final.startsWith(prefix)) {
        return "-ERR INVALID_ARGUMENT bad client-final message\r\n";
      }
      const proof = Buffer.from(final.slice(prefix.length), "base64");
      const signature = hmac(storedKey, authMessage);
      const clientKey = Buffer.from(proof.map((byte, i) => byte ^ signature[i]));
      if (!createHash("sha256").update(clientKey).digest().equals(storedKey)) {
        return "-ERR AUTH_FAILED invalid user or password\r\n";
      }
      return helloReply(options.signature ?? `v=${hmac(serverKey, authMessage).toString("base64")}`);
    }
    return null;
  };
}

export interface FakeRequest {
  line: string;
  frames: Array<Buffer | null>;
}

export interface FakeServer {
  readonly port: number;
  readonly requests: FakeRequest[];
  readonly connections: number;
  close(): Promise<void>;
}

/**
 * A server that reads statements with their parameter frames and answers
 * each with what `answer` returns (nothing for null).
 */
export async function startFakeServer(
  answer: (request: FakeRequest, socket: Socket) => string | Buffer | null | Promise<string | Buffer | null>,
): Promise<FakeServer> {
  const requests: FakeRequest[] = [];
  const sockets = new Set<Socket>();
  let connections = 0;
  const server = net.createServer((socket) => {
    connections += 1;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    let buffer = Buffer.alloc(0);
    let chain = Promise.resolve();
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (true) {
        const newline = buffer.indexOf(0x0a);
        if (newline === -1) {
          return;
        }
        const line = buffer.subarray(0, newline).toString("utf8").replace(/\r$/, "");
        const count = (line.replace(/'(?:[^']|'')*'/g, "").match(/\$[0-9]+/g) ?? []).length;
        let at = newline + 1;
        const frames: Array<Buffer | null> = [];
        for (let i = 0; i < count; i += 1) {
          const end = buffer.indexOf(0x0a, at);
          if (end === -1) {
            return;
          }
          const header = buffer.subarray(at, end).toString("latin1").replace(/\r$/, "");
          if (header === "$-1") {
            frames.push(null);
            at = end + 1;
            continue;
          }
          const length = Number(header.slice(1));
          if (buffer.length < end + 1 + length + 2) {
            return;
          }
          frames.push(Buffer.from(buffer.subarray(end + 1, end + 1 + length)));
          at = end + 1 + length + 2;
        }
        buffer = buffer.subarray(at);
        const request = { line, frames };
        requests.push(request);
        chain = chain.then(async () => {
          const reply = await answer(request, socket);
          if (reply !== null && !socket.destroyed) {
            socket.write(reply);
          }
        });
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("failed to determine fake server address");
  }
  return {
    port: address.port,
    requests,
    get connections() {
      return connections;
    },
    async close() {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
