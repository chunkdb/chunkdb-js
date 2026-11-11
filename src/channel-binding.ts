// SCRAM channel binding: the data that ties a login to its TLS connection.
// `tls-exporter` (RFC 9266) on TLS 1.3, `tls-server-end-point` (RFC 5929)
// on TLS 1.2.
import { createHash } from "node:crypto";
import type tls from "node:tls";

import { ChunkTlsError } from "./errors";

export type ScramChannelBindingType = "tls-exporter" | "tls-server-end-point";

/** What a bound login sends: the type in its GS2 header and the data in `c=`. */
export interface ScramChannelBinding {
  type: ScramChannelBindingType;
  data: Buffer;
}

// One DER element: its tag and where its contents start and end.
interface Element {
  tag: number;
  start: number;
  end: number;
}

function element(der: Uint8Array, offset: number, limit: number): Element | undefined {
  if (offset + 2 > limit) return undefined;
  const tag = der[offset];
  let length = der[offset + 1];
  let start = offset + 2;
  if (length & 0x80) {
    const bytes = length & 0x7f;
    // Indefinite lengths are not DER; four bytes cover any certificate.
    if (bytes === 0 || bytes > 4 || start + bytes > limit) return undefined;
    length = 0;
    for (let i = 0; i < bytes; i += 1) length = length * 256 + der[start + i];
    start += bytes;
  }
  const end = start + length;
  return end <= limit ? { tag, start, end } : undefined;
}

function objectIdentifier(der: Uint8Array, at: Element): string | undefined {
  if (at.tag !== 0x06 || at.end === at.start) return undefined;
  const arcs: number[] = [];
  let value = 0;
  for (let i = at.start; i < at.end; i += 1) {
    value = value * 128 + (der[i] & 0x7f);
    if (value > Number.MAX_SAFE_INTEGER / 128) return undefined;
    if ((der[i] & 0x80) === 0) {
      arcs.push(value);
      value = 0;
    }
  }
  if ((der[at.end - 1] & 0x80) !== 0) return undefined;
  const first = arcs[0] < 80 ? Math.floor(arcs[0] / 40) : 2;
  return [first, arcs[0] - first * 40, ...arcs.slice(1)].join(".");
}

// The algorithm of an AlgorithmIdentifier, and its parameters if any.
function algorithm(der: Uint8Array, at: Element | undefined): { oid: string; parameters?: Element } | undefined {
  if (at?.tag !== 0x30) return undefined;
  const id = element(der, at.start, at.end);
  const oid = id === undefined ? undefined : objectIdentifier(der, id);
  if (id === undefined || oid === undefined) return undefined;
  return { oid, parameters: element(der, id.end, at.end) };
}

// RFC 5929 section 4.1: MD5 and SHA-1 give way to SHA-256.
const SIGNATURE_HASHES: Readonly<Record<string, string>> = {
  "1.2.840.113549.1.1.4": "sha256", // md5WithRSAEncryption
  "1.2.840.113549.1.1.5": "sha256", // sha1WithRSAEncryption
  "1.2.840.113549.1.1.14": "sha224",
  "1.2.840.113549.1.1.11": "sha256",
  "1.2.840.113549.1.1.12": "sha384",
  "1.2.840.113549.1.1.13": "sha512",
  "1.2.840.10045.4.1": "sha256", // ecdsa-with-SHA1
  "1.2.840.10045.4.3.1": "sha224",
  "1.2.840.10045.4.3.2": "sha256",
  "1.2.840.10045.4.3.3": "sha384",
  "1.2.840.10045.4.3.4": "sha512",
};
const RSASSA_PSS = "1.2.840.113549.1.1.10";
const DIGESTS: Readonly<Record<string, string>> = {
  "1.3.14.3.2.26": "sha256", // SHA-1
  "2.16.840.1.101.3.4.2.4": "sha224",
  "2.16.840.1.101.3.4.2.1": "sha256",
  "2.16.840.1.101.3.4.2.2": "sha384",
  "2.16.840.1.101.3.4.2.3": "sha512",
};

/**
 * The hash `tls-server-end-point` uses for a DER certificate: that of its
 * signature algorithm, SHA-256 for MD5 and SHA-1. Undefined for an
 * algorithm without one hash (Ed25519, Ed448) or one this client does not
 * know.
 */
export function endPointHash(certificate: Uint8Array): string | undefined {
  const outer = element(certificate, 0, certificate.length);
  if (outer?.tag !== 0x30) return undefined;
  const tbs = element(certificate, outer.start, outer.end);
  if (tbs?.tag !== 0x30) return undefined;
  const signature = algorithm(certificate, element(certificate, tbs.end, outer.end));
  if (signature === undefined) return undefined;
  if (signature.oid !== RSASSA_PSS) return SIGNATURE_HASHES[signature.oid];
  // RSASSA-PSS-params: hashAlgorithm [0] defaults to SHA-1.
  const parameters = signature.parameters;
  if (parameters?.tag !== 0x30) return undefined;
  for (let at = element(certificate, parameters.start, parameters.end); at !== undefined;
    at = element(certificate, at.end, parameters.end)) {
    if (at.tag === 0xa0) {
      const digest = algorithm(certificate, element(certificate, at.start, at.end));
      return digest === undefined ? undefined : DIGESTS[digest.oid];
    }
  }
  return DIGESTS["1.3.14.3.2.26"];
}

/**
 * The binding of a login to a TLS connection whose handshake has completed:
 * `tls-exporter` on TLS 1.3, `tls-server-end-point` below it. Throws a
 * `ChunkTlsError` when the connection defines neither.
 */
export function tlsChannelBinding(socket: tls.TLSSocket): ScramChannelBinding {
  if (socket.getProtocol() === "TLSv1.3") {
    // RFC 9266: 32 bytes under this label with an empty context.
    return { type: "tls-exporter", data: socket.exportKeyingMaterial(32, "EXPORTER-Channel-Binding", Buffer.alloc(0)) };
  }
  const certificate = socket.getPeerX509Certificate()?.raw;
  const hash = certificate === undefined ? undefined : endPointHash(certificate);
  if (certificate === undefined || hash === undefined) {
    throw new ChunkTlsError(
      `channel binding on ${socket.getProtocol() ?? "this TLS connection"} needs tls-server-end-point, ` +
        "which the server certificate's signature algorithm does not define; " +
        'connect over TLS 1.3 or set channelBinding: "off"',
      { phase: "tls", command: "HELLO" },
    );
  }
  return { type: "tls-server-end-point", data: createHash(hash).update(certificate).digest() };
}
