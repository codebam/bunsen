// SPDX-License-Identifier: MIT OR Apache-2.0
//! Phase-0 Bunsen render backend: WebKitGTK behind `include/bunsen_render.h`.
//!
//! The exported surface is five functions. Everything else the shell wants to
//! say goes inside a command batch, so adding features never widens the ABI.

mod eventq;
mod protocol;
mod ui;

use std::ffi::CStr;
use std::os::raw::c_char;
use std::sync::Arc;
use std::thread::JoinHandle;

use eventq::EventQueue;
use protocol::Config;

pub const BUNSEN_OK: i32 = 0;
pub const BUNSEN_ERR: i32 = -1;
pub const BUNSEN_ERR_NOSPACE: i32 = -2;

pub struct BunsenBackend {
    commands: async_channel::Sender<Vec<u8>>,
    events: Arc<EventQueue>,
    thread: Option<JoinHandle<()>>,
}

#[no_mangle]
pub extern "C" fn bunsen_backend_start(config_json: *const c_char) -> *mut BunsenBackend {
    if config_json.is_null() {
        return std::ptr::null_mut();
    }
    let raw = unsafe { CStr::from_ptr(config_json) };
    let cfg: Config = match raw.to_str().ok().and_then(|s| serde_json::from_str(s).ok()) {
        Some(c) => c,
        None => return std::ptr::null_mut(),
    };

    let (tx, rx) = async_channel::unbounded::<Vec<u8>>();
    let events = EventQueue::new();

    let thread = {
        let events = events.clone();
        std::thread::Builder::new()
            .name("bunsen-ui".into())
            .spawn(move || ui::run(cfg, rx, events))
            .ok()
    };
    let thread = match thread {
        Some(t) => t,
        None => return std::ptr::null_mut(),
    };

    Box::into_raw(Box::new(BunsenBackend {
        commands: tx,
        events,
        thread: Some(thread),
    }))
}

#[no_mangle]
pub extern "C" fn bunsen_backend_submit(
    b: *mut BunsenBackend,
    buf: *const u8,
    len: usize,
) -> i32 {
    let b = match unsafe { b.as_ref() } {
        Some(b) => b,
        None => return BUNSEN_ERR,
    };
    if buf.is_null() {
        return BUNSEN_ERR;
    }
    let batch = unsafe { std::slice::from_raw_parts(buf, len) }.to_vec();
    match b.commands.send_blocking(batch) {
        Ok(()) => BUNSEN_OK,
        Err(_) => BUNSEN_ERR,
    }
}

#[no_mangle]
pub extern "C" fn bunsen_backend_poll(b: *mut BunsenBackend, out: *mut u8, out_cap: usize) -> i32 {
    let b = match unsafe { b.as_ref() } {
        Some(b) => b,
        None => return BUNSEN_ERR,
    };
    if out.is_null() {
        return BUNSEN_ERR;
    }
    let slice = unsafe { std::slice::from_raw_parts_mut(out, out_cap) };
    match b.events.drain_into(slice) {
        Some(n) => n as i32,
        None => BUNSEN_ERR_NOSPACE,
    }
}

#[no_mangle]
pub extern "C" fn bunsen_backend_wakeup_fd(b: *mut BunsenBackend) -> i32 {
    match unsafe { b.as_ref() } {
        Some(b) => b.events.wakeup_fd(),
        None => -1,
    }
}

#[no_mangle]
pub extern "C" fn bunsen_backend_stop(b: *mut BunsenBackend) {
    if b.is_null() {
        return;
    }
    let mut backend = unsafe { Box::from_raw(b) };
    let _ = backend.commands.send_blocking(br#"[{"op":"app_quit"}]"#.to_vec());
    backend.commands.close();
    if let Some(t) = backend.thread.take() {
        let _ = t.join();
    }
}
