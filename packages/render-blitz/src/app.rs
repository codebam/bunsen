// SPDX-License-Identifier: MIT OR Apache-2.0
//! The winit thread: one window, one document installed at a time, the rest
//! of the tabs parked in [`crate::tabs`].
//!
//! `BlitzApplication` already knows how to drive a `View`, so this wraps it
//! rather than reimplementing it, and intercepts the three things Blitz leaves
//! to the embedder: navigation requests, everything about tabs, and now the
//! top strip of the window, which is our chrome (see [`crate::chrome`]).
//!
//! Page JavaScript lives in Bun subprocesses managed by [`crate::js`]: one
//! per loaded document, mutating a DOM we reparse on every flush.

use std::collections::{HashMap, VecDeque};
use std::sync::mpsc::{channel, Receiver as StdReceiver, Sender as StdSender};
use std::sync::{Arc, Mutex};

use anyrender_vello::VelloWindowRenderer;
use blitz_dom::{Document, DocumentConfig};
use blitz_html::HtmlDocument;
use blitz_shell::{
    BlitzApplication, BlitzShellEvent, BlitzShellProxy, ControlFlow, EventLoop, View, WindowConfig,
};
use blitz_traits::navigation::{NavigationOptions, NavigationProvider};
use blitz_traits::net::NetProvider;
use winit::application::ApplicationHandler;
use winit::event::{ElementState, WindowEvent};
use winit::event_loop::ActiveEventLoop;
use winit::keyboard::{Key, NamedKey};
use winit::window::{WindowAttributes, WindowId};
use winit_wayland::WindowAttributesWayland;

use bunsen_protocol::codec::decode_commands;
use bunsen_protocol::protocol::ContentScript;
use bunsen_protocol::{Command, Config, Event, EventQueue, TabId};

use crate::chrome::{self, Hit};
use crate::fetch;
use crate::js::{self, JsEnvelope, JsMsg};
use crate::tabs::Tab;

/// A finished (or failed) document load.
struct Loaded {
    tab: TabId,
    generation: u64,
    result: Result<(String, String), String>,
}

pub fn run(cfg: Config, commands: async_channel::Receiver<Vec<u8>>, events: Arc<EventQueue>) {
    // Blitz's net provider is async and expects an ambient Tokio runtime.
    let rt = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("bunsen: cannot start async runtime: {e}");
            return;
        }
    };
    let _guard = rt.enter();

    let event_loop = build_event_loop();
    let (proxy, blitz_events) = BlitzShellProxy::new(event_loop.create_proxy());
    let net = Arc::new(blitz_net::Provider::new(Some(Arc::new(proxy.clone()))));
    let navigation = Arc::new(ProxyNavigation {
        proxy: proxy.clone(),
    });

    let mut inner = BlitzApplication::<VelloWindowRenderer>::new(proxy.clone(), blitz_events);
    inner.add_window(WindowConfig::with_attributes(
        Box::new(blank_document(&net, &navigation)),
        VelloWindowRenderer::new(),
        WindowAttributes::default()
            .with_title("Bunsen")
            // Without this the Wayland toplevel has no app_id at all, so a
            // compositor cannot match a rule to it or show it a sensible icon.
            // It must match the WebKit backend's, since it is the same browser.
            .with_platform_attributes(Box::new(
                WindowAttributesWayland::default().with_name("dev.bunsen.Browser", "bunsen"),
            ))
            .with_surface_size(winit::dpi::LogicalSize::new(cfg.width, cfg.height)),
    ));

    // Commands arrive on a thread that is not the winit thread, so park them
    // and wake the loop.
    let pending: Arc<Mutex<VecDeque<Command>>> = Arc::new(Mutex::new(VecDeque::new()));
    spawn_command_pump(commands, pending.clone(), proxy.clone());

    let (load_tx, load_rx) = channel::<Loaded>();
    let (js_tx, js_rx) = channel::<JsEnvelope>();

    let bun = js::find_bun();
    let worker_script = js::materialize_worker();
    match (&bun, &worker_script) {
        (Some(_), Some(worker)) => {
            eprintln!("bunsen: JavaScript via bun enabled ({})", worker.display());
        }
        _ => eprintln!("bunsen: bun not found; page JavaScript disabled"),
    }

    let app = BunsenApp {
        inner,
        events: events.clone(),
        pending,
        tabs: HashMap::new(),
        order: Vec::new(),
        active: None,
        net,
        navigation,
        proxy: proxy.clone(),
        load_tx,
        load_rx,
        runtime: rt.handle().clone(),
        quitting: false,
        engines: HashMap::new(),
        js_tx,
        js_rx,
        bun,
        worker_script,
        content_scripts: cfg.content_scripts.clone(),
        display_cache: HashMap::new(),
        chrome: chrome::Chrome::new(cfg.chrome_height),
        modifiers: winit::keyboard::ModifiersState::empty(),
        warned_no_bun: false,
    };
    app.emit(Event::Ready);

    if let Err(e) = event_loop.run_app(app) {
        eprintln!("bunsen: event loop stopped: {e}");
    }
    events.push(Event::WindowClosed);
}

