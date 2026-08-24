// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * Bookmarks, on SQLite, in the profile alongside history.
 *
 * Deliberately flat — no folders, no tags. A URL is either saved or it is
 * not, which is what the chrome bar's one button can express. Folders can be
 * added when there is a UI that could show them; inventing a hierarchy nobody
 * can see would be storage for its own sake.
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export interface Bookmark {
  url: string;
  title: string;
  addedAt: number;
}

export class Bookmarks {
  #db: Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(join(path, ".."), { recursive: true });
    this.#db = new Database(path, { create: true });
    this.#db.exec("PRAGMA journal_mode = WAL");
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS bookmarks (
        url      TEXT PRIMARY KEY,
        title    TEXT NOT NULL DEFAULT '',
        added_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS bookmarks_recent ON bookmarks(added_at DESC);
    `);
  }

  /** Idempotent: bookmarking twice updates the title rather than erroring. */
  add(url: string, title: string): void {
    if (!/^https?:/.test(url)) return;
    this.#db
      .query(
        `INSERT INTO bookmarks (url, title, added_at) VALUES ($url, $title, $now)
         ON CONFLICT(url) DO UPDATE SET
           title = CASE WHEN $title <> '' THEN $title ELSE bookmarks.title END`,
      )
      .run({ $url: url, $title: title, $now: Date.now() });
  }

  remove(url: string): void {
    this.#db.query(`DELETE FROM bookmarks WHERE url = $url`).run({ $url: url });
  }

  has(url: string): boolean {
    return (
      this.#db
        .query<{ n: number }, any>(`SELECT COUNT(*) AS n FROM bookmarks WHERE url = $url`)
        .get({ $url: url })?.n === 1
    );
  }

  /** Toggling is what a single star button actually does. */
  toggle(url: string, title: string): boolean {
    if (this.has(url)) {
      this.remove(url);
      return false;
    }
    this.add(url, title);
    return this.has(url);
  }

  all(limit = 200): Bookmark[] {
    return this.#db
      .query<Bookmark, any>(
        `SELECT url, title, added_at AS addedAt FROM bookmarks
          ORDER BY added_at DESC LIMIT $limit`,
      )
      .all({ $limit: limit });
  }

  close(): void {
    this.#db.close();
  }
}
