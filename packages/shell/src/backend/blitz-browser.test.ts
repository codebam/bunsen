// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * Browser behaviour on the Blitz backend, as distinct from DOM/JS behaviour.
 *
 * These are the things that make a renderer a browser: a session that
 * survives navigation, history that goes back and forward, links that load,
 * and the chrome bar's requests reaching the shell. They run against the real
 * renderer over the socket transport, because only one in-process renderer
 * may exist per process and other suites claim it.
 */

import { afterAll, expect, test } from "bun:test";
import { join } from "node:path";

import { createBackend } from "./client";
import type { BackendEvent, RenderBackend } from "./types";

const HOST =
  Bun.env.BUNSEN_BLITZ_HOST_PATH ??
  join(import.meta.dir, "../../../../target/debug/bunsen-render-blitz-host");

const headless = !Bun.env.DISPLAY && !Bun.env.WAYLAND_DISPLAY;
const running: RenderBackend[] = [];

afterAll(() => {
  for (const b of running.splice(0)) b.stop();
});

async function renderer(): Promise<{ backend: RenderBackend; seen: BackendEvent[] }> {
  const backend = createBackend("socket", { library: "", host: HOST });
  running.push(backend);
  const seen: BackendEvent[] = [];
  backend.onEvent((ev) => seen.push(ev));
  await backend.start({ chrome_url: "about:blank", width: 700, height: 500 });
  return { backend, seen };
}

const titles = (seen: BackendEvent[]) =>
  seen.filter((e): e is BackendEvent & { title: string } => e.ev === "tab_title").map((e) => e.title);

async function waitFor(check: () => boolean, ms = 20_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && !check()) await Bun.sleep(50);
  return check();
}

test.skipIf(headless)("a session cookie survives the next navigation", async () => {
  // Without a cookie jar nothing stays logged in, which is the difference
  // between rendering a page and browsing.
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const seen = /session=(\w+)/.exec(req.headers.get("cookie") ?? "")?.[1];
      return new Response(`<title>cookie=${seen ?? "none"}</title><body>ok</body>`, {
        headers: { "content-type": "text/html", "set-cookie": "session=alive; Path=/" },
      });
    },
  });
  const base = `http://127.0.0.1:${server.port}`;

  const { backend, seen } = await renderer();
  backend.send({ op: "tab_create", id: 1, url: `${base}/one` });
  backend.send({ op: "tab_activate", id: 1 });
  backend.flush();
  expect(await waitFor(() => titles(seen).includes("cookie=none"))).toBe(true);

  backend.send({ op: "tab_navigate", id: 1, url: `${base}/two` });
  backend.flush();
  expect(await waitFor(() => titles(seen).includes("cookie=alive"))).toBe(true);

  server.stop(true);
}, 60_000);

test.skipIf(headless)("history goes back and forward", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req) =>
      new Response(`<title>page${new URL(req.url).pathname.slice(1)}</title><body>x</body>`, {
        headers: { "content-type": "text/html" },
      }),
  });
  const base = `http://127.0.0.1:${server.port}`;

  const { backend, seen } = await renderer();
  backend.send({ op: "tab_create", id: 7, url: `${base}/1` });
  backend.send({ op: "tab_activate", id: 7 });
  backend.flush();
  expect(await waitFor(() => titles(seen).includes("page1"))).toBe(true);

  backend.send({ op: "tab_navigate", id: 7, url: `${base}/2` });
  backend.flush();
  expect(await waitFor(() => titles(seen).includes("page2"))).toBe(true);

  // can_back only becomes true once there is somewhere to go back to.
  const nav = () =>
    seen.filter((e): e is BackendEvent & { can_back: boolean; can_forward: boolean } =>
      e.ev === "tab_nav");
  expect(await waitFor(() => nav().some((e) => e.can_back))).toBe(true);

  backend.send({ op: "tab_back", id: 7 });
  backend.flush();
  expect(
    await waitFor(() => titles(seen).lastIndexOf("page1") > titles(seen).indexOf("page2")),
  ).toBe(true);

  backend.send({ op: "tab_forward", id: 7 });
  backend.flush();
  expect(await waitFor(() => nav().some((e) => e.can_back && !e.can_forward))).toBe(true);

  server.stop(true);
}, 60_000);

/**
 * A scripted `a.click()` must navigate, not merely fire listeners: it is how
 * a great many sites move you between pages.
 */
