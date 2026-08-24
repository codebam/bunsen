// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * RenderBackend on top of a Transport.
 *
 * Commands accumulate and go out as one batch per microtask, so a busy page
 * costs one crossing per turn of the event loop rather than one per
 * operation. That is the property that lets the transport underneath be
 * either a function call or a socket without the shell caring.
 */

import { decodeEvents, encodeCommands } from "./codec";
import { FfiTransport, SocketTransport, type Transport } from "./transport";
import type { BackendConfig, BackendEvent, Command, RenderBackend } from "./types";

export type TransportKind = "ffi" | "socket";

export class BackendClient implements RenderBackend {
  #transport: Transport;
  #pending: Command[] = [];
  #flushScheduled = false;
  #handlers: ((ev: BackendEvent) => void)[] = [];

  constructor(transport: Transport) {
    this.#transport = transport;
    this.#transport.onBatch((bytes) => {
      let events: BackendEvent[];
      try {
        events = decodeEvents(bytes);
      } catch (err) {
        // A desynchronised stream cannot be recovered by guessing.
        console.error("bunsen: dropping malformed event batch:", err);
        return;
      }
      for (const ev of events) {
        for (const h of this.#handlers) h(ev);
      }
    });
  }

  async start(config: BackendConfig): Promise<void> {
    const json = JSON.stringify(config);
    const ready = new Promise<void>((resolve) => {
      this.#handlers.push((ev) => {
        if (ev.ev === "ready") resolve();
      });
    });

    const t = this.#transport;
    if (t instanceof SocketTransport) await t.start(json);
    else if (t instanceof FfiTransport) t.start(json);
    else throw new Error("bunsen: transport cannot be started");

    await ready;
  }

  send(cmd: Command): void {
    this.#pending.push(cmd);
    if (!this.#flushScheduled) {
      this.#flushScheduled = true;
      queueMicrotask(() => this.flush());
    }
  }

  flush(): void {
    this.#flushScheduled = false;
    if (this.#pending.length === 0) return;
    const batch = encodeCommands(this.#pending);
    this.#pending.length = 0;
    this.#transport.submit(batch);
  }

  onEvent(handler: (ev: BackendEvent) => void): void {
    this.#handlers.push(handler);
  }

  stop(): void {
    this.#transport.close();
  }

  get transport(): Transport {
    return this.#transport;
  }
}

/**
 * Pick a transport. `socket` isolates the renderer in its own process, so a
 * renderer crash loses the window instead of the browser; `ffi` keeps it
 * in-process, which is one less context switch per batch.
 */
export function createBackend(
  kind: TransportKind,
  paths: { library: string; host: string },
): BackendClient {
  const transport =
    kind === "socket" ? new SocketTransport(paths.host) : new FfiTransport(paths.library);
  return new BackendClient(transport);
}