/// Blitz's own helper refuses to build an event loop off the main thread, and
/// the ABI runs every backend on a spawned one. Opting into `with_any_thread`
/// is what makes the in-process transport possible at all — and the
/// in-process transport is what lets JavaScript reach this DOM synchronously,
/// which is the whole reason the Blitz backend exists.
fn build_event_loop() -> EventLoop {
    let mut builder = EventLoop::builder();

    // Both extension traits spell the method the same way, so each call has to
    // say which trait it means.
    #[cfg(all(unix, not(target_os = "macos"), not(target_os = "android")))]
    {
        use winit_wayland::EventLoopBuilderExtWayland;
        EventLoopBuilderExtWayland::with_any_thread(&mut builder, true);
    }
    // No X11 counterpart here: winit picks its backend at runtime, and this
    // crate does not enable winit's x11 feature, so the trait would not exist
    // to call. Under Xwayland the Wayland backend is still what runs.

    let event_loop = builder.build().expect("build winit event loop");
    event_loop.set_control_flow(ControlFlow::Wait);
    event_loop
}

fn blank_document(
    net: &Arc<blitz_net::Provider>,
    navigation: &Arc<ProxyNavigation>,
) -> HtmlDocument {
    document_from("", None, net, navigation)
}

fn document_from(
    html: &str,
    base_url: Option<String>,
    net: &Arc<blitz_net::Provider>,
    navigation: &Arc<ProxyNavigation>,
) -> HtmlDocument {
    HtmlDocument::from_html(
        html,
        DocumentConfig {
            base_url,
            net_provider: Some(net.clone() as Arc<dyn NetProvider>),
            navigation_provider: Some(navigation.clone()),
            ..Default::default()
        },
    )
}

/// Blitz reports link clicks and form submissions through this trait. We do
/// not act on them here — the shell owns navigation policy, exactly as it does
/// on the WebKit backend — so the request is forwarded onto the event loop.
struct ProxyNavigation {
    proxy: BlitzShellProxy,
}

impl NavigationProvider for ProxyNavigation {
    fn navigate_to(&self, options: NavigationOptions) {
        self.proxy
            .send_event(BlitzShellEvent::Navigate(Box::new(options)));
    }
}

fn spawn_command_pump(
    commands: async_channel::Receiver<Vec<u8>>,
    pending: Arc<Mutex<VecDeque<Command>>>,
    proxy: BlitzShellProxy,
) {
    std::thread::Builder::new()
        .name("bunsen-cmd".into())
        .spawn(move || {
            while let Ok(batch) = commands.recv_blocking() {
                match decode_commands(&batch) {
                    Ok(cmds) => pending.lock().unwrap().extend(cmds),
                    Err(e) => {
                        eprintln!("bunsen: {e}");
                        continue;
                    }
                }
                proxy.wake_up();
            }
        })
        .expect("spawn command pump");
}

struct BunsenApp {
    inner: BlitzApplication<VelloWindowRenderer>,
    events: Arc<EventQueue>,
    pending: Arc<Mutex<VecDeque<Command>>>,
    tabs: HashMap<TabId, Tab>,
    order: Vec<TabId>,
    active: Option<TabId>,
    net: Arc<blitz_net::Provider>,
    navigation: Arc<ProxyNavigation>,
    proxy: BlitzShellProxy,
    load_tx: StdSender<Loaded>,
    load_rx: StdReceiver<Loaded>,
    runtime: tokio::runtime::Handle,
    quitting: bool,

