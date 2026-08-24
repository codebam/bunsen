// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * RenderBackend over the C ABI, loaded with bun:ffi.
 *
 * The whole point of the batch protocol lives here: `send` only appends to an
 * array, and one `bunsen_backend_submit` call per microtask carries the lot.
 * A DOM-heavy page therefore costs one FFI crossing per turn of the loop, not
 * one per mutation.
 */

import { dlopen, FFIType, JSCallback, ptr } from "bun:ffi";
import type {
  BackendConfig,
  BackendEvent,
  Command,
  RenderBackend,
} from "./types";

const { cstring, i32, ptr: pointer, u64_fast } = FFIType;

const SYMBOLS = {
  bunsen_backend_start: { args: [cstring], returns: pointer },
  bunsen_backend_submit: { args: [pointer, pointer, u64_fast], returns: i32 },
  bunsen_backend_poll: { args: [pointer, pointer, u64_fast], returns: i32 },
  bunsen_backend_set_wakeup: { args: [pointer, pointer], returns: i32 },
  bunsen_backend_stop: { args: [pointer], returns: FFIType.void },
} as const;

const ERR_NOSPACE = -2;
/**
 * Safety net only. Events normally arrive through the backend's wakeup
 * callback; this catches the case where registering it failed, and covers any
 * event pushed in the window between start() and registration.
 */
const SAFETY_POLL_MS = 250;

export class FfiBackend implements RenderBackend {
  #lib: ReturnType<typeof dlopen<typeof SYMBOLS>>;
  #handle: number | bigint | null = null;
  #pending: Command[] = [];
  #flushScheduled = false;
  #handlers: ((ev: BackendEvent) => void)[] = [];
  #timer: ReturnType<typeof setInterval> | null = null;
  #wakeup: JSCallback | null = null;
  #buf = new Uint8Array(64 * 1024);
  #decoder = new TextDecoder();
  #encoder = new TextEncoder();
  /** Diagnostic: proves the wakeup path is carrying events, not the timer. */
  readonly stats = { wakeups: 0, timerDrains: 0 };

  constructor(libraryPath: string) {
    this.#lib = dlopen(libraryPath, SYMBOLS);
  }

  start(config: BackendConfig): Promise<void> {
    const handle = this.#lib.symbols.bunsen_backend_start(
      Buffer.from(JSON.stringify(config) + "\0", "utf8"),
    );
    if (!handle) throw new Error("bunsen: backend failed to start");
    this.#handle = handle as number | bigint;

    // Fired on a backend thread; hop to the JS loop before touching anything.
    this.#wakeup = new JSCallback(
      () => {
        this.stats.wakeups++;
        queueMicrotask(() => this.#drain());
      },
      {
        args: [],
        returns: FFIType.void,
        threadsafe: true,
      },
    );
    const registered =
      this.#lib.symbols.bunsen_backend_set_wakeup(
        this.#handle,
        this.#wakeup.ptr,
      ) === 0;
    if (!registered) {
      console.warn("bunsen: wakeup callback unavailable, falling back to polling");
    }
    this.#timer = setInterval(() => {
      this.stats.timerDrains++;
      this.#drain();
    }, SAFETY_POLL_MS);
    this.#timer.unref?.();

    return new Promise<void>((resolve) => {
      const onReady = (ev: BackendEvent) => {
        if (ev.ev === "ready") resolve();
      };
      this.#handlers.push(onReady);
      this.#drain();
    });
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
    if (this.#pending.length === 0 || this.#handle === null) return;
    const batch = this.#encoder.encode(JSON.stringify(this.#pending));
    this.#pending.length = 0;
    const rc = this.#lib.symbols.bunsen_backend_submit(
      this.#handle,
      ptr(batch),
      batch.byteLength,
    );
    if (rc !== 0) throw new Error(`bunsen: submit failed (${rc})`);
  }

  onEvent(handler: (ev: BackendEvent) => void): void {
    this.#handlers.push(handler);
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    if (this.#handle !== null) {
      this.#lib.symbols.bunsen_backend_stop(this.#handle);
      this.#handle = null;
    }
    this.#wakeup?.close();
    this.#wakeup = null;
  }

  #drain(): void {
    if (this.#handle === null) return;
    const n = this.#lib.symbols.bunsen_backend_poll(
      this.#handle,
      ptr(this.#buf),
      this.#buf.byteLength,
    );
    if (n === ERR_NOSPACE) {
      // Nothing was consumed; widen and retry immediately.
      this.#buf = new Uint8Array(this.#buf.byteLength * 2);
      return this.#drain();
    }
    if (n <= 0) return;

    const events = JSON.parse(
      this.#decoder.decode(this.#buf.subarray(0, n)),
    ) as BackendEvent[];
    for (const ev of events) {
      for (const h of this.#handlers) h(ev);
    }
  }
}
