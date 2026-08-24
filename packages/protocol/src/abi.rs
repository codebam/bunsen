// SPDX-License-Identifier: MIT OR Apache-2.0
//! The five C entry points, generic over a [`crate::Renderer`].
//!
//! A backend gets its ABI by calling [`export_backend!`]. Keeping the bodies
//! here rather than in each backend means the handle lifetime, the batching
//! contract and the GTK-style once-per-process rule are implemented once, and
//! a new backend cannot get them subtly wrong.
//!
//! See `include/bunsen_render.h` for the C view of all this.

use std::ffi::CStr;
use std::os::raw::c_char;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;

use crate::eventq::EventQueue;
use crate::protocol::Config;
use crate::Renderer;

pub const BUNSEN_OK: i32 = 0;
pub const BUNSEN_ERR: i32 = -1;
pub const BUNSEN_ERR_NOSPACE: i32 = -2;

/// Windowing toolkits initialise once, from one thread, per process — true of
/// both GTK and winit. A second in-process backend would panic somewhere deep
/// and unhelpful, so refuse it here. This is the sharpest argument for the
/// out-of-process host: it gets a fresh process, and so can be restarted.
static CLAIMED: AtomicBool = AtomicBool::new(false);

pub struct Backend {
    commands: async_channel::Sender<Vec<u8>>,
    events: Arc<EventQueue>,
    thread: Option<JoinHandle<()>>,
    notifier: Option<JoinHandle<()>>,
}

/// # Safety
/// `config_json` must be a valid NUL-terminated UTF-8 string.
pub unsafe fn start<R: Renderer>(config_json: *const c_char) -> *mut Backend {
    if config_json.is_null() {
        return std::ptr::null_mut();
    }
    let raw = unsafe { CStr::from_ptr(config_json) };
    let Some(cfg) = raw
        .to_str()
        .ok()
        .and_then(|s| serde_json::from_str::<Config>(s).ok())
    else {
        return std::ptr::null_mut();
    };

    if CLAIMED.swap(true, Ordering::SeqCst) {
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
            .spawn(move || R::run(cfg, rx, events))
            .ok()
    };
    let Some(thread) = thread else {
        return std::ptr::null_mut();
    };

    Box::into_raw(Box::new(Backend {
        commands: tx,
        events,
        thread: Some(thread),
        notifier: None,
    }))
}

/// # Safety
/// `b` must be a live handle and `buf` must point to `len` readable bytes.
pub unsafe fn submit(b: *mut Backend, buf: *const u8, len: usize) -> i32 {
    let Some(b) = (unsafe { b.as_ref() }) else {
        return BUNSEN_ERR;
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
/// `b` must be a live handle and `out` must point to `out_cap` writable bytes.
pub unsafe fn poll(b: *mut Backend, out: *mut u8, out_cap: usize) -> i32 {
    let Some(b) = (unsafe { b.as_ref() }) else {
        return BUNSEN_ERR;
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

/// # Safety
/// `b` must be a live handle; `callback` must outlive it.
pub unsafe fn set_wakeup(b: *mut Backend, callback: Option<extern "C" fn()>) -> i32 {
    let Some(backend) = (unsafe { b.as_mut() }) else {
        return BUNSEN_ERR;
    };
    let Some(callback) = callback else {
        return BUNSEN_ERR;
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
/// `b` must be a live handle and must not be used afterwards.
pub unsafe fn stop(b: *mut Backend) {
    if b.is_null() {
        return;
    }
    let mut backend = unsafe { Box::from_raw(b) };
    let _ = backend.commands.send_blocking(crate::codec::quit_batch());
    backend.commands.close();
    if let Some(t) = backend.thread.take() {
        let _ = t.join();
    }
    backend.events.shutdown();
    if let Some(t) = backend.notifier.take() {
        let _ = t.join();
    }
}

/// Emit the five exported symbols for a backend.
#[macro_export]
macro_rules! export_backend {
    ($renderer:ty) => {
        /// # Safety
        /// See `include/bunsen_render.h`.
        #[no_mangle]
        pub unsafe extern "C" fn bunsen_backend_start(
            config_json: *const ::std::os::raw::c_char,
        ) -> *mut $crate::abi::Backend {
            unsafe { $crate::abi::start::<$renderer>(config_json) }
        }

        /// # Safety
        /// See `include/bunsen_render.h`.
        #[no_mangle]
        pub unsafe extern "C" fn bunsen_backend_submit(
            b: *mut $crate::abi::Backend,
            buf: *const u8,
            len: usize,
        ) -> i32 {
            unsafe { $crate::abi::submit(b, buf, len) }
        }

        /// # Safety
        /// See `include/bunsen_render.h`.
        #[no_mangle]
        pub unsafe extern "C" fn bunsen_backend_poll(
            b: *mut $crate::abi::Backend,
            out: *mut u8,
            out_cap: usize,
        ) -> i32 {
            unsafe { $crate::abi::poll(b, out, out_cap) }
        }

        /// # Safety
        /// See `include/bunsen_render.h`.
        #[no_mangle]
        pub unsafe extern "C" fn bunsen_backend_set_wakeup(
            b: *mut $crate::abi::Backend,
            callback: Option<extern "C" fn()>,
        ) -> i32 {
            unsafe { $crate::abi::set_wakeup(b, callback) }
        }

        /// # Safety
        /// See `include/bunsen_render.h`.
        #[no_mangle]
        pub unsafe extern "C" fn bunsen_backend_stop(b: *mut $crate::abi::Backend) {
            unsafe { $crate::abi::stop(b) }
        }
    };
}