    /// One live JS engine per tab with a document. Killed and replaced on
    /// every navigation.
    engines: HashMap<TabId, js::Engine>,
    js_tx: StdSender<JsEnvelope>,
    js_rx: StdReceiver<JsEnvelope>,
    bun: Option<std::path::PathBuf>,
    worker_script: Option<std::path::PathBuf>,
    /// Content-script registrations from the shell (startup config plus
    /// `set_content_scripts` updates).
    content_scripts: Vec<ContentScript>,
    /// Last stripped HTML per tab, so the chrome can redraw without refetching.
    display_cache: HashMap<TabId, String>,
    chrome: chrome::Chrome,
    warned_no_bun: bool,
    /// Latest modifier state; winit reports it separately from key presses.
    modifiers: winit::keyboard::ModifiersState,
}

impl BunsenApp {
    fn emit(&self, event: Event) {
        self.events.push(event);
    }

    fn view(&mut self) -> Option<&mut View<VelloWindowRenderer>> {
        self.inner.windows.values_mut().next()
    }

    fn scale_factor(&self) -> f64 {
        self.inner
            .windows
            .values()
            .next()
            .map(|v| v.window.scale_factor())
            .unwrap_or(1.0)
    }

    /// Install `doc` in the window and hand back whatever was there, keeping
    /// the viewport and shell provider that belong to the window rather than
    /// to any one document.
    fn install(&mut self, doc: Box<dyn Document>) -> Option<Box<dyn Document>> {
        let view = self.view()?;
        let (viewport, shell_provider) = {
            let inner = view.doc.inner();
            (inner.viewport().clone(), inner.shell_provider.clone())
        };
        let old = std::mem::replace(&mut view.doc, doc);
        {
            let mut inner = view.doc.inner_mut();
            inner.set_viewport(viewport);
            inner.set_shell_provider(shell_provider);
        }
        let scale = view.window.scale_factor() as f32;
        view.with_viewport(|v| v.set_hidpi_scale(scale));
        view.poll();
        view.request_redraw();
        Some(old)
    }

    // ------------------------------------------------------------ chrome io

    /// Push current backend truth into the chrome model and repaint the bar.
    fn sync_chrome(&mut self) {
        let listing: Vec<(u32, String)> = self
            .order
            .iter()
            .map(|id| {
                (
                    *id,
                    self.tabs
                        .get(id)
                        .map(|t| t.title.clone())
                        .unwrap_or_default(),
                )
            })
            .collect();
        let (can_back, can_forward, loading, url) = self
            .active
            .and_then(|id| self.tabs.get(&id))
            .map(|t| (t.can_back(), t.can_forward(), t.loading, t.url.clone()))
            .unwrap_or((false, false, false, String::new()));
        if let Some(view) = self.inner.windows.values().next() {
            let size = view.window.surface_size();
            let scale = view.window.scale_factor();
            self.chrome.viewport_w = size.to_logical(scale).width;
        }
        self.chrome
            .sync_tabs(&listing, self.active, can_back, can_forward, loading, &url);
        self.rebuild_active_document();
    }

    /// Reinstall the active tab's cached HTML with fresh chrome injected.
    /// This is the only way the bar changes pixels, and it costs a reparse of
    /// the cached page — fine for tabs, tolerable for keystrokes.
    fn rebuild_active_document(&mut self) {
        let Some(active) = self.active else {
            return;
        };
        let stripped = self
            .display_cache
            .get(&active)
            .cloned()
            .unwrap_or_else(|| "<html><body></body></html>".to_string());
        let url = self
            .tabs
            .get(&active)
            .map(|t| t.url.clone())
            .filter(|u| !u.is_empty());
        let full = chrome::inject(&stripped, &self.chrome);
        let doc = document_from(&full, url, &self.net, &self.navigation);
        self.install(Box::new(doc));
    }

