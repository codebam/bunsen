// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * The render backend contract, mirrored from
 * packages/render-webkit/include/bunsen_render.h.
 *
 * The shell is written against this interface only. Swapping WebKitGTK for
 * Blitz means loading a different shared object, not touching anything here.
 */

export type TabId = number;

export type Command =
  | { op: "tab_create"; id: TabId; url: string }
  | { op: "tab_close"; id: TabId }
  | { op: "tab_activate"; id: TabId }
  | { op: "tab_navigate"; id: TabId; url: string }
  | { op: "tab_back"; id: TabId }
  | { op: "tab_forward"; id: TabId }
  | { op: "tab_reload"; id: TabId; bypass_cache?: boolean }
  | { op: "tab_stop"; id: TabId }
  | { op: "chrome_height"; px: number }
  | { op: "set_content_scripts"; json: string }
  | { op: "status"; text: string }
  | { op: "to_page"; id: TabId; payload: string }
  | { op: "app_quit" };

export interface ContentScript {
  ext: string;
  matches: string[];
  files: string[];
}

export type BackendEvent =
  | { ev: "ready" }
  | { ev: "tab_title"; id: TabId; title: string }
  | { ev: "tab_url"; id: TabId; url: string }
  | { ev: "tab_progress"; id: TabId; progress: number }
  | { ev: "tab_loading"; id: TabId; loading: boolean }
  | { ev: "tab_nav"; id: TabId; can_back: boolean; can_forward: boolean }
  | { ev: "tab_failed"; id: TabId; url: string; message: string }
  | { ev: "tab_favicon"; id: TabId; data_url: string }
  | { ev: "tab_requested"; opener: TabId; url: string }
  | { ev: "window_closed" }
  | { ev: "tab_close_request"; id: TabId }
  | { ev: "page_event"; id: TabId; payload: string }
  | { ev: "bookmark_request"; id: TabId }
  | { ev: "navigate_request"; id: TabId; text: string };

export interface BackendConfig {
  chrome_url: string;
  width?: number;
  height?: number;
  chrome_height?: number;
  /** Profile directory. Omit for a session that forgets everything on exit. */
  data_dir?: string;
  cache_dir?: string;
  /** Let scripts open windows without a user gesture. Off is the popup blocker. */
  allow_popups?: boolean;
  /** Content scripts known at startup; more can arrive via set_content_scripts. */
  content_scripts?: ContentScript[];
}

export interface RenderBackend {
  /** Bring up the window. Resolves once the backend reports `ready`. */
  start(config: BackendConfig): Promise<void>;
  /** Queue a command. Commands are flushed as one batch per microtask. */
  send(cmd: Command): void;
  /** Force the pending batch out now. */
  flush(): void;
  onEvent(handler: (ev: BackendEvent) => void): void;
  stop(): void;
}
