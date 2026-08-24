// SPDX-License-Identifier: MIT OR Apache-2.0
//! The GTK thread: owns the window, the chrome view, and one WebView per tab.
//!
//! Nothing here is reachable from the Bun thread except through the command
//! channel and the event queue.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::Arc;

use gtk::prelude::*;
use webkit6::prelude::*;

use crate::eventq::EventQueue;
use crate::protocol::{Command, Config, Event, TabId};

struct Ui {
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

    let chrome = webkit6::WebView::new();
    chrome.set_size_request(-1, cfg.chrome_height);
    chrome.set_vexpand(false);
    chrome.load_uri(&cfg.chrome_url);

    let stack = gtk::Stack::new();
    stack.set_vexpand(true);

    root.append(&chrome);
    root.append(&stack);
    window.set_child(Some(&root));

    let ui = Rc::new(RefCell::new(Ui {
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
                let cmds: Vec<Command> = match serde_json::from_slice(&batch) {
                    Ok(c) => c,
                    Err(e) => {
                        eprintln!("bunsen: bad command batch: {e}");
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
            let view = webkit6::WebView::new();
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
