// SPDX-License-Identifier: MIT OR Apache-2.0
//! Binary wire format for the command/event batches.
//!
//! Layout, little-endian throughout:
//!
//! ```text
//! batch   := u32 count, message * count
//! message := u16 opcode, field*        (fields in the order declared below)
//! u32     := 4 bytes
//! f64     := 8 bytes, IEEE-754
//! bool    := 1 byte, 0 or 1
//! str     := u32 byte length, that many bytes of UTF-8
//! ```
//!
//! Opcodes are the whole compatibility story: never renumber one, only append.
//! An unknown opcode is a hard error rather than a skip, because without a
//! length prefix per message there is no way to resynchronise — and a shell
//! newer than its backend is a bug worth failing loudly on.

use crate::protocol::{Command, Event};

pub mod op {
    pub const TAB_CREATE: u16 = 1;
    pub const TAB_CLOSE: u16 = 2;
    pub const TAB_ACTIVATE: u16 = 3;
    pub const TAB_NAVIGATE: u16 = 4;
    pub const TAB_BACK: u16 = 5;
    pub const TAB_FORWARD: u16 = 6;
    pub const TAB_RELOAD: u16 = 7;
    pub const TAB_STOP: u16 = 8;
    pub const CHROME_HEIGHT: u16 = 9;
    pub const APP_QUIT: u16 = 10;
    pub const SET_CONTENT_SCRIPTS: u16 = 11;
    pub const STATUS: u16 = 12;
    pub const TO_PAGE: u16 = 13;
}

pub mod ev {
    pub const READY: u16 = 1;
    pub const TAB_TITLE: u16 = 2;
    pub const TAB_URL: u16 = 3;
    pub const TAB_PROGRESS: u16 = 4;
    pub const TAB_LOADING: u16 = 5;
    pub const TAB_NAV: u16 = 6;
    pub const TAB_FAILED: u16 = 7;
    pub const TAB_FAVICON: u16 = 8;
    pub const TAB_REQUESTED: u16 = 9;
    pub const WINDOW_CLOSED: u16 = 10;
    pub const TAB_CLOSE_REQUEST: u16 = 11;
    pub const PAGE_EVENT: u16 = 12;
    pub const BOOKMARK_REQUEST: u16 = 13;
    pub const NAVIGATE_REQUEST: u16 = 14;
}

/// A batch holding a single AppQuit, which the ABI's stop path needs to send
/// without building a command vector.
pub fn quit_batch() -> Vec<u8> {
    let mut buf = 1u32.to_le_bytes().to_vec();
    buf.extend_from_slice(&op::APP_QUIT.to_le_bytes());
    buf
}

#[derive(Debug)]
pub struct DecodeError(pub &'static str);

impl std::fmt::Display for DecodeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "malformed batch: {}", self.0)
    }
}

// ------------------------------------------------------------------ reading

struct Reader<'a> {
    buf: &'a [u8],
    at: usize,
}

impl<'a> Reader<'a> {
    fn new(buf: &'a [u8]) -> Self {
        Self { buf, at: 0 }
    }

    fn take(&mut self, n: usize) -> Result<&'a [u8], DecodeError> {
        let end = self
            .at
            .checked_add(n)
            .ok_or(DecodeError("length overflow"))?;
        let slice = self.buf.get(self.at..end).ok_or(DecodeError("truncated"))?;
        self.at = end;
        Ok(slice)
    }

    fn u16(&mut self) -> Result<u16, DecodeError> {
        Ok(u16::from_le_bytes(self.take(2)?.try_into().unwrap()))
    }

    fn u32(&mut self) -> Result<u32, DecodeError> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }

    fn i32(&mut self) -> Result<i32, DecodeError> {
        Ok(self.u32()? as i32)
    }

    fn bool(&mut self) -> Result<bool, DecodeError> {
        Ok(self.take(1)?[0] != 0)
    }

    fn str(&mut self) -> Result<String, DecodeError> {
        let len = self.u32()? as usize;
        let bytes = self.take(len)?;
        String::from_utf8(bytes.to_vec()).map_err(|_| DecodeError("invalid utf-8"))
    }
}

