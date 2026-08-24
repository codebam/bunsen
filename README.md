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
      src/eventq.rs            GTK-thread → Bun-thread queue + eventfd
      src/ui.rs                window, chrome view, one WebView per tab
      src/lib.rs               the five exported ABI functions
    packages/shell/            the Bun side
      src/backend/types.ts     the same contract, in TypeScript
      src/backend/ffi.ts       bun:ffi transport, one batch per microtask
      src/chrome/index.html    the browser UI (tabs, omnibox, progress)
      src/history.ts           bun:sqlite
      src/tabs.ts              tab model
      src/omnibox.ts           typed-text → URL
      src/main.ts              wiring

## Run

    nix develop
    ./run.sh

`BUNSEN_HOME_PAGE` overrides the start page; `BUNSEN_BACKEND_PATH` points at a
different backend `.so`.

## The boundary

Two rules make the seam cheap now and relocatable later:

1. **Batches, not calls.** The shell queues commands and flushes one
   `bunsen_backend_submit` per microtask. Cost is one FFI crossing per turn of
   the event loop, not one per operation.
2. **No pointers on the wire.** Everything crossing is a self-contained byte
   buffer. The same bytes travel over a socket to a sandboxed content process
   whenever that becomes worth doing — a transport change, not a redesign.

Encoding is JSON while the protocol is still moving. Swapping in a binary
format touches the two codecs and nothing else.

## Roadmap

- **Phase 0 — done.** Real browser on the system webview. Establishes the ABI.
- **Phase 1 — protocol hardening.** Binary encoding, eventfd-driven wakeups
  instead of the 8ms poll, per-tab process transport.
- **Phase 2 — Blitz backend.** Stylo + Taffy + Parley + Vello behind the same
  header. Shell code does not change.
- **Phase 3 — the rest of a browser.** Event dispatch, forms, session history,
  cookie/storage partitioning, HTTP cache, accessibility tree.

## License

Dual-licensed under **MIT OR Apache-2.0**, at your option — see
[`LICENSING.md`](./LICENSING.md) for why that pairing is compatible with the
LGPL libraries Bunsen links against, and [`NOTICE.md`](./NOTICE.md) for the
attributions binary releases must carry.
