// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * `browser.storage` backed by SQLite.
 *
 * One database for every extension, one row per key, partitioned by extension
 * id and area. Partitioning by id in the schema rather than by giving each
 * extension its own file means a misbehaving extension cannot reach another's
 * keys even if the id it reports is wrong — the id comes from the loader, not
 * from the extension.
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export type Area = "local" | "session" | "sync";

/** Chrome's per-extension local quota. Worth enforcing from the start. */
export const LOCAL_QUOTA_BYTES = 10 * 1024 * 1024;

export class ExtensionStorage {
  #db: Database;
  /** `session` is explicitly not persisted, so it lives here. */
  #session = new Map<string, Map<string, string>>();

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(join(path, ".."), { recursive: true });
    this.#db = new Database(path, { create: true });
    this.#db.exec("PRAGMA journal_mode = WAL");
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS items (
        extension TEXT NOT NULL,
        area      TEXT NOT NULL,
        key       TEXT NOT NULL,
        value     TEXT NOT NULL,
        PRIMARY KEY (extension, area, key)
      );
    `);
  }

  get(extension: string, area: Area, keys: string[] | null): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (area === "session") {
      const bucket = this.#session.get(extension);
      if (!bucket) return out;
      for (const [k, v] of bucket) {
        if (keys === null || keys.includes(k)) out[k] = JSON.parse(v);
      }
      return out;
    }

    const rows = this.#db
      .query<{ key: string; value: string }, any>(
        `SELECT key, value FROM items WHERE extension = $e AND area = $a`,
      )
      .all({ $e: extension, $a: persistedArea(area) });
    for (const row of rows) {
      if (keys === null || keys.includes(row.key)) out[row.key] = JSON.parse(row.value);
    }
    return out;
  }

  set(extension: string, area: Area, items: Record<string, unknown>): void {
    if (area === "session") {
      const bucket = this.#session.get(extension) ?? new Map();
      for (const [k, v] of Object.entries(items)) bucket.set(k, JSON.stringify(v));
      this.#session.set(extension, bucket);
      return;
    }

    const stored = persistedArea(area);
    const write = this.#db.query(
      `INSERT INTO items (extension, area, key, value) VALUES ($e, $a, $k, $v)
       ON CONFLICT(extension, area, key) DO UPDATE SET value = $v`,
    );
    // One transaction: a partial write would leave the extension's view of
    // its own state inconsistent.
    this.#db.transaction(() => {
      for (const [key, value] of Object.entries(items)) {
        const encoded = JSON.stringify(value ?? null);
        write.run({ $e: extension, $a: stored, $k: key, $v: encoded });
      }
      const used = this.bytesInUse(extension, area);
      if (used > LOCAL_QUOTA_BYTES) {
        throw new Error(`storage quota exceeded: ${used} > ${LOCAL_QUOTA_BYTES} bytes`);
      }
    })();
  }

  remove(extension: string, area: Area, keys: string[]): void {
    if (area === "session") {
      const bucket = this.#session.get(extension);
      for (const k of keys) bucket?.delete(k);
      return;
    }
    const del = this.#db.query(
      `DELETE FROM items WHERE extension = $e AND area = $a AND key = $k`,
    );
    this.#db.transaction(() => {
      for (const key of keys) del.run({ $e: extension, $a: persistedArea(area), $k: key });
    })();
  }

  clear(extension: string, area: Area): void {
    if (area === "session") {
      this.#session.delete(extension);
      return;
    }
    this.#db
      .query(`DELETE FROM items WHERE extension = $e AND area = $a`)
      .run({ $e: extension, $a: persistedArea(area) });
  }

  bytesInUse(extension: string, area: Area): number {
    if (area === "session") {
      let total = 0;
      for (const [k, v] of this.#session.get(extension) ?? []) total += k.length + v.length;
      return total;
    }
    const row = this.#db
      .query<{ n: number }, any>(
        `SELECT COALESCE(SUM(LENGTH(key) + LENGTH(value)), 0) AS n
           FROM items WHERE extension = $e AND area = $a`,
      )
      .get({ $e: extension, $a: persistedArea(area) });
    return row?.n ?? 0;
  }

  close(): void {
    this.#db.close();
  }
}

/** `sync` has nowhere to sync to, so it is local that says it is sync. */
function persistedArea(area: Area): string {
  return area === "sync" ? "sync" : "local";
}
