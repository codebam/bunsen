// SPDX-License-Identifier: MIT OR Apache-2.0
//! Wire types for the backend ABI.
//!
//! Deliberately free of anything WebKit-specific: the Blitz backend will
//! reuse this module verbatim.

use serde::{Deserialize, Serialize};

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

#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Command {
    TabCreate { id: TabId, url: String },
    TabClose { id: TabId },
    TabActivate { id: TabId },
    TabNavigate { id: TabId, url: String },
    TabBack { id: TabId },
    TabForward { id: TabId },
    TabReload { id: TabId, #[serde(default)] bypass_cache: bool },
    TabStop { id: TabId },
    ChromeHeight { px: i32 },
    AppQuit,
}

#[derive(Debug, Serialize)]
#[serde(tag = "ev", rename_all = "snake_case")]
pub enum Event {
    Ready,
    TabTitle { id: TabId, title: String },
    TabUrl { id: TabId, url: String },
    TabProgress { id: TabId, progress: f64 },
    TabLoading { id: TabId, loading: bool },
    TabNav { id: TabId, can_back: bool, can_forward: bool },
    TabFailed { id: TabId, url: String, message: String },
    WindowClosed,
}
