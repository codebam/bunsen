// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * Binary wire format for command/event batches. The authoritative description
 * of the layout and the opcode table lives in
 * packages/render-webkit/src/codec.rs — the two must be edited together.
 *
 * Never renumber an opcode; only append.
 */

import type { BackendEvent, Command } from "./types";

export const OP = {
  tab_create: 1,
  tab_close: 2,
  tab_activate: 3,
  tab_navigate: 4,
  tab_back: 5,
  tab_forward: 6,
  tab_reload: 7,
  tab_stop: 8,
  chrome_height: 9,
  app_quit: 10,
} as const;

export const EV = {
  1: "ready",
  2: "tab_title",
  3: "tab_url",
  4: "tab_progress",
  5: "tab_loading",
  6: "tab_nav",
  7: "tab_failed",
  8: "tab_favicon",
  9: "tab_requested",
  10: "window_closed",
} as const;

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();

class Writer {
  #bytes = new Uint8Array(1024);
  #view = new DataView(this.#bytes.buffer);
  #at = 0;

  #room(n: number): void {
    if (this.#at + n <= this.#bytes.byteLength) return;
    let size = this.#bytes.byteLength * 2;
    while (size < this.#at + n) size *= 2;
    const grown = new Uint8Array(size);
    grown.set(this.#bytes);
    this.#bytes = grown;
    this.#view = new DataView(grown.buffer);
  }

  u16(v: number): void {
    this.#room(2);
    this.#view.setUint16(this.#at, v, true);
    this.#at += 2;
  }

  u32(v: number): void {
    this.#room(4);
    this.#view.setUint32(this.#at, v, true);
    this.#at += 4;
  }

  i32(v: number): void {
    this.#room(4);
    this.#view.setInt32(this.#at, v, true);
    this.#at += 4;
  }

  bool(v: boolean): void {
    this.#room(1);
    this.#bytes[this.#at++] = v ? 1 : 0;
  }

  str(v: string): void {
    // Length is in bytes, not code units: encode first, then prefix.
    const bytes = utf8.encode(v);
    this.u32(bytes.byteLength);
    this.#room(bytes.byteLength);
    this.#bytes.set(bytes, this.#at);
    this.#at += bytes.byteLength;
  }

  done(): Uint8Array {
    return this.#bytes.subarray(0, this.#at);
  }
}

export function encodeCommands(commands: Command[]): Uint8Array {
  const w = new Writer();
  w.u32(commands.length);
  for (const c of commands) {
    w.u16(OP[c.op]);
    switch (c.op) {
      case "tab_create":
      case "tab_navigate":
        w.u32(c.id);
        w.str(c.url);
        break;
      case "tab_reload":
        w.u32(c.id);
        w.bool(c.bypass_cache ?? false);
        break;
      case "tab_close":
      case "tab_activate":
      case "tab_back":
      case "tab_forward":
      case "tab_stop":
        w.u32(c.id);
        break;
      case "chrome_height":
        w.i32(c.px);
        break;
      case "app_quit":
        break;
    }
  }
  return w.done();
}

class Reader {
  #view: DataView;
  #bytes: Uint8Array;
  #at = 0;

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get exhausted(): boolean {
    return this.#at === this.#bytes.byteLength;
  }

  #need(n: number): void {
    if (this.#at + n > this.#bytes.byteLength) throw new Error("truncated batch");
  }

  u16(): number {
    this.#need(2);
    const v = this.#view.getUint16(this.#at, true);
    this.#at += 2;
    return v;
  }

  u32(): number {
    this.#need(4);
    const v = this.#view.getUint32(this.#at, true);
    this.#at += 4;
    return v;
  }

  f64(): number {
    this.#need(8);
    const v = this.#view.getFloat64(this.#at, true);
    this.#at += 8;
    return v;
  }

  bool(): boolean {
    this.#need(1);
    return this.#bytes[this.#at++] !== 0;
  }

  str(): string {
    const len = this.u32();
    this.#need(len);
    const s = fromUtf8.decode(this.#bytes.subarray(this.#at, this.#at + len));
    this.#at += len;
    return s;
  }
}

export function decodeEvents(bytes: Uint8Array): BackendEvent[] {
  const r = new Reader(bytes);
  const count = r.u32();
  const out: BackendEvent[] = [];
  for (let i = 0; i < count; i++) {
    const code = r.u16();
    switch (code) {
      case 1:
        out.push({ ev: "ready" });
        break;
      case 2:
        out.push({ ev: "tab_title", id: r.u32(), title: r.str() });
        break;
      case 3:
        out.push({ ev: "tab_url", id: r.u32(), url: r.str() });
        break;
      case 4:
        out.push({ ev: "tab_progress", id: r.u32(), progress: r.f64() });
        break;
      case 5:
        out.push({ ev: "tab_loading", id: r.u32(), loading: r.bool() });
        break;
      case 6:
        out.push({
          ev: "tab_nav",
          id: r.u32(),
          can_back: r.bool(),
          can_forward: r.bool(),
        });
        break;
      case 7:
        out.push({ ev: "tab_failed", id: r.u32(), url: r.str(), message: r.str() });
        break;
      case 8:
        out.push({ ev: "tab_favicon", id: r.u32(), data_url: r.str() });
        break;
      case 9:
        out.push({ ev: "tab_requested", opener: r.u32(), url: r.str() });
        break;
      case 10:
        out.push({ ev: "window_closed" });
        break;
      default:
        // No per-message length prefix means no way to skip an unknown
        // message and stay in sync. Fail loudly rather than desynchronise.
        throw new Error(`unknown event opcode ${code}`);
    }
  }
  if (!r.exhausted) throw new Error("trailing bytes in batch");
  return out;
}
