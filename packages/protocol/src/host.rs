// SPDX-License-Identifier: MIT OR Apache-2.0
//! The same protocol over a Unix socket.
//!
//! This is what forbidding pointers on the wire bought: the identical batches
//! the ABI passes by pointer travel over a socket with a u32 length prefix,
//! and the shell above cannot tell the difference. A renderer that crashes
//! here takes a window with it, not the browser.

use std::io::{Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::sync::Arc;

use crate::eventq::EventQueue;
use crate::protocol::Config;
use crate::Renderer;

/// Bind `socket_path`, wait for the shell, then run the renderer on this
/// thread until its window closes. Returns the process exit code.
pub fn serve<R: Renderer>(socket_path: &str, config_json: &str) -> i32 {
    let cfg: Config = match serde_json::from_str(config_json) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("bunsen-render-host: bad config: {e}");
            return 2;
        }
    };

    let _ = std::fs::remove_file(socket_path);
    let listener = match UnixListener::bind(socket_path) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("bunsen-render-host: cannot bind {socket_path}: {e}");
            return 1;
        }
    };
    let stream = match listener.accept() {
        Ok((s, _)) => s,
        Err(e) => {
            eprintln!("bunsen-render-host: accept failed: {e}");
            return 1;
        }
    };
    let _ = std::fs::remove_file(socket_path);

    let (tx, rx) = async_channel::unbounded::<Vec<u8>>();
    let events = EventQueue::new();

    spawn_reader(stream.try_clone().expect("dup socket"), tx);
    spawn_writer(stream, events.clone());

    // The windowing toolkit owns the main thread here, unlike in the cdylib
    // where the host process already had one.
    R::run(cfg, rx, events.clone());
    events.shutdown();
    0
}

/// Socket to command channel.
fn spawn_reader(mut stream: UnixStream, tx: async_channel::Sender<Vec<u8>>) {
    std::thread::spawn(move || {
        let mut header = [0u8; 4];
        loop {
            if stream.read_exact(&mut header).is_err() {
                break; // shell closed the connection
            }
            let len = u32::from_le_bytes(header) as usize;
            let mut payload = vec![0u8; len];
            if stream.read_exact(&mut payload).is_err() {
                break;
            }
            if tx.send_blocking(payload).is_err() {
                break;
            }
        }
        tx.close();
    });
}

/// Event queue to socket. Parks on the same eventfd the FFI notifier uses.
fn spawn_writer(mut stream: UnixStream, events: Arc<EventQueue>) {
    std::thread::spawn(move || {
        while events.wait() {
            let Some(batch) = events.drain() else {
                continue;
            };
            let header = (batch.len() as u32).to_le_bytes();
            if stream.write_all(&header).is_err() || stream.write_all(&batch).is_err() {
                break;
            }
            let _ = stream.flush();
        }
    });
}

/// Standard entry point for a backend's host binary.
pub fn main<R: Renderer>() -> ! {
    let mut args = std::env::args().skip(1);
    let (Some(socket_path), Some(config_json)) = (args.next(), args.next()) else {
        eprintln!("usage: <host> <socket-path> <config-json>");
        std::process::exit(2);
    };
    std::process::exit(serve::<R>(&socket_path, &config_json))
}
