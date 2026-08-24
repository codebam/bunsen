// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * The same scenario over both transports. If in-process and out-of-process
 * ever diverge, this is where it shows up.
 */

import { expect, test } from "bun:test";
import { join } from "node:path";

import { createBackend, type TransportKind } from "./client";
import { FfiTransport } from "./transport";
import type { BackendEvent } from "./types";

const BUILD = join(import.meta.dir, "../../../../target/debug");
const LIB = Bun.env.BUNSEN_BACKEND_PATH ?? join(BUILD, "libbunsen_render_webkit.so");
const HOST = Bun.env.BUNSEN_HOST_PATH ?? join(BUILD, "bunsen-render-host");
const BLITZ_HOST =
  Bun.env.BUNSEN_BLITZ_HOST_PATH ?? join(BUILD, "bunsen-render-blitz-host");

const headless = !Bun.env.DISPLAY && !Bun.env.WAYLAND_DISPLAY;

for (const kind of ["ffi", "socket"] as TransportKind[]) {
  test.skipIf(headless)(`${kind}: loads a page and reports its state`, async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        new Response("<title>Bunsen Test Page</title><h1>hello</h1>", {
          headers: { "content-type": "text/html" },
        }),
    });
    const pageUrl = `http://127.0.0.1:${server.port}/`;

    const backend = createBackend(kind, { library: LIB, host: HOST });
    const seen: BackendEvent[] = [];
    backend.onEvent((ev) => seen.push(ev));

    await backend.start({ chrome_url: "about:blank", width: 640, height: 480 });

    backend.send({ op: "tab_create", id: 1, url: pageUrl });
    backend.send({ op: "tab_activate", id: 1 });
    backend.flush();

    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (seen.some((e) => e.ev === "tab_title" && e.title === "Bunsen Test Page")) break;
      await Bun.sleep(25);
    }
    backend.stop();
    server.stop(true);

    expect(seen.some((e) => e.ev === "ready")).toBe(true);
    expect(seen.some((e) => e.ev === "tab_title" && e.title === "Bunsen Test Page")).toBe(true);
    expect(seen.some((e) => e.ev === "tab_url" && e.url === pageUrl)).toBe(true);
    expect(seen.some((e) => e.ev === "tab_loading" && e.loading === false)).toBe(true);

    if (backend.transport instanceof FfiTransport) {
      // The wakeup callback, not the 250ms safety timer, delivered these.
      expect(backend.transport.stats.wakeups).toBeGreaterThan(0);
    }
  }, 30000);
}

test.skipIf(headless)("socket: a page opening a new window becomes a shell tab", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req) =>
      new URL(req.url).pathname === "/opened"
        ? new Response("<title>Opened</title>", { headers: { "content-type": "text/html" } })
        : new Response(
            `<title>Opener</title><a id="a" href="/opened" target="_blank">go</a>
             <script>addEventListener('load', () => document.getElementById('a').click())</script>`,
            { headers: { "content-type": "text/html" } },
          ),
  });

  const backend = createBackend("socket", { library: LIB, host: HOST });
  const seen: BackendEvent[] = [];
  backend.onEvent((ev) => seen.push(ev));
  // The click below carries no user gesture, so the popup blocker would
  // swallow it; this test is about the plumbing, not the policy.
  await backend.start({
    chrome_url: "about:blank",
    width: 640,
    height: 480,
    allow_popups: true,
  });

  backend.send({ op: "tab_create", id: 1, url: `http://127.0.0.1:${server.port}/` });
  backend.send({ op: "tab_activate", id: 1 });
  backend.flush();

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (seen.some((e) => e.ev === "tab_requested")) break;
    await Bun.sleep(25);
  }
  backend.stop();
  server.stop(true);

  const requested = seen.find((e) => e.ev === "tab_requested");
  expect(requested).toBeDefined();
  expect(requested).toMatchObject({ opener: 1 });
  expect((requested as { url: string }).url).toContain("/opened");
}, 30000);

test.skipIf(headless)("cookies survive a restart when a profile directory is set", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const seen = /bunsen=(\w+)/.exec(req.headers.get("cookie") ?? "")?.[1];
      return new Response(`<title>cookie:${seen ?? "none"}</title>`, {
        headers: {
          "content-type": "text/html",
          // No Secure flag: this is plain http on loopback.
          "set-cookie": "bunsen=remembered; Path=/; Max-Age=3600",
        },
      });
    },
  });
  const url = `http://127.0.0.1:${server.port}/`;
  const profile = join(
    Bun.env.TMPDIR ?? "/tmp",
    `bunsen-cookie-test-${process.pid}-${Date.now()}`,
  );

  const visit = async () => {
    // Socket transport on purpose: each visit is a separate renderer process,
    // which is both what a restart means and the only way to start a second
    // backend at all (GTK initialises once per process).
    const backend = createBackend("socket", { library: LIB, host: HOST });
    const titles: string[] = [];
    backend.onEvent((ev) => {
      if (ev.ev === "tab_title") titles.push(ev.title);
    });
    await backend.start({
      chrome_url: "about:blank",
      width: 400,
      height: 300,
      data_dir: profile,
      cache_dir: join(profile, "cache"),
    });
    backend.send({ op: "tab_create", id: 1, url });
    backend.flush();

    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && !titles.some((t) => t.startsWith("cookie:"))) {
      await Bun.sleep(25);
    }
    // The cookie jar is flushed to sqlite asynchronously.
    await Bun.sleep(500);
    backend.stop();
    return titles.filter((t) => t.startsWith("cookie:")).at(-1);
  };

  try {
    expect(await visit()).toBe("cookie:none");
    expect(await visit()).toBe("cookie:remembered");
  } finally {
    server.stop(true);
    await Bun.$`rm -rf ${profile}`.quiet().nothrow();
  }
}, 40000);

test.skipIf(headless)("blitz: the second backend answers the same protocol", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () =>
      new Response(
        "<title>Rendered by Blitz</title><style>h1{color:rebeccapurple}</style><h1>hello</h1>",
        { headers: { "content-type": "text/html" } },
      ),
  });
  const pageUrl = `http://127.0.0.1:${server.port}/`;

  // Socket transport only: two windowing toolkits cannot both own a process,
  // and the WebKit tests above already claimed this one.
  const backend = createBackend("socket", { library: LIB, host: BLITZ_HOST });
  const seen: BackendEvent[] = [];
  backend.onEvent((ev) => seen.push(ev));

  await backend.start({ chrome_url: "about:blank", width: 800, height: 600 });

  backend.send({ op: "tab_create", id: 1, url: pageUrl });
  backend.send({ op: "tab_activate", id: 1 });
  backend.flush();

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (seen.some((e) => e.ev === "tab_title" && e.title === "Rendered by Blitz")) break;
    await Bun.sleep(50);
  }
  backend.stop();
  server.stop(true);

  expect(seen.some((e) => e.ev === "ready")).toBe(true);
  expect(seen.some((e) => e.ev === "tab_title" && e.title === "Rendered by Blitz")).toBe(true);
  expect(seen.some((e) => e.ev === "tab_url" && e.url === pageUrl)).toBe(true);
  expect(seen.some((e) => e.ev === "tab_loading" && e.loading === false)).toBe(true);
}, 40000);
