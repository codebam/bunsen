// SPDX-License-Identifier: MIT OR Apache-2.0
//! The GTK thread: owns the window, the chrome view, and one WebView per tab.
//!
//! Nothing here is reachable from the Bun thread except through the command
//! channel and the event queue.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::Arc;

use gtk::gdk::prelude::TextureExt;
use gtk::prelude::*;
use webkit6::prelude::*;

use bunsen_protocol::codec::decode_commands;
use bunsen_protocol::eventq::EventQueue;
use bunsen_protocol::protocol::{Command, Config, Event, TabId};

struct Ui {
    session: webkit6::NetworkSession,
    settings: webkit6::Settings,
    stack: gtk::Stack,
    chrome: webkit6::WebView,
    window: gtk::ApplicationWindow,
    tabs: HashMap<TabId, webkit6::WebView>,
    events: Arc<EventQueue>,
}

pub fn run(cfg: Config, commands: async_channel::Receiver<Vec<u8>>, events: Arc<EventQueue>) {
    if gtk::init().is_err() {
        eprintln!("bunsen: gtk::init failed (no display?)");
        return;
    }

    let app = gtk::Application::builder()
        .application_id("dev.bunsen.Browser")
        .flags(gtk::gio::ApplicationFlags::NON_UNIQUE)
        .build();
    // Register without activating: we drive the window ourselves so the
    // lifetime is owned by this thread, not by GApplication's run loop.
    let _ = app.register(gtk::gio::Cancellable::NONE);

    let window = gtk::ApplicationWindow::builder()
        .application(&app)
        .default_width(cfg.width)
        .default_height(cfg.height)
        .title("Bunsen")
        .build();

    let root = gtk::Box::new(gtk::Orientation::Vertical, 0);

    let session = content_session(&cfg);
    let settings = content_settings(&cfg);

    // The chrome UI is local and must never share cookies or storage with the
    // pages it is displaying.
    let chrome = webkit6::WebView::builder()
        .network_session(&webkit6::NetworkSession::new_ephemeral())
        .build();
    chrome.set_size_request(-1, cfg.chrome_height);
    chrome.set_vexpand(false);
    chrome.load_uri(&cfg.chrome_url);

    let stack = gtk::Stack::new();
    stack.set_vexpand(true);

    root.append(&chrome);
    root.append(&stack);
    window.set_child(Some(&root));

    let ui = Rc::new(RefCell::new(Ui {
        session,
        settings,
        stack,
        chrome,
        window: window.clone(),
        tabs: HashMap::new(),
        events: events.clone(),
    }));

    let main_loop = glib::MainLoop::new(None, false);

    {
        let events = events.clone();
        let main_loop = main_loop.clone();
        window.connect_close_request(move |_| {
            events.push(Event::WindowClosed);
            main_loop.quit();
            glib::Propagation::Proceed
        });
    }

    // Command pump.
    {
        let ui = ui.clone();
        let main_loop = main_loop.clone();
        glib::MainContext::default().spawn_local(async move {
            while let Ok(batch) = commands.recv().await {
                let cmds = match decode_commands(&batch) {
                    Ok(c) => c,
                    Err(e) => {
                        eprintln!("bunsen: {e}");
                        continue;
                    }
                };
                for cmd in cmds {
                    if matches!(cmd, Command::AppQuit) {
                        main_loop.quit();
                        return;
                    }
                    apply(&ui, cmd);
                }
            }
            main_loop.quit();
        });
    }

    window.present();
    events.push(Event::Ready);
    main_loop.run();
}

fn apply(ui: &Rc<RefCell<Ui>>, cmd: Command) {
    match cmd {
        Command::TabCreate { id, url } => {
            let view = {
                let u = ui.borrow();
                webkit6::WebView::builder()
                    .network_session(&u.session)
                    .settings(&u.settings)
                    .build()
            };
            wire_signals(ui, id, &view);
            {
                let mut u = ui.borrow_mut();
                u.stack.add_named(&view, Some(&id.to_string()));
                u.tabs.insert(id, view.clone());
            }
            if !url.is_empty() {
                view.load_uri(&url);
            }
        }
        Command::TabClose { id } => {
            let mut u = ui.borrow_mut();
            if let Some(view) = u.tabs.remove(&id) {
                u.stack.remove(&view);
            }
        }
        Command::TabActivate { id } => {
            let u = ui.borrow();
            if u.tabs.contains_key(&id) {
                u.stack.set_visible_child_name(&id.to_string());
            }
        }
        Command::TabNavigate { id, url } => with_tab(ui, id, |v| v.load_uri(&url)),
        Command::TabBack { id } => with_tab(ui, id, |v| v.go_back()),
        Command::TabForward { id } => with_tab(ui, id, |v| v.go_forward()),
        Command::TabReload { id, bypass_cache } => with_tab(ui, id, |v| {
            if bypass_cache {
                v.reload_bypass_cache()
            } else {
                v.reload()
            }
        }),
        Command::TabStop { id } => with_tab(ui, id, |v| v.stop_loading()),
        Command::ChromeHeight { px } => {
            ui.borrow().chrome.set_size_request(-1, px);
        }
        Command::AppQuit => {
            ui.borrow().window.close();
        }
    }
}

