// SPDX-License-Identifier: MIT OR Apache-2.0
//! The in-window chrome: tab strip and omnibox, drawn by the same engine as
//! the page.
//!
//! Blitz binds one document to one window, so a second "chrome document" is
//! not an option yet. Instead every installed document gets the chrome bar
//! injected into its `<body>`, and input events in the bar's band are routed
//! here before Blitz ever sees them — clicks become hit-tests against our own
//! model, keystrokes edit our own omnibox string, and any change re-serializes
//! the cached page HTML with fresh chrome. Crude, entirely ours, and it makes
//! this backend an actual browser rather than a headless renderer.

/// Layout constants, logical pixels.
const ROW1: f64 = 36.0;
const BTN_W: f64 = 34.0;
const OMNI_PAD: f64 = 8.0;
const TAB_MIN: f64 = 52.0;
const TAB_MAX: f64 = 220.0;
const CLOSE_W: f64 = 22.0;
const PLUS_W: f64 = 30.0;
const GAP: f64 = 2.0;

#[derive(Debug, Clone)]
pub struct TabInfo {
    pub id: u32,
    pub title: String,
    pub active: bool,
    pub loading: bool,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Hit {
    Back,
    Forward,
    Reload,
    Omnibox,
    Tab(u32),
    TabClose(u32),
    NewTab,
    Page,
}

#[derive(Debug, Default)]
pub struct Chrome {
    pub height: f64,
    pub viewport_w: f64,
    pub tabs: Vec<TabInfo>,
    pub active: Option<u32>,
    pub omnibox: String,
    pub focused: bool,
    pub status: String,
    pub can_back: bool,
    pub can_forward: bool,
    pub loading: bool,
}

impl Chrome {
    pub fn new(height: i32) -> Self {
        Self {
            height: height.max(48) as f64,
            ..Default::default()
        }
    }

    /// Rebuild the tab list from backend truth. Titles come from tabs; the
    /// omnibox tracks the active tab's URL unless the user is typing.
    pub fn sync_tabs(
        &mut self,
        order: &[(u32, String)],
        active: Option<u32>,
        can_back: bool,
        can_forward: bool,
        loading: bool,
        url: &str,
    ) {
        self.tabs = order
            .iter()
            .map(|(id, title)| TabInfo {
                id: *id,
                title: title.clone(),
                active: Some(*id) == active,
                loading: loading && Some(*id) == active,
            })
            .collect();
        self.active = active;
        self.can_back = can_back;
        self.can_forward = can_forward;
        self.loading = loading;
        if !self.focused {
            self.omnibox = url.to_string();
        }
    }

    /// Map a click (logical px) to an action. Row 1 is buttons + omnibox; row
    /// 2 is the tab strip.
    pub fn hit_test(&self, x: f64, y: f64) -> Hit {
        if y < 0.0 || y >= self.height || self.viewport_w <= 0.0 {
            return Hit::Page;
        }
        if y < ROW1 {
            if x < BTN_W {
                return Hit::Back;
            }
            if x < BTN_W * 2.0 + GAP {
                return Hit::Forward;
            }
            if x < BTN_W * 3.0 + GAP * 2.0 {
                return Hit::Reload;
            }
            let right = self.viewport_w - OMNI_PAD - BTN_W;
            return if x >= BTN_W * 3.0 + OMNI_PAD && x <= right {
                Hit::Omnibox
            } else {
                Hit::Page
            };
        }

        let n = self.tabs.len() as f64;
        let row2 = self.height - ROW1;
        let ty = y - ROW1;
        if ty < row2 * 0.25 {
            // A thin gutter above tabs: treat as page so drags still work.
            return Hit::Page;
        }
        let avail = self.viewport_w - PLUS_W - GAP * 2.0;
        let tw = tab_width(n.max(1.0), avail);
        let mut x0 = 4.0;
        for t in &self.tabs {
            if x >= x0 && x < x0 + tw {
                return if x >= x0 + tw - CLOSE_W {
                    Hit::TabClose(t.id)
                } else {
                    Hit::Tab(t.id)
                };
            }
            x0 += tw + GAP;
        }
        if x >= x0 && x < x0 + PLUS_W {
            return Hit::NewTab;
        }
        Hit::Page
    }

