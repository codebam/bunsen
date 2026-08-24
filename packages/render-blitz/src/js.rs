// SPDX-License-Identifier: MIT OR Apache-2.0
//! The Bun side of page JavaScript, hosted.
//!
//! One [`Engine`] per loaded document: a persistent `bun` subprocess speaking
//! one JSON object per line on stdio (see js/engine.ts for the other half).
//! The worker owns a DOM of plain records, evaluates the document's scripts
//! against it, and streams back serializations whenever scripts mutate it; we
//! reparse those into real Stylo documents. Crude compared to an in-process
//! binding, but stateless on the wire and impossible to desynchronize.
//!
//! The security story is honest but thin: page code runs with the privileges
//! of this process's user, exactly like `node script-from-the-internet`.
//! WebKit isolates content properly; this does not. It is a development
//! convenience on the road to a sandboxed JSC.

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::Sender;
use std::thread::JoinHandle;

pub type TabId = u32;

/// A message from a JS worker, tagged with the tab and generation it belongs
/// to so stale ones can be dropped after a navigation.
#[derive(Debug)]
pub struct JsEnvelope {
    pub tab: TabId,
    pub generation: u64,
    pub msg: JsMsg,
}

#[derive(Debug)]
pub enum JsMsg {
    Ready,
    /// The serialized DOM after mutations. Display-ready: no script tags.
    Html(String),
    Title(String),
    Console {
        level: String,
        text: String,
    },
    Error {
        stage: String,
        message: String,
    },
    Navigate(String),
    /// `<a download>`: save the target rather than showing it.
    Download {
        url: String,
        filename: String,
    },
    /// An opaque payload for the extension host (already JSON).
    Page(String),
}

/// Chrome-style match patterns (`*://*.example.com/foo/*`) against a URL.
/// Path matching ignores query and fragment, as specified. The registrations
/// themselves live in `bunsen_protocol::ContentScript`.
pub fn matches_pattern(pattern: &str, url: &url::Url) -> bool {
    let rest = match pattern.split_once("://") {
        Some((scheme, rest)) => {
            if scheme != "*" && scheme != url.scheme() {
                return false;
            }
            rest
        }
        None => return false,
    };
    let (host_pat, path_pat) = match rest.split_once('/') {
        Some((h, p)) => (h, format!("/{p}")),
        None => (rest, "/".to_string()),
    };
    let path = url.path();
    if host_pat == "*" && !matches!(url.scheme(), "http" | "https" | "ws" | "wss" | "ftp") {
        return false;
    }
    let host_ok = host_pat == "*"
        || match host_pat.strip_prefix("*.") {
            Some(suffix) => match url.host_str() {
                Some(host) => host == suffix || host.ends_with(&format!(".{suffix}")),
                None => false,
            },
            None => url.host_str() == Some(host_pat),
        };
    host_ok && wildcard_match(path_pat.as_bytes(), path.as_bytes())
}

fn wildcard_match(pat: &[u8], text: &[u8]) -> bool {
    // Iterative two-pointer glob; '*' matches any run including none.
    let (mut p, mut t) = (0usize, 0usize);
    let (mut star, mut backtrack) = (None::<usize>, 0usize);
    while t < text.len() {
        if p < pat.len() && (pat[p] == b'?' || pat[p] == text[t]) {
            p += 1;
            t += 1;
        } else if p < pat.len() && pat[p] == b'*' {
            star = Some(p);
            backtrack = t;
            p += 1;
        } else if let Some(sp) = star {
            p = sp + 1;
            backtrack += 1;
            t = backtrack;
        } else {
            return false;
        }
    }
    pat[p..].iter().all(|&b| b == b'*')
}

// ------------------------------------------------------------------ spawning