    /// Browser-level keyboard shortcuts.
    ///
    /// Tab lifetime belongs to the shell, so the ones that create or destroy
    /// tabs are emitted as requests rather than acted on here — the same
    /// division the chrome bar's buttons already follow.
    fn handle_shortcut(&mut self, key: &Key) -> bool {
        let ctrl = self.modifiers.control_key();
        let alt = self.modifiers.alt_key();

        match key {
            Key::Named(NamedKey::F5) => {
                self.reload_active();
                true
            }
            Key::Named(NamedKey::ArrowLeft) if alt => {
                self.step_active(-1);
                true
            }
            Key::Named(NamedKey::ArrowRight) if alt => {
                self.step_active(1);
                true
            }
            Key::Named(NamedKey::PageDown) => self.scroll_page(1.0),
            Key::Named(NamedKey::PageUp) => self.scroll_page(-1.0),
            Key::Named(NamedKey::Home) if !self.chrome.focused => self.scroll_to_top(),
            Key::Named(NamedKey::End) if !self.chrome.focused => self.scroll_page(1e6),
            Key::Named(NamedKey::ArrowDown) if !self.chrome.focused => self.scroll_by(60.0),
            Key::Named(NamedKey::ArrowUp) if !self.chrome.focused => self.scroll_by(-60.0),
            // Space is a character key, not a named one, and only scrolls
            // when the page rather than the omnibox has the keyboard.
            Key::Character(c) if c.as_str() == " " && !ctrl && !self.chrome.focused => {
                self.scroll_page(1.0)
            }
            Key::Character(c) if ctrl => match c.as_str() {
                "l" => {
                    // Focus the address bar and select what is there, which is
                    // what every browser does and what makes ctrl-l useful.
                    self.chrome.focused = true;
                    true
                }
                "t" => {
                    self.emit(Event::TabRequested {
                        opener: self.active.unwrap_or(0),
                        url: String::new(),
                    });
                    true
                }
                "w" => {
                    if let Some(id) = self.active {
                        self.emit(Event::TabCloseRequest { id });
                    }
                    true
                }
                "r" => {
                    self.reload_active();
                    true
                }
                "d" => {
                    if let Some(id) = self.active {
                        self.emit(Event::BookmarkRequest { id });
                    }
                    true
                }
                _ => false,
            },
            _ => false,
        }
    }

    /// Scroll the active document by a fraction of the viewport.
    ///
    /// The chrome bar is `position: fixed`, so it stays put while this moves
    /// the page underneath it.
    fn scroll_page(&mut self, pages: f64) -> bool {
        let height = self
            .view()
            .map(|v| v.doc.inner().viewport().window_size.1 as f64)
            .unwrap_or(600.0);
        // Overlap by a line or so, the way every reader does, so nothing is
        // skipped between one press and the next.
        self.scroll_by((height - self.chrome.height - 40.0).max(80.0) * pages)
    }

    fn scroll_by(&mut self, delta: f64) -> bool {
        let chrome_height = self.chrome.height;
        let Some(view) = self.view() else { return true };
        let mut inner = view.doc.inner_mut();
        let current = inner.viewport_scroll();
        let max = (inner.root_node().final_layout.size.height as f64
            - inner.viewport().window_size.1 as f64
            + chrome_height)
            .max(0.0);
        let y = (current.y + delta).clamp(0.0, max);
        inner.set_viewport_scroll(blitz_dom::Point { x: current.x, y });
        drop(inner);
        view.request_redraw();
        true
    }

    fn scroll_to_top(&mut self) -> bool {
        let Some(view) = self.view() else { return true };
        let mut inner = view.doc.inner_mut();
        let x = inner.viewport_scroll().x;
        inner.set_viewport_scroll(blitz_dom::Point { x, y: 0.0 });
        drop(inner);
        view.request_redraw();
        true
    }

    fn reload_active(&mut self) {
        if let Some(id) = self.active {
            if let Some(url) = self.tabs.get(&id).map(|t| t.url.clone()) {
                self.navigate(id, url, false);
            }
        }
    }

    fn step_active(&mut self, delta: isize) {
        let Some(id) = self.active else { return };
        if let Some(url) = self.tabs.get_mut(&id).and_then(|t| t.step(delta)) {
            self.navigate(id, url, false);
        }
    }

