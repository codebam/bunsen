// SPDX-License-Identifier: MIT OR Apache-2.0
//! Event queue shared between the GTK thread (producer) and the Bun thread
//! (consumer).
//!
//! A blocking eventfd carries the "something happened" signal to a notifier
//! thread, which pokes the shell. The shell then drains on its own thread.
//! The fd is never read by the drain path, so there is exactly one consumer
//! and no spinning.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use crate::protocol::Event;

pub struct EventQueue {
    pending: Mutex<Vec<Event>>,
    wakeup: i32,
    stopping: AtomicBool,
}

impl EventQueue {
    pub fn new() -> Arc<Self> {
        // Blocking on purpose: the notifier thread parks here.
        let wakeup = unsafe { libc::eventfd(0, libc::EFD_CLOEXEC) };
        Arc::new(Self {
            pending: Mutex::new(Vec::new()),
            wakeup,
            stopping: AtomicBool::new(false),
        })
    }

    pub fn push(&self, ev: Event) {
        self.pending.lock().unwrap().push(ev);
        self.signal();
    }

    /// Wake the notifier thread without enqueuing anything.
    pub fn signal(&self) {
        if self.wakeup < 0 {
            return;
        }
        let one: u64 = 1;
        unsafe {
            libc::write(
                self.wakeup,
                &one as *const u64 as *const libc::c_void,
                std::mem::size_of::<u64>(),
            );
        }
    }

    /// Park until at least one event has been pushed. Returns false once the
    /// queue is shutting down.
    pub fn wait(&self) -> bool {
        if self.wakeup < 0 {
            return false;
        }
        let mut count: u64 = 0;
        let n = unsafe {
            libc::read(
                self.wakeup,
                &mut count as *mut u64 as *mut libc::c_void,
                std::mem::size_of::<u64>(),
            )
        };
        n == std::mem::size_of::<u64>() as isize && !self.stopping.load(Ordering::Acquire)
    }

    pub fn shutdown(&self) {
        self.stopping.store(true, Ordering::Release);
        self.signal();
    }

    /// Serialize pending events into `out`. Returns bytes written, or None if
    /// `out` is too small — in which case nothing is consumed.
    pub fn drain_into(&self, out: &mut [u8]) -> Option<usize> {
        let mut pending = self.pending.lock().unwrap();
        if pending.is_empty() {
            return Some(0);
        }
        let bytes = serde_json::to_vec(&*pending).unwrap_or_else(|_| b"[]".to_vec());
        if bytes.len() > out.len() {
            return None;
        }
        out[..bytes.len()].copy_from_slice(&bytes);
        pending.clear();
        Some(bytes.len())
    }
}

impl Drop for EventQueue {
    fn drop(&mut self) {
        if self.wakeup >= 0 {
            unsafe { libc::close(self.wakeup) };
        }
    }
}
