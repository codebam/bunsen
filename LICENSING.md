# Licensing

Bunsen is dual-licensed under **MIT OR Apache-2.0**, at your option. This is
the standard Rust-ecosystem pairing: MIT for maximum permissiveness, Apache-2.0
for its explicit patent grant.

    SPDX-License-Identifier: MIT OR Apache-2.0

Contributions are accepted under the same dual license.

## Why this combination works with everything we link

| Dependency | License | Interaction |
| --- | --- | --- |
| Bun | MIT | Runtime host; we run on it, not link into it |
| WebKitGTK | LGPL-2.1-or-later + BSD-2-Clause | **Dynamically** linked |
| GTK4, GLib, GDK | LGPL-2.1-or-later | **Dynamically** linked |
| gtk4-rs, webkit6-rs, glib-rs | MIT | Permissive |
| serde, serde_json, libc, async-channel | MIT OR Apache-2.0 | Permissive |
| Blitz, Taffy, Parley, Vello, wgpu | Apache-2.0 OR MIT | Permissive |
| blitz-net (vendored, see NOTICE.md) | Apache-2.0 OR MIT | Copied with one change, upstream licence kept |
| Stylo (phase 2) | MPL-2.0 | File-level copyleft; see below |

### The LGPL libraries

GTK and WebKitGTK are LGPL. We link them dynamically and ship no modified
copies, which is exactly the case the LGPL carves out: our own source stays
under whatever license we choose, and downstream users retain the right to
swap in their own build of those libraries. Two obligations we must keep:

1. **Never statically link them** into a Bunsen binary without also shipping
   what the LGPL requires to relink.
2. **Distribute the LGPL license texts** alongside any binary release, with
   attribution and a pointer to each project's source.

`nix develop` and `run.sh` link dynamically, so a source checkout is already
compliant. Binary releases must carry the notices — see
[`NOTICE.md`](./NOTICE.md).

### Apache-2.0 and GPLv2

Apache-2.0 is incompatible with GPL**v2-only**. Nothing we depend on is
GPLv2-only: WebKitGTK and GTK are LGPL-2.1-**or-later**, which upgrades to
LGPL-3.0 and is compatible. Because we offer MIT as an alternative, anyone who
does hit a GPLv2 wall can simply take Bunsen under MIT.

### Stylo (phase 2)

Stylo is MPL-2.0, which is copyleft per *file*, not per *program*. Using it as
a dependency imposes nothing on our files. If we ever patch a Stylo source
file, that modified file must stay MPL-2.0 and be published — a normal upstream
contribution, not a relicensing event.

### JavaScriptCore

JSC reaches us inside Bun, which we run as a host process rather than link
into. Should a future phase embed JSC directly, note that it is
LGPL-2.1-or-later plus BSD-2-Clause and the dynamic-linking rules above apply
unchanged.
