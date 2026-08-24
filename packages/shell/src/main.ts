// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * Bunsen shell: the browser process.
 *
 * Bun owns tabs, history, the omnibox and the chrome UI. The render backend
 * owns pixels and nothing else. The two talk only through the command/event
 * batch protocol in ./backend.
 */

import { join } from "node:path";
import type { ServerWebSocket } from "bun";

import { FfiBackend } from "./backend/ffi";
import type { BackendEvent, RenderBackend } from "./backend/types";
import { History } from "./history";
import { resolve as resolveOmnibox } from "./omnibox";
import { TabStore } from "./tabs";

const CHROME_HEIGHT = 76;
const HOME = Bun.env.BUNSEN_HOME_PAGE ?? "https://duckduckgo.com";
const BACKEND_PATH =
  Bun.env.BUNSEN_BACKEND_PATH ??
  join(
    import.meta.dir,
    "../../render-webkit/target/debug/libbunsen_render_webkit.so",
  );

const history = new History();
const tabs = new TabStore();
const chromeSockets = new Set<ServerWebSocket<unknown>>();

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0, // ephemeral: never collide with whatever else is running
  development: false,

  async fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === "/chrome") {
      return srv.upgrade(req) ? undefined : new Response("upgrade failed", { status: 400 });
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(Bun.file(join(import.meta.dir, "chrome/index.html")));
    }
    if (url.pathname === "/history") {
      return Response.json(history.recent());
    }
    return new Response("not found", { status: 404 });
  },

  websocket: {
    open(ws) {
      chromeSockets.add(ws);
      pushState();
    },
    close(ws) {
      chromeSockets.delete(ws);
    },
    message(ws, raw) {
      let msg: any;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      handleChrome(ws, msg);
    },
  },
});

const chromeUrl = `http://127.0.0.1:${server.port}/`;
const backend: RenderBackend = new FfiBackend(BACKEND_PATH);

backend.onEvent(onBackendEvent);
await backend.start({
  chrome_url: chromeUrl,
  width: 1280,
  height: 860,
  chrome_height: CHROME_HEIGHT,
});

openTab(HOME);
console.log(`bunsen: chrome on ${chromeUrl}, backend ${BACKEND_PATH}`);

// ---------------------------------------------------------------- chrome UI

function handleChrome(ws: ServerWebSocket<unknown>, msg: any): void {
  const active = tabs.activeId;
  switch (msg.t) {
    case "navigate": {
      const id = active;
      if (id === null) return void openTab(resolveOmnibox(msg.url));
      const url = resolveOmnibox(msg.url);
      tabs.update(id, { url, error: null });
      backend.send({ op: "tab_navigate", id, url });
      pushState();
      break;
    }
    case "newtab":
      openTab(HOME);
      break;
    case "close":
      closeTab(msg.id ?? active);
      break;
    case "activate":
      tabs.activate(msg.id);
      backend.send({ op: "tab_activate", id: msg.id });
      pushState();
      break;
    case "back":
      if (active !== null) backend.send({ op: "tab_back", id: active });
      break;
    case "forward":
      if (active !== null) backend.send({ op: "tab_forward", id: active });
      break;
    case "reload":
      if (active !== null) backend.send({ op: "tab_reload", id: active });
      break;
    case "stop":
      if (active !== null) backend.send({ op: "tab_stop", id: active });
      break;
    case "suggest":
      ws.send(
        JSON.stringify({ t: "suggestions", items: history.suggest(msg.q) }),
      );
      break;
  }
}

function pushState(): void {
  const payload = JSON.stringify({
    t: "state",
    tabs: tabs.list(),
    activeId: tabs.activeId,
  });
  for (const ws of chromeSockets) ws.send(payload);
}

// ------------------------------------------------------------------- tabs

function openTab(url: string): void {
  const tab = tabs.create(url);
  backend.send({ op: "tab_create", id: tab.id, url });
  backend.send({ op: "tab_activate", id: tab.id });
  tabs.activate(tab.id);
  pushState();
}

function closeTab(id: number | null): void {
  if (id === null) return;
  backend.send({ op: "tab_close", id });
  const next = tabs.close(id);
  if (tabs.size === 0) return shutdown();
  if (next !== null) backend.send({ op: "tab_activate", id: next });
  pushState();
}

// --------------------------------------------------------- backend events

function onBackendEvent(ev: BackendEvent): void {
  switch (ev.ev) {
    case "tab_title":
      tabs.update(ev.id, { title: ev.title });
      break;
    case "tab_url":
      tabs.update(ev.id, { url: ev.url });
      break;
    case "tab_progress":
      tabs.update(ev.id, { progress: ev.progress });
      break;
    case "tab_loading": {
      const tab = tabs.update(ev.id, { loading: ev.loading });
      // Record on completion so redirects collapse into their destination.
      if (tab && !ev.loading && !tab.error) history.record(tab.url, tab.title);
      break;
    }
    case "tab_nav":
      tabs.update(ev.id, { canBack: ev.can_back, canForward: ev.can_forward });
      break;
    case "tab_failed":
      tabs.update(ev.id, { error: ev.message, loading: false });
      break;
    case "window_closed":
      return shutdown();
    case "ready":
      return;
  }
  pushState();
}

function shutdown(): void {
  backend.flush();
  backend.stop();
  history.close();
  server.stop(true);
  process.exit(0);
}

process.on("SIGINT", shutdown);
