// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * Extensions, end to end, against the real Blitz renderer.
 *
 * This is the test that proves the whole chain rather than any one link: an
 * unpacked MV3 extension on disk, its content script injected into a matching
 * page by the renderer, `chrome.runtime.sendMessage` from that content script
 * reaching a background service worker running in a Bun Worker, the worker's
 * answer travelling back, and `chrome.storage` writes surviving the round
 * trip with permissions enforced on the way.
 *
 * It wires the same shell plumbing main.ts does, deliberately duplicated in
 * miniature so a break in either half shows up here rather than only in a
 * running browser.
 *
 * The socket transport is used on purpose: only one in-process renderer may
 * exist per process, and other test files claim it.
 */

import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createBackend } from "../backend/client";
import type { BackendEvent, RenderBackend } from "../backend/types";
import type { ShellBridge, TabView } from "./api";
import { ExtensionHost } from "./registry";

const HOST =
  Bun.env.BUNSEN_BLITZ_HOST_PATH ??
  join(import.meta.dir, "../../../../target/debug/bunsen-render-blitz-host");

const headless = !Bun.env.DISPLAY && !Bun.env.WAYLAND_DISPLAY;
const temporary: string[] = [];

afterAll(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function extensionTree(files: Record<string, string>, manifest: object): string {
  const root = mkdtempSync(join(tmpdir(), "bunsen-blitz-ext-"));
  temporary.push(root);
  const dir = join(root, "sample");
  mkdirSync(dir);
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return root;
}

/** The half of main.ts that mediates between the renderer and extensions. */
function wireShell(backend: RenderBackend, host: ExtensionHost): void {
  backend.onEvent((ev: BackendEvent) => {
    if (ev.ev !== "page_event") return;
    let payload: any;
    try {
      payload = JSON.parse(ev.payload);
    } catch {
      return;
    }
    if (!payload?.ticket) return;

    const reply = (value: unknown) =>
      backend.send({
        op: "to_page",
        id: ev.id,
        payload: JSON.stringify({ ticket: payload.ticket, value }),
      });

    const answer =
      payload.kind === "api"
        ? host.callApi(payload.ext, payload.method, payload.params)
        : host.sendToBackground(payload.ext, payload.message, { tab: { id: ev.id } });

    void answer
      .then(reply)
      .catch((err) => reply({ error: err instanceof Error ? err.message : String(err) }));
  });
}

test.skipIf(headless)(
  "a content script runs in the page and talks to its background worker",
  async () => {
    const root = extensionTree(
      {
        "content.js": `
          // Prove we can see the page's DOM, then ask the background for a
          // value and publish both through the title.
          const heading = document.getElementById("h").textContent;
          chrome.storage.local.set({ seen: heading }).then(async () => {
            const stored = await chrome.storage.local.get("seen");
            const answer = await chrome.runtime.sendMessage({ ask: "who" });
            document.title = "ext=" + heading + "|" + stored.seen + "|" + answer;
          });
        `,
        "bg.js": `
          chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
            sendResponse(msg.ask === "who" ? "background" : "unexpected");
          });
        `,
      },
      {
        manifest_version: 3,
        name: "Blitz Sample",
        version: "1.0",
        permissions: ["storage"],
        background: { service_worker: "bg.js", type: "module" },
        content_scripts: [
          { matches: ["http://127.0.0.1/*"], js: ["content.js"], run_at: "document_end" },
        ],
      },
    );

    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        new Response(`<title>page</title><body><h1 id="h">hello</h1></body>`, {
          headers: { "content-type": "text/html" },
        }),
    });

    const tabs: TabView[] = [];
    const shell: ShellBridge = {
      listTabs: () => tabs,
      createTab: (url, active) => {
        const tab = { id: 1, url, title: "", active, loading: false };
        tabs.push(tab);
        return tab;
      },
      updateTab: () => null,
      removeTab: () => {},
      onExtensionMessage: () => {},
    };

    const host = new ExtensionHost(":memory:", shell);
    const [extension] = host.loadAll(root).loaded;
    expect(extension).toBeDefined();
    await host.startBackground(extension);

    const backend = createBackend("socket", { library: "", host: HOST });
    const seen: BackendEvent[] = [];
    backend.onEvent((ev) => seen.push(ev));
    wireShell(backend, host);

    await backend.start({ chrome_url: "about:blank", width: 700, height: 500 });
    backend.send({
      op: "set_content_scripts",
      json: JSON.stringify(host.contentScripts()),
    });
    backend.send({ op: "tab_create", id: 1, url: `http://127.0.0.1:${server.port}/` });
    backend.send({ op: "tab_activate", id: 1 });
    backend.flush();

    const title = () =>
      seen
        .filter((e): e is BackendEvent & { title: string } => e.ev === "tab_title")
        .map((e) => e.title)
        .find((t) => t.startsWith("ext="));

    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && !title()) await Bun.sleep(100);

    backend.stop();
    server.stop(true);
    host.stop();

    // heading read from the page | value round-tripped through storage |
    // answer from the background worker
    expect(title()).toBe("ext=hello|hello|background");
  },
  60_000,
);

test.skipIf(headless)(
  "a content script is refused an API its manifest did not ask for",
  async () => {
    const root = extensionTree(
      {
        "content.js": `
          chrome.storage.local.get("anything")
            .then(() => { document.title = "denied=NO, it was allowed"; })
            .catch((err) => { document.title = "denied=" + err.message; });
        `,
      },
      {
        manifest_version: 3,
        name: "Greedy Content",
        version: "1.0",
        // No "storage" permission on purpose.
        content_scripts: [{ matches: ["http://127.0.0.1/*"], js: ["content.js"] }],
      },
    );

    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(`<title>page</title><body>x</body>`, {
        headers: { "content-type": "text/html" },
      }),
    });

    const shell: ShellBridge = {
      listTabs: () => [],
      createTab: (url, active) => ({ id: 1, url, title: "", active, loading: false }),
      updateTab: () => null,
      removeTab: () => {},
      onExtensionMessage: () => {},
    };
    const host = new ExtensionHost(":memory:", shell);
    const [extension] = host.loadAll(root).loaded;

    const backend = createBackend("socket", { library: "", host: HOST });
    const seen: BackendEvent[] = [];
    backend.onEvent((ev) => seen.push(ev));
    wireShell(backend, host);

    await backend.start({ chrome_url: "about:blank", width: 700, height: 500 });
    backend.send({ op: "set_content_scripts", json: JSON.stringify(host.contentScripts()) });
    backend.send({ op: "tab_create", id: 1, url: `http://127.0.0.1:${server.port}/` });
    backend.send({ op: "tab_activate", id: 1 });
    backend.flush();

    const title = () =>
      seen
        .filter((e): e is BackendEvent & { title: string } => e.ev === "tab_title")
        .map((e) => e.title)
        .find((t) => t.startsWith("denied="));

    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && !title()) await Bun.sleep(100);

    backend.stop();
    server.stop(true);
    host.stop();

    expect(extension).toBeDefined();
    expect(title()).toBe("denied=permission denied: storage");
  },
  60_000,
);
