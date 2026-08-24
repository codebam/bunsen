// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * Loading extensions from disk and running their background workers.
 *
 * An extension is a directory with a manifest.json. Nothing is packed,
 * signed or fetched from a store — that is a distribution problem, and there
 * is no point solving it before the thing being distributed works.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { ExtensionApi, PermissionError, type Extension, type ShellBridge } from "./api";
import { parseManifest } from "./manifest";
import { ExtensionStorage } from "./storage";

const BOOTSTRAP = join(import.meta.dir, "worker-bootstrap.ts");

export interface LoadReport {
  loaded: Extension[];
  failures: { path: string; errors: string[] }[];
  warnings: { id: string; warnings: string[] }[];
}

export class ExtensionHost {
  #api: ExtensionApi;
  #storage: ExtensionStorage;
  #extensions = new Map<string, Extension>();
  #workers = new Map<string, Worker>();
  /** In-flight background messages, keyed by ticket. */
  #messageWaiters = new Map<number, (value: unknown) => void>();
  #nextMessage = 1;

  constructor(storagePath: string, shell: ShellBridge) {
    this.#storage = new ExtensionStorage(storagePath);
    this.#api = new ExtensionApi(this.#storage, shell);
  }

  get extensions(): Extension[] {
    return [...this.#extensions.values()];
  }

  /**
   * Run one `browser.*` call on behalf of a page or content script.
   *
   * Content scripts get the same permission check as background code, because
   * the check is keyed on the extension, not on where the call came from.
   */
  async callApi(extensionId: string, method: string, params: unknown): Promise<unknown> {
    const extension = this.#extensions.get(extensionId);
    if (!extension) throw new Error(`unknown extension: ${extensionId}`);
    return this.#api.dispatch(extension, method, params);
  }

  /**
   * Deliver a message to an extension's background context and wait for its
   * answer — `chrome.runtime.sendMessage` from a content script.
   *
   * Resolves to undefined if the extension has no background worker or no
   * listener takes it, so a caller is never left hanging.
   */
  async sendToBackground(
    extensionId: string,
    message: unknown,
    sender: unknown,
  ): Promise<unknown> {
    const worker = this.#workers.get(extensionId);
    if (!worker) return undefined;

    const id = this.#nextMessage++;
    return new Promise<unknown>((resolve) => {
      const timer = setTimeout(() => {
        // A wedged background worker must not leak a waiter forever.
        this.#messageWaiters.delete(id);
        resolve(undefined);
      }, 5_000);
      this.#messageWaiters.set(id, (value) => {
        clearTimeout(timer);
        resolve(value);
      });
      worker.postMessage({ kind: "message", id, message, sender });
    });
  }

  /**
   * Every content script every loaded extension asks for, with file contents
   * resolved to absolute paths the renderer can read.
   */
  contentScripts(): { ext: string; matches: string[]; files: string[] }[] {
    const out: { ext: string; matches: string[]; files: string[] }[] = [];
    for (const extension of this.#extensions.values()) {
      for (const script of extension.manifest.contentScripts) {
        const files = script.js
          .map((relative) => safeJoin(extension.root, relative))
          .filter((path): path is string => path !== null && existsSync(path));
        if (files.length === 0) continue;
        out.push({
          ext: extension.id,
          matches: script.matches.sources,
          files,
        });
      }
    }
    return out;
  }

  /** Load every subdirectory of `dir` that looks like an extension. */
  loadAll(dir: string): LoadReport {
    const report: LoadReport = { loaded: [], failures: [], warnings: [] };
    if (!existsSync(dir)) return report;

    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = join(dir, entry.name);
      const result = this.load(path, entry.name);
      if (result.extension) {
        report.loaded.push(result.extension);
        if (result.warnings.length > 0) {
          report.warnings.push({ id: result.extension.id, warnings: result.warnings });
        }
      } else {
        report.failures.push({ path, errors: result.errors });
      }
    }
    return report;
  }

  load(
    path: string,
    fallbackId: string,
  ): { extension: Extension | null; errors: string[]; warnings: string[] } {
    const root = resolve(path);
    const manifestPath = join(root, "manifest.json");
    if (!existsSync(manifestPath)) {
      return { extension: null, errors: ["no manifest.json"], warnings: [] };
    }

    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch (err) {
      return { extension: null, errors: [`manifest.json is not valid JSON: ${err}`], warnings: [] };
    }

    const { manifest, errors, warnings } = parseManifest(raw, fallbackId);
    if (!manifest) return { extension: null, errors, warnings };

    const extension: Extension = { id: manifest.id, manifest, root };
    this.#extensions.set(extension.id, extension);
    return { extension, errors, warnings };
  }

  /**
   * Start an extension's background service worker. Resolves once the script
   * has finished evaluating, so a caller can rely on its listeners existing.
   */
  async startBackground(extension: Extension): Promise<void> {
    const background = extension.manifest.background;
    if (!background) return;

    const script = safeJoin(extension.root, background.serviceWorker);
    if (!script) {
      throw new Error(`${extension.id}: background script escapes the extension directory`);
    }
    if (!existsSync(script)) {
      throw new Error(`${extension.id}: background script not found: ${background.serviceWorker}`);
    }

    const worker = new Worker(BOOTSTRAP, { type: "module" });
    this.#workers.set(extension.id, worker);

    await new Promise<void>((resolveStart, rejectStart) => {
      worker.addEventListener("message", (event: MessageEvent) => {
        const msg = event.data;
        if (msg?.kind === "started") return resolveStart();
        if (msg?.kind === "failed") return rejectStart(new Error(msg.error));
        if (msg?.kind === "call") void this.#answer(extension, worker, msg);
        if (msg?.kind === "message-reply") {
          const waiter = this.#messageWaiters.get(msg.id);
          if (waiter) {
            this.#messageWaiters.delete(msg.id);
            waiter(msg.value);
          }
        }
      });
      worker.addEventListener("error", (event) => rejectStart(new Error(String(event))));
      worker.postMessage({ kind: "start", script });
    });
  }

  async #answer(extension: Extension, worker: Worker, msg: any): Promise<void> {
    try {
      const value = await this.#api.dispatch(extension, msg.method, msg.params);
      worker.postMessage({ kind: "result", id: msg.id, value });
    } catch (err) {
      // Permission failures are the extension's problem to handle, so they
      // travel back as a rejected promise rather than killing the worker.
      const error = err instanceof PermissionError ? err.message : String(err);
      worker.postMessage({ kind: "result", id: msg.id, error });
    }
  }

  stop(): void {
    for (const worker of this.#workers.values()) worker.terminate();
    this.#workers.clear();
    this.#storage.close();
  }
}

/**
 * Resolve a manifest-relative path, refusing anything that climbs out of the
 * extension directory. A manifest is untrusted input.
 */
function safeJoin(root: string, relative: string): string | null {
  if (isAbsolute(relative)) return null;
  const candidate = resolve(root, relative);
  return candidate === root || candidate.startsWith(root + "/") ? candidate : null;
}
