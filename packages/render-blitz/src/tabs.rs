// SPDX-License-Identifier: MIT OR Apache-2.0
//! Per-tab state for the Blitz backend.
//!
//! One document per tab, kept live. Only the active tab's document is
//! installed in the window; the rest sit here with their DOM, layout and
//! scroll position intact, so switching back is a swap rather than a reparse.

use blitz_dom::Document;

pub struct Tab {
    pub url: String,
    pub title: String,
    pub loading: bool,
    /// Present unless this tab is the active one, in which case the window
    /// holds it.
    pub doc: Option<Box<dyn Document>>,
    /// Session history, and where in it we are. Blitz has no history of its
    /// own, so back/forward is ours to keep.
    pub history: Vec<String>,
    pub position: usize,
    /// Bumped on every navigation so a slow fetch that lands after the user
    /// has moved on can be recognised and dropped.
    pub generation: u64,
}

impl Tab {
    pub fn new(url: String) -> Self {
        Self {
            url,
            title: String::new(),
            loading: false,
            doc: None,
            history: Vec::new(),
            position: 0,
            generation: 0,
        }
    }

    /// Record a committed navigation, discarding any forward entries — the
    /// same thing every browser does when you navigate away from the middle
    /// of a history stack.
    pub fn commit(&mut self, url: String) {
        if self.history.get(self.position).map(String::as_str) == Some(url.as_str()) {
            return;
        }
        if !self.history.is_empty() {
            self.history.truncate(self.position + 1);
            self.position += 1;
        }
        self.history.push(url.clone());
        if self.history.len() == 1 {
            self.position = 0;
        }
        self.url = url;
    }

    pub fn can_back(&self) -> bool {
        self.position > 0
    }

    pub fn can_forward(&self) -> bool {
        self.position + 1 < self.history.len()
    }

    /// Step through history without recording a new entry. Returns the URL to
    /// load, or None at either end.
    pub fn step(&mut self, delta: isize) -> Option<String> {
        let next = self.position as isize + delta;
        if next < 0 || next as usize >= self.history.len() {
            return None;
        }
        self.position = next as usize;
        let url = self.history[self.position].clone();
        self.url = url.clone();
        Some(url)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tab() -> Tab {
        Tab::new(String::new())
    }

    #[test]
    fn history_walks_back_and_forward() {
        let mut t = tab();
        t.commit("a".into());
        t.commit("b".into());
        t.commit("c".into());
        assert!(t.can_back() && !t.can_forward());
        assert_eq!(t.step(-1).as_deref(), Some("b"));
        assert_eq!(t.step(-1).as_deref(), Some("a"));
        assert!(!t.can_back() && t.can_forward());
        assert_eq!(t.step(-1), None);
        assert_eq!(t.step(1).as_deref(), Some("b"));
    }

    #[test]
    fn navigating_from_the_middle_drops_the_forward_entries() {
        let mut t = tab();
        t.commit("a".into());
        t.commit("b".into());
        t.commit("c".into());
        t.step(-1);
        t.commit("d".into());
        assert!(!t.can_forward());
        assert_eq!(t.history, vec!["a", "b", "d"]);
        assert_eq!(t.url, "d");
    }

    #[test]
    fn reloading_the_same_url_does_not_grow_history() {
        let mut t = tab();
        t.commit("a".into());
        t.commit("a".into());
        assert_eq!(t.history.len(), 1);
        assert!(!t.can_back());
    }
}