pub fn decode_commands(buf: &[u8]) -> Result<Vec<Command>, DecodeError> {
    let mut r = Reader::new(buf);
    let count = r.u32()? as usize;
    // A count is not a length, so it cannot be trusted to size an allocation.
    let mut out = Vec::with_capacity(count.min(1024));
    for _ in 0..count {
        out.push(match r.u16()? {
            op::TAB_CREATE => Command::TabCreate {
                id: r.u32()?,
                url: r.str()?,
            },
            op::TAB_CLOSE => Command::TabClose { id: r.u32()? },
            op::TAB_ACTIVATE => Command::TabActivate { id: r.u32()? },
            op::TAB_NAVIGATE => Command::TabNavigate {
                id: r.u32()?,
                url: r.str()?,
            },
            op::TAB_BACK => Command::TabBack { id: r.u32()? },
            op::TAB_FORWARD => Command::TabForward { id: r.u32()? },
            op::TAB_RELOAD => Command::TabReload {
                id: r.u32()?,
                bypass_cache: r.bool()?,
            },
            op::TAB_STOP => Command::TabStop { id: r.u32()? },
            op::CHROME_HEIGHT => Command::ChromeHeight { px: r.i32()? },
            op::SET_CONTENT_SCRIPTS => Command::SetContentScripts { json: r.str()? },
            op::STATUS => Command::Status { text: r.str()? },
            op::TO_PAGE => Command::ToPage {
                id: r.u32()?,
                payload: r.str()?,
            },
            op::APP_QUIT => Command::AppQuit,
            _ => return Err(DecodeError("unknown opcode")),
        });
    }
    if r.at != buf.len() {
        return Err(DecodeError("trailing bytes"));
    }
    Ok(out)
}

// ------------------------------------------------------------------ writing

struct Writer(Vec<u8>);

impl Writer {
    fn u16(&mut self, v: u16) {
        self.0.extend_from_slice(&v.to_le_bytes());
    }
    fn u32(&mut self, v: u32) {
        self.0.extend_from_slice(&v.to_le_bytes());
    }
    fn f64(&mut self, v: f64) {
        self.0.extend_from_slice(&v.to_le_bytes());
    }
    fn bool(&mut self, v: bool) {
        self.0.push(v as u8);
    }
    fn str(&mut self, v: &str) {
        self.u32(v.len() as u32);
        self.0.extend_from_slice(v.as_bytes());
    }
}

pub fn encode_events(events: &[Event]) -> Vec<u8> {
    let mut w = Writer(Vec::with_capacity(64 + events.len() * 24));
    w.u32(events.len() as u32);
    for e in events {
        match e {
            Event::Ready => w.u16(ev::READY),
            Event::TabTitle { id, title } => {
                w.u16(ev::TAB_TITLE);
                w.u32(*id);
                w.str(title);
            }
            Event::TabUrl { id, url } => {
                w.u16(ev::TAB_URL);
                w.u32(*id);
                w.str(url);
            }
            Event::TabProgress { id, progress } => {
                w.u16(ev::TAB_PROGRESS);
                w.u32(*id);
                w.f64(*progress);
            }
            Event::TabLoading { id, loading } => {
                w.u16(ev::TAB_LOADING);
                w.u32(*id);
                w.bool(*loading);
            }
            Event::TabNav {
                id,
                can_back,
                can_forward,
            } => {
                w.u16(ev::TAB_NAV);
                w.u32(*id);
                w.bool(*can_back);
                w.bool(*can_forward);
            }
            Event::TabFailed { id, url, message } => {
                w.u16(ev::TAB_FAILED);
                w.u32(*id);
                w.str(url);
                w.str(message);
            }
            Event::TabFavicon { id, data_url } => {
                w.u16(ev::TAB_FAVICON);
                w.u32(*id);
                w.str(data_url);
            }
            Event::TabRequested { opener, url } => {
                w.u16(ev::TAB_REQUESTED);
                w.u32(*opener);
                w.str(url);
            }
            Event::WindowClosed => w.u16(ev::WINDOW_CLOSED),
            Event::TabCloseRequest { id } => {
                w.u16(ev::TAB_CLOSE_REQUEST);
                w.u32(*id);
            }
            Event::PageEvent { id, payload } => {
                w.u16(ev::PAGE_EVENT);
                w.u32(*id);
                w.str(payload);
            }
            Event::NavigateRequest { id, text } => {
                w.u16(ev::NAVIGATE_REQUEST);
                w.u32(*id);
                w.str(text);
            }
            Event::BookmarkRequest { id } => {
                w.u16(ev::BOOKMARK_REQUEST);
                w.u32(*id);
            }
        }
    }
    w.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_truncated_and_trailing_input() {
        // count says one message, buffer holds none
        assert!(decode_commands(&[1, 0, 0, 0]).is_err());
        // count says none, buffer holds bytes
        assert!(decode_commands(&[0, 0, 0, 0, 7]).is_err());
        // a string longer than the buffer must not panic
        let mut bad = vec![1, 0, 0, 0, 1, 0, 9, 0, 0, 0];
        bad.extend_from_slice(&u32::MAX.to_le_bytes());
        assert!(decode_commands(&bad).is_err());
    }

    #[test]
    fn rejects_unknown_opcodes() {
        assert!(decode_commands(&[1, 0, 0, 0, 0xff, 0xff]).is_err());
    }

    #[test]
    fn empty_batch_round_trips() {
        assert!(decode_commands(&[0, 0, 0, 0]).unwrap().is_empty());
        assert_eq!(encode_events(&[]), vec![0, 0, 0, 0]);
    }
}