/// Where `bun` lives: `$BUNSEN_BUN`, or somewhere on PATH.
pub fn find_bun() -> Option<PathBuf> {
    if let Ok(path) = std::env::var("BUNSEN_BUN") {
        if !path.is_empty() {
            return Some(PathBuf::from(path));
        }
    }
    let paths = std::env::var("PATH").ok()?;
    for dir in paths.split(':') {
        let candidate = Path::new(dir).join("bun");
        // Not executable-bit-checked: nix store symlinks can confuse stat
        // modes through bind mounts, and spawn failing is reported anyway.
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

/// Write the worker script somewhere stable once per renderer process.
pub fn materialize_worker() -> Option<PathBuf> {
    let path = std::env::temp_dir().join(format!("bunsen-js-engine-{}.ts", std::process::id()));
    std::fs::write(&path, include_str!("../js/engine.ts")).ok()?;
    Some(path)
}

pub struct Engine {
    pub tab: TabId,
    pub generation: u64,
    child: Option<Child>,
    tx: Option<Sender<String>>,
    writer: Option<JoinHandle<()>>,
    reader: Option<JoinHandle<()>>,
}

impl std::fmt::Debug for Engine {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Engine")
            .field("tab", &self.tab)
            .field("generation", &self.generation)
            .finish_non_exhaustive()
    }
}

impl Engine {
    /// Spawn a bun worker for `html` at `url`. The returned engine already
    /// has the load message queued; results arrive on `out`.
    #[allow(clippy::too_many_arguments)]
    /// `wake` is called after every message this engine produces.
    ///
    /// The channel alone is not enough: the renderer only drains it from the
    /// windowing thread's pump, and that pump runs when the event loop wakes.
    /// Without a nudge, a page's output sits unread until some unrelated
    /// event arrives — which looks exactly like a scripted page that has
    /// frozen until you move the mouse.
    pub fn spawn(
        bun: &Path,
        worker: &Path,
        tab: TabId,
        generation: u64,
        url: &str,
        html: &str,
        out: Sender<JsEnvelope>,
        wake: Box<dyn Fn() + Send + 'static>,
    ) -> std::io::Result<Engine> {
        use std::sync::mpsc::channel;

        let mut command = Command::new(bun);
        command
            .arg("run")
            .arg(worker)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());

        // Tie the engine's life to ours at the kernel level.
        //
        // Dropping an Engine kills its child, and the child exits on EOF, but
        // neither survives a SIGKILL of this process: Drop never runs, and a
        // page spinning in synchronous JavaScript never reaches an event-loop
        // turn where it could notice the pipe closed. Orphans were found at
        // 100% CPU each, long after every renderer had gone. PR_SET_PDEATHSIG
        // makes the kernel do it, whatever the page is doing.
        #[cfg(target_os = "linux")]
        unsafe {
            use std::os::unix::process::CommandExt;
            command.pre_exec(|| {
                // SIGKILL rather than SIGTERM: a wedged engine cannot handle
                // a signal it would have to reach an event loop to see.
                if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                // The parent may already have died between fork and here, in
                // which case the death signal has been missed.
                if libc::getppid() == 1 {
                    libc::_exit(0);
                }
                Ok(())
            });
        }

        let mut child = command.spawn()?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| std::io::Error::other("no stdin"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| std::io::Error::other("no stdout"))?;

        // Writer: owns stdin, dies when the sender is dropped.
        let (tx, rx) = channel::<String>();
        let writer = std::thread::Builder::new()
            .name("js-write".into())
            .spawn(move || {
                let mut w = StdinWriter(stdin);
                for line_msg in rx {
                    if w.send_line(&line_msg).is_err() {
                        break;
                    }
                }
            })?;

        // Reader: parses stdout lines into envelopes until EOF.
        let reader = std::thread::Builder::new()
            .name("js-read".into())
            .spawn(move || {
                let lines = BufReader::new(stdout);
                for l in lines.lines() {
                    let Ok(l) = l else { break };
                    match parse_msg(&l) {
                        Ok(msg) => {
                            if out
                                .send(JsEnvelope {
                                    tab,
                                    generation,
                                    msg,
                                })
                                .is_err()
                            {
                                break;
                            }
                            wake();
                        }
                        Err(e) => eprintln!("bunsen-js: undecodable line ({e}): {:.200}", l),
                    }
                }
            })?;

        let engine = Engine {
            tab,
            generation,
            child: Some(child),
            tx: Some(tx.clone()),
            writer: Some(writer),
            reader: Some(reader),
        };
        engine.send_line(&format!(
            "{}",
            serde_json::json!({ "op": "load", "tab": tab, "url": url, "html": html })
        ));
        Ok(engine)
    }

    fn send_line(&self, line: &str) {
        if let Some(tx) = &self.tx {
            let _ = tx.send(line.to_owned());
        }
    }

    /// Queue content scripts / extension payloads into this document.
    pub fn inject(&self, items: &[serde_json::Value]) {
        if items.is_empty() {
            return;
        }
        self.send_line(
            &serde_json::to_string(&serde_json::json!({ "op": "inject", "items": items }))
                .unwrap_or_else(|_| "{}".into()),
        );
    }

    /// Deliver a message from the extension host toward the page/content side.
    ///
    /// `payload` is already JSON text, so it has to be embedded as a *value*.
    /// Passing the `&str` straight to `json!` nests it as a string, and the
    /// engine's `deliverPageMessage` drops anything that is not an object —
    /// which silently swallowed every reply, leaving content scripts awaiting
    /// a promise that never settled.
    pub fn page_message(&self, payload: &str) {
        let value: serde_json::Value =
            serde_json::from_str(payload).unwrap_or(serde_json::Value::Null);
        self.send_line(&serde_json::json!({ "op": "page", "payload": value }).to_string());
    }

    fn kill(&mut self) {
        self.tx = None; // writer thread sees EOF-ish close and exits
        if let Some(child) = &mut self.child {
            let _ = child.kill();
            let _ = child.wait();
        }
        self.child = None;
    }
}

