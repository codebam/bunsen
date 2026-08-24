// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * Session persistence: the open tabs, so a restart puts the window back.
 *
 * JSON on disk rather than SQLite, unlike history and bookmarks, because the
 * access pattern is the opposite one. A session is written whole and read
 * whole, exactly once per start, and is never queried, ranged over or joined.
 * SQLite buys indexes and partial updates that nothing here would use, and
 * costs a schema and a second file (the WAL) to keep in sync. One small
 * document, replaced atomically, is the honest shape of this data.
 *
 * The overriding rule: a bad session file must never stop the browser
 * starting. Every failure path here degrades to "no tabs restored".
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface SessionTab {
  url: string;
  title: string;
  active: boolean;
}

/**
 * Restoring hundreds of tabs would spawn hundreds of web views at once and
 * make the browser appear hung on the very launch that is meant to recover
 * it. Anyone past this many has tabs they are hoarding, not reading.
 */
const MAX_TABS = 100;

/**
 * Writes coalesce over this window. Tab churn arrives in bursts — restoring a
 * window, closing ten tabs, a load settling a title — and each burst only
 * needs its final state on disk. Small enough that a crash loses nothing a
 * user would notice.
 */
const DEBOUNCE_MS = 250;

export class Session {
  #path: string;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #pending: SessionTab[] | null = null;

  constructor(path: string) {
    this.#path = path;
    try {
      mkdirSync(join(path, ".."), { recursive: true });
    } catch {
      // A read-only or missing profile dir costs session restore, nothing more.
    }
  }

  /** Cheap by design: callable from every tab event, it only arms a timer. */
  save(tabs: SessionTab[]): void {
    this.#pending = tabs.filter((t) => restorable(t.url)).slice(0, MAX_TABS).map(clean);
    if (this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#write();
    }, DEBOUNCE_MS);
    // Never hold the process open for a session write; on the last tick before
    // exit, flush() is the path that matters.
    this.#timer.unref?.();
  }

  /** Write any debounced state immediately — call before a clean shutdown. */
  flush(): void {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    this.#write();
  }

  /** [] whenever the file is missing, empty, corrupt or not the shape expected. */
  restore(): SessionTab[] {
    let raw: string;
    try {
      // Sync on purpose: this runs once, before the first window exists, and
      // the rest of startup has nothing useful to do without its tab list.
      raw = readFileSync(this.#path, "utf8");
    } catch {
      return [];
    }
    if (!raw.trim()) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
    const list = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as { tabs?: unknown })?.tabs)
        ? (parsed as { tabs: unknown[] }).tabs
        : null;
    if (!list) return [];

    const tabs: SessionTab[] = [];
    for (const item of list) {
      // Field-by-field, because a file that is valid JSON still proves nothing
      // about its contents — it may be someone else's document entirely.
      if (!item || typeof item !== "object") continue;
      const { url, title, active } = item as Record<string, unknown>;
      if (typeof url !== "string" || !restorable(url)) continue;
      tabs.push({
        url,
        title: typeof title === "string" ? title : "",
        active: active === true,
      });
      if (tabs.length === MAX_TABS) break;
    }
    // Exactly one tab must end up focused; a file claiming zero or five is
    // still usable, so fix it rather than discarding the session.
    if (tabs.length && !tabs.some((t) => t.active)) tabs[0].active = true;
    let seen = false;
    for (const t of tabs) {
      if (t.active && seen) t.active = false;
      else if (t.active) seen = true;
    }
    return tabs;
  }

  /** Forget the saved session, e.g. after the user closes the window cleanly. */
  clear(): void {
    this.#pending = null;
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    try {
      unlinkSync(this.#path);
    } catch {
      // Nothing saved yet: already the state we wanted.
    }
  }

  #write(): void {
    if (this.#pending === null) return;
    const body = JSON.stringify({ version: 1, savedAt: Date.now(), tabs: this.#pending });
    this.#pending = null;
    // Write-then-rename, so a crash mid-write leaves the previous session
    // intact instead of a truncated file we would have to throw away.
    const tmp = `${this.#path}.tmp`;
    try {
      writeFileSync(tmp, body);
      renameSync(tmp, this.#path);
    } catch {
      try {
        unlinkSync(tmp);
      } catch {
        // Best effort; a stray tmp file is harmless and gets overwritten.
      }
    }
  }
}

/**
 * Only real pages come back. Restoring `about:blank`, `chrome://` panels or
 * `file://` paths that may no longer exist reproduces clutter, not work.
 */
function restorable(url: unknown): url is string {
  return typeof url === "string" && /^https?:\/\/./.test(url);
}

function clean(t: SessionTab): SessionTab {
  return { url: t.url, title: typeof t.title === "string" ? t.title : "", active: t.active === true };
}

export function defaultSessionPath(): string {
  const base = Bun.env.XDG_DATA_HOME ?? join(Bun.env.HOME ?? ".", ".local", "share");
  return join(base, "bunsen", "session.json");
}
