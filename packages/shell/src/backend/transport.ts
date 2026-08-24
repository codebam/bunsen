// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * How batches get from the shell to the renderer and back.
 *
 * Two implementations, one protocol. In-process FFI is fastest; the socket
 * transport puts the renderer in its own process, so a crash there costs a
 * window rather than the browser. Nothing above this file knows which is in
 * use.
 */

export interface Transport {
  /** Deliver one encoded command batch. */
  submit(bytes: Uint8Array): void;
  /** Called with each encoded event batch as it arrives. */
  onBatch(handler: (bytes: Uint8Array) => void): void;
  close(): void;
}

// ------------------------------------------------------------- in-process

import { dlopen, FFIType, JSCallback, ptr } from "bun:ffi";

const SYMBOLS = {
  bunsen_backend_start: { args: [FFIType.cstring], returns: FFIType.ptr },
  bunsen_backend_submit: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.u64_fast],
    returns: FFIType.i32,
  },
  bunsen_backend_poll: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.u64_fast],
    returns: FFIType.i32,
  },
  bunsen_backend_set_wakeup: {
    args: [FFIType.ptr, FFIType.ptr],
    returns: FFIType.i32,
  },
  bunsen_backend_stop: { args: [FFIType.ptr], returns: FFIType.void },
} as const;

const ERR_NOSPACE = -2;
/**
 * Safety net only. Events normally arrive through the backend's wakeup
 * callback; this covers a failed registration and the window between start()
 * and registration.
 */
const SAFETY_POLL_MS = 250;

export class FfiTransport implements Transport {
  #lib: ReturnType<typeof dlopen<typeof SYMBOLS>>;
  #handle: number | bigint | null = null;
  #wakeup: JSCallback | null = null;
  #timer: ReturnType<typeof setInterval> | null = null;
  #buf = new Uint8Array(64 * 1024);
  #handler: ((bytes: Uint8Array) => void) | null = null;
  readonly stats = { wakeups: 0, timerDrains: 0 };

  constructor(libraryPath: string) {
    this.#lib = dlopen(libraryPath, SYMBOLS);
  }

  start(configJson: string): void {
    const handle = this.#lib.symbols.bunsen_backend_start(
      Buffer.from(configJson + "\0", "utf8"),
    );
    if (!handle) throw new Error("bunsen: backend failed to start");
    this.#handle = handle as number | bigint;

    // Fired on a backend thread; hop to the JS loop before touching anything.
    this.#wakeup = new JSCallback(
      () => {
        this.stats.wakeups++;
        queueMicrotask(() => this.#drain());
      },
      { args: [], returns: FFIType.void, threadsafe: true },
    );
    const registered =
      this.#lib.symbols.bunsen_backend_set_wakeup(this.#handle, this.#wakeup.ptr) === 0;
    if (!registered) {
      console.warn("bunsen: wakeup callback unavailable, falling back to polling");
    }

    this.#timer = setInterval(() => {
      this.stats.timerDrains++;
      this.#drain();
    }, SAFETY_POLL_MS);
    this.#timer.unref?.();
    this.#drain();
  }

  submit(bytes: Uint8Array): void {
    if (this.#handle === null) return;
    const rc = this.#lib.symbols.bunsen_backend_submit(
      this.#handle,
      ptr(bytes),
      bytes.byteLength,
    );
    if (rc !== 0) throw new Error(`bunsen: submit failed (${rc})`);
  }

  onBatch(handler: (bytes: Uint8Array) => void): void {
    this.#handler = handler;
  }

  close(): void {
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
    this.#handler?.(this.#buf.subarray(0, n));
  }
}

// ---------------------------------------------------------- out-of-process

import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Socket, Subprocess } from "bun";

/**
 * Runs the renderer as a child process and talks to it over a Unix socket.
 * Frames are u32 little-endian length prefixes around the same batches the
 * FFI transport passes by pointer.
 */
/**
 * Process-wide counter. Two transports created in the same millisecond would
 * otherwise pick the same socket path, and the second renderer would unlink
 * the first's socket out from under it — which showed up as a tab that never
 * loaded, only when several were started at once.
 */
let socketSequence = 0;

export class SocketTransport implements Transport {
  #hostPath: string;
  #socketPath: string;
  #proc: Subprocess | null = null;
  #socket: Socket | null = null;
  #handler: ((bytes: Uint8Array) => void) | null = null;
  #inbox = new Uint8Array(0);
  #onExit: (() => void) | null = null;

  constructor(hostPath: string) {
    this.#hostPath = hostPath;
    this.#socketPath = join(
      tmpdir(),
      `bunsen-${process.pid}-${Date.now()}-${socketSequence++}.sock`,
    );
  }

  /** Resolves once the renderer has connected back. */
  async start(configJson: string): Promise<void> {
    this.#proc = Bun.spawn([this.#hostPath, this.#socketPath, configJson], {
      stdio: ["ignore", "inherit", "inherit"],
      onExit: () => this.#onExit?.(),
    });

    // The child binds the socket; poll briefly for it to appear.
    const deadline = Date.now() + 10_000;
    for (;;) {
      try {
        this.#socket = await Bun.connect({
          unix: this.#socketPath,
          socket: {
            data: (_s, chunk) => this.#feed(chunk),
            close: () => this.#onExit?.(),
            error: (_s, err) => console.error("bunsen: renderer socket error", err),
          },
        });
        break;
      } catch (err) {
        if (Date.now() > deadline) throw new Error(`bunsen: renderer never came up: ${err}`);
        await Bun.sleep(10);
      }
    }
  }

  /** The renderer's process id, for supervision. Null before start(). */
  get pid(): number | null {
    return this.#proc?.pid ?? null;
  }

  /** Fires when the renderer process goes away — a crash, or a closed window. */
  onExit(handler: () => void): void {
    this.#onExit = handler;
  }

  submit(bytes: Uint8Array): void {
    if (!this.#socket) return;
    const framed = new Uint8Array(4 + bytes.byteLength);
    new DataView(framed.buffer).setUint32(0, bytes.byteLength, true);
    framed.set(bytes, 4);
    this.#socket.write(framed);
  }

  onBatch(handler: (bytes: Uint8Array) => void): void {
    this.#handler = handler;
  }

  close(): void {
    this.#socket?.end();
    this.#socket = null;
    this.#proc?.kill();
    this.#proc = null;
    try {
      unlinkSync(this.#socketPath);
    } catch {
      // The renderer unlinks it after accept; missing is the normal case.
    }
  }

  /** Reassemble frames: a socket read is not a message boundary. */
  #feed(chunk: Uint8Array): void {
    if (this.#inbox.byteLength === 0) {
      this.#inbox = chunk;
    } else {
      const merged = new Uint8Array(this.#inbox.byteLength + chunk.byteLength);
      merged.set(this.#inbox);
      merged.set(chunk, this.#inbox.byteLength);
      this.#inbox = merged;
    }

    for (;;) {
      if (this.#inbox.byteLength < 4) return;
      const view = new DataView(
        this.#inbox.buffer,
        this.#inbox.byteOffset,
        this.#inbox.byteLength,
      );
      const len = view.getUint32(0, true);
      if (this.#inbox.byteLength < 4 + len) return;
      this.#handler?.(this.#inbox.subarray(4, 4 + len));
      this.#inbox = this.#inbox.subarray(4 + len);
    }
  }
}
