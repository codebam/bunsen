// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * Runs *inside* the background worker, before the extension's own code.
 *
 * Installs `browser` and `chrome` as proxies that forward every call to the
 * shell and await a reply. The extension never gets a direct reference to
 * anything of ours; the only channel out is postMessage, and the only thing
 * on the other end is the permission-checked dispatcher in api.ts.
 */

declare const self: Worker & { postMessage(m: unknown): void };

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

const pending = new Map<number, Pending>();
let nextCall = 1;

function call(method: string, params: unknown): Promise<unknown> {
  const id = nextCall++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    self.postMessage({ kind: "call", id, method, params });
  });
}

/**
 * `browser.storage.local.get(...)` is a path, not a fixed method table, so
 * build it from a proxy: any property access deepens the path and any call
 * sends it. Unimplemented methods then fail at the shell with a real message
 * rather than as "undefined is not a function".
 */
function namespace(path: string[]): any {
  return new Proxy(function () {} as any, {
    get(_target, prop) {
      if (typeof prop !== "string") return undefined;
      return namespace([...path, prop]);
    },
    apply(_target, _this, args) {
      const method = path.join(".");
      // storage areas read as storage.local.get; the shell wants
      // storage.get with an area parameter.
      const storage = /^storage\.(local|session|sync)\.(\w+)$/.exec(method);
      if (storage) {
        const [, areaName, op] = storage;
        return call(`storage.${op}`, storageParams(op, areaName, args));
      }
      return call(method, positional(method, args));
    },
  });
}

/**
 * Most APIs take a single options object, which passes straight through. The
 * ones that take positional arguments are named here rather than guessed at,
 * because guessing produces a silent `undefined` on the shell side.
 */
function positional(method: string, args: unknown[]): unknown {
  switch (method) {
    case "runtime.sendMessage":
      return { message: args[0] };
    case "runtime.getURL":
      return { path: args[0] };
    case "tabs.update":
      // tabs.update(tabId, props) — tabId is optional and means "active tab".
      return typeof args[0] === "number"
        ? { tabId: args[0], ...(args[1] as object) }
        : (args[0] as object);
    case "tabs.remove":
      return { tabId: args[0] };
    default:
      return args[0];
  }
}

function storageParams(op: string, area: string, args: unknown[]): unknown {
  switch (op) {
    case "set":
      return { area, items: args[0] };
    case "get":
    case "remove":
      return { area, keys: args[0] ?? null };
    default:
      return { area };
  }
}

const api = namespace([]);
(globalThis as any).browser = api;
(globalThis as any).chrome = api;

self.onmessage = async (event: MessageEvent) => {
  const msg = event.data;

  if (msg?.kind === "result") {
    const waiter = pending.get(msg.id);
    if (!waiter) return;
    pending.delete(msg.id);
    if (msg.error) waiter.reject(new Error(msg.error));
    else waiter.resolve(msg.value);
    return;
  }

  if (msg?.kind === "start") {
    try {
      await import(msg.script);
      self.postMessage({ kind: "started" });
    } catch (err) {
      self.postMessage({ kind: "failed", error: String(err) });
    }
  }
};