impl Drop for Engine {
    fn drop(&mut self) {
        self.kill();
        if let Some(h) = self.writer.take() {
            let _ = h.join();
        }
        if let Some(h) = self.reader.take() {
            let _ = h.join();
        }
    }
}

struct StdinWriter(ChildStdin);

impl StdinWriter {
    fn send_line(&mut self, line: &str) -> std::io::Result<()> {
        self.0.write_all(line.as_bytes())?;
        self.0.write_all(b"\n")?;
        self.0.flush()
    }
}

fn parse_msg(line: &str) -> Result<JsMsg, String> {
    let v: serde_json::Value = serde_json::from_str(line).map_err(|e| format!("bad json: {e}"))?;
    let t = v
        .get("t")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "missing t".to_string())?;
    let s = |k: &str| v.get(k).and_then(serde_json::Value::as_str).unwrap_or("");
    Ok(match t {
        "ready" => JsMsg::Ready,
        "html" => JsMsg::Html(s("html").to_owned()),
        "title" => JsMsg::Title(s("title").to_owned()),
        "console" => JsMsg::Console {
            level: s("level").to_owned(),
            text: s("text").to_owned(),
        },
        "error" => JsMsg::Error {
            stage: s("stage").to_owned(),
            message: s("message").to_owned(),
        },
        "navigate" => JsMsg::Navigate(s("url").to_owned()),
        "download" => JsMsg::Download {
            url: s("url").to_owned(),
            filename: s("filename").to_owned(),
        },
        // Forward just the inner payload; the envelope is ours, not the
        // extension host's business.
        "page" => JsMsg::Page(
            serde_json::to_string(v.get("payload").unwrap_or(&serde_json::Value::Null))
                .unwrap_or_else(|_| "null".into()),
        ),
        other => return Err(format!("unknown message kind {other:?}")),
    })
}

// ------------------------------------------------------------ script stripping

