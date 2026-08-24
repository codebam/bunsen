// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * Installing extensions from the Chrome Web Store.
 *
 * registry.ts loads extensions from directories and says outright that
 * fetching from a store is somebody else's problem. This is that somebody:
 * it turns a store URL into an id, an id into a CRX download, and a CRX into
 * the unpacked directory the loader already understands. Nothing here touches
 * the host — install and load stay separate so a failed download can never
 * leave a half-registered extension behind.
 *
 * The download endpoint is Google's own update service, the same one Chrome
 * uses. It is not a documented public API, so it can change; when it does the
 * failure is a clear error here rather than a mystery elsewhere.
 *
 * Note that installs are only as trustworthy as the transport: parseCrx does
 * not verify the CRX signature (see crx.ts), so authenticity rests on TLS to
 * clients2.google.com.
 */

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

import { extractZipTo, parseCrx } from "./crx";
import { parseManifest } from "./manifest";

/**
 * Version claimed to the update service.
 *
 * This is not cosmetic. The service answers a version it considers too old
 * with `204 No Content` and an empty body rather than an error, so a stale
 * value here looks exactly like a corrupt download. Verified against the live
 * endpoint: 120 returns 204, 131 and above return the package.
 */
export const PRODVERSION = "131.0.0.0";

/** Store ids are 32 characters drawn from 'a'..'p'. */
const ID_RE = /^[a-p]{32}$/;

/**
 * Extract an extension id from a store URL, or from a bare id.
 *
 * Accepts the current chromewebstore.google.com/detail/<slug>/<id> layout, the
 * older chrome.google.com/webstore/detail/... form (with or without a slug),
 * and a plain id. Returns null rather than guessing when nothing matches.
 */
export function extensionIdFromUrl(url: string): string | null {
  const trimmed = url.trim();
  if (ID_RE.test(trimmed)) return trimmed;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  if (host !== "chromewebstore.google.com" && host !== "chrome.google.com") return null;

  // Both layouts end with the id; the slug in between is decorative and the
  // older form sometimes omits it entirely. Take the last id-shaped segment.
  const segments = parsed.pathname.split("/").filter((s) => s.length > 0);
  if (!segments.includes("detail")) return null;
  for (let i = segments.length - 1; i >= 0; i--) {
    if (ID_RE.test(segments[i]!)) return segments[i]!;
  }
  return null;
}

/** The CRX download endpoint for an id. Responds with a redirect to the file. */
export function downloadUrl(id: string): string {
  if (!ID_RE.test(id)) throw new Error(`not a Web Store extension id: ${JSON.stringify(id)}`);
  return (
    "https://clients2.google.com/service/update2/crx" +
    "?response=redirect&acceptformat=crx2,crx3" +
    `&prodversion=${PRODVERSION}&x=id%3D${id}%26uc`
  );
}

export interface Installed {
  id: string;
  /** Absolute path of the unpacked directory, ready for ExtensionHost.load. */
  path: string;
}

/**
 * Download an extension and unpack it into `intoDir/<id>/`.
 *
 * `idOrUrl` may be anything `extensionIdFromUrl` accepts.
 */
export async function install(idOrUrl: string, intoDir: string): Promise<Installed> {
  const id = extensionIdFromUrl(idOrUrl);
  if (!id) throw new Error(`could not find an extension id in ${JSON.stringify(idOrUrl)}`);

  const response = await fetch(downloadUrl(id), { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`downloading ${id} failed: HTTP ${response.status} ${response.statusText}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  // 204, or any empty 2xx, is how the service declines: no such extension, or
  // a prodversion it will not serve. Saying so beats letting the CRX parser
  // report "not a CRX file: 0 bytes" for what is really a refusal.
  if (bytes.length === 0) {
    throw new Error(
      `the store returned no package for ${id} (HTTP ${response.status}); ` +
        `it may not exist, or PRODVERSION ${PRODVERSION} may no longer be accepted`,
    );
  }
  return installFromCrx(bytes, id, intoDir);
}

/**
 * Unpack CRX bytes that are already in hand.
 *
 * Split out from `install` so the unpacking half is exercisable without the
 * network, and so a locally downloaded .crx can be installed the same way.
 */
export function installFromCrx(bytes: Uint8Array, id: string, intoDir: string): Installed {
  const target = resolve(join(intoDir, id));
  if (existsSync(target)) {
    // Overwriting in place would leave a mix of two versions if it failed
    // partway. Removing the old install is the caller's decision to make.
    throw new Error(`${target} already exists; remove it before reinstalling`);
  }

  try {
    const { zip, crxId } = parseCrx(bytes);
    if (crxId !== null && crxId !== id) {
      throw new Error(`CRX is for extension ${crxId}, expected ${id}`);
    }

    mkdirSync(target, { recursive: true });
    extractZipTo(zip, target);

    // Check now rather than at load time: an archive that unpacks but is not a
    // usable extension should not be left on disk looking installed.
    const manifestPath = join(target, "manifest.json");
    if (!existsSync(manifestPath)) throw new Error("CRX contains no manifest.json");
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch (err) {
      throw new Error(`manifest.json is not valid JSON: ${err}`);
    }
    const { manifest, errors } = parseManifest(raw, id);
    if (!manifest) throw new Error(`manifest.json is not usable: ${errors.join("; ")}`);

    return { id, path: target };
  } catch (err) {
    // Anything left behind would be picked up by ExtensionHost.loadAll as a
    // broken extension, so a failed install must leave nothing.
    rmSync(target, { recursive: true, force: true });
    throw err;
  }
}

