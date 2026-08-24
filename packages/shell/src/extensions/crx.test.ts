// SPDX-License-Identifier: MIT OR Apache-2.0
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test } from "bun:test";
import { extractZipTo, parseCrx, readZipEntries, safeJoin } from "./crx";

/**
 * Archives are built here rather than checked in as fixtures: the point of the
 * tests is the byte layout, and a binary fixture hides exactly the thing under
 * test.
 */

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "bunsen-crx-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface File {
  name: string;
  content: string | Uint8Array;
  deflate?: boolean;
}

function makeZip(files: File[]): Uint8Array {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const file of files) {
    const name = encoder.encode(file.name);
    const data =
      typeof file.content === "string" ? encoder.encode(file.content) : file.content;
    const compressed = file.deflate ? Bun.deflateSync(data) : data;
    const method = file.deflate ? 8 : 0;
    const crc = Bun.hash.crc32(data) >>> 0;

    const local = new Uint8Array(30 + name.length + compressed.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(8, method, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, compressed.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(compressed, 30 + name.length);
    locals.push(local);

    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(10, method, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, compressed.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    centrals.push(central);

    offset += local.length;
  }

  const cdSize = centrals.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);

  return concat([...locals, ...centrals, eocd]);
}

/** A CrxFileHeader carrying only signed_header_data { crx_id }. */
function makeCrxHeader(crxId: string | null): Uint8Array {
  // Field 2 (sha256_with_rsa) stands in for the proofs a real header carries,
  // so that a header without an id is still a non-empty header.
  if (crxId === null) return new Uint8Array([0x12, 0x02, 0x00, 0x00]);
  const raw = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    raw[i] = ((crxId.charCodeAt(i * 2) - 97) << 4) | (crxId.charCodeAt(i * 2 + 1) - 97);
  }
  // SignedData { bytes crx_id = 1 }
  const signed = concat([new Uint8Array([0x0a, raw.length]), raw]);
  // CrxFileHeader { bytes signed_header_data = 10000 } -> key 10000<<3|2 = 80002
  return concat([varint(80002), varint(signed.length), signed]);
}

function makeCrx(
  zip: Uint8Array,
  opts: { crxId?: string | null; magic?: string; version?: number } = {},
): Uint8Array {
  const header = makeCrxHeader(opts.crxId ?? null);
  const prefix = new Uint8Array(12);
  prefix.set(new TextEncoder().encode(opts.magic ?? "Cr24"), 0);
  const pv = new DataView(prefix.buffer);
  pv.setUint32(4, opts.version ?? 3, true);
  pv.setUint32(8, header.length, true);
  return concat([prefix, header, zip]);
}

function varint(n: number): Uint8Array {
  const out: number[] = [];
  let v = n;
  while (v >= 128) {
    out.push((v % 128) + 128);
    v = Math.floor(v / 128);
  }
  out.push(v);
  return new Uint8Array(out);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const ID = "a".repeat(32);

test("a valid CRX3 yields its zip payload and id", () => {
  const zip = makeZip([{ name: "manifest.json", content: "{}" }]);
  const crx = makeCrx(zip, { crxId: ID });
  const parsed = parseCrx(crx);
  expect(parsed.crxId).toBe(ID);
  expect([...parsed.zip]).toEqual([...zip]);
});

test("an id-shaped header with mixed nibbles round trips", () => {
  const id = "abcdefghijklmnopabcdefghijklmnop";
  const parsed = parseCrx(makeCrx(makeZip([{ name: "a", content: "x" }]), { crxId: id }));
  expect(parsed.crxId).toBe(id);
});

test("a header without signed data leaves the id null", () => {
  const parsed = parseCrx(makeCrx(makeZip([{ name: "a", content: "x" }])));
  expect(parsed.crxId).toBeNull();
});

test("bad magic is rejected", () => {
  const crx = makeCrx(makeZip([{ name: "a", content: "x" }]), { magic: "Cr99" });
  expect(() => parseCrx(crx)).toThrow(/Cr24/);
});

test("CRX2 is rejected rather than half-parsed", () => {
  const crx = makeCrx(makeZip([{ name: "a", content: "x" }]), { version: 2 });
  expect(() => parseCrx(crx)).toThrow(/version 2/);
});

test("a truncated file is rejected", () => {
  expect(() => parseCrx(new Uint8Array([0x43, 0x72, 0x32, 0x34]))).toThrow(/not a CRX/);
});

test("a header longer than the file is rejected", () => {
  const crx = makeCrx(makeZip([{ name: "a", content: "x" }]), { crxId: ID });
  new DataView(crx.buffer).setUint32(8, 1_000_000, true);
  expect(() => parseCrx(crx)).toThrow(/does not fit/);
});

test("stored and deflated entries both read back", () => {
  const big = "x".repeat(5000);
  const zip = makeZip([
    { name: "stored.txt", content: "plain" },
    { name: "packed.txt", content: big, deflate: true },
  ]);
  const entries = readZipEntries(zip);
  expect(entries.map((e) => e.name)).toEqual(["stored.txt", "packed.txt"]);
  expect(new TextDecoder().decode(entries[1]!.data)).toBe(big);
});

test("a corrupted entry fails its CRC check", () => {
  const zip = makeZip([{ name: "a.txt", content: "hello" }]);
  zip[30 + "a.txt".length] = 0x00;
  expect(() => readZipEntries(zip)).toThrow(/CRC-32/);
});

test("a non-zip is rejected", () => {
  expect(() => readZipEntries(new TextEncoder().encode("not a zip at all"))).toThrow(
    /not a zip archive/,
  );
});

test("nested paths are extracted", () => {
  const dir = tmp();
  extractZipTo(makeZip([{ name: "js/deep/x.js", content: "1" }]), dir);
  expect(readFileSync(join(dir, "js/deep/x.js"), "utf8")).toBe("1");
});

test("zip slip is refused and nothing is written outside the target", () => {
  const dir = tmp();
  const outside = join(dir, "outside.txt");
  const zip = makeZip([{ name: "../outside.txt", content: "pwned" }]);
  expect(() => extractZipTo(makeZip([{ name: "../outside.txt", content: "x" }]), join(dir, "in")))
    .toThrow(/escapes the target directory/);
  expect(() => readZipEntries(zip)).not.toThrow();
  expect(existsSync(outside)).toBe(false);
});

test("safeJoin refuses escapes in every shape", () => {
  const root = "/tmp/bunsen-root";
  expect(() => safeJoin(root, "../x")).toThrow();
  expect(() => safeJoin(root, "a/../../x")).toThrow();
  expect(() => safeJoin(root, "a/b/../../../x")).toThrow();
  expect(() => safeJoin(root, "a\0b")).toThrow();
  expect(safeJoin(root, "a/b.js")).toBe("/tmp/bunsen-root/a/b.js");
  // An absolute name is joined under the root, not honoured as absolute.
  expect(safeJoin(root, "/etc/passwd")).toBe("/tmp/bunsen-root/etc/passwd");
});
