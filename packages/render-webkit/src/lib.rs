// SPDX-License-Identifier: MIT OR Apache-2.0
//! WebKitGTK render backend.
//!
//! Everything protocol-shaped lives in `bunsen-protocol`; all this crate adds
//! is a [`Renderer`] that happens to draw with WebKitGTK, plus the exported
//! symbols the macro generates from it.

mod ui;

use std::sync::Arc;

use bunsen_protocol::{Config, EventQueue, Renderer};

pub struct WebKitRenderer;

impl Renderer for WebKitRenderer {
    fn run(cfg: Config, commands: async_channel::Receiver<Vec<u8>>, events: Arc<EventQueue>) {
        ui::run(cfg, commands, events)
    }
}

bunsen_protocol::export_backend!(WebKitRenderer);
