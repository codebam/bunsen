// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * The `browser.*` surface, implemented shell-side.
 *
 * Every call arrives here as a method name and a parameter object, from
 * whatever context made it — today a background worker, later a popup page or
 * a content script. Permissions are checked here and nowhere else, so there
 * is one place to audit.
 *
 * This is the half of WebExtensions that is browser plumbing rather than DOM
 * access, which is why it can exist before the engine that owns the DOM does.
 * See docs/extensions.md.
 */

import type { Manifest } from "./manifest";
import type { Area, ExtensionStorage } from "./storage";

export interface TabView {
  id: number;
  url: string;
  title: string;
  active: boolean;
  loading: boolean;
}

/** What the API needs from the rest of the shell. */
export interface ShellBridge {
  listTabs(): TabView[];
  createTab(url: string, active: boolean): TabView;
  updateTab(id: number, changes: { url?: string; active?: boolean }): TabView | null;
  removeTab(id: number): void;
  /** Delivered to whatever is listening on the browser side. */
  onExtensionMessage(extension: string, message: unknown): void;
}

export class PermissionError extends Error {
  constructor(permission: string) {
    super(`permission denied: ${permission}`);
    this.name = "PermissionError";
  }
}

export interface Extension {
  id: string;
  manifest: Manifest;
  /** Absolute path to the unpacked extension. */
  root: string;
}

export class ExtensionApi {
  #storage: ExtensionStorage;
  #shell: ShellBridge;

  constructor(storage: ExtensionStorage, shell: ShellBridge) {
    this.#storage = storage;
    this.#shell = shell;
  }

  /**
   * Route one call. Throws `PermissionError` when the manifest did not ask
   * for what the call needs, and a plain Error for anything unimplemented —
   * an extension should be able to feature-detect us honestly.
   */
  async dispatch(ext: Extension, method: string, params: any): Promise<unknown> {
    switch (method) {
      // ------------------------------------------------------------ storage
      case "storage.get":
        this.#require(ext, "storage");
        return this.#storage.get(ext.id, area(params?.area), keys(params?.keys));
      case "storage.set":
        this.#require(ext, "storage");
        this.#storage.set(ext.id, area(params?.area), params?.items ?? {});
        return null;
      case "storage.remove":
        this.#require(ext, "storage");
        this.#storage.remove(ext.id, area(params?.area), keys(params?.keys) ?? []);
        return null;
      case "storage.clear":
        this.#require(ext, "storage");
        this.#storage.clear(ext.id, area(params?.area));
        return null;
      case "storage.getBytesInUse":
        this.#require(ext, "storage");
        return this.#storage.bytesInUse(ext.id, area(params?.area));

      // --------------------------------------------------------------- tabs
      case "tabs.query": {
        this.#require(ext, "tabs");
        const all = this.#shell.listTabs();
        return all.filter((t) => {
          if (params?.active !== undefined && t.active !== params.active) return false;
          if (params?.url && !ext.manifest.hostPermissions.matches(t.url)) return false;
          return true;
        });
      }
      case "tabs.create":
        this.#require(ext, "tabs");
        return this.#shell.createTab(String(params?.url ?? "about:blank"), params?.active !== false);
      case "tabs.update":
        this.#require(ext, "tabs");
        return this.#shell.updateTab(Number(params?.tabId), {
          url: params?.url,
          active: params?.active,
        });
      case "tabs.remove":
        this.#require(ext, "tabs");
        this.#shell.removeTab(Number(params?.tabId));
        return null;

      // ------------------------------------------------------------ runtime
      case "runtime.getManifest":
        return {
          manifest_version: 3,
          name: ext.manifest.name,
          version: ext.manifest.version,
          description: ext.manifest.description,
        };
      case "runtime.getURL":
        return `bunsen-extension://${ext.id}/${String(params?.path ?? "").replace(/^\//, "")}`;
      case "runtime.sendMessage":
        this.#shell.onExtensionMessage(ext.id, params?.message);
        return null;

      default:
        throw new Error(`not implemented: browser.${method}`);
    }
  }

  #require(ext: Extension, permission: string): void {
    if (!ext.manifest.permissions.has(permission as any)) {
      throw new PermissionError(permission);
    }
  }
}

function area(value: unknown): Area {
  return value === "session" || value === "sync" ? value : "local";
}

function keys(value: unknown): string[] | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter((k): k is string => typeof k === "string");
  // storage.get({key: default}) form: the keys are what matter here.
  if (typeof value === "object") return Object.keys(value as object);
  return null;
}
