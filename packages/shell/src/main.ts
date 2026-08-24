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

import { createBackend, type TransportKind } from "./backend/client";
import type { BackendEvent } from "./backend/types";
import type { ShellBridge, TabView } from "./extensions/api";
import { ExtensionHost } from "./extensions/registry";
import { History } from "./history";
import { resolve as resolveOmnibox } from "./omnibox";
import { TabStore } from "./tabs";

const CHROME_HEIGHT = 76;
// Events start arriving during backend.start(), i.e. while this module is
// still evaluating, so anything the handler touches must be defined up here.
const DEBUG_EVENTS = Bun.env.BUNSEN_DEBUG_EVENTS === "1";
const HOME = Bun.env.BUNSEN_HOME_PAGE ?? "https://duckduckgo.com";
const BUILD = join(import.meta.dir, "../../../target/debug");
// `webkit` is the default because it is the one with a chrome UI. `blitz`
// renders with Stylo/Taffy/Vello and answers the identical protocol, but does
// not composite the chrome yet — see packages/render-blitz/src/lib.rs.
const ENGINE = Bun.env.BUNSEN_ENGINE ?? "webkit";
const BACKEND_PATH =
  Bun.env.BUNSEN_BACKEND_PATH ?? join(BUILD, "libbunsen_render_webkit.so");
// Each engine reads its own override. A single BUNSEN_HOST_PATH used to win
// over BUNSEN_ENGINE, so anything that sets it — the dev shell, the Nix
// wrapper — silently pinned the engine to WebKit while the banner still said
// blitz.
const HOST_PATH =
  ENGINE === "blitz"
    ? Bun.env.BUNSEN_BLITZ_HOST_PATH ?? join(BUILD, "bunsen-render-blitz-host")
    : Bun.env.BUNSEN_HOST_PATH ?? join(BUILD, "bunsen-render-host");
// FFI by default: one less context switch per batch. Socket puts the renderer
// in its own process, so a renderer crash costs the window, not the browser.
// Blitz has no in-process path here, since the shell process is already
// claimed by whichever toolkit got there first.
const TRANSPORT = (Bun.env.BUNSEN_TRANSPORT ??
  (ENGINE === "blitz" ? "socket" : "ffi")) as TransportKind;
const PROFILE =
  Bun.env.BUNSEN_PROFILE ??
  join(
    Bun.env.XDG_DATA_HOME ?? join(Bun.env.HOME ?? ".", ".local", "share"),
    "bunsen",
    "profile",
  );

const EXTENSIONS_DIR = Bun.env.BUNSEN_EXTENSIONS_DIR ?? join(PROFILE, "extensions");

// History belongs to the profile like everything else; it used to land in
// the default XDG path regardless of BUNSEN_PROFILE.
const history = new History(join(PROFILE, "history.db"));
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
const backend = createBackend(TRANSPORT, {
  library: BACKEND_PATH,
  host: HOST_PATH,
});

backend.onEvent(onBackendEvent);
await backend.start({
  chrome_url: chromeUrl,
  width: 1280,
  height: 860,
  chrome_height: CHROME_HEIGHT,
  // Cookies, local storage and the favicon database live here.
  data_dir: PROFILE,
  cache_dir: join(PROFILE, "cache"),
});

// Extensions come up after the renderer, so tabs.query has something to see.
const extensionHost = new ExtensionHost(join(PROFILE, "extensions.db"), shellBridge());
const extensionReport = extensionHost.loadAll(EXTENSIONS_DIR);
for (const { id, warnings } of extensionReport.warnings) {
  for (const warning of warnings) console.warn(`bunsen: ${id}: ${warning}`);
}
for (const { path, errors } of extensionReport.failures) {
  console.error(`bunsen: failed to load ${path}: ${errors.join("; ")}`);
}
for (const extension of extensionHost.extensions) {
  extensionHost.startBackground(extension).catch((err) => {
    console.error(`bunsen: ${extension.id} background worker: ${err}`);
  });
}

openTab(HOME);
console.log(
  `bunsen: chrome on ${chromeUrl}, engine ${ENGINE}, transport ${TRANSPORT}, profile ${PROFILE}`,
);

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

function openTab(url: string, opener?: number): void {
  const tab = tabs.create(url, opener);
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
  if (DEBUG_EVENTS) console.log("bunsen: event", JSON.stringify(ev));
  switch (ev.ev) {
    case "tab_title": {
      const tab = tabs.update(ev.id, { title: ev.title });
      // WebKit often settles the title after the load finishes, so the
      // history row already exists with the URL standing in for a title.
      if (tab && !tab.loading && !tab.error) history.retitle(tab.url, ev.title);
      break;
    }
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
    case "tab_favicon":
      tabs.update(ev.id, { favicon: ev.data_url });
      break;
    case "tab_requested":
      // target=_blank / window.open: the backend declined to make a view, so
      // the new tab is an ordinary shell-owned tab.
      openTab(ev.url, ev.opener);
      return;
    case "window_closed":
      return shutdown();
    case "ready":
      return;
  }
  pushState();
}

/** What the extension APIs are allowed to do to the browser. */
function shellBridge(): ShellBridge {
  const view = (id: number): TabView | null => {
    const tab = tabs.get(id);
    return tab
      ? {
          id: tab.id,
          url: tab.url,
          title: tab.title,
          active: tabs.activeId === tab.id,
          loading: tab.loading,
        }
      : null;
  };

  return {
    listTabs: () => tabs.list().map((t) => view(t.id)!).filter(Boolean),
    createTab: (url, active) => {
      const tab = tabs.create(url);
      backend.send({ op: "tab_create", id: tab.id, url });
      if (active) {
        tabs.activate(tab.id);
        backend.send({ op: "tab_activate", id: tab.id });
      }
      pushState();
      return view(tab.id)!;
    },
    updateTab: (id, changes) => {
      if (changes.url !== undefined) {
        tabs.update(id, { url: changes.url });
        backend.send({ op: "tab_navigate", id, url: changes.url });
      }
      if (changes.active) {
        tabs.activate(id);
        backend.send({ op: "tab_activate", id });
      }
      pushState();
      return view(id);
    },
    removeTab: (id) => closeTab(id),
    onExtensionMessage: (extension, message) => {
      // Nothing subscribes yet; the chrome UI is the eventual listener.
      console.log(`bunsen: message from ${extension}:`, message);
    },
  };
}

function shutdown(): void {
  extensionHost.stop();
  backend.flush();
  backend.stop();
  history.close();
  server.stop(true);
  process.exit(0);
}

process.on("SIGINT", shutdown);
