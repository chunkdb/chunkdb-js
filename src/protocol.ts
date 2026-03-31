import { ChunkProtocolError } from "./errors";

export interface SimpleFrame {
  type: "simple";
  value: string;
}

export interface ErrorFrame {
  type: "error";
  code: string;
  message: string;
  raw: string;
}

export interface BulkFrame {
  type: "bulk";
  value: Buffer;
}

export type ChunkFrame = SimpleFrame | ErrorFrame | BulkFrame;

export function serializeCommand(parts: Array<string | number>): Buffer {
  return Buffer.from(`${parts.map((part) => String(part)).join(" ")}\r\n`, "utf8");
}

function findLineEnd(buffer: Buffer): { end: number; width: number } | null {
  for (let i = 0; i < buffer.length; i += 1) {
    if (buffer[i] === 0x0a) {
      if (i > 0 && buffer[i - 1] === 0x0d) {
        return { end: i - 1, width: 2 };
      }
      return { end: i, width: 1 };
    }
  }
  return null;
}

export function parseFrame(
  buffer: Buffer,
): { frame: ChunkFrame; bytesConsumed: number } | null {
  if (buffer.length === 0) {
    return null;
  }

  if (buffer[0] === 0x2b || buffer[0] === 0x2d) {
    const lineEnd = findLineEnd(buffer);
    if (lineEnd === null) {
      return null;
    }

    const line = buffer.subarray(1, lineEnd.end).toString("utf8");
    if (buffer[0] === 0x2b) {
      return {
        frame: { type: "simple", value: line },
        bytesConsumed: lineEnd.end + lineEnd.width,
      };
    }

    const raw = line;
    if (!line.startsWith("ERR ")) {
      return {
        frame: { type: "error", code: "ERR", message: line, raw },
        bytesConsumed: lineEnd.end + lineEnd.width,
      };
    }

    const withoutPrefix = line.slice(4);
    const space = withoutPrefix.indexOf(" ");
    const code = space === -1 ? withoutPrefix : withoutPrefix.slice(0, space);
    const message = space === -1 ? "" : withoutPrefix.slice(space + 1);
    return {
      frame: { type: "error", code, message, raw },
      bytesConsumed: lineEnd.end + lineEnd.width,
    };
  }

  if (buffer[0] !== 0x24) {
    throw new ChunkProtocolError("unexpected response frame prefix", {
      phase: "protocol",
    });
  }

  const headerEnd = findLineEnd(buffer);
  if (headerEnd === null) {
    return null;
  }

  const lengthText = buffer.subarray(1, headerEnd.end).toString("utf8");
  const length = Number(lengthText);
  if (!Number.isInteger(length) || length < 0) {
    throw new ChunkProtocolError(`invalid bulk length: ${lengthText}`, {
      phase: "protocol",
    });
  }

  const payloadOffset = headerEnd.end + headerEnd.width;
  const afterPayload = payloadOffset + length;
  if (buffer.length < afterPayload + 1) {
    return null;
  }

  let trailerWidth = 0;
  if (buffer.length >= afterPayload + 2 && buffer[afterPayload] === 0x0d && buffer[afterPayload + 1] === 0x0a) {
    trailerWidth = 2;
  } else if (buffer[afterPayload] === 0x0a) {
    trailerWidth = 1;
  } else {
    return null;
  }

  return {
    frame: {
      type: "bulk",
      value: Buffer.from(buffer.subarray(payloadOffset, afterPayload)),
    },
    bytesConsumed: afterPayload + trailerWidth,
  };
}

export function parseInfoPayload(payload: Buffer): Record<string, string> {
  const values: Record<string, string> = {};
  const text = payload.toString("utf8");
  for (const line of text.split(/\r?\n/)) {
    if (line === "") {
      continue;
    }
    const separator = line.indexOf("=");
    if (separator === -1) {
      values[line] = "";
      continue;
    }
    values[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return values;
}
