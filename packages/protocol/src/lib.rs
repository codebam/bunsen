// SPDX-License-Identifier: MIT OR Apache-2.0
//! The contract every Bunsen render backend implements.
//!
//! Nothing in this crate knows what draws the pixels. WebKitGTK and Blitz both
//! depend on it, which is what keeps the two honest: a change that only makes
//! sense for one of them cannot be expressed here.
//!
//! - [`protocol`] — the command and event types
//! - [`codec`] — their binary encoding, and the opcode table
//! - [`eventq`] — the renderer-thread to shell-thread handoff
//! - [`abi`] — the five C entry points, generic over a backend
//! - [`host`] — the same protocol over a Unix socket, for out-of-process use

pub mod abi;
pub mod codec;
pub mod eventq;
pub mod host;
pub mod protocol;

use std::sync::Arc;

pub use eventq::EventQueue;
pub use protocol::{Command, Config, Event, TabId};

/// What a backend must provide: run a window until it closes.
///
/// The call owns the calling thread. Commands arrive decoded on `commands`;
/// events go out through `events`. Returning means the window is gone.
pub trait Renderer {
    fn run(cfg: Config, commands: async_channel::Receiver<Vec<u8>>, events: Arc<EventQueue>);
}
