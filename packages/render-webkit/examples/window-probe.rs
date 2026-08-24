// SPDX-License-Identifier: MIT OR Apache-2.0
//! Which part of a window makes a tiling compositor treat it as a dialog.
//!
//! An example rather than a binary, so it stays in the repo without shipping
//! in the package. Build a window up in stages and ask the compositor what it
//! thinks of each:
//!
//!     cargo run -p bunsen-render-webkit --example window-probe
//!     VARIANT=4 cargo run -p bunsen-render-webkit --example window-probe
//!
//! 1. a plain GTK window
//! 2. an application window
//! 3. plus the chrome WebView and content stack
//! 4. plus the chrome's height request
//!
//! This is how the floating-window question got answered: variant 1 already
//! floated under a compositor that tiles everything else, which ruled out
//! anything Bunsen does and pointed at GTK4 itself. GTK4 creates an
//! `xdg_dialog_v1` for every toplevel and calls `unset_modal()` on it; a
//! compositor that reads the mere existence of that object as "dialog" floats
//! every GTK4 window. `WAYLAND_DEBUG=1` shows the calls.

use gtk::prelude::*;

fn main() {
    gtk::init().unwrap();
    let variant: u32 = std::env::var("VARIANT")
        .unwrap_or_else(|_| "1".into())
        .parse()
        .unwrap();

    let main_loop = glib::MainLoop::new(None, false);

    let window: gtk::Window = match variant {
        1 => gtk::Window::builder()
            .default_width(1280)
            .default_height(860)
            .title("probe-plain-window")
            .build(),
        _ => {
            let app = gtk::Application::builder()
                .application_id("dev.bunsen.Probe")
                .flags(gtk::gio::ApplicationFlags::NON_UNIQUE)
                .build();
            let _ = app.register(gtk::gio::Cancellable::NONE);
            let w = gtk::ApplicationWindow::builder()
                .application(&app)
                .default_width(1280)
                .default_height(860)
                .title(format!("probe-variant-{variant}"))
                .build();
            if variant >= 3 {
                let root = gtk::Box::new(gtk::Orientation::Vertical, 0);
                let chrome = webkit6::WebView::new();
                if variant >= 4 {
                    chrome.set_size_request(-1, 76);
                }
                chrome.set_vexpand(false);
                let stack = gtk::Stack::new();
                stack.set_vexpand(true);
                root.append(&chrome);
                root.append(&stack);
                w.set_child(Some(&root));
            }
            w.upcast()
        }
    };

    let ml = main_loop.clone();
    window.connect_close_request(move |_| {
        ml.quit();
        glib::Propagation::Proceed
    });
    window.present();
    main_loop.run();
}
