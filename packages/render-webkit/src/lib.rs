// SPDX-License-Identifier: MIT OR Apache-2.0
#![deny(unsafe_op_in_unsafe_fn)]
//! Phase-0 Bunsen render backend: WebKitGTK behind `include/bunsen_render.h`.
//!
//! The exported surface is five functions. Everything else the shell wants to
//! say goes inside a command batch, so adding features never widens the ABI.

pub mod codec;
pub mod eventq;
pub mod protocol;
pub mod ui;

use std::ffi::CStr;
use std::os::raw::c_char;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;

use eventq::EventQueue;

// Every exported function is `unsafe`: they take raw pointers from a foreign
// caller, and the caller is the one who must guarantee those are the handles
// and buffers this library handed out. The bodies below still spell out each
// dereference explicitly rather than relying on the function-wide waiver.
use protocol::Config;

pub const BUNSEN_OK: i32 = 0;
pub const BUNSEN_ERR: i32 = -1;
pub const BUNSEN_ERR_NOSPACE: i32 = -2;

/// GTK may be initialised exactly once, from exactly one thread, per process.
/// A second in-process backend would panic inside gtk-rs, so refuse it here
/// with a return code the caller can act on. This is the sharpest reason to
/// prefer the out-of-process host: it gets a fresh process every time, and so
/// can be restarted after a crash.
static GTK_CLAIMED: AtomicBool = AtomicBool::new(false);

pub struct BunsenBackend {
    commands: async_channel::Sender<Vec<u8>>,
    events: Arc<EventQueue>,
    thread: Option<JoinHandle<()>>,
    notifier: Option<JoinHandle<()>>,
}

/// # Safety
/// `config_json` must be a valid NUL-terminated UTF-8 string. The returned
/// handle must be released with [`bunsen_backend_stop`] exactly once.
#[no_mangle]
pub unsafe extern "C" fn bunsen_backend_start(config_json: *const c_char) -> *mut BunsenBackend {
    if config_json.is_null() {
        return std::ptr::null_mut();
    }
    let raw = unsafe { CStr::from_ptr(config_json) };
    let cfg: Config = match raw.to_str().ok().and_then(|s| serde_json::from_str(s).ok()) {
        Some(c) => c,
        None => return std::ptr::null_mut(),
    };

    if GTK_CLAIMED.swap(true, Ordering::SeqCst) {
        eprintln!(
            "bunsen: a render backend already ran in this process; \
             use the out-of-process host instead"
        );
        return std::ptr::null_mut();
    }

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
        notifier: None,
    }))
}

/// # Safety
/// `b` must be a live handle from [`bunsen_backend_start`], and `buf` must
/// point to `len` readable bytes. The bytes are copied before returning.
#[no_mangle]
pub unsafe extern "C" fn bunsen_backend_submit(
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

/// # Safety
/// `b` must be a live handle from [`bunsen_backend_start`], and `out` must
/// point to `out_cap` writable bytes.
#[no_mangle]
pub unsafe extern "C" fn bunsen_backend_poll(
    b: *mut BunsenBackend,
    out: *mut u8,
    out_cap: usize,
) -> i32 {
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

/// Register a callback fired (from a dedicated thread) whenever events become
/// available, so the shell can stop polling on a timer. The callback must be
/// safe to invoke from a foreign thread; on the Bun side that means a
/// threadsafe JSCallback.
/// # Safety
/// `b` must be a live handle from [`bunsen_backend_start`], and `callback`
/// must remain valid until the handle is stopped. It is invoked from a
/// backend-owned thread.
#[no_mangle]
pub unsafe extern "C" fn bunsen_backend_set_wakeup(
    b: *mut BunsenBackend,
    callback: Option<extern "C" fn()>,
) -> i32 {
    let backend = match unsafe { b.as_mut() } {
        Some(b) => b,
        None => return BUNSEN_ERR,
    };
    let callback = match callback {
        Some(c) => c,
        None => return BUNSEN_ERR,
    };
    if backend.notifier.is_some() {
        return BUNSEN_ERR;
    }

    let events = backend.events.clone();
    backend.notifier = std::thread::Builder::new()
        .name("bunsen-notify".into())
        .spawn(move || {
            while events.wait() {
                callback();
            }
        })
        .ok();

    if backend.notifier.is_some() {
        BUNSEN_OK
    } else {
        BUNSEN_ERR
    }
}

/// # Safety
/// `b` must be a live handle from [`bunsen_backend_start`] and must not be
/// used afterwards. Safe to call with NULL.
#[no_mangle]
pub unsafe extern "C" fn bunsen_backend_stop(b: *mut BunsenBackend) {
    if b.is_null() {
        return;
    }
    let mut backend = unsafe { Box::from_raw(b) };
    // One AppQuit, hand-encoded: count=1, opcode, no fields.
    let mut quit = 1u32.to_le_bytes().to_vec();
    quit.extend_from_slice(&codec::op::APP_QUIT.to_le_bytes());
    let _ = backend.commands.send_blocking(quit);
    backend.commands.close();
    if let Some(t) = backend.thread.take() {
        let _ = t.join();
    }
    backend.events.shutdown();
    if let Some(t) = backend.notifier.take() {
        let _ = t.join();
    }
}
