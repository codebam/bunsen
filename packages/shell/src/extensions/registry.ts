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

  constructor(storagePath: string, shell: ShellBridge) {
    this.#storage = new ExtensionStorage(storagePath);
    this.#api = new ExtensionApi(this.#storage, shell);
  }

  get extensions(): Extension[] {
    return [...this.#extensions.values()];
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
