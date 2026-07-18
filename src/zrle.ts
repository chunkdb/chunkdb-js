// Decoder/encoder for chunkdb's "CZ1" zero-run-length codec used by the
// CHUNKBINC wire command:
//
//   [0x01][u32le uncompressedSize][token...]
//   token := 0x00 <uleb128 n>            n zero bytes
//          | 0x01 <uleb128 n> <n bytes>  n literal bytes
//
// Decompression is bounded: the caller supplies the exact expected output
// size and malformed, truncated, or oversized inputs throw.

const CODEC_ID = 0x01;

function appendUleb128(bytes: number[], value: number): void {
  let remaining = value;
  while (remaining >= 0x80) {
    bytes.push((remaining & 0x7f) | 0x80);
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(remaining);
}

function readUleb128(input: Buffer, cursor: { offset: number }): number {
  let value = 0;
  let shift = 0;
  for (;;) {
    if (cursor.offset >= input.length) {
      throw new Error("zrle: truncated varint");
    }
    if (shift > 49) {
      throw new Error("zrle: varint too large");
    }
    const byte = input[cursor.offset];
    cursor.offset += 1;
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) {
      return value;
    }
    shift += 7;
  }
}

export function zrleCompress(input: Buffer): Buffer {
  const out: number[] = [CODEC_ID, 0, 0, 0, 0];
  out[1] = input.length & 0xff;
  out[2] = (input.length >>> 8) & 0xff;
  out[3] = (input.length >>> 16) & 0xff;
  out[4] = (input.length >>> 24) & 0xff;

  let i = 0;
  while (i < input.length) {
    if (input[i] === 0) {
      let run = 1;
      while (i + run < input.length && input[i + run] === 0) {
        run += 1;
      }
      out.push(0x00);
      appendUleb128(out, run);
      i += run;
    } else {
      let run = 1;
      while (i + run < input.length) {
        if (input[i + run] !== 0) {
          run += 1;
          continue;
        }
        let zeros = 0;
        while (i + run + zeros < input.length && input[i + run + zeros] === 0) {
          zeros += 1;
        }
        if (zeros <= 2 && i + run + zeros < input.length) {
          run += zeros + 1;
          continue;
        }
        break;
      }
      out.push(0x01);
      appendUleb128(out, run);
      for (let j = 0; j < run; j += 1) {
        out.push(input[i + j]);
      }
      i += run;
    }
  }
  return Buffer.from(out);
}

export function zrleDecompress(input: Buffer, expectedSize: number): Buffer {
  if (input.length < 5) {
    throw new Error("zrle: input too small");
  }
  if (input[0] !== CODEC_ID) {
    throw new Error("zrle: unsupported codec id");
  }
  const declared = input.readUInt32LE(1);
  if (declared !== expectedSize) {
    throw new Error("zrle: declared size does not match expected size");
  }

  const out = Buffer.alloc(expectedSize);
  let written = 0;
  const cursor = { offset: 5 };
  while (cursor.offset < input.length) {
    const token = input[cursor.offset];
    cursor.offset += 1;
    const run = readUleb128(input, cursor);
    if (run === 0) {
      throw new Error("zrle: zero-length run");
    }
    if (run > expectedSize - written) {
      throw new Error("zrle: output overflows expected size");
    }
    if (token === 0x00) {
      written += run; // Buffer.alloc already zero-fills
    } else if (token === 0x01) {
      if (run > input.length - cursor.offset) {
        throw new Error("zrle: truncated literal run");
      }
      input.copy(out, written, cursor.offset, cursor.offset + run);
      cursor.offset += run;
      written += run;
    } else {
      throw new Error("zrle: unknown token");
    }
  }
  if (written !== expectedSize) {
    throw new Error("zrle: output smaller than expected size");
  }
  return out;
}
