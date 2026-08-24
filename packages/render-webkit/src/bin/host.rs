// SPDX-License-Identifier: MIT OR Apache-2.0
//! Out-of-process render host.
//!
//! Speaks exactly the protocol the cdylib speaks, over a Unix socket instead
//! of across an FFI boundary. That is the whole point of forbidding pointers
//! on the wire: the shell's transport becomes a deployment choice rather than
//! an architectural one, and a crashing renderer stops taking the browser
//! process down with it.
//!
//! Framing: u32 little-endian payload length, then that many bytes of the
//! same binary batch the ABI uses.
//!
//! Usage: bunsen-render-host <socket-path> <config-json>

use std::io::{Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::sync::Arc;

use bunsen_render_webkit::eventq::EventQueue;
use bunsen_render_webkit::protocol::Config;
use bunsen_render_webkit::ui;

fn main() {
    let mut args = std::env::args().skip(1);
    let (Some(socket_path), Some(config_json)) = (args.next(), args.next()) else {
        eprintln!("usage: bunsen-render-host <socket-path> <config-json>");
        std::process::exit(2);
    };

    let cfg: Config = match serde_json::from_str(&config_json) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("bunsen-render-host: bad config: {e}");
            std::process::exit(2);
        }
    };

    // Bind before the shell connects; it waits for the socket to appear.
    let _ = std::fs::remove_file(&socket_path);
    let listener = match UnixListener::bind(&socket_path) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("bunsen-render-host: cannot bind {socket_path}: {e}");
            std::process::exit(1);
        }
    };
    let stream = match listener.accept() {
        Ok((s, _)) => s,
        Err(e) => {
            eprintln!("bunsen-render-host: accept failed: {e}");
            std::process::exit(1);
        }
    };
    let _ = std::fs::remove_file(&socket_path);

    let (tx, rx) = async_channel::unbounded::<Vec<u8>>();
    let events = EventQueue::new();

    spawn_reader(stream.try_clone().expect("dup socket"), tx);
    spawn_writer(stream, events.clone());

    // GTK owns the main thread here, unlike in the cdylib where the host
    // process already has one.
    ui::run(cfg, rx, events.clone());
    events.shutdown();
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
