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

## Runtime

- **Bun** — https://bun.sh — MIT. Executed as the host runtime; not linked into
  any Bunsen binary.
