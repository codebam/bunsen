// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * Tab model. Owns the authoritative state the chrome UI renders; the backend
 * only reports what its views are doing.
 */

import type { TabId } from "./backend/types";

export interface Tab {
  id: TabId;
  url: string;
  title: string;
  loading: boolean;
  progress: number;
  canBack: boolean;
  canForward: boolean;
  favicon: string | null;
  error: string | null;
}

export class TabStore {
  #tabs = new Map<TabId, Tab>();
  #order: TabId[] = [];
  #active: TabId | null = null;
  #nextId = 1;

  create(url: string, opener?: TabId): Tab {
    const tab: Tab = {
      id: this.#nextId++,
      url,
      title: url || "New Tab",
      loading: false,
      progress: 0,
      canBack: false,
      canForward: false,
      favicon: null,
      error: null,
    };
    this.#tabs.set(tab.id, tab);
    const at = opener === undefined ? -1 : this.#order.indexOf(opener);
    if (at >= 0) this.#order.splice(at + 1, 0, tab.id);
    else this.#order.push(tab.id);
    if (this.#active === null) this.#active = tab.id;
    return tab;
  }

  /** Returns the tab that should become active, or null if none are left. */
  close(id: TabId): TabId | null {
    if (!this.#tabs.delete(id)) return this.#active;
    const i = this.#order.indexOf(id);
    if (i >= 0) this.#order.splice(i, 1);
    if (this.#active === id) {
      this.#active = this.#order[Math.min(i, this.#order.length - 1)] ?? null;
    }
    return this.#active;
  }

  activate(id: TabId): void {
    if (this.#tabs.has(id)) this.#active = id;
  }

  get(id: TabId): Tab | undefined {
    return this.#tabs.get(id);
  }

  update(id: TabId, patch: Partial<Tab>): Tab | undefined {
    const tab = this.#tabs.get(id);
    if (!tab) return undefined;
    Object.assign(tab, patch);
    return tab;
  }

  get active(): Tab | undefined {
    return this.#active === null ? undefined : this.#tabs.get(this.#active);
  }

  get activeId(): TabId | null {
    return this.#active;
  }

  list(): Tab[] {
    return this.#order.map((id) => this.#tabs.get(id)!).filter(Boolean);
  }

  get size(): number {
    return this.#tabs.size;
  }
}