    fn handle_hit(&mut self, hit: Hit) {
        match hit {
            Hit::Page => {}
            Hit::Back => {
                if let Some(id) = self.active {
                    if let Some(url) = self.tabs.get_mut(&id).and_then(|t| t.step(-1)) {
                        self.navigate(id, url, false);
                    }
                }
            }
            Hit::Forward => {
                if let Some(id) = self.active {
                    if let Some(url) = self.tabs.get_mut(&id).and_then(|t| t.step(1)) {
                        self.navigate(id, url, false);
                    }
                }
            }
            Hit::Reload => {
                if let Some(id) = self.active {
                    if let Some(url) = self.tabs.get(&id).map(|t| t.url.clone()) {
                        self.navigate(id, url, false);
                    }
                }
            }
            Hit::Omnibox => {
                self.chrome.focused = true;
                self.chrome.status.clear();
                self.rebuild_active_document();
            }
            Hit::Tab(id) => self.activate(id),
            Hit::TabClose(id) => self.emit(Event::TabCloseRequest { id }),
            Hit::NewTab => {
                self.emit(Event::TabRequested {
                    opener: self.active.unwrap_or(0),
                    url: String::new(),
                });
            }
        }
    }

    /// Keystrokes aimed at the omnibox. Returns true when consumed.
    fn handle_chrome_key(&mut self, key: &Key, text: Option<&str>) -> bool {
        if !self.chrome.focused {
            return false;
        }
        match key {
            Key::Named(NamedKey::Enter) => {
                let typed = self.chrome.omnibox.trim().to_string();
                self.chrome.focused = false;
                if !typed.is_empty() {
                    match self.active {
                        // Raw text, deliberately: the shell owns what typing
                        // means, so search, history and extension installs all
                        // behave the same however the address was entered.
                        Some(id) => self.emit(Event::NavigateRequest { id, text: typed }),
                        None => self.emit(Event::TabRequested {
                            opener: 0,
                            url: self.chrome.resolve_entry(),
                        }),
                    }
                }
                true
            }
            Key::Named(NamedKey::Escape) => {
                self.chrome.focused = false;
                if let Some(id) = self.active {
                    if let Some(tab) = self.tabs.get(&id) {
                        self.chrome.omnibox = tab.url.clone();
                    }
                }
                true
            }
            Key::Named(NamedKey::Backspace) => {
                self.chrome.omnibox.pop();
                true
            }
            Key::Named(_) => false,
            Key::Character(c) => {
                if let Some(t) = text {
                    self.chrome.omnibox.push_str(t);
                } else {
                    self.chrome.omnibox.push_str(c.as_str());
                }
                true
            }
            _ => false,
        }
    }

    // ------------------------------------------------------------- commands

    fn apply(&mut self, cmd: Command) {
        match cmd {
            Command::TabCreate { id, url } => {
                self.tabs.insert(id, Tab::new(url.clone()));
                self.order.push(id);
                if !url.is_empty() {
                    self.navigate(id, url, true);
                }
            }
            Command::TabClose { id } => {
                self.order.retain(|t| *t != id);
                self.tabs.remove(&id);
                self.engines.remove(&id); // kills the worker
                self.display_cache.remove(&id);
                if self.active == Some(id) {
                    self.active = None;
                    // Park a blank document so the window is never left
                    // holding a document no tab owns.
                    let blank = blank_document(&self.net, &self.navigation);
                    self.install(Box::new(blank));
                }
                self.sync_chrome();
            }
            Command::TabActivate { id } => self.activate(id),
            Command::TabNavigate { id, url } => self.navigate(id, url, true),
            Command::TabBack { id } => {
                if let Some(url) = self.tabs.get_mut(&id).and_then(|t| t.step(-1)) {
                    self.navigate(id, url, false);
                }
            }
            Command::TabForward { id } => {
                if let Some(url) = self.tabs.get_mut(&id).and_then(|t| t.step(1)) {
                    self.navigate(id, url, false);
                }
            }
            Command::TabReload { id, .. } => {
                if let Some(url) = self.tabs.get(&id).map(|t| t.url.clone()) {
                    self.navigate(id, url, false);
                }
            }
            Command::TabStop { id } => {
                // Bumping the generation orphans the in-flight fetch; its
                // result is discarded when it lands.
                if let Some(tab) = self.tabs.get_mut(&id) {
                    tab.generation += 1;
                    tab.loading = false;
                }
                self.emit(Event::TabLoading { id, loading: false });
            }
            // The chrome bar is drawn by us now, so the shell's height only
            // matters for where we put the band.
            Command::ChromeHeight { px } => {
                self.chrome.height = px.max(48) as f64;
                self.sync_chrome();
            }
            Command::SetContentScripts { json } => {
                match serde_json::from_str::<Vec<ContentScript>>(&json) {
                    Ok(list) => {
                        eprintln!(
                            "bunsen: content scripts updated: {} registration(s)",
                            list.len()
                        );
                        self.content_scripts = list;
                    }
                    Err(e) => eprintln!("bunsen: bad content_scripts payload: {e}"),
                }
            }
            Command::Status { text } => {
                self.chrome.status = text;
                self.sync_chrome();
            }
            Command::ToPage { id, payload } => {
                if let Some(engine) = self.engines.get(&id) {
                    engine.page_message(&payload);
                }
            }
            Command::AppQuit => self.quitting = true,
        }
    }

