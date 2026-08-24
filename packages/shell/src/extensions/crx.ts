// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * CRX3 and ZIP readers.
 *
 * The Web Store ships extensions as CRX3: a small signed header wrapped around
 * an ordinary ZIP. The loader in registry.ts only knows how to read a directory
 * of files, so something has to turn a downloaded .crx into that directory, and
 * that is this module.
 *
 * Two deliberate limitations, both worth knowing before trusting the output:
 *
 * 1. Signatures are NOT verified. A CRX3 header carries RSA/ECDSA proofs over
 *    the payload, and checking them is the only thing that makes the crx id
 *    meaningful: without verification the id is just a number the file claims
 *    for itself, and the archive could have been altered anywhere between
 *    Google and here. We rely on TLS to clients2.google.com for authenticity
 *    instead, which covers transport but not a file that arrived by other
 *    means. Do not treat a locally supplied .crx as trusted because it parsed.
 *    (Implementing verification means SHA-256 over a prefixed digest with the
 *    signed header data, plus a pinned Google root key — a separate job.)
 *
 * 2. The ZIP reader supports store and deflate only, and rejects ZIP64. Those
 *    are what the Web Store produces; anything else is an error rather than a
 *    silent skip, because a missing file inside an extension shows up much
 *    later as a confusing runtime failure.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const CRX_MAGIC = 0x34327243; // "Cr24" read as a little-endian u32.

export interface Crx {
  /** The ZIP payload, ready for `readZipEntries`. */
  zip: Uint8Array;
  /** The 32-character a-p id, or null if the header did not carry one. */
  crxId: string | null;
}

/**
 * Split a CRX3 file into its header-derived id and its ZIP payload.
 *
 * Throws on anything that is not a well-formed CRX3. CRX2 (version 2) is
 * rejected on purpose: it is a different, long-deprecated layout.
 */
