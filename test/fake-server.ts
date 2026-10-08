import net, { type Socket } from "node:net";

// The HELLO 3 reply.
export const FAKE_HELLO = (() => {
  const entries: Array<[string, string]> = [
    ["protocol", ":3"],
    ["server_version", "$4\r\ntest"],
    ["max_line_bytes", ":65536"],
    ["max_parameters", ":65535"],
    ["max_area_chunks", ":256"],
    ["max_response_bytes", ":67108864"],
    ["max_scan_limit", ":1024"],
  ];
  return `%${entries.length}\r\n${entries.map(([key, value]) => `$${key.length}\r\n${key}\r\n${value}\r\n`).join("")}`;
})();

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
