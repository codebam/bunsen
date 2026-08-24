// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * One renderer process per tab.
 *
 * Each tab gets its own `bunsen-render-host`, so a renderer that segfaults,
 * hangs or leaks takes one tab with it. The shell keeps every piece of tab
 * state — url, title, history position — so a dead renderer can be replaced
 * and the tab reloaded without the user losing their place.
 *
 * **What this does not do yet is put those tabs in one window.** GTK4 removed
 * `GtkSocket`/XEmbed and Wayland has no portable protocol for embedding one
 * client's surface in another's, so a renderer process can only draw into a
 * window it owns. Compositing N processes into one window means each renderer
 * rendering into shared memory and the browser process blitting the result —
 * which Blitz can do, since we own its paint target, and WebKitGTK cannot.
 * Until that exists, this mode is one OS window per tab with no chrome UI:
 * the isolation is real and testable, the presentation is not finished.
 *
 * Everything above this class sees a plain `RenderBackend`.
 */

import { BackendClient } from "./client";
import { SocketTransport } from "./transport";
import type { BackendConfig, BackendEvent, Command, RenderBackend, TabId } from "./types";

/** Inside its own process, every tab is tab 1. */
const LOCAL_ID = 1;

interface Slot {
  client: BackendClient;
  transport: SocketTransport;
  /** Commands issued before the renderer finished starting. */
  queue: Command[];
  ready: boolean;
  dead: boolean;
}

export class ProcessPerTabBackend implements RenderBackend {
  #hostPath: string;
  #config: BackendConfig | null = null;
  #slots = new Map<TabId, Slot>();
  #handlers: ((ev: BackendEvent) => void)[] = [];
  #stopped = false;

  constructor(hostPath: string) {
    this.#hostPath = hostPath;
  }

  async start(config: BackendConfig): Promise<void> {
    // Each renderer owns a window of its own, so none of them draws chrome.
    this.#config = { ...config, chrome_url: "about:blank", chrome_height: 0 };
    this.#emit({ ev: "ready" });
  }

  send(cmd: Command): void {
    if (this.#stopped) return;
    if (cmd.op === "app_quit") return this.stop();
    if (!("id" in cmd)) return; // chrome_height has no tab to route to

    if (cmd.op === "tab_create") {
      this.#spawn(cmd.id, cmd);
      return;
    }

    const slot = this.#slots.get(cmd.id);
    if (!slot || slot.dead) return;
    if (cmd.op === "tab_close") {
      this.#slots.delete(cmd.id);
      slot.client.stop();
      return;
    }
    this.#forward(slot, cmd);
  }

  flush(): void {
    for (const slot of this.#slots.values()) {
      if (slot.ready && !slot.dead) slot.client.flush();
    }
  }

  onEvent(handler: (ev: BackendEvent) => void): void {
    this.#handlers.push(handler);
  }

  stop(): void {
    this.#stopped = true;
    for (const slot of this.#slots.values()) slot.client.stop();
    this.#slots.clear();
    this.#emit({ ev: "window_closed" });
  }

  /** Renderer processes currently alive. Used by tests and diagnostics. */
  get liveTabs(): TabId[] {
    return [...this.#slots.entries()].filter(([, s]) => !s.dead).map(([id]) => id);
  }

  /** The process rendering a given tab, if it is up. */
  pidOf(id: TabId): number | null {
    const slot = this.#slots.get(id);
    return slot && !slot.dead ? slot.transport.pid : null;
  }

  #spawn(id: TabId, create: Command & { op: "tab_create" }): void {
    if (!this.#config) throw new Error("bunsen: supervisor used before start()");
    if (this.#slots.has(id)) return;

    const transport = new SocketTransport(this.#hostPath);
    const client = new BackendClient(transport);
    const slot: Slot = { client, transport, queue: [], ready: false, dead: false };
    this.#slots.set(id, slot);

    // Rewrite the local tab id back to the shell's before anyone sees it.
    client.onEvent((ev) => {
      if (ev.ev === "ready") return;
      // A renderer closing its own window means the tab is gone, not the
      // browser; the shell decides what that means.
      if (ev.ev === "window_closed") return this.#died(id, slot);
      this.#emit(withTabId(ev, id));
    });
    transport.onExit(() => this.#died(id, slot));

    client
      .start(this.#config)
      .then(() => {
        slot.ready = true;
        client.send({ ...create, id: LOCAL_ID });
        for (const queued of slot.queue) client.send(queued);
        slot.queue.length = 0;
        client.flush();
      })
      .catch((err) => {
        console.error(`bunsen: renderer for tab ${id} failed to start:`, err);
        this.#died(id, slot);
      });
  }

  #forward(slot: Slot, cmd: Command): void {
    const local = { ...cmd, id: LOCAL_ID } as Command;
    if (!slot.ready) slot.queue.push(local);
    else slot.client.send(local);
  }

  #died(id: TabId, slot: Slot): void {
    if (slot.dead) return;
    slot.dead = true;
    slot.client.stop();
    this.#slots.delete(id);
    // Not part of the renderer protocol: no renderer is alive to report it.
    this.#emit({
      ev: "tab_failed",
      id,
      url: "",
      message: "renderer process exited",
    });
  }

  #emit(ev: BackendEvent): void {
    for (const h of this.#handlers) h(ev);
  }
}

/** Replace whichever id field an event carries. */
function withTabId(ev: BackendEvent, id: TabId): BackendEvent {
  if ("id" in ev) return { ...ev, id };
  if ("opener" in ev) return { ...ev, opener: id };
  return ev;
}