    fn activate(&mut self, id: TabId) {
        if self.active == Some(id) || !self.tabs.contains_key(&id) {
            return;
        }
        let incoming = match self.tabs.get_mut(&id).and_then(|t| t.doc.take()) {
            Some(doc) => doc,
            None => Box::new(blank_document(&self.net, &self.navigation)),
        };
        let outgoing = self.install(incoming);
        if let (Some(previous), Some(doc)) = (self.active, outgoing) {
            if let Some(tab) = self.tabs.get_mut(&previous) {
                tab.doc = Some(doc);
            }
        }
        self.active = Some(id);
        self.report_nav(id);
        self.sync_chrome();
    }

    fn navigate(&mut self, id: TabId, url: String, record: bool) {
        let Ok(parsed) = url::Url::parse(&url) else {
            self.emit(Event::TabFailed {
                id,
                url: url.clone(),
                message: format!("not a URL: {url}"),
            });
            return;
        };

        let Some(tab) = self.tabs.get_mut(&id) else {
            return;
        };
        // The previous page's worker dies here, not at install time: nothing
        // it does afterwards can matter once the user asked to leave.
        self.engines.remove(&id);
        tab.generation += 1;
        tab.loading = true;
        let generation = tab.generation;
        if record {
            tab.url = url.clone();
        }

        self.emit(Event::TabLoading { id, loading: true });
        self.emit(Event::TabUrl {
            id,
            url: url.clone(),
        });

        let net = self.net.clone();
        let tx = self.load_tx.clone();
        let proxy = self.proxy.clone();
        self.runtime.spawn(async move {
            let result = fetch::document(net.as_ref(), parsed).await;
            let _ = tx.send(Loaded {
                tab: id,
                generation,
                result,
            });
            proxy.wake_up();
        });
    }

    fn finish_load(&mut self, loaded: Loaded) {
        let Some(tab) = self.tabs.get_mut(&loaded.tab) else {
            return;
        };
        // A stale response from a navigation the user has already abandoned.
        if loaded.generation != tab.generation {
            return;
        }
        tab.loading = false;

        let (final_url, html) = match loaded.result {
            Ok(pair) => pair,
            Err(message) => {
                let url = tab.url.clone();
                self.emit(Event::TabLoading {
                    id: loaded.tab,
                    loading: false,
                });
                self.emit(Event::TabFailed {
                    id: loaded.tab,
                    url,
                    message,
                });
                return;
            }
        };

        let title = fetch::title_of(&html).unwrap_or_else(|| final_url.clone());
        tab.title = title.clone();
        tab.commit(final_url.clone());

        // Scripts never reach Stylo: the display copy is their absence, and
        // the worker gets the original.
        let stripped = js::strip_scripts(&html);
        self.display_cache.insert(loaded.tab, stripped.clone());
        let shown = chrome::inject(&stripped, &self.chrome);
        let doc = document_from(&shown, Some(final_url.clone()), &self.net, &self.navigation);
        if self.active == Some(loaded.tab) {
            self.install(Box::new(doc));
        } else if let Some(tab) = self.tabs.get_mut(&loaded.tab) {
            tab.doc = Some(Box::new(document_from(
                &stripped,
                Some(final_url.clone()),
                &self.net,
                &self.navigation,
            )));
        }

        self.spawn_engine(loaded.tab, final_url.clone(), html);

        self.emit(Event::TabUrl {
            id: loaded.tab,
            url: final_url,
        });
        self.emit(Event::TabTitle {
            id: loaded.tab,
            title,
        });
        self.emit(Event::TabLoading {
            id: loaded.tab,
            loading: false,
        });
        self.report_nav(loaded.tab);
        self.sync_chrome();
    }

