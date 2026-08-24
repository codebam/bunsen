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
import { extensionIdFromUrl, install as installFromStore } from "./extensions/webstore";
import { Bookmarks } from "./bookmarks";
import { History } from "./history";
import { resolve as resolveOmnibox } from "./omnibox";
import { TabStore } from "./tabs";

const CHROME_HEIGHT = 76;
// Events start arriving during backend.start(), i.e. while this module is
// still evaluating, so anything the handler touches must be defined up here.
const DEBUG_EVENTS = Bun.env.BUNSEN_DEBUG_EVENTS === "1";
const HOME = Bun.env.BUNSEN_HOME_PAGE ?? "https://duckduckgo.com";
const BUILD = join(import.meta.dir, "../../../target/debug");
// Blitz is the default: it is the engine this project is aimed at, and the
// one whose DOM we own. It does not composite the chrome UI yet, so there is
// no tab strip or omnibox on it — BUNSEN_ENGINE=webkit is the way back to a
// browser with controls while that is built.
const ENGINE = Bun.env.BUNSEN_ENGINE ?? "blitz";
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
const bookmarks = new Bookmarks(join(PROFILE, "bookmarks.db"));
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
syncContentScripts();

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
      if (maybeInstallExtension(url, id)) return;
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

/**
 * Navigating to a Chrome Web Store listing installs the extension instead.
 *
 * The store's own pages need a Google-signed browser to render the install
 * button, so following the link would only ever show a page that cannot do
 * anything. Treating the URL as the install command is the honest behaviour:
 * the address is the identifier, and installing is what the user meant.
 *
 * Returns true if the URL was handled as an install.
 */
function maybeInstallExtension(url: string, tabId: number | null): boolean {
  const id = extensionIdFromUrl(url);
  if (!id) return false;

  backend.send({ op: "status", text: `Installing ${id}…` });
  void installFromStore(id, EXTENSIONS_DIR)
    .then(async ({ path }) => {
      const { extension, errors, warnings } = extensionHost.load(path, id);
      for (const warning of warnings) console.warn(`bunsen: ${id}: ${warning}`);
      if (!extension) {
        throw new Error(errors.join("; ") || "manifest rejected");
      }
      await extensionHost.startBackground(extension).catch((err) => {
        // A broken background worker is worth reporting but does not undo the
        // install: content scripts and the manifest are still usable.
        console.error(`bunsen: ${id} background worker: ${err}`);
      });
      syncContentScripts();
      backend.send({
        op: "status",
        text: `Installed ${extension.manifest.name} ${extension.manifest.version}`,
      });
    })
    .catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`bunsen: install ${id} failed: ${message}`);
      backend.send({ op: "status", text: `Install failed: ${message}` });
    });

  // Leave the tab where it was rather than navigating to a page that cannot
  // work; a brand new tab has nowhere to stay, so send it home.
  if (tabId !== null && tabs.get(tabId)?.url === "") {
    backend.send({ op: "tab_navigate", id: tabId, url: HOME });
  }
  return true;
}

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
      if (maybeInstallExtension(ev.url, null)) return;
      // ctrl-t asks for a tab without saying where; that means the home page.
      openTab(ev.url || HOME, ev.opener);
      return;
    case "tab_close_request":
      // The chrome bar's close button lives in the renderer, so closing is a
      // request rather than a fact: tab lifetime stays the shell's.
      closeTab(ev.id);
      return;
    case "bookmark_request": {
      const tab = tabs.get(ev.id);
      if (tab) {
        bookmarks.add(tab.url, tab.title);
        backend.send({ op: "status", text: `Bookmarked ${tab.title || tab.url}` });
      }
      return;
    }
    case "navigate_request": {
      // The renderer's omnibox hands us raw text; resolving it here is what
      // keeps one address-bar heuristic for the whole browser.
      const url = resolveOmnibox(ev.text);
      if (!maybeInstallExtension(url, ev.id)) {
        tabs.update(ev.id, { url, error: null });
        backend.send({ op: "tab_navigate", id: ev.id, url });
      }
      pushState();
      return;
    }
    case "page_event":
      void onPageEvent(ev.id, ev.payload);
      return;
    case "window_closed":
      return shutdown();
    case "ready":
      return;
  }
  pushState();
}

/**
 * A content script talking to its extension.
 *
 * Two shapes cross: `api` is a direct `browser.*` call, permission-checked
 * exactly as a background call is, and `sendMessage` is delivered to the
 * extension's background listeners. Both carry a ticket, and both must be
 * answered even on failure — a content script awaiting a reply that never
 * comes is a hung page.
 */
async function onPageEvent(tabId: number, raw: string): Promise<void> {
  let payload: any;
  try {
    payload = JSON.parse(raw);
  } catch {
    return;
  }
  if (!payload?.ticket || typeof payload.ext !== "string") return;

  const reply = (value: unknown) =>
    backend.send({
      op: "to_page",
      id: tabId,
      payload: JSON.stringify({ ticket: payload.ticket, value }),
    });

  try {
    if (payload.kind === "api") {
      reply(await extensionHost.callApi(payload.ext, payload.method, payload.params));
    } else if (payload.kind === "sendMessage") {
      const sender = { tab: { id: tabId }, id: payload.ext };
      reply(await extensionHost.sendToBackground(payload.ext, payload.message, sender));
    } else {
      reply({ error: `unknown page message: ${payload.kind}` });
    }
  } catch (err) {
    reply({ error: err instanceof Error ? err.message : String(err) });
  }
}

/** Tell the renderer which content scripts to inject, and where. */
function syncContentScripts(): void {
  backend.send({
    op: "set_content_scripts",
    json: JSON.stringify(extensionHost.contentScripts()),
  });
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

let shuttingDown = false;

function shutdown(): void {
  // Re-entrant on a second signal, and stopping the backend twice would
  // double-free the handle.
  if (shuttingDown) return;
  shuttingDown = true;

  extensionHost.stop();
  bookmarks.close();
  backend.flush();
  backend.stop();
  history.close();
  server.stop(true);
  process.exit(0);
}

// SIGTERM matters as much as SIGINT: it is what a service manager, a
// `timeout`, and a compositor closing the session all send. Without it the JS
// VM was torn down while the renderer's threads were still live and the
// threadsafe wakeup callback still had somewhere to call, which crashed Bun
// with SIGILL instead of exiting.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, shutdown);
}