/// Remove `<script ...>...</script>` blocks from HTML before handing it to
/// Stylo. The worker gets the original; the display copy never needs them.
pub fn strip_scripts(html: &str) -> String {
    let lower = html.to_ascii_lowercase();
    let mut out = String::with_capacity(html.len());
    let mut cursor = 0;
    while let Some(rel) = lower[cursor..].find("<script") {
        let start = cursor + rel;
        // The tag ends at its '>', which cannot appear inside quoted
        // attributes in practice — and being wrong here only risks keeping
        // script text visible, never running it twice.
        let tag_end = lower[start..].find('>').map(|r| start + r + 1);
        let body_start = tag_end.unwrap_or(start);
        let end = lower[body_start..]
            .find("</script>")
            .map_or(lower.len(), |r| body_start + r + "</script>".len());
        out.push_str(&html[cursor..start]);
        cursor = end;
    }
    out.push_str(&html[cursor..]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msgs(lines: &[&str]) -> Vec<JsMsg> {
        lines.iter().map(|l| parse_msg(l).unwrap()).collect()
    }

    #[test]
    fn parses_every_message_kind() {
        let m0 = &msgs(&[r#"{"t":"ready"}"#])[0];
        assert!(matches!(m0, JsMsg::Ready));
        let m1 = &msgs(&[r#"{"t":"html","html":"<p>x</p>"}"#])[0];
        assert!(matches!(m1, JsMsg::Html(_)));
        let m2 = &msgs(&[r#"{"t":"title","title":"T"}"#])[0];
        assert!(matches!(m2, JsMsg::Title(t) if t == "T"));
        let m3 = &msgs(&[r#"{"t":"console","level":"log","text":"hi"}"#])[0];
        assert!(matches!(m3, JsMsg::Console { level, .. } if level == "log"));
        let m4 = &msgs(&[r#"{"t":"error","stage":"boot","message":"m"}"#])[0];
        assert!(matches!(m4, JsMsg::Error { stage, message } if stage == "boot" && message == "m"));
        let m5 = &msgs(&[r#"{"t":"navigate","url":"https://x"}"#])[0];
        assert!(matches!(m5, JsMsg::Navigate(u) if u == "https://x"));
        let m6 = &msgs(&[r#"{"t":"page"}"#])[0];
        assert!(matches!(m6, JsMsg::Page(_)));
    }

    #[test]
    fn rejects_garbage_lines() {
        assert!(parse_msg("not json").is_err());
        assert!(parse_msg(r#"{"op":1}"#).is_err());
        assert!(parse_msg(r#"{"t":"wat"}"#).is_err());
    }

    #[test]
    fn strips_scripts_whatever_the_case() {
        assert_eq!(
            strip_scripts("<p>a</p><SCRIPT>x</script><p>b</p>"),
            "<p>a</p><p>b</p>"
        );
        assert_eq!(strip_scripts("a<script src='x'></script>b"), "ab");
        // Unterminated: everything from the tag goes.
        assert_eq!(strip_scripts("a<script>never"), "a");
        assert_eq!(strip_scripts("<script></script>"), "");
        assert_eq!(strip_scripts("no scripts here"), "no scripts here");
    }

    #[test]
    fn patterns_match_like_chrome() {
        let mk = |s: &str| url::Url::parse(s).unwrap();
        assert!(matches_pattern(
            "*://*.example.com/*",
            &mk("https://a.example.com/x")
        ));
        assert!(matches_pattern(
            "*://*.example.com/*",
            &mk("https://example.com/x")
        ));
        assert!(!matches_pattern(
            "*://*.example.com/*",
            &mk("https://notexample.com/x")
        ));
        assert!(matches_pattern(
            "https://*/foo*",
            &mk("https://any.host/foo/bar")
        ));
        assert!(!matches_pattern("http://*", &mk("https://any.host/"))); // scheme gate
                                                                         // Unsupported pattern forms simply never match rather than panicking.
        assert!(!matches_pattern("<all_urls>", &mk("about:blank")));
        assert!(!matches_pattern("file:///tmp/*", &mk("https://x/y")));
    }
}
