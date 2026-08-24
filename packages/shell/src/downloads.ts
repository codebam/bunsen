// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * Downloads: fetch a URL to disk, with a record of it in SQLite.
 *
 * The record list lives in the same kind of store as history and bookmarks
 * because it is the same kind of data — a long, append-mostly log the user
 * scrolls and searches, which outlives the process that made it. Live
 * progress deliberately does *not* go through SQLite: a write per chunk would
 * be thousands of transactions for one file, so bytes are counted in memory
 * and flushed to the row when the transfer settles.
 *
 * The body is streamed chunk by chunk into a FileSink. A browser is expected
 * to survive downloading something larger than RAM, so the response is never
 * materialised as a Blob or ArrayBuffer.
 */

import { Database } from "bun:sqlite";
import { mkdirSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";

export type DownloadState = "pending" | "complete" | "failed" | "cancelled";

export interface Download {
  id: number;
  url: string;
  /** Absolute path actually written, collision suffix included. */
  path: string;
  filename: string;
  state: DownloadState;
  received: number;
  /** Content-Length when the server sent one, else null — it often lies or is absent. */
  total: number | null;
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
}

export interface StartOptions {
  directory?: string;
  filename?: string;
}

/**
 * Progress is an EventTarget rather than a per-download callback so the chrome
 * UI can subscribe once, for every download, and re-render from the event —
 * which is how the downloads shelf actually consumes this.
 */
export type DownloadEvent = CustomEvent<Download>;

export class Downloads extends EventTarget {
  #db: Database;
  #dir: string;
  /** Live rows for in-flight transfers; the DB row lags until they settle. */
  #live = new Map<number, Download>();
  #aborts = new Map<number, AbortController>();
  #settled = new Map<number, Promise<Download>>();
  #closed = false;

  constructor(path: string, directory?: string) {
    super();
    if (path !== ":memory:") mkdirSync(join(path, ".."), { recursive: true });
    this.#db = new Database(path, { create: true });
    this.#db.exec("PRAGMA journal_mode = WAL");
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS downloads (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        url         TEXT NOT NULL,
        path        TEXT NOT NULL,
        filename    TEXT NOT NULL,
        state       TEXT NOT NULL,
        received    INTEGER NOT NULL DEFAULT 0,
        total       INTEGER,
        started_at  INTEGER NOT NULL,
        finished_at INTEGER,
        error       TEXT
      );
      CREATE INDEX IF NOT EXISTS downloads_recent ON downloads(started_at DESC);
    `);
    this.#dir = directory ?? defaultDirectory();

    // Anything left "pending" belongs to a process that is gone; its partial
    // file will never grow again, so it is a failure, not a live transfer.
    this.#db
      .query(
        `UPDATE downloads SET state = 'failed', error = 'interrupted'
          WHERE state = 'pending'`,
      )
      .run();
  }

  /**
   * Resolves once the response headers are in and the destination is claimed,
   * *not* when the file is complete — the caller needs an id it can cancel
   * while the body is still arriving. Await `settled(id)` for the end state.
   */
  async start(url: string, opts: StartOptions = {}): Promise<Download> {
    const dir = opts.directory ?? this.#dir;
    mkdirSync(dir, { recursive: true });

    const abort = new AbortController();
    let res: Response;
    try {
      res = await fetch(url, { signal: abort.signal, redirect: "follow" });
    } catch (e) {
      throw new Error(`download failed: ${(e as Error).message}`);
    }
    if (!res.ok) {
      // Record it anyway: a 404 the user asked for is history they will look
      // for when the file is not where they expected.
      // No path: nothing was written, and naming a file would imply otherwise.
      const rec = this.#insert(url, "", safeFilename(urlFilename(url)), null);
      this.#finish(rec, "failed", `HTTP ${res.status}`);
      throw new Error(`download failed: HTTP ${res.status}`);
    }

    const name = safeFilename(
      opts.filename ?? dispositionFilename(res.headers.get("content-disposition")) ?? urlFilename(url),
    );
    const path = await claimPath(dir, name);
    const len = Number(res.headers.get("content-length"));
    const total = Number.isFinite(len) && len > 0 ? len : null;

    const rec = this.#insert(url, path, basename(path), total);
    this.#live.set(rec.id, rec);
    this.#aborts.set(rec.id, abort);
    this.#settled.set(rec.id, this.#pump(rec, res));
    return { ...rec };
  }

  /** The end state of a transfer; resolves even when it failed or was cancelled. */
  settled(id: number): Promise<Download> {
    return this.#settled.get(id) ?? Promise.resolve(this.get(id) as Download);
  }

  /**
   * Aborts the in-flight fetch and unlinks the partial file. A half-written
   * file left on disk looks like a real one to every other program.
   */
  cancel(id: number): void {
    const abort = this.#aborts.get(id);
    const live = this.#live.get(id);
    if (!abort || !live) return;
    // Marked before aborting so #pump can tell a cancellation from a network
    // error when the read throws.
    live.state = "cancelled";
    abort.abort();
  }

  get(id: number): Download | undefined {
    const live = this.#live.get(id);
    if (live) return { ...live };
    return (
      this.#db
        .query<Row, any>(`${SELECT} WHERE id = $id`)
        .get({ $id: id }) as Download | null
    ) ?? undefined;
  }

  list(limit = 100): Download[] {
    const rows = this.#db
      .query<Row, any>(`${SELECT} ORDER BY started_at DESC, id DESC LIMIT $limit`)
      .all({ $limit: limit }) as Download[];
    // In-flight rows carry stale byte counts on disk; overlay the live ones.
    return rows.map((r) => (this.#live.has(r.id) ? { ...this.#live.get(r.id)! } : r));
  }

  close(): void {
    // Abort first, then refuse further writes: the pumps settle asynchronously
    // and would otherwise touch a closed handle. Their rows stay "pending",
    // which the next constructor turns into "interrupted" — accurate, since
    // that is exactly what happened to them.
    for (const id of [...this.#aborts.keys()]) this.cancel(id);
    this.#closed = true;
    this.#db.close();
  }

  async #pump(rec: Download, res: Response): Promise<Download> {
    const sink = Bun.file(rec.path).writer();
    try {
      // An explicit reader, one chunk at a time: the whole point is that the
      // body never exists in memory as a single buffer.
      const reader = res.body!.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        sink.write(value);
        rec.received += value.byteLength;
        this.dispatchEvent(new CustomEvent("progress", { detail: { ...rec } }));
      }
      await sink.end();
      this.#finish(rec, "complete", null);
    } catch (e) {
      try {
        // The sink may already be broken; closing it is best-effort cleanup.
        await sink.end();
      } catch {
        // Nothing to salvage — the partial file is unlinked below regardless.
      }
      const cancelled = rec.state === "cancelled";
      try {
        unlinkSync(rec.path);
      } catch {
        // Already gone, or never created; either way there is nothing to clean.
      }
      this.#finish(rec, cancelled ? "cancelled" : "failed", cancelled ? null : (e as Error).message);
    }
    return { ...rec };
  }

  #insert(url: string, path: string, filename: string, total: number | null): Download {
    const now = Date.now();
    const id = Number(
      this.#db
        .query<{ id: number }, any>(
          `INSERT INTO downloads (url, path, filename, state, received, total, started_at)
           VALUES ($url, $path, $filename, 'pending', 0, $total, $now)
           RETURNING id`,
        )
        .get({ $url: url, $path: path, $filename: filename, $total: total, $now: now })!.id,
    );
    return {
      id,
      url,
      path,
      filename,
      state: "pending",
      received: 0,
      total,
      startedAt: now,
      finishedAt: null,
      error: null,
    };
  }

  #finish(rec: Download, state: DownloadState, error: string | null): void {
    rec.state = state;
    rec.error = error;
    rec.finishedAt = Date.now();
    this.#live.delete(rec.id);
    this.#aborts.delete(rec.id);
    if (!this.#closed) {
      this.#db
        .query(
          `UPDATE downloads SET state = $state, received = $received,
                                finished_at = $at, error = $error
            WHERE id = $id`,
        )
        .run({
          $id: rec.id,
          $state: state,
          $received: rec.received,
          $at: rec.finishedAt,
          $error: error,
        });
    }
    this.dispatchEvent(new CustomEvent("end", { detail: { ...rec } }));
  }
}

type Row = Download;

const SELECT = `SELECT id, url, path, filename, state, received, total,
                       started_at AS startedAt, finished_at AS finishedAt, error
                  FROM downloads`;

/**
 * Security boundary. Everything feeding this — Content-Disposition, the URL
 * path — is chosen by the server, so a name is treated as hostile until it has
 * been reduced to a single, relative, non-traversing path component.
 */
export function safeFilename(raw: string | null | undefined): string {
  let name = (raw ?? "").trim();
  // Percent-encoding hides separators from a naive check ("%2e%2e%2f").
  try {
    name = decodeURIComponent(name);
  } catch {
    // Malformed escapes: keep the literal text rather than trusting a guess.
  }
  // Take the last component of *either* separator; a Windows-style path is
  // still a traversal attempt on a filesystem that treats "\" as a character.
  name = name.split(/[\\/]/).pop() ?? "";
  // Control characters and NUL truncate or confuse downstream consumers.
  name = name.replace(/[\x00-\x1f\x7f]/g, "");
  name = name.replace(/^\.+$/, "");
  if (!name || name === "." || name === "..") return "download";
  return name.slice(0, 200);
}

/** Prefers RFC 5987 `filename*` over `filename`, as the RFC requires. */
export function dispositionFilename(header: string | null): string | null {
  if (!header) return null;
  const ext = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(header);
  if (ext) {
    try {
      return decodeURIComponent(ext[1].trim());
    } catch {
      return ext[1].trim();
    }
  }
  const quoted = /filename\s*=\s*"((?:[^"\\]|\\.)*)"/.exec(header);
  if (quoted) return quoted[1].replace(/\\(.)/g, "$1");
  const bare = /filename\s*=\s*([^;]+)/.exec(header);
  return bare ? bare[1].trim() : null;
}

function urlFilename(url: string): string {
  try {
    const last = new URL(url).pathname.split("/").filter(Boolean).pop();
    return last ?? "download";
  } catch {
    return "download";
  }
}

/**
 * Picks a free name and creates the file immediately, so two downloads racing
 * for "photo.jpg" cannot both decide it is free and then overwrite each other.
 */
async function claimPath(dir: string, name: string): Promise<string> {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let n = 0; n < 10_000; n++) {
    const candidate = join(dir, n === 0 ? name : `${stem} (${n})${ext}`);
    if (await Bun.file(candidate).exists()) continue;
    await Bun.write(candidate, "");
    return candidate;
  }
  throw new Error(`no free filename for ${name} in ${dir}`);
}

function defaultDirectory(): string {
  return Bun.env.XDG_DOWNLOAD_DIR ?? join(Bun.env.HOME ?? ".", "Downloads");
}
