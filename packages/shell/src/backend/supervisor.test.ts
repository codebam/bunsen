// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * Crash isolation is the whole point of process-per-tab, so that is what this
 * asserts: kill one renderer and the other tab keeps working.
 */

import { expect, test } from "bun:test";
import { join } from "node:path";

import { ProcessPerTabBackend } from "./supervisor";
import type { BackendEvent } from "./types";

const HOST =
  Bun.env.BUNSEN_HOST_PATH ??
  join(import.meta.dir, "../../../../target/debug/bunsen-render-host");

const headless = !Bun.env.DISPLAY && !Bun.env.WAYLAND_DISPLAY;

// Generous: spinning up two renderer processes, each with its own GPU
// surface, is slow on a cold cache and this went flaky at 15s.
const settle = async (check: () => boolean, ms = 30_000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && !check()) await Bun.sleep(25);
  return check();
};

test.skipIf(headless)("a renderer crash takes one tab, not the browser", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req) =>
      new Response(`<title>tab ${new URL(req.url).pathname.slice(1)}</title>`, {
        headers: { "content-type": "text/html" },
      }),
  });
  const base = `http://127.0.0.1:${server.port}`;

  const backend = new ProcessPerTabBackend(HOST);
  const seen: BackendEvent[] = [];
  backend.onEvent((ev) => seen.push(ev));
  await backend.start({ chrome_url: "about:blank", width: 500, height: 400 });

  backend.send({ op: "tab_create", id: 11, url: `${base}/one` });
  backend.send({ op: "tab_create", id: 22, url: `${base}/two` });
  backend.flush();

  const titled = (n: string) =>
    seen.some((e) => e.ev === "tab_title" && e.title === `tab ${n}`);
  expect(await settle(() => titled("one") && titled("two"))).toBe(true);

  // Each tab really is its own process.
  const first = backend.pidOf(11);
  const second = backend.pidOf(22);
  expect(first).not.toBeNull();
  expect(second).not.toBeNull();
  expect(first).not.toBe(second);

  // Kill one renderer outright.
  process.kill(first!, "SIGKILL");
  expect(
    await settle(() =>
      seen.some((e) => e.ev === "tab_failed" && e.id === 11 && e.message.includes("exited")),
    ),
  ).toBe(true);
  expect(backend.liveTabs).toEqual([22]);

  // The survivor still answers.
  seen.length = 0;
  backend.send({ op: "tab_navigate", id: 22, url: `${base}/three` });
  backend.flush();
  expect(await settle(() => titled("three"))).toBe(true);

  backend.stop();
  server.stop(true);
}, 45000);
