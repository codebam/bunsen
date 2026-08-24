// SPDX-License-Identifier: MIT OR Apache-2.0
//! Blitz render backend: Stylo for CSS, Taffy for layout, Parley for text,
//! Vello on wgpu for paint — behind the same ABI WebKitGTK sits behind.
//!
//! This is the backend the project is actually aimed at. The DOM lives in
//! Rust where we can reach it, which is the precondition for content scripts,
//! and therefore for extensions. See `docs/extensions.md`.
//!
//! What it does not do yet is composite the chrome UI. Blitz binds one
//! document to one window, and the chrome is a second document; putting both
//! in one window needs either iframe support in Blitz or a compositing layer
//! of our own. Until then this backend renders the active tab full-window and
//! the shell drives it headlessly. That is why it is not the default.

mod app;
mod fetch;
mod tabs;

use std::sync::Arc;

use bunsen_protocol::{Config, EventQueue, Renderer};

pub struct BlitzRenderer;

impl Renderer for BlitzRenderer {
    fn run(cfg: Config, commands: async_channel::Receiver<Vec<u8>>, events: Arc<EventQueue>) {
        app::run(cfg, commands, events)
    }
}

bunsen_protocol::export_backend!(BlitzRenderer);
