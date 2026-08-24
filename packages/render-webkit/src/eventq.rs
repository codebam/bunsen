// SPDX-License-Identifier: MIT OR Apache-2.0
//! Event queue shared between the GTK thread (producer) and the Bun thread
//! (consumer), with an eventfd so the consumer can park instead of spin.

use std::sync::{Arc, Mutex};

use crate::protocol::Event;

pub struct EventQueue {
    pending: Mutex<Vec<Event>>,
    wakeup: i32,
}

impl EventQueue {
    pub fn new() -> Arc<Self> {
        // EFD_NONBLOCK | EFD_CLOEXEC; -1 is a soft failure, the shell falls
        // back to timer polling.
        let wakeup = unsafe { libc::eventfd(0, libc::EFD_NONBLOCK | libc::EFD_CLOEXEC) };
        Arc::new(Self {
            pending: Mutex::new(Vec::new()),
            wakeup,
        })
    }

    pub fn wakeup_fd(&self) -> i32 {
        self.wakeup
    }

    pub fn push(&self, ev: Event) {
        self.pending.lock().unwrap().push(ev);
        if self.wakeup >= 0 {
            let one: u64 = 1;
            unsafe {
                libc::write(
                    self.wakeup,
                    &one as *const u64 as *const libc::c_void,
                    std::mem::size_of::<u64>(),
                );
            }
        }
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
        // Reset the eventfd counter; a read of 8 bytes clears it.
        if self.wakeup >= 0 {
            let mut sink: u64 = 0;
            unsafe {
                libc::read(
                    self.wakeup,
                    &mut sink as *mut u64 as *mut libc::c_void,
                    std::mem::size_of::<u64>(),
                );
            }
        }
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
