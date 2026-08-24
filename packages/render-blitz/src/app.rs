// SPDX-License-Identifier: MIT OR Apache-2.0
//! The winit thread: one window, one document installed at a time, the rest
//! of the tabs parked in [`crate::tabs`].
//!
//! `BlitzApplication` already knows how to drive a `View`, so this wraps it
//! rather than reimplementing it, and intercepts the two things Blitz leaves
//! to the embedder: navigation requests, and everything about tabs.

use std::collections::{HashMap, VecDeque};
use std::sync::mpsc::{channel, Receiver as StdReceiver, Sender as StdSender};
use std::sync::{Arc, Mutex};

use anyrender_vello::VelloWindowRenderer;
use blitz_dom::{Document, DocumentConfig};
use blitz_html::HtmlDocument;
use blitz_shell::{
    create_default_event_loop, BlitzApplication, BlitzShellEvent, BlitzShellProxy, View,
    WindowConfig,
};
use blitz_traits::navigation::{NavigationOptions, NavigationProvider};
use blitz_traits::net::NetProvider;
use winit::application::ApplicationHandler;
use winit::event::WindowEvent;
use winit::event_loop::ActiveEventLoop;
use winit::window::{WindowAttributes, WindowId};

use bunsen_protocol::codec::decode_commands;
use bunsen_protocol::{Command, Config, Event, EventQueue, TabId};

use crate::fetch;
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

    let event_loop = create_default_event_loop();
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
            .with_surface_size(winit::dpi::LogicalSize::new(cfg.width, cfg.height)),
    ));

    // Commands arrive on a thread that is not the winit thread, so park them
    // and wake the loop.
    let pending: Arc<Mutex<VecDeque<Command>>> = Arc::new(Mutex::new(VecDeque::new()));
    spawn_command_pump(commands, pending.clone(), proxy.clone());

    let (load_tx, load_rx) = channel::<Loaded>();

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
    };
    app.emit(Event::Ready);

    if let Err(e) = event_loop.run_app(app) {
        eprintln!("bunsen: event loop stopped: {e}");
    }
    events.push(Event::WindowClosed);
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
}

impl BunsenApp {
    fn emit(&self, event: Event) {
        self.events.push(event);
    }

    fn view(&mut self) -> Option<&mut View<VelloWindowRenderer>> {
        self.inner.windows.values_mut().next()
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
        view.poll();
        view.request_redraw();
        Some(old)
    }

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
                if self.active == Some(id) {
                    self.active = None;
                    // Park a blank document so the window is never left
                    // holding a document no tab owns.
                    let blank = blank_document(&self.net, &self.navigation);
                    self.install(Box::new(blank));
                }
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
            // The chrome UI is not composited into this window yet, so there
            // is no height to set. See the note in lib.rs.
            Command::ChromeHeight { .. } => {}
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

        let doc = document_from(&html, Some(final_url.clone()), &self.net, &self.navigation);
        if self.active == Some(loaded.tab) {
            self.install(Box::new(doc));
        } else if let Some(tab) = self.tabs.get_mut(&loaded.tab) {
            tab.doc = Some(Box::new(doc));
        }

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
