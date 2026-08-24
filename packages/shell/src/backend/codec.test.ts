// SPDX-License-Identifier: MIT OR Apache-2.0
import { expect, test } from "bun:test";

import { decodeEvents, encodeCommands, EV, OP } from "./codec";
import type { BackendEvent, Command } from "./types";

/** Mirror of the Rust encoder, so decodeEvents can be tested standalone. */
function encodeEvents(events: BackendEvent[]): Uint8Array {
  const parts: number[] = [];
  const u16 = (v: number) => parts.push(v & 0xff, (v >> 8) & 0xff);
  const u32 = (v: number) => parts.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  const f64 = (v: number) => {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setFloat64(0, v, true);
    parts.push(...b);
  };
  const str = (v: string) => {
    const b = new TextEncoder().encode(v);
    u32(b.byteLength);
    parts.push(...b);
  };

  u32(events.length);
  for (const e of events) {
    switch (e.ev) {
      case "ready": u16(1); break;
      case "tab_title": u16(2); u32(e.id); str(e.title); break;
      case "tab_url": u16(3); u32(e.id); str(e.url); break;
      case "tab_progress": u16(4); u32(e.id); f64(e.progress); break;
      case "tab_loading": u16(5); u32(e.id); parts.push(e.loading ? 1 : 0); break;
      case "tab_nav": u16(6); u32(e.id); parts.push(e.can_back ? 1 : 0, e.can_forward ? 1 : 0); break;
      case "tab_failed": u16(7); u32(e.id); str(e.url); str(e.message); break;
      case "tab_favicon": u16(8); u32(e.id); str(e.data_url); break;
      case "tab_requested": u16(9); u32(e.opener); str(e.url); break;
      case "window_closed": u16(10); break;
    }
  }
  return new Uint8Array(parts);
}

test("every event kind survives a round trip", () => {
  const events: BackendEvent[] = [
    { ev: "ready" },
    { ev: "tab_title", id: 1, title: "Hello" },
    { ev: "tab_url", id: 2, url: "https://example.com/a?b=1" },
    { ev: "tab_progress", id: 3, progress: 0.375 },
    { ev: "tab_loading", id: 4, loading: true },
    { ev: "tab_nav", id: 5, can_back: true, can_forward: false },
    { ev: "tab_failed", id: 6, url: "https://x", message: "boom" },
    { ev: "tab_favicon", id: 7, data_url: "data:image/png;base64,AAA" },
    { ev: "tab_requested", opener: 8, url: "https://opened" },
    { ev: "window_closed" },
  ];
  expect(decodeEvents(encodeEvents(events))).toEqual(events);
});

test("string lengths are counted in bytes, not code units", () => {
  const title = "日本語 🌸 café";
  const [decoded] = decodeEvents(encodeEvents([{ ev: "tab_title", id: 1, title }]));
  expect(decoded).toEqual({ ev: "tab_title", id: 1, title });
});

test("commands encode to the documented layout", () => {
  // count=1, opcode 2 (tab_close), id=7
  expect(Array.from(encodeCommands([{ op: "tab_close", id: 7 }]))).toEqual([
    1, 0, 0, 0, 2, 0, 7, 0, 0, 0,
  ]);
  expect(Array.from(encodeCommands([]))).toEqual([0, 0, 0, 0]);
});

test("a growing batch does not corrupt earlier messages", () => {
  // Enough payload to force the writer past its initial 1KB buffer.
  const long = "x".repeat(4096);
  const commands: Command[] = [
    { op: "tab_create", id: 1, url: long },
    { op: "tab_navigate", id: 2, url: long + "y" },
    { op: "app_quit" },
  ];
  const bytes = encodeCommands(commands);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect(view.getUint32(0, true)).toBe(3);
  expect(view.getUint16(4, true)).toBe(1); // tab_create
  expect(view.getUint32(6, true)).toBe(1); // id
  expect(view.getUint32(10, true)).toBe(4096); // url length
});

test("malformed input is rejected rather than guessed at", () => {
  expect(() => decodeEvents(new Uint8Array([1, 0, 0, 0]))).toThrow();
  expect(() => decodeEvents(new Uint8Array([0, 0, 0, 0, 9]))).toThrow(/trailing/);
  expect(() => decodeEvents(new Uint8Array([1, 0, 0, 0, 0xff, 0xff]))).toThrow(/unknown/);
});

/**
 * The two halves of the wire format live in different languages, and nothing
 * but discipline keeps them in step. Discipline failed once already: the Rust
 * side grew set_content_scripts/status/to_page and the TypeScript side did
 * not, so every command batch encoded opcode 0 and the renderer dropped it —
 * which presented as a browser that opened a blank window and loaded nothing.
 * This reads the Rust table and refuses to let that happen quietly again.
 */
test("the Rust and TypeScript opcode tables agree", async () => {
  const rust = await Bun.file(
    new URL("../../../protocol/src/codec.rs", import.meta.url).pathname,
  ).text();

  const tableOf = (module: "op" | "ev") => {
    const block = new RegExp(`pub mod ${module} \\{([\\s\\S]*?)\\n\\}`).exec(rust);
    if (!block) throw new Error(`could not find 'pub mod ${module}' in codec.rs`);
    const entries: Record<string, number> = {};
    for (const m of block[1].matchAll(/pub const (\w+): u16 = (\d+);/g)) {
      entries[m[1].toLowerCase()] = Number(m[2]);
    }
    return entries;
  };

  expect(OP).toEqual(tableOf("op"));

  // Events are keyed by number on the TypeScript side, so compare the inverse.
  const tsEvents: Record<string, number> = {};
  for (const [code, name] of Object.entries(EV)) tsEvents[name] = Number(code);
  expect(tsEvents).toEqual(tableOf("ev"));
});
