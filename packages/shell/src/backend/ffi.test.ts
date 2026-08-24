// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * Exercises the ABI end to end: start, batch submit, poll, stop.
 * Needs a display, so it skips itself under headless CI.
 */

import { expect, test } from "bun:test";
import { join } from "node:path";

import { FfiBackend } from "./ffi";
import type { BackendEvent } from "./types";

const LIB =
  Bun.env.BUNSEN_BACKEND_PATH ??
  join(import.meta.dir, "../../../render-webkit/target/debug/libbunsen_render_webkit.so");

const headless = !Bun.env.DISPLAY && !Bun.env.WAYLAND_DISPLAY;

test.skipIf(headless)("backend starts, reports tab events, and stops", async () => {
  const backend = new FfiBackend(LIB);
  const seen: BackendEvent[] = [];
  backend.onEvent((ev) => seen.push(ev));

  await backend.start({ chrome_url: "about:blank", width: 640, height: 480 });

  backend.send({ op: "tab_create", id: 1, url: "about:blank" });
  backend.send({ op: "tab_activate", id: 1 });
  backend.flush();

  // Give the UI thread a few frames to emit property notifications.
  await Bun.sleep(1500);
  backend.stop();

  expect(seen.some((e) => e.ev === "ready")).toBe(true);
  expect(seen.some((e) => e.ev === "tab_url" || e.ev === "tab_loading")).toBe(true);
}, 15000);