    /// Turn omnibox text into a URL, mirroring the shell's heuristic closely
    /// enough that both places behave the same on the common inputs.
    pub fn resolve_entry(&self) -> String {
        let q = self.omnibox.trim();
        if q.is_empty() {
            return String::new();
        }
        let looks_url = q.starts_with("http://")
            || q.starts_with("https://")
            || q.starts_with("about:")
            || q.starts_with("file://")
            || q.contains("localhost")
            || (q.contains('.') && !q.contains(' ') && q.chars().all(|c| c.is_ascii_graphic()));
        if looks_url {
            if q.starts_with("http") || q.starts_with("about:") || q.starts_with("file://") {
                q.to_string()
            } else {
                format!("http://{q}")
            }
        } else {
            format!("https://duckduckgo.com/?q={}", urlencoding_lite(q))
        }
    }
}

fn tab_width(n: f64, avail: f64) -> f64 {
    (avail / n)
        .clamp(TAB_MIN.min(avail / 1.0), TAB_MAX)
        .min(TAB_MAX)
}

fn urlencoding_lite(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn esc(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// Render the chrome bar as HTML.
pub fn render(c: &Chrome) -> String {
    let h = c.height;
    let row2 = h - ROW1;
    let n = c.tabs.len().max(1) as f64;
    let avail = (c.viewport_w - PLUS_W - GAP * 2.0).max(120.0);
    let tw = tab_width(n, avail);

    let mut tabs = String::new();
    for t in &c.tabs {
        let bg = if t.active { "#3a3f47" } else { "#26292f" };
        let fg = if t.active { "#f2f4f8" } else { "#aab2bf" };
        let marker = if t.loading { " ⟳" } else { "" };
        tabs.push_str(&format!(
            "<div class=\"bns-tab\" data-id=\"{}\" style=\"box-sizing:border-box;width:{}px;height:{row2:.0}px;background:{bg};border-radius:8px 8px 0 0;display:flex;align-items:center;padding:0 2px 0 10px;font-size:12px;color:{fg};overflow:hidden\"><span style=\"flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap\">{}{marker}</span><span class=\"bns-close\" data-id=\"{}\" style=\"width:{CLOSE_W}px;height:{row2:.0}px;line-height:{row2:.0}px;text-align:center;color:#8892a0\">×</span></div>",
            t.id, tw, esc(&if t.title.is_empty() { "New tab".into() } else { t.title.clone() }), t.id,
        ));
    }

    format!(
        "<div id=\"bns-chrome\" style=\"position:fixed;top:0;left:0;right:0;height:{h:.0}px;background:#17191d;color:#dde3ec;font-family:sans-serif;z-index:2147483647\">\
<div style=\"display:flex;align-items:center;height:{ROW1:.0}px;padding:0 {OMNI_PAD}px;gap:{GAP}px\">\
<span style=\"width:{BTN_W}px;text-align:center;color:{}\">‹</span>\
<span style=\"width:{BTN_W}px;text-align:center;color:{}\">›</span>\
<span style=\"width:{BTN_W}px;text-align:center;color:#dde3ec\">⟳</span>\
<span style=\"flex:1;margin:0 6px;background:{};border-radius:15px;height:28px;line-height:28px;padding:0 14px;font-size:13px;overflow:hidden;white-space:nowrap;color:{}\">{}{}</span>\
</div>\
<div style=\"display:flex;align-items:flex-end;height:{row2:.0}px;padding:0 4px;gap:{GAP}px\">{tabs}\
<span style=\"width:{PLUS_W}px;height:{row2:.0}px;text-align:center;line-height:{row2:.0}px;font-size:18px;color:#aab2bf\">＋</span>\
</div></div>",
        if c.can_back { "#dde3ec" } else { "#555b66" },
        if c.can_forward { "#dde3ec" } else { "#555b66" },
        if c.focused { "#22262d" } else { "#26292f" },
        if c.focused { "#f2f4f8" } else { "#9aa3b2" },
        esc(if c.omnibox.is_empty() {
            "Search or enter address"
        } else {
            &c.omnibox
        }),
        if c.focused { "<span style=\"color:#7ab3ff\">▏</span>" } else { "" },
    )
}

/// Inject chrome + spacer into a document's HTML.
pub fn inject(html: &str, c: &Chrome) -> String {
    let bar = render(c);
    let spacer = format!("<div style=\"height:{:.0}px\"></div>", c.height);
    let lower = html.to_ascii_lowercase();
    let insertion = match lower.find("<body") {
        Some(tag_start) => match lower[tag_start..].find('>') {
            Some(gt) => tag_start + gt + 1,
            None => 0,
        },
        None => 0,
    };
    if insertion == 0 {
        format!("{bar}{spacer}{html}")
    } else {
        format!("{}{bar}{spacer}{}", &html[..insertion], &html[insertion..])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chrome() -> Chrome {
        Chrome {
            height: 76.0,
            viewport_w: 800.0,
            tabs: vec![
                TabInfo {
                    id: 1,
                    title: "One".into(),
                    active: true,
                    loading: false,
                },
                TabInfo {
                    id: 2,
                    title: "Two".into(),
                    active: false,
                    loading: false,
                },
            ],
            active: Some(1),
            omnibox: "https://example.com".into(),
            focused: false,
            status: String::new(),
            can_back: true,
            can_forward: false,
            loading: false,
        }
    }

    #[test]
    fn hits_buttons_then_tabs_then_plus() {
        let c = chrome();
        assert_eq!(c.hit_test(17.0, 18.0), Hit::Back);
        assert_eq!(c.hit_test(51.0, 18.0), Hit::Forward);
        assert_eq!(c.hit_test(85.0, 18.0), Hit::Reload);
        assert_eq!(c.hit_test(400.0, 18.0), Hit::Omnibox);
        // Two tabs at width 220 each starting at x=4: bodies then a 22px
        // close strip on the right of each, then the + button.
        assert_eq!(c.hit_test(100.0, 60.0), Hit::Tab(1));
        assert_eq!(c.hit_test(210.0, 60.0), Hit::TabClose(1));
        assert_eq!(c.hit_test(300.0, 60.0), Hit::Tab(2));
        assert_eq!(c.hit_test(430.0, 60.0), Hit::TabClose(2));
        assert_eq!(c.hit_test(460.0, 60.0), Hit::NewTab);
        assert_eq!(c.hit_test(400.0, 90.0), Hit::Page); // below the bar
        assert_eq!(c.hit_test(700.0, 60.0), Hit::Page); // past the strip
    }

    #[test]
    fn many_tabs_stay_hittable_and_closable() {
        let mut c = chrome();
        c.tabs = (1..=20)
            .map(|i| TabInfo {
                id: i,
                title: "t".into(),
                active: false,
                loading: false,
            })
            .collect();
        let mut saw_close = false;
        for x in 0..800usize {
            if matches!(c.hit_test(x as f64, 60.0), Hit::TabClose(_)) {
                saw_close = true;
            }
        }
        assert!(saw_close);
    }

    #[test]
    fn resolves_entries_like_the_shell_heuristic() {
        let mut c = chrome();
        c.omnibox = "localhost:3000".into();
        assert_eq!(c.resolve_entry(), "http://localhost:3000");
        c.omnibox = "example.com".into();
        assert_eq!(c.resolve_entry(), "http://example.com");
        c.omnibox = "https://secure".into();
        assert_eq!(c.resolve_entry(), "https://secure");
        c.omnibox = "rust closures".into();
        assert!(c
            .resolve_entry()
            .starts_with("https://duckduckgo.com/?q=rust%20closures"));
        c.omnibox = "   ".into();
        assert_eq!(c.resolve_entry(), "");
    }

    #[test]
    fn inject_lands_inside_body_when_there_is_one() {
        let html = "<html><head></head><body><p>x</p></body></html>";
        let injected = inject(html, &chrome());
        assert!(injected.contains("<body><div id=\"bns-chrome\""));
        assert!(injected.ends_with("</body></html>"));
        // No body at all: prepend rather than lose the document.
        let bare = inject("<p>hi</p>", &chrome());
        assert!(bare.starts_with("<div id=\"bns-chrome\""));
        assert!(bare.ends_with("<p>hi</p>"));
    }

    #[test]
    fn escapes_titles_into_the_markup() {
        let mut c = chrome();
        c.tabs[0].title = "<script>alert(\"x\")</script>".into();
        let rendered = render(&c);
        assert!(!rendered.contains("<script>alert"));
        assert!(rendered.contains("&lt;script&gt;"));
    }
}
