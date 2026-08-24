// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * RenderBackend over the C ABI, loaded with bun:ffi.
 *
 * The whole point of the batch protocol lives here: `send` only appends to an
 * array, and one `bunsen_backend_submit` call per microtask carries the lot.
 * A DOM-heavy page therefore costs one FFI crossing per turn of the loop, not
 * one per mutation.
 */

import { dlopen, FFIType, ptr } from "bun:ffi";
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
  bunsen_backend_wakeup_fd: { args: [pointer], returns: i32 },
  bunsen_backend_stop: { args: [pointer], returns: FFIType.void },
} as const;

const ERR_NOSPACE = -2;
/** Idle poll cadence. The wakeup eventfd exists for when this becomes a cost. */
const POLL_MS = 8;

export class FfiBackend implements RenderBackend {
  #lib: ReturnType<typeof dlopen<typeof SYMBOLS>>;
  #handle: number | bigint | null = null;
  #pending: Command[] = [];
  #flushScheduled = false;
  #handlers: ((ev: BackendEvent) => void)[] = [];
  #timer: ReturnType<typeof setInterval> | null = null;
  #buf = new Uint8Array(64 * 1024);
  #decoder = new TextDecoder();
  #encoder = new TextEncoder();

  constructor(libraryPath: string) {
    this.#lib = dlopen(libraryPath, SYMBOLS);
  }

  start(config: BackendConfig): Promise<void> {
    const handle = this.#lib.symbols.bunsen_backend_start(
      Buffer.from(JSON.stringify(config) + "\0", "utf8"),
    );
    if (!handle) throw new Error("bunsen: backend failed to start");
    this.#handle = handle as number | bigint;

    return new Promise<void>((resolve) => {
      const onReady = (ev: BackendEvent) => {
        if (ev.ev === "ready") resolve();
      };
      this.#handlers.push(onReady);
      this.#timer = setInterval(() => this.#drain(), POLL_MS);
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
  }

  #drain(): void {
    if (this.#handle === null) return;
    let n = this.#lib.symbols.bunsen_backend_poll(
      this.#handle,
      ptr(this.#buf),
      this.#buf.byteLength,
    );
    if (n === ERR_NOSPACE) {
      // Nothing was consumed; widen and retry on the next tick.
      this.#buf = new Uint8Array(this.#buf.byteLength * 2);
      return;
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