export function parseCrx(bytes: Uint8Array): Crx {
  if (bytes.length < 12) throw new Error(`not a CRX file: only ${bytes.length} bytes`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const magic = view.getUint32(0, true);
  if (magic !== CRX_MAGIC) {
    const seen = new TextDecoder().decode(bytes.subarray(0, 4)).replace(/[^\x20-\x7e]/g, ".");
    throw new Error(`not a CRX file: expected magic "Cr24", got "${seen}"`);
  }

  const version = view.getUint32(4, true);
  if (version !== 3) {
    throw new Error(`unsupported CRX version ${version}; only CRX3 is supported`);
  }

  const headerLength = view.getUint32(8, true);
  const zipStart = 12 + headerLength;
  if (headerLength === 0 || zipStart > bytes.length) {
    throw new Error(
      `CRX header length ${headerLength} does not fit in a ${bytes.length} byte file`,
    );
  }

  const header = bytes.subarray(12, zipStart);
  return { zip: bytes.subarray(zipStart), crxId: crxIdFromHeader(header) };
}

/**
 * Pull the crx id out of a CrxFileHeader.
 *
 * Only two fields matter, so rather than pull in a protobuf runtime we scan the
 * wire format directly: CrxFileHeader.signed_header_data (field 10000, bytes)
 * contains a SignedData whose crx_id (field 1, bytes) is 16 raw bytes. Those
 * bytes are rendered as 32 characters by mapping each nibble onto 'a'..'p'.
 * Anything unexpected yields null — an id we cannot read is not fatal, since
 * the caller usually already knows which id it asked the store for.
 */
function crxIdFromHeader(header: Uint8Array): string | null {
  const signed = protobufBytesField(header, 10000);
  if (!signed) return null;
  const id = protobufBytesField(signed, 1);
  if (!id || id.length !== 16) return null;

  let out = "";
  for (const byte of id) {
    out += String.fromCharCode(97 + (byte >> 4), 97 + (byte & 0x0f));
  }
  return out;
}

/** First length-delimited (wire type 2) field with the given number, or null. */
function protobufBytesField(buf: Uint8Array, field: number): Uint8Array | null {
  let i = 0;
  while (i < buf.length) {
    const key = readVarint(buf, i);
    if (!key) return null;
    i = key.next;
    const wire = key.value & 0x07;
    const number = Math.floor(key.value / 8);

    if (wire === 2) {
      const len = readVarint(buf, i);
      if (!len) return null;
      const start = len.next;
      const end = start + len.value;
      if (end > buf.length) return null;
      if (number === field) return buf.subarray(start, end);
      i = end;
    } else if (wire === 0) {
      const v = readVarint(buf, i);
      if (!v) return null;
      i = v.next;
    } else if (wire === 5) {
      i += 4;
    } else if (wire === 1) {
      i += 8;
    } else {
      return null; // Groups, or corruption. Either way we cannot walk further.
    }
  }
  return null;
}

function readVarint(buf: Uint8Array, at: number): { value: number; next: number } | null {
  let value = 0;
  let shift = 1;
  for (let i = at; i < buf.length && i < at + 10; i++) {
    const byte = buf[i]!;
    // Multiply rather than shift: field 10000's key exceeds 32 bits once the
    // wire type is folded in, and `<<` would wrap it.
    value += (byte & 0x7f) * shift;
    if ((byte & 0x80) === 0) return { value, next: i + 1 };
    shift *= 128;
  }
  return null;
}

export interface ZipEntry {
  /** Path as stored in the archive, always with forward slashes. */
  name: string;
  data: Uint8Array;
}

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const ZIP64_MARKER = 0xffffffff;

/**
 * Read every file entry out of a ZIP archive.
 *
 * Entries are located through the central directory rather than by walking
 * local headers: the central directory is the archive's authoritative index,
 * and streaming-produced archives put sizes only in a trailing data descriptor
 * that a local-header walk cannot see.
 */
export function readZipEntries(zip: Uint8Array): ZipEntry[] {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const eocd = findEocd(view, zip.length);

  const count = view.getUint16(eocd + 10, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (cdOffset === ZIP64_MARKER) throw new Error("ZIP64 archives are not supported");
  if (cdOffset > zip.length) throw new Error("zip central directory offset is out of range");

  const entries: ZipEntry[] = [];
  let at = cdOffset;
  for (let i = 0; i < count; i++) {
    if (at + 46 > zip.length || view.getUint32(at, true) !== CD_SIG) {
      throw new Error(`zip central directory entry ${i} is malformed`);
    }
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const compressedSize = view.getUint32(at + 20, true);
    const uncompressedSize = view.getUint32(at + 24, true);
    const nameLen = view.getUint16(at + 28, true);
    const extraLen = view.getUint16(at + 30, true);
    const commentLen = view.getUint16(at + 32, true);
    const localOffset = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(zip.subarray(at + 46, at + 46 + nameLen));
    at += 46 + nameLen + extraLen + commentLen;

    if (
      compressedSize === ZIP64_MARKER ||
      uncompressedSize === ZIP64_MARKER ||
      localOffset === ZIP64_MARKER
    ) {
      throw new Error(`ZIP64 archives are not supported (entry ${name})`);
    }
    // Directories carry no data; the extractor creates parents as it goes.
    if (name.endsWith("/")) continue;

    if (localOffset + 30 > zip.length || view.getUint32(localOffset, true) !== LOCAL_SIG) {
      throw new Error(`zip entry ${name} has a malformed local header`);
    }
    // The local extra field is allowed to differ in length from the central
    // one, so it must be read here rather than reused from above.
    const localNameLen = view.getUint16(localOffset + 26, true);
    const localExtraLen = view.getUint16(localOffset + 28, true);
    const start = localOffset + 30 + localNameLen + localExtraLen;
    const end = start + compressedSize;
    if (end > zip.length) throw new Error(`zip entry ${name} runs past the end of the archive`);
    const raw = zip.subarray(start, end);

    let data: Uint8Array;
    if (method === 0) {
      data = raw;
    } else if (method === 8) {
      // ZIP stores bare deflate streams with no zlib wrapper, which is exactly
      // what Bun.inflateSync consumes.
      data = Bun.inflateSync(raw);
    } else {
      throw new Error(`zip entry ${name} uses unsupported compression method ${method}`);
    }

    if (data.length !== uncompressedSize) {
      throw new Error(
        `zip entry ${name} decompressed to ${data.length} bytes, expected ${uncompressedSize}`,
      );
    }
    if ((Bun.hash.crc32(data) >>> 0) !== crc >>> 0) {
      throw new Error(`zip entry ${name} failed its CRC-32 check`);
    }
    entries.push({ name, data });
  }
  return entries;
}

function findEocd(view: DataView, length: number): number {
  // The end-of-central-directory record is last, but a trailing comment of up
  // to 64 KiB may follow it, so scan backwards for the signature.
  const min = Math.max(0, length - 22 - 0xffff);
  for (let i = length - 22; i >= min; i--) {
    if (view.getUint32(i, true) === EOCD_SIG) return i;
  }
  throw new Error("not a zip archive: no end-of-central-directory record");
}

/**
 * Write every entry of a ZIP under `dir`.
 *
 * Entry names come from an untrusted archive, so each one is resolved and
 * checked to still be inside `dir`. Without that check a name like
 * `../../.bashrc` — or an absolute path — would let a downloaded extension
 * write anywhere the shell can write ("zip slip"). Refusing is the only safe
 * answer: sanitising the name silently would install something other than what
 * the archive described.
 */
export function extractZipTo(zip: Uint8Array, dir: string): string[] {
  const root = resolve(dir);
  const written: string[] = [];
  for (const entry of readZipEntries(zip)) {
    const target = safeJoin(root, entry.name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, entry.data);
    written.push(target);
  }
  return written;
}

/** Resolve `name` under `root`, throwing if it escapes. Exported for testing. */
export function safeJoin(root: string, name: string): string {
  if (name.includes("\0")) throw new Error(`unsafe zip entry name: ${JSON.stringify(name)}`);
  const target = resolve(join(root, name));
  const rel = relative(root, target);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || resolve(rel) === rel) {
    throw new Error(`zip entry escapes the target directory: ${JSON.stringify(name)}`);
  }
  return target;
}
