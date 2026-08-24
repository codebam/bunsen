# Bunsen

A web browser with Bun as the JavaScript backend.

Bun is the browser process: tabs, history, omnibox, chrome UI, and eventually
extensions. Rendering lives behind a narrow C ABI in a separate shared object,
so the engine can be replaced without touching the shell — and without
forking Bun.

## Layout

    packages/render-webkit/    phase-0 backend: WebKitGTK (GTK4 + WebKit 6)
      include/bunsen_render.h  THE CONTRACT — read this first
      src/protocol.rs          command/event wire types (engine-agnostic)
      src/codec.rs             binary wire format + opcode table
      src/eventq.rs            GTK-thread → Bun-thread queue + wakeup eventfd
      src/bin/host.rs          out-of-process renderer, same protocol on a socket
      src/ui.rs                window, chrome view, one WebView per tab
      src/lib.rs               the five exported ABI functions
    packages/shell/            the Bun side
      src/backend/types.ts     the same contract, in TypeScript
      src/backend/codec.ts     the other half of the wire format
      src/backend/transport.ts bun:ffi and Unix-socket transports
      src/backend/client.ts    RenderBackend over a transport, one batch/microtask
      src/chrome/index.html    the browser UI (tabs, omnibox, progress)
      src/history.ts           bun:sqlite
      src/tabs.ts              tab model
      src/omnibox.ts           typed-text → URL
      src/main.ts              wiring

## Run

    nix run github:codebam/bunsen      # or, in a checkout: nix run .

From a checkout, for development:

    nix develop
    ./run.sh

### Environment

| Variable | Default | Effect |
| --- | --- | --- |
| `BUNSEN_HOME_PAGE` | `https://duckduckgo.com` | Start page |
| `BUNSEN_PROFILE` | `$XDG_DATA_HOME/bunsen/profile` | Cookies, storage, favicon DB |
| `BUNSEN_ENGINE` | `webkit` | `webkit` or `blitz` |
| `BUNSEN_TRANSPORT` | `ffi` | `ffi`, `socket`, or `process-per-tab` |
| `BUNSEN_EXTENSIONS_DIR` | `$BUNSEN_PROFILE/extensions` | Unpacked MV3 extensions |
| `BUNSEN_BACKEND_PATH` | build output | Which backend `.so` to load |
| `BUNSEN_HOST_PATH` | build output | Which render host binary to spawn |
| `BUNSEN_BLITZ_HOST_PATH` | build output | The Blitz host binary |

## Testing

    nix develop
    cargo test --manifest-path packages/render-webkit/Cargo.toml   # codec
    bun test packages/shell/src                                    # everything else

The suite is in three layers. The codec has round-trip and
malformed-input tests on both sides of the wire. The shell's omnibox, tab
store, and history are plain unit tests with no renderer involved. The backend
tests drive a real window against a local HTTP server and run the same
scenario over **both** transports — if in-process and out-of-process ever
diverge, that is where it shows. They need a display and skip themselves
without one, which is why CI runs everything else.

To try it by hand: `./run.sh`, then check that typing in the omnibox
navigates, `localhost:3000`-style input goes to http rather than a search,
ctrl-T/W/L work, middle-of-page links that open new tabs land beside their
opener, favicons appear, and a site you log into is still logged in after a
restart.

## What works, and what does not

Working: tabs, back/forward/reload/stop, omnibox with history suggestions,
history in SQLite, favicons, persistent cookies and storage per profile,
third-party cookies blocked, popup blocking, `target=_blank` opening real
tabs, a renderer that can run in-process, out-of-process, or one process per
tab, a second rendering engine, and MV3 extensions with background workers.

Half-working: **extensions** load and run their background service workers
with `storage`, `tabs` and `runtime` behind a permission check, but cannot
inject content scripts yet — that needs a DOM we own, which is what the Blitz
backend is for. See [`docs/extensions.md`](./docs/extensions.md).
**Process-per-tab** isolates renderers properly but gives each one its own
window, because nothing can composite them into one yet.

Not there yet: downloads, find-in-page, private windows, bookmarks, session
restore, zoom, and a settings UI.

## The boundary

Two rules make the seam cheap now and relocatable later:

1. **Batches, not calls.** The shell queues commands and flushes one
   `bunsen_backend_submit` per microtask. Cost is one FFI crossing per turn of
   the event loop, not one per operation.
2. **No pointers on the wire.** Everything crossing is a self-contained byte
   buffer. The same bytes travel over a socket to a sandboxed content process
   whenever that becomes worth doing — a transport change, not a redesign.

Encoding is a compact little-endian binary format — `packages/render-webkit/src/codec.rs`
and `packages/shell/src/backend/codec.ts` are the two halves and must be
edited together. Opcodes are the compatibility story: append, never renumber.
Only the startup config is JSON, because it crosses once and readability is
worth more than bytes there.

Events flow the other way without polling: a backend thread parks on an
eventfd and calls the wakeup callback registered by
`bunsen_backend_set_wakeup`, which on the Bun side is a threadsafe
`JSCallback` that schedules a drain on the JS loop.

### Transports

`BUNSEN_TRANSPORT=ffi` (default) loads the backend as a shared object and
passes batches by pointer. `BUNSEN_TRANSPORT=socket` spawns
`bunsen-render-host`, which speaks the identical protocol over a Unix socket
with a u32 length prefix per batch. Same bytes, same code above the transport.

Out-of-process is not just about crash isolation. GTK initialises once per
process, from one thread, so the FFI backend can be started exactly once and
never restarted — `bunsen_backend_start` returns NULL on a second attempt
rather than panicking somewhere unhelpful. Anything that needs a fresh
renderer needs a fresh process.

Note that WebKit already runs page content in its own processes, so phase 0
has content isolation regardless. What the socket transport adds is isolation
of *our* renderer code, and the plumbing that a per-tab split would be built
on. A literal tab-per-process split also needs cross-process window
embedding, which is a real piece of work and not yet done.

## Roadmap

- **Phase 0 — done.** Real browser on the system webview. Establishes the ABI.
- **Phase 1 — done.** Wakeup-driven event delivery (a notifier thread parks on
  an eventfd and pokes a threadsafe `JSCallback`; the 250ms timer is only a
  safety net), a binary wire format, and a transport abstraction with an
  out-of-process renderer behind it.
- **Phase 2 — Blitz backend.** Stylo + Taffy + Parley + Vello behind the same
  header. Shell code does not change.
- **Phase 3 — the rest of a browser.** Event dispatch, forms, session history,
  cookie/storage partitioning, HTTP cache, accessibility tree.

## License

Dual-licensed under **MIT OR Apache-2.0**, at your option — see
[`LICENSING.md`](./LICENSING.md) for why that pairing is compatible with the
LGPL libraries Bunsen links against, and [`NOTICE.md`](./NOTICE.md) for the
attributions binary releases must carry.