    fn spawn_engine(&mut self, tab: TabId, url: String, html: String) {
        let (Some(bun), Some(worker)) = (self.bun.clone(), self.worker_script.clone()) else {
            if !self.warned_no_bun && !html.trim().is_empty() {
                eprintln!("bunsen: page has scripts but bun is unavailable");
                self.warned_no_bun = true;
            }
            return;
        };
        let tx = self.js_tx.clone();
        let proxy = self.proxy.clone();
        match js::Engine::spawn(
            &bun,
            &worker,
            tab,
            self.current_generation(tab),
            &url,
            &html,
            tx,
            Box::new(move || proxy.wake_up()),
        ) {
            Ok(engine) => {
                self.engines.insert(tab, engine);
            }
            Err(e) => eprintln!("bunsen-js: spawn failed for tab {tab}: {e}"),
        }
    }

    fn current_generation(&self, tab: TabId) -> u64 {
        self.tabs.get(&tab).map(|t| t.generation).unwrap_or(0)
    }

    /// Content scripts whose patterns match `url`, read off disk.
    fn matching_scripts(&self, url: &str) -> Vec<serde_json::Value> {
        let Ok(parsed) = url::Url::parse(url) else {
            return vec![];
        };
        let mut items = vec![];
        for reg in &self.content_scripts {
            if !reg.matches.iter().any(|p| js::matches_pattern(p, &parsed)) {
                continue;
            }
            for file in &reg.files {
                match std::fs::read_to_string(file) {
                    Ok(code) => items.push(serde_json::json!({ "ext": reg.ext, "code": code })),
                    Err(e) => eprintln!("bunsen: {}: cannot read {file}: {e}", reg.ext),
                }
            }
        }
        items
    }

    fn drain_js(&mut self) {
        while let Ok(env) = self.js_rx.try_recv() {
            // Anything a superseded generation sends is dropped unread.
            if env.generation != self.current_generation(env.tab)
                || !self.tabs.contains_key(&env.tab)
            {
                continue;
            }
            match env.msg {
                JsMsg::Ready => {
                    let items = self.matching_scripts(
                        &self
                            .tabs
                            .get(&env.tab)
                            .map(|t| t.url.clone())
                            .unwrap_or_default(),
                    );
                    if !items.is_empty() {
                        eprintln!(
                            "bunsen: injecting {} content script(s) into tab {}",
                            items.len(),
                            env.tab
                        );
                    }
                    if let Some(engine) = self.engines.get(&env.tab) {
                        engine.inject(&items);
                    }
                }
                JsMsg::Html(stripped) => {
                    self.display_cache.insert(env.tab, stripped.clone());
                    if self.active == Some(env.tab) {
                        let url = self
                            .tabs
                            .get(&env.tab)
                            .map(|t| t.url.clone())
                            .filter(|u| !u.is_empty());
                        let shown = chrome::inject(&stripped, &self.chrome);
                        let doc = document_from(&shown, url, &self.net, &self.navigation);
                        self.install(Box::new(doc));
                    } else if let Some(tab) = self.tabs.get_mut(&env.tab) {
                        tab.doc = Some(Box::new(document_from(
                            &stripped,
                            None,
                            &self.net,
                            &self.navigation,
                        )));
                    }
                }
                JsMsg::Title(title) => {
                    if let Some(tab) = self.tabs.get_mut(&env.tab) {
                        tab.title = title.clone();
                    }
                    self.emit(Event::TabTitle { id: env.tab, title });
                    self.sync_chrome();
                }
                JsMsg::Console { level, text } => {
                    eprintln!("bunsen-js [{}] {}: {}", env.tab, level, text);
                }
                JsMsg::Error { stage, message } => {
                    eprintln!("bunsen-js [{}] error in {}: {}", env.tab, stage, message);
                }
                JsMsg::Navigate(url) => self.navigate(env.tab, url, true),
                JsMsg::Download { url, filename } => self.emit(Event::DownloadRequest {
                    id: env.tab,
                    url,
                    filename,
                }),
                JsMsg::Page(payload) => {
                    self.emit(Event::PageEvent {
                        id: env.tab,
                        payload,
                    });
                }
            }
        }
    }

