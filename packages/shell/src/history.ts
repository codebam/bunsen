// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * Browsing history, on bun:sqlite.
 *
 * A visit is recorded when a load finishes, not when navigation starts, so
 * redirects and failed loads don't accumulate junk entries.
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export interface HistoryEntry {
  url: string;
  title: string;
  visitedAt: number;
  visits: number;
}

export class History {
  #db: Database;

  constructor(path?: string) {
    const file = path ?? defaultPath();
    mkdirSync(join(file, ".."), { recursive: true });
    this.#db = new Database(file, { create: true });
    this.#db.exec("PRAGMA journal_mode = WAL");
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS visits (
        url        TEXT PRIMARY KEY,
        title      TEXT NOT NULL DEFAULT '',
        visited_at INTEGER NOT NULL,
        visits     INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS visits_recent ON visits(visited_at DESC);
    `);
  }

  record(url: string, title: string): void {
    if (!/^https?:/.test(url)) return;
    this.#db
      .query(
        `INSERT INTO visits (url, title, visited_at, visits)
         VALUES ($url, $title, $now, 1)
         ON CONFLICT(url) DO UPDATE SET
           title      = CASE WHEN $title <> '' THEN $title ELSE visits.title END,
           visited_at = $now,
           visits     = visits.visits + 1`,
      )
      .run({ $url: url, $title: title, $now: Date.now() });
  }

  /**
   * Correct the title of a page already recorded, without counting a second
   * visit. Engines settle the title whenever they like — WebKit usually after
   * the load finishes — and a visit is not a new visit just because its name
   * arrived late.
   */
  retitle(url: string, title: string): void {
    if (!title || !/^https?:/.test(url)) return;
    this.#db
      .query(`UPDATE visits SET title = $title WHERE url = $url`)
      .run({ $url: url, $title: title });
  }

  /** Prefix/substring match over url and title, most-visited first. */
  suggest(query: string, limit = 8): HistoryEntry[] {
    if (!query.trim()) return [];
    return this.#db
      .query<HistoryEntry, any>(
        `SELECT url, title, visited_at AS visitedAt, visits
           FROM visits
          WHERE url LIKE $q OR title LIKE $q
          ORDER BY visits DESC, visited_at DESC
          LIMIT $limit`,
      )
      .all({ $q: `%${query}%`, $limit: limit });
  }

  recent(limit = 50): HistoryEntry[] {
    return this.#db
      .query<HistoryEntry, any>(
        `SELECT url, title, visited_at AS visitedAt, visits
           FROM visits ORDER BY visited_at DESC LIMIT $limit`,
      )
      .all({ $limit: limit });
  }

  close(): void {
    this.#db.close();
  }
}

function defaultPath(): string {
  const base =
    Bun.env.XDG_DATA_HOME ?? join(Bun.env.HOME ?? ".", ".local", "share");
  return join(base, "bunsen", "history.db");
}
