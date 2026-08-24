// SPDX-License-Identifier: MIT OR Apache-2.0
//! Out-of-process Blitz renderer.
//!
//! Usage: bunsen-render-blitz-host <socket-path> <config-json>

fn main() {
    bunsen_protocol::host::main::<bunsen_render_blitz::BlitzRenderer>()
}
