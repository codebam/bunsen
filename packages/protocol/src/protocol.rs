// SPDX-License-Identifier: MIT OR Apache-2.0
//! Wire types for the backend ABI.
//!
//! Deliberately free of anything WebKit-specific: the Blitz backend will
//! reuse this module verbatim. Their encoding lives in [`crate::codec`];
//! only `Config` is JSON, because it crosses once at startup and readability
//! is worth more there than bytes.

use serde::Deserialize;

pub type TabId = u32;

#[derive(Debug, Deserialize)]
pub struct Config {
    pub chrome_url: String,
    #[serde(default = "default_width")]
    pub width: i32,
    #[serde(default = "default_height")]
    pub height: i32,
    #[serde(default = "default_chrome_height")]
    pub chrome_height: i32,
    /// Profile directory. Cookies, local storage and the favicon database
    /// live here; omit it for a session that forgets everything on exit.
    #[serde(default)]
    pub data_dir: Option<String>,
    #[serde(default)]
    pub cache_dir: Option<String>,
    /// Let scripts open windows without a user gesture. Off by default —
    /// that default *is* the popup blocker.
    #[serde(default)]
    pub allow_popups: bool,
}

fn default_width() -> i32 {
    1280
}
fn default_height() -> i32 {
    800
}
fn default_chrome_height() -> i32 {
    76
}

#[derive(Debug, PartialEq)]
pub enum Command {
    TabCreate { id: TabId, url: String },
    TabClose { id: TabId },
    TabActivate { id: TabId },
    TabNavigate { id: TabId, url: String },
    TabBack { id: TabId },
    TabForward { id: TabId },
    TabReload { id: TabId, bypass_cache: bool },
    TabStop { id: TabId },
    ChromeHeight { px: i32 },
    AppQuit,
}

#[derive(Debug, PartialEq)]
pub enum Event {
    Ready,
    TabTitle {
        id: TabId,
        title: String,
    },
    TabUrl {
        id: TabId,
        url: String,
    },
    TabProgress {
        id: TabId,
        progress: f64,
    },
    TabLoading {
        id: TabId,
        loading: bool,
    },
    TabNav {
        id: TabId,
        can_back: bool,
        can_forward: bool,
    },
    TabFailed {
        id: TabId,
        url: String,
        message: String,
    },
    TabFavicon {
        id: TabId,
        data_url: String,
    },
    /// The page asked for a new view (target=_blank, window.open). The backend
    /// declines to create one itself: tab lifetime is the shell's business, so
    /// it decides whether this becomes a tab and with what id.
    TabRequested {
        opener: TabId,
        url: String,
    },
    WindowClosed,
}
