// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * Exercises the ABI end to end against a local page: start, batch submit,
 * wakeup-driven delivery, stop. Needs a display, so it skips under headless CI.
 */

import { expect, test } from "bun:test";
import { join } from "node:path";

import { FfiBackend } from "./ffi";
import type { BackendEvent } from "./types";

const LIB =
  Bun.env.BUNSEN_BACKEND_PATH ??
  join(import.meta.dir, "../../../render-webkit/target/debug/libbunsen_render_webkit.so");

const headless = !Bun.env.DISPLAY && !Bun.env.WAYLAND_DISPLAY;

test.skipIf(headless)("loads a page and reports its state over the wakeup path", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () =>
      new Response("<title>Bunsen Test Page</title><h1>hello</h1>", {
        headers: { "content-type": "text/html" },
      }),
  });
  const pageUrl = `http://127.0.0.1:${server.port}/`;

  const backend = new FfiBackend(LIB);
  const seen: BackendEvent[] = [];
  backend.onEvent((ev) => seen.push(ev));

  await backend.start({ chrome_url: "about:blank", width: 640, height: 480 });

  backend.send({ op: "tab_create", id: 1, url: pageUrl });
  backend.send({ op: "tab_activate", id: 1 });
  backend.flush();

  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (seen.some((e) => e.ev === "tab_title" && e.title.includes("Bunsen Test"))) break;
    await Bun.sleep(25);
  }
  backend.stop();
  server.stop(true);

  expect(seen.some((e) => e.ev === "ready")).toBe(true);
  expect(seen.some((e) => e.ev === "tab_title" && e.title === "Bunsen Test Page")).toBe(true);
  expect(seen.some((e) => e.ev === "tab_url" && e.url === pageUrl)).toBe(true);
  expect(seen.some((e) => e.ev === "tab_loading" && e.loading === false)).toBe(true);
  // The wakeup callback, not the 250ms safety timer, is what delivered these.
  expect(backend.stats.wakeups).toBeGreaterThan(0);
}, 20000);