    fn report_nav(&self, id: TabId) {
        if let Some(tab) = self.tabs.get(&id) {
            self.emit(Event::TabNav {
                id,
                can_back: tab.can_back(),
                can_forward: tab.can_forward(),
            });
        }
    }

    /// Blitz asks the embedder what to do with a link click. Which document
    /// asked tells us which tab it was.
    fn handle_navigate(&mut self, options: NavigationOptions) {
        let source = options.source_document;
        let owner = self
            .tabs
            .iter()
            .find(|(_, tab)| tab.doc.as_ref().map(|d| d.id() == source).unwrap_or(false))
            .map(|(id, _)| *id)
            .or_else(|| {
                // The active tab's document lives in the window, not the map.
                self.active
                    .filter(|_| self.inner.windows.values().any(|v| v.doc.id() == source))
            });

        match owner {
            Some(id) => self.navigate(id, options.url.to_string(), true),
            None => self.emit(Event::TabRequested {
                opener: self.active.unwrap_or(0),
                url: options.url.to_string(),
            }),
        }
    }

    fn pump(&mut self, event_loop: &dyn ActiveEventLoop) {
        loop {
            let next = self.pending.lock().unwrap().pop_front();
            match next {
                Some(cmd) => self.apply(cmd),
                None => break,
            }
        }
        while let Ok(loaded) = self.load_rx.try_recv() {
            self.finish_load(loaded);
        }
        self.drain_js();

        // Blitz's own queue, minus the events it expects us to answer.
        while let Ok(event) = self.inner.event_queue.try_recv() {
            match event {
                BlitzShellEvent::Navigate(options) => self.handle_navigate(*options),
                other => self.inner.handle_blitz_shell_event(event_loop, other),
            }
        }

        if self.quitting {
            event_loop.exit();
        }
    }
}

impl ApplicationHandler for BunsenApp {
    fn can_create_surfaces(&mut self, event_loop: &dyn ActiveEventLoop) {
        self.inner.can_create_surfaces(event_loop);
    }

    fn destroy_surfaces(&mut self, event_loop: &dyn ActiveEventLoop) {
        self.inner.destroy_surfaces(event_loop);
    }

    fn resumed(&mut self, event_loop: &dyn ActiveEventLoop) {
        self.inner.resumed(event_loop);
    }

    fn suspended(&mut self, event_loop: &dyn ActiveEventLoop) {
        self.inner.suspended(event_loop);
    }

    fn window_event(
        &mut self,
        event_loop: &dyn ActiveEventLoop,
        window_id: WindowId,
        event: WindowEvent,
    ) {
        let closing = matches!(event, WindowEvent::CloseRequested);

        // Chrome-band input never reaches Blitz: the bar is ours.
        match &event {
            WindowEvent::SurfaceResized(_) => {
                self.sync_chrome();
            }
            WindowEvent::PointerButton {
                state,
                position,
                button,
                ..
            } => {
                if matches!(state, ElementState::Pressed)
                    && matches!(
                        button.clone().mouse_button(),
                        Some(winit::event::MouseButton::Left)
                    )
                {
                    let logical: winit::dpi::LogicalPosition<f64> =
                        position.to_logical(self.scale_factor());
                    if logical.y < self.chrome.height {
                        let hit = self.chrome.hit_test(logical.x, logical.y);
                        self.handle_hit(hit);
                        return; // swallowed: the bar is ours
                    }
                }
            }
            WindowEvent::ModifiersChanged(mods) => {
                self.modifiers = mods.state();
            }
            WindowEvent::KeyboardInput { event, .. } if event.state == ElementState::Pressed => {
                {
                    // Shortcuts outrank both the omnibox and the page: ctrl-w
                    // must close a tab even while typing in a text field.
                    if self.handle_shortcut(&event.logical_key) {
                        self.sync_chrome();
                        return;
                    }
                    let text = event.text.as_ref().map(|s| s.as_str());
                    if self.handle_chrome_key(&event.logical_key, text) {
                        self.sync_chrome();
                        return; // omnibox ate it
                    }
                }
            }
            _ => {}
        }

        self.inner.window_event(event_loop, window_id, event);
        if closing {
            self.events.push(Event::WindowClosed);
        }
        self.pump(event_loop);
    }

    fn proxy_wake_up(&mut self, event_loop: &dyn ActiveEventLoop) {
        self.pump(event_loop);
    }
}