fn with_tab<F: FnOnce(&webkit6::WebView)>(ui: &Rc<RefCell<Ui>>, id: TabId, f: F) {
    let view = ui.borrow().tabs.get(&id).cloned();
    if let Some(view) = view {
        f(&view);
    }
}

fn wire_signals(ui: &Rc<RefCell<Ui>>, id: TabId, view: &webkit6::WebView) {
    let q = ui.borrow().events.clone();

    let e = q.clone();
    view.connect_title_notify(move |v| {
        e.push(Event::TabTitle {
            id,
            title: v.title().map(|s| s.to_string()).unwrap_or_default(),
        });
    });

    let e = q.clone();
    view.connect_uri_notify(move |v| {
        e.push(Event::TabUrl {
            id,
            url: v.uri().map(|s| s.to_string()).unwrap_or_default(),
        });
    });

    let e = q.clone();
    view.connect_estimated_load_progress_notify(move |v| {
        e.push(Event::TabProgress {
            id,
            progress: v.estimated_load_progress(),
        });
    });

    let e = q.clone();
    view.connect_is_loading_notify(move |v| {
        e.push(Event::TabLoading {
            id,
            loading: v.is_loading(),
        });
        // Back/forward availability only settles as the load state moves.
        e.push(Event::TabNav {
            id,
            can_back: v.can_go_back(),
            can_forward: v.can_go_forward(),
        });
    });

    let e = q.clone();
    view.connect_favicon_notify(move |v| {
        if let Some(url) = favicon_data_url(v) {
            e.push(Event::TabFavicon { id, data_url: url });
        }
    });

    // target=_blank and window.open() arrive as a new-window policy decision.
    // We intercept there rather than on `create`, because `create` must hand
    // WebKit a live view and tab lifetime belongs to the shell, not here.
    let e = q.clone();
    view.connect_decide_policy(move |_, decision, kind| {
        if kind != webkit6::PolicyDecisionType::NewWindowAction {
            return false;
        }
        let uri = decision
            .downcast_ref::<webkit6::NavigationPolicyDecision>()
            .and_then(|d| d.navigation_action())
            .and_then(|mut a| a.request())
            .and_then(|r| r.uri());
        if let Some(uri) = uri {
            e.push(Event::TabRequested {
                opener: id,
                url: uri.to_string(),
            });
        }
        decision.ignore();
        true
    });

    let e = q.clone();
    view.connect_load_failed(move |_, _, uri, err| {
        e.push(Event::TabFailed {
            id,
            url: uri.to_string(),
            message: err.to_string(),
        });
        // false: let WebKit render its own error page.
        false
    });
}

/// Settings shared by every content view.
fn content_settings(cfg: &Config) -> webkit6::Settings {
    let settings = webkit6::Settings::new();
    // WebKit's default is already to block gesture-less window.open; state it
    // explicitly so the popup policy is visible in one place.
    settings.set_javascript_can_open_windows_automatically(cfg.allow_popups);
    settings
}

/// Build the session every content view shares: one cookie jar, one cache,
/// one favicon database. With no data directory it is ephemeral, which is
/// what private browsing will be built on.
fn content_session(cfg: &Config) -> webkit6::NetworkSession {
    let Some(data_dir) = cfg.data_dir.as_deref() else {
        return webkit6::NetworkSession::new_ephemeral();
    };
    let cache_dir = cfg.cache_dir.as_deref().unwrap_or(data_dir);
    let session = webkit6::NetworkSession::new(Some(data_dir), Some(cache_dir));

    if let Some(data) = session.website_data_manager() {
        // Favicons are off by default, and the database is per session.
        data.set_favicons_enabled(true);
    }
    if let Some(cookies) = session.cookie_manager() {
        cookies.set_persistent_storage(
            &format!("{data_dir}/cookies.sqlite"),
            webkit6::CookiePersistentStorage::Sqlite,
        );
        // Third-party cookies are off. Sites that need them will have to ask
        // once we have a permission surface to ask through.
        cookies.set_accept_policy(webkit6::CookieAcceptPolicy::NoThirdParty);
    }
    session
}

/// WebKit hands us a GdkTexture; the chrome UI wants something it can put in
/// an <img>. PNG round-trip is cheap at favicon sizes and avoids teaching the
/// protocol about pixel formats.
fn favicon_data_url(view: &webkit6::WebView) -> Option<String> {
    let texture = view.favicon()?;
    let png = texture.save_to_png_bytes();
    Some(format!(
        "data:image/png;base64,{}",
        glib::base64_encode(&png)
    ))
}
