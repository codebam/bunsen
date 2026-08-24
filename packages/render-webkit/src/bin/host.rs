// SPDX-License-Identifier: MIT OR Apache-2.0
//! Out-of-process WebKitGTK renderer.
//!
//! Usage: bunsen-render-host <socket-path> <config-json>

fn main() {
    bunsen_protocol::host::main::<bunsen_render_webkit::WebKitRenderer>()
}
