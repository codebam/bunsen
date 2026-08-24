# Extensions

**Today: the browser half works, the page half does not.** Bunsen loads
unpacked MV3 extensions, runs their background service workers, and answers
`storage`, `tabs` and `runtime` calls with permissions enforced. It cannot yet
inject content scripts, because that needs a DOM we own. This document is
about that split, and why the second half arrives with Blitz.

## What is implemented

- **Manifest V3 loading** from `$BUNSEN_PROFILE/extensions/*/manifest.json`.
  Strict: an unsupported `manifest_version`, or MV2's `background.scripts`,
  is a load failure rather than a half-understood extension. Unknown
  permissions and malformed match patterns are dropped with a warning, never
  silently granted.
- **Match patterns**, the real ones — `*://*.example.com/*` matches
  `example.com` and its subdomains but not `evil-example.com`, a bare `*`
  scheme means web schemes and never `file:`, and path globs are anchored at
  both ends with regex metacharacters escaped.
- **Background service workers**, each in a Bun `Worker`. The extension gets
  no reference to anything of ours: `browser` and `chrome` are proxies whose
  only channel out is `postMessage`, and the only thing on the other end is a
  permission-checked dispatcher.
- **`browser.storage`** (`local`, `session`, `sync`) on SQLite, partitioned by
  extension id in the schema, with Chrome's 10MB quota enforced
  transactionally so an oversized write rolls back rather than half-lands.
- **`browser.tabs`** — `query`, `create`, `update`, `remove` — against the
  shell's own tab store.
- **`browser.runtime`** — `getManifest`, `getURL`, `sendMessage`.

Permissions are checked in exactly one place, and an API we have not built
throws `not implemented: browser.x.y` rather than being `undefined`, so an
extension can feature-detect us honestly.

## What is not, and why

## Why WebKitGTK cannot give us WebExtensions

WebKit has a WebExtensions implementation — `WKWebExtension` — and it is
Apple-platform only. The GTK port does not expose it. What WebKitGTK offers
instead is *web process extensions*: shared objects, written in C, loaded into
the web process, talking to the UI process over a private D-Bus-ish channel.
That is an embedder hook, not an extension system. With it you could
reimplement content-script injection and a slice of the `browser.*` surface
yourself, in C, per API, with no manifest support and no story for popups,
options pages, or the extension's own background context.

Content scripts are the gap. Everything above is browser plumbing that lives
in the shell; injection needs a DOM and an isolated world to inject into.
So on the WebKitGTK backend the honest options are:

1. Ship no extensions.
2. Patch WebKitGTK to expose `WKWebExtension`, and maintain that patch.
3. Build a private extension API that is not WebExtensions and that no
   existing extension targets.

We are doing (1). (2) is a WebKit fork, which is the thing this architecture
exists to avoid. (3) is work spent on an ecosystem of zero.

Two things that *look* like extensions are still reachable now, and are worth
having regardless:

- **User scripts and user stylesheets.** `WebKitUserContentManager` injects
  script and CSS at document-start or document-end, with world isolation and
  URL match patterns. That covers the Greasemonkey-shaped half of what people
  actually install extensions for. It is a small addition to the ABI:
  a `user_script_add` command and a message-handler event.
- **Content blocking.** WebKit ships a compiled content-blocker engine taking
  the same JSON rule format Safari uses, which is close enough to EasyList
  that converters exist. This is the single highest-value extension-shaped
  feature and it needs no extension system at all.

Neither is WebExtensions. Both are honest wins available on the current
backend.

## Why Blitz changes the answer

WebExtensions is not really a rendering feature. It is:

1. A manifest and packaging format.
2. Content scripts injected into a page's DOM, in an isolated world that
   shares the DOM but not the page's globals.
3. A `browser.*` / `chrome.*` API surface, most of which is browser plumbing:
   tabs, windows, storage, cookies, webRequest, alarms, messaging.
4. Background contexts, popups, and options pages — which are just more pages.
5. A permission model over all of it.

Look at what Bunsen already owns. Tabs, windows, history, cookies, storage,
and the chrome UI are all shell-side, in TypeScript, on Bun. That is most of
item 3 already sitting in the process that would implement it. Bun gives us
the background-context runtime for free, and `Bun.serve` already hosts chrome
pages, which is what popup and options pages are.

The part we do not own today is item 2, and that is precisely what phase 2
buys. With Blitz, the DOM lives in a Rust arena we control and scripts run in
a JSC we drive. Injecting a content script into an isolated world becomes a
thing we can implement, because we own both the world and the DOM it sees.
On WebKitGTK we own neither.

So the ordering is not "extensions later because we ran out of time". It is:
extensions are gated on owning the DOM, owning the DOM is phase 2, and every
piece of extension support that *isn't* gated on that — the tab/storage/cookie
APIs, the permission model, the manifest loader, the background-page runtime —
can be built on the shell side in the meantime and will carry over unchanged.

The realistic target is a useful subset: manifest v3 packaging, content
scripts, `storage`, `tabs`, `runtime` messaging, and declarative request
blocking. Full WebExtensions parity is a multi-year project for a funded team,
and pretending otherwise on a roadmap would be dishonest.

## What would land next

Item 3 below is done — see "What is implemented". The rest, in rough order of
value per unit of work:

1. Content blocking, on the WebKit backend, via WebKit's rule engine, driven
   by `declarativeNetRequest` rules from the manifest.
2. User scripts and stylesheets, on the WebKit backend, via
   `WebKitUserContentManager`.
3. ~~The shell-side halves of the extension API.~~ Done.
4. Popup and options pages, which are ordinary pages `Bun.serve` can host and
   the chrome UI can open.
5. Content-script injection, once the Blitz backend owns the DOM.
