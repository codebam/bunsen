// SPDX-License-Identifier: MIT OR Apache-2.0
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test } from "bun:test";
import { downloadUrl, extensionIdFromUrl, install, installFromCrx, PRODVERSION } from "./webstore";

/**
 * No network: every CRX here is assembled from bytes in-process. The builders
 * are duplicated from crx.test.ts on purpose — importing one test file from
 * another makes bun:test register the imported file's tests twice.
 */

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "bunsen-webstore-"));
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

const ID = "abcdefghijklmnopabcdefghijklmnop";

const MANIFEST = JSON.stringify({
  manifest_version: 3,
  name: "Test Extension",
  version: "1.2.3",
  permissions: ["storage"],
  background: { service_worker: "bg.js", type: "module" },
});

test("a bare id is accepted as-is", () => {
  expect(extensionIdFromUrl(ID)).toBe(ID);
  expect(extensionIdFromUrl(`  ${ID}\n`)).toBe(ID);
});

test("ids are pulled out of every store URL form", () => {
  expect(extensionIdFromUrl(`https://chromewebstore.google.com/detail/some-slug/${ID}`)).toBe(ID);
  expect(
    extensionIdFromUrl(`https://chromewebstore.google.com/detail/some-slug/${ID}?hl=en`),
  ).toBe(ID);
  expect(extensionIdFromUrl(`https://chrome.google.com/webstore/detail/slug/${ID}`)).toBe(ID);
  expect(extensionIdFromUrl(`https://chrome.google.com/webstore/detail/${ID}`)).toBe(ID);
  expect(extensionIdFromUrl(`https://chrome.google.com/webstore/detail/slug/${ID}/related`)).toBe(
    ID,
  );
});

test("anything that is not an id returns null instead of a guess", () => {
  expect(extensionIdFromUrl("")).toBeNull();
  expect(extensionIdFromUrl("z".repeat(32))).toBeNull(); // 'z' is outside a-p
  expect(extensionIdFromUrl("a".repeat(31))).toBeNull();
  expect(extensionIdFromUrl(`https://evil.example.com/detail/slug/${ID}`)).toBeNull();
  expect(extensionIdFromUrl("https://chromewebstore.google.com/category/extensions")).toBeNull();
});

test("the download url is the official update2 endpoint", () => {
  expect(downloadUrl(ID)).toBe(
    "https://clients2.google.com/service/update2/crx?response=redirect" +
      `&acceptformat=crx2,crx3&prodversion=${PRODVERSION}&x=id%3D${ID}%26uc`,
  );
  expect(() => downloadUrl("nope")).toThrow(/not a Web Store extension id/);
});

test("a synthetic CRX installs into a directory the loader can read", () => {
  const dir = tmp();
  const crx = makeCrx(
    makeZip([
      { name: "manifest.json", content: MANIFEST },
      { name: "bg.js", content: "console.log(1)", deflate: true },
      { name: "icons/16.png", content: new Uint8Array([1, 2, 3]) },
    ]),
    { crxId: ID },
  );

  const result = installFromCrx(crx, ID, dir);
  expect(result.id).toBe(ID);
  expect(result.path).toBe(join(dir, ID));
  expect(JSON.parse(readFileSync(join(result.path, "manifest.json"), "utf8")).name).toBe(
    "Test Extension",
  );
  expect(readFileSync(join(result.path, "bg.js"), "utf8")).toBe("console.log(1)");
  expect([...readFileSync(join(result.path, "icons/16.png"))]).toEqual([1, 2, 3]);
});

test("a CRX for a different id is refused", () => {
  const dir = tmp();
  const crx = makeCrx(makeZip([{ name: "manifest.json", content: MANIFEST }]), { crxId: ID });
  expect(() => installFromCrx(crx, "b".repeat(32), dir)).toThrow(/is for extension/);
});

test("installing over an existing directory is refused", () => {
  const dir = tmp();
  const crx = makeCrx(makeZip([{ name: "manifest.json", content: MANIFEST }]), { crxId: ID });
  installFromCrx(crx, ID, dir);
  expect(() => installFromCrx(crx, ID, dir)).toThrow(/already exists/);
  // The refusal must not have destroyed the install it refused to replace.
  expect(existsSync(join(dir, ID, "manifest.json"))).toBe(true);
});

test("a CRX without a manifest leaves nothing behind", () => {
  const dir = tmp();
  const crx = makeCrx(makeZip([{ name: "bg.js", content: "1" }]), { crxId: ID });
  expect(() => installFromCrx(crx, ID, dir)).toThrow(/no manifest.json/);
  expect(existsSync(join(dir, ID))).toBe(false);
});

test("an unusable manifest leaves nothing behind", () => {
  const dir = tmp();
  const mv2 = JSON.stringify({ manifest_version: 2, name: "Old", version: "1" });
  const crx = makeCrx(makeZip([{ name: "manifest.json", content: mv2 }]), { crxId: ID });
  expect(() => installFromCrx(crx, ID, dir)).toThrow(/manifest_version/);
  expect(existsSync(join(dir, ID))).toBe(false);
});

test("unparsable manifest json leaves nothing behind", () => {
  const dir = tmp();
  const crx = makeCrx(makeZip([{ name: "manifest.json", content: "{" }]), { crxId: ID });
  expect(() => installFromCrx(crx, ID, dir)).toThrow(/not valid JSON/);
  expect(existsSync(join(dir, ID))).toBe(false);
});

test("a zip-slip entry aborts the install and writes nothing outside it", () => {
  const dir = tmp();
  const crx = makeCrx(
    makeZip([
      { name: "manifest.json", content: MANIFEST },
      { name: "../../pwned.txt", content: "pwned" },
    ]),
    { crxId: ID },
  );
  expect(() => installFromCrx(crx, ID, dir)).toThrow(/escapes the target directory/);
  expect(existsSync(join(dir, ID))).toBe(false);
  expect(existsSync(join(dir, "..", "pwned.txt"))).toBe(false);
});

test("a corrupt CRX leaves nothing behind", () => {
  const dir = tmp();
  expect(() => installFromCrx(new TextEncoder().encode("garbage!!"), ID, dir)).toThrow();
  expect(existsSync(join(dir, ID))).toBe(false);
});

test("install rejects input with no id in it before touching the network", async () => {
  await expect(install("https://example.com/not-a-store", tmp())).rejects.toThrow(
    /could not find an extension id/,
  );
});

test.skipIf(!process.env.BUNSEN_NETWORK_TESTS)(
  "a real extension downloads and installs from the Web Store",
  async () => {
    // uBlock Origin Lite, MV3 and small enough to fetch in a test.
    const result = await install("ddkjiahejlhfcafbddmgiahcphecmpfh", tmp());
    expect(existsSync(join(result.path, "manifest.json"))).toBe(true);
  },
  30_000,
);