test.skipIf(headless)("clicking a link from script navigates", async () => {
  // Blitz hands link clicks to the embedder rather than following them, so
  // this proves the navigation policy path, not just the DOM.
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      const body =
        path === "/target"
          ? `<title>arrived</title><body>done</body>`
          : `<title>start</title><body><a id="l" href="/target">go</a>
             <script>document.getElementById("l").click()</script></body>`;
      return new Response(body, { headers: { "content-type": "text/html" } });
    },
  });
  const base = `http://127.0.0.1:${server.port}`;

  const { backend, seen } = await renderer();
  backend.send({ op: "tab_create", id: 3, url: `${base}/` });
  backend.send({ op: "tab_activate", id: 3 });
  backend.flush();

  expect(await waitFor(() => titles(seen).includes("start"))).toBe(true);
  // A click either navigates the tab directly or is reported for the shell to
  // act on; both are correct, and either proves the path is wired.
  const followed = await waitFor(
    () =>
      titles(seen).includes("arrived") ||
      seen.some((e) => e.ev === "tab_requested" && e.url.includes("/target")) ||
      seen.some((e) => e.ev === "tab_url" && e.url.includes("/target")),
  );
  expect(followed).toBe(true);

  server.stop(true);
}, 60_000);

test.skipIf(headless)("a download link saves the file instead of navigating", async () => {
  // The renderer only reports the intent; the shell owns where files land and
  // what they are called. This proves both halves.
  const { mkdtempSync, existsSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "bunsen-dl-"));

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      if (new URL(req.url).pathname === "/file.txt") {
        return new Response("saved-by-bunsen", { headers: { "content-type": "text/plain" } });
      }
      return new Response(
        `<title>dl</title><body><a id="d" href="/file.txt" download="grabbed.txt">get</a>
         <script>document.getElementById("d").click()</script></body>`,
        { headers: { "content-type": "text/html" } },
      );
    },
  });

  const { Downloads } = await import("../downloads");
  const downloads = new Downloads(":memory:", dir);

  const { backend, seen } = await renderer();
  backend.onEvent((ev) => {
    if (ev.ev !== "download_request") return;
    void downloads
      .start(ev.url, ev.filename ? { filename: ev.filename } : {})
      .then((d) => downloads.settled(d.id));
  });

  backend.send({ op: "tab_create", id: 42, url: `http://127.0.0.1:${server.port}/` });
  backend.send({ op: "tab_activate", id: 42 });
  backend.flush();

  const asked = await waitFor(() => seen.some((e) => e.ev === "download_request"));
  expect(asked).toBe(true);

  const saved = join(dir, "grabbed.txt");
  expect(await waitFor(() => existsSync(saved), 15_000)).toBe(true);
  expect(readFileSync(saved, "utf8")).toBe("saved-by-bunsen");

  // The tab must NOT have navigated away to the file.
  expect(seen.some((e) => e.ev === "tab_url" && e.url.endsWith("/file.txt"))).toBe(false);

  downloads.close();
  server.stop(true);
}, 60_000);

test.skipIf(headless)("HTML entities are decoded, not shown literally", async () => {
  // The DOM holds text, not markup. Without decoding at parse time the
  // serializer escapes the ampersand again and the page shows "&nbsp;" — the
  // state every entity on a real page was in.
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () =>
      new Response(
        `<title>t</title><body><p id="p">a&nbsp;b &amp; c &#x2F; d &#39;e&#39; &quot;f&quot;</p>
         <a id="l" href="/x?a=1&amp;b=2">l</a>
         <script>
           var p = document.getElementById("p").textContent;
           var href = document.getElementById("l").getAttribute("href");
           document.title = "ent:" +
             (p.indexOf("&") === p.lastIndexOf("&") ? "amp=ok" : "amp=FAIL") + " " +
             (p.indexOf("nbsp") === -1 ? "nbsp=ok" : "nbsp=FAIL") + " " +
             (p.indexOf("/") !== -1 ? "slash=ok" : "slash=FAIL") + " " +
             (p.indexOf("'e'") !== -1 ? "apos=ok" : "apos=FAIL") + " " +
             (p.indexOf('"f"') !== -1 ? "quot=ok" : "quot=FAIL") + " " +
             (href === "/x?a=1&b=2" ? "href=ok" : "href=FAIL<" + href + ">");
         </script></body>`,
        { headers: { "content-type": "text/html" } },
      ),
  });

  const { backend, seen } = await renderer();
  backend.send({ op: "tab_create", id: 55, url: `http://127.0.0.1:${server.port}/` });
  backend.send({ op: "tab_activate", id: 55 });
  backend.flush();

  const reported = () => titles(seen).find((t) => t.startsWith("ent:"));
  expect(await waitFor(() => reported() !== undefined)).toBe(true);
  expect(reported()).toBe("ent:amp=ok nbsp=ok slash=ok apos=ok quot=ok href=ok");

  server.stop(true);
}, 60_000);
