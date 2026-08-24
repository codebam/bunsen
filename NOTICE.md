# Third-party notices

Bunsen itself is MIT OR Apache-2.0. Binary distributions include the following
third-party components. This file must ship with any binary release.

## Dynamically linked, LGPL-2.1-or-later

- **WebKitGTK** — https://webkitgtk.org — LGPL-2.1-or-later and BSD-2-Clause
- **GTK 4** — https://gitlab.gnome.org/GNOME/gtk — LGPL-2.1-or-later
- **GLib / GObject / GIO** — https://gitlab.gnome.org/GNOME/glib — LGPL-2.1-or-later
- **libsoup** — https://libsoup.gnome.org — LGPL-2.1-or-later

These are used unmodified and linked dynamically. Recipients may replace them
with their own builds. Full license texts accompany each upstream project;
copies are included in release archives under `licenses/`.

## Statically linked, permissive

Rust crates under MIT and/or Apache-2.0: `gtk4`, `webkit6`, `glib`,
`serde`, `serde_json`, `async-channel`, `libc`, and their transitive
dependencies. Run `cargo tree` for the exhaustive list, or
`cargo about generate` to regenerate this section mechanically.

## Vendored

- **blitz-net** — https://github.com/DioxusLabs/blitz — Apache-2.0 OR MIT.
  `packages/blitz-net-bunsen` is a copy of blitz-net 0.3.0-beta.1 with one
  change: the user agent is configurable. Upstream hardcodes a 2020 Firefox
  string and appends it after any caller-supplied header, so it cannot be
  overridden from outside the crate. The copy carries upstream's licence.

## Runtime

- **Bun** — https://bun.sh — MIT. Executed as the host runtime; not linked into
  any Bunsen binary.
