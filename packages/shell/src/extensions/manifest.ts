// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * Manifest V3 parsing.
 *
 * Deliberately strict: an extension whose manifest we only half understand is
 * an extension whose permissions we only half understand. Anything unrecognised
 * is reported as a warning and dropped rather than passed through, and
 * anything structurally wrong is an error that stops the extension loading.
 */

import { MatchSet } from "./matching";

/** Permissions the shell can actually honour today. */
export const SUPPORTED_PERMISSIONS = [
  "storage",
  "tabs",
  "activeTab",
  "alarms",
  "declarativeNetRequest",
  "webNavigation",
] as const;

export type Permission = (typeof SUPPORTED_PERMISSIONS)[number];

export interface ContentScript {
  matches: MatchSet;
  js: string[];
  css: string[];
  runAt: "document_start" | "document_end" | "document_idle";
  allFrames: boolean;
}

export interface Manifest {
  id: string;
  name: string;
  version: string;
  description: string;
  permissions: Set<Permission>;
  hostPermissions: MatchSet;
  background: { serviceWorker: string; type: "module" | "classic" } | null;
  contentScripts: ContentScript[];
  action: { defaultPopup: string | null; defaultTitle: string | null } | null;
  optionsPage: string | null;
}

export interface ParseResult {
  manifest: Manifest | null;
  errors: string[];
  warnings: string[];
}

export function parseManifest(raw: unknown, fallbackId: string): ParseResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { manifest: null, errors: ["manifest.json is not an object"], warnings };
  }
  const m = raw as Record<string, unknown>;

  if (m.manifest_version !== 3) {
    errors.push(
      `unsupported manifest_version ${JSON.stringify(m.manifest_version)}; only 3 is supported`,
    );
  }
  const name = str(m.name);
  if (!name) errors.push("name is required");
  const version = str(m.version);
  if (!version) errors.push("version is required");

  const permissions = new Set<Permission>();
  for (const p of arr(m.permissions)) {
    if (typeof p !== "string") continue;
    if ((SUPPORTED_PERMISSIONS as readonly string[]).includes(p)) {
      permissions.add(p as Permission);
    } else {
      warnings.push(`permission not supported, ignoring: ${p}`);
    }
  }

  const hostPermissions = new MatchSet(arr(m.host_permissions).filter(isString));
  for (const bad of hostPermissions.invalid) {
    warnings.push(`invalid host permission, ignoring: ${bad}`);
  }

  let background: Manifest["background"] = null;
  if (m.background !== undefined) {
    const b = m.background as Record<string, unknown>;
    const worker = str(b?.service_worker);
    if (!worker) {
      // MV2's background.scripts is the most common thing to trip over.
      errors.push("background must declare a service_worker (MV3)");
    } else {
      background = { serviceWorker: worker, type: b.type === "module" ? "module" : "classic" };
    }
  }

  const contentScripts: ContentScript[] = [];
  for (const [i, entry] of arr(m.content_scripts).entries()) {
    const c = entry as Record<string, unknown>;
    const matches = new MatchSet(arr(c?.matches).filter(isString));
    for (const bad of matches.invalid) {
      warnings.push(`content_scripts[${i}]: invalid match pattern, ignoring: ${bad}`);
    }
    if (matches.size === 0) {
      warnings.push(`content_scripts[${i}]: no usable match patterns, ignoring entry`);
      continue;
    }
    const js = arr(c?.js).filter(isString);
    const css = arr(c?.css).filter(isString);
    if (js.length === 0 && css.length === 0) {
      warnings.push(`content_scripts[${i}]: nothing to inject, ignoring entry`);
      continue;
    }
    contentScripts.push({
      matches,
      js,
      css,
      runAt: runAt(c?.run_at),
      allFrames: c?.all_frames === true,
    });
  }

  const actionRaw = (m.action ?? null) as Record<string, unknown> | null;
  const action = actionRaw
    ? {
        defaultPopup: str(actionRaw.default_popup),
        defaultTitle: str(actionRaw.default_title),
      }
    : null;

  const optionsPage =
    str((m.options_page as string | undefined)) ??
    str((m.options_ui as Record<string, unknown> | undefined)?.page);

  if (errors.length > 0) return { manifest: null, errors, warnings };

  return {
    manifest: {
      id: str(m.id) ?? fallbackId,
      name: name!,
      version: version!,
      description: str(m.description) ?? "",
      permissions,
      hostPermissions,
      background,
      contentScripts,
      action,
      optionsPage,
    },
    errors,
    warnings,
  };
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function isString(v: unknown): v is string {
  return typeof v === "string";
}

function runAt(v: unknown): ContentScript["runAt"] {
  return v === "document_start" || v === "document_end" ? v : "document_idle";
}
