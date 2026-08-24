// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * End to end: a real extension directory, a real background worker, real
 * calls back into the shell.
 */

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ShellBridge, TabView } from "./api";
import { ExtensionHost } from "./registry";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function extensionDir(manifest: object, files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "bunsen-ext-"));
  dirs.push(root);
  const ext = join(root, "sample");
  mkdirSync(ext);
  writeFileSync(join(ext, "manifest.json"), JSON.stringify(manifest));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(ext, name), body);
  return root;
}

function bridge() {
  const tabs: TabView[] = [
    { id: 1, url: "https://a.test/", title: "A", active: true, loading: false },
    { id: 2, url: "https://b.test/", title: "B", active: false, loading: false },
  ];
  const messages: { extension: string; message: unknown }[] = [];
  const shell: ShellBridge = {
    listTabs: () => tabs,
    createTab: (url, active) => {
      const tab = { id: tabs.length + 1, url, title: "", active, loading: true };
      tabs.push(tab);
      return tab;
    },
    updateTab: (id, changes) => {
      const tab = tabs.find((t) => t.id === id);
      if (tab) Object.assign(tab, changes);
      return tab ?? null;
    },
    removeTab: (id) => {
      const i = tabs.findIndex((t) => t.id === id);
      if (i >= 0) tabs.splice(i, 1);
    },
    onExtensionMessage: (extension, message) => messages.push({ extension, message }),
  };
  return { shell, tabs, messages };
}

test("a background worker can use storage and talk back to the shell", async () => {
  const root = extensionDir(
    {
      manifest_version: 3,
      name: "Sample",
      version: "1.0",
      permissions: ["storage", "tabs"],
      background: { service_worker: "bg.js", type: "module" },
    },
    {
      "bg.js": `
        await browser.storage.local.set({ visits: 3 });
        const stored = await browser.storage.local.get("visits");
        const tabs = await browser.tabs.query({ active: true });
        const manifest = await browser.runtime.getManifest();
        await browser.runtime.sendMessage({
          stored: stored.visits,
          activeUrl: tabs[0].url,
          name: manifest.name,
        });
      `,
    },
  );

  const { shell, messages } = bridge();
  const host = new ExtensionHost(":memory:", shell);
  const report = host.loadAll(root);
  expect(report.failures).toEqual([]);
  expect(report.loaded).toHaveLength(1);

  await host.startBackground(report.loaded[0]);
  // sendMessage is fire and forget from the worker's side.
  await Bun.sleep(100);

  expect(messages).toHaveLength(1);
  expect(messages[0].message).toEqual({
    stored: 3,
    activeUrl: "https://a.test/",
    name: "Sample",
  });
  host.stop();
});

test("a call the manifest did not ask for is rejected, not silently allowed", async () => {
  const root = extensionDir(
    {
      manifest_version: 3,
      name: "Greedy",
      version: "1.0",
      permissions: ["storage"],
      background: { service_worker: "bg.js", type: "module" },
    },
    {
      "bg.js": `
        let outcome = "allowed";
        try { await browser.tabs.query({}); }
        catch (err) { outcome = err.message; }
        await browser.runtime.sendMessage(outcome);
      `,
    },
  );

  const { shell, messages } = bridge();
  const host = new ExtensionHost(":memory:", shell);
  const [ext] = host.loadAll(root).loaded;
  await host.startBackground(ext);
  await Bun.sleep(100);

  expect(messages[0].message).toBe("permission denied: tabs");
  host.stop();
});

test("an unimplemented API fails honestly instead of being undefined", async () => {
  const root = extensionDir(
    {
      manifest_version: 3,
      name: "Ahead of us",
      version: "1.0",
      background: { service_worker: "bg.js", type: "module" },
    },
    {
      "bg.js": `
        let outcome = "allowed";
        try { await browser.webRequest.onBeforeRequest.addListener(); }
        catch (err) { outcome = err.message; }
        await browser.runtime.sendMessage(outcome);
      `,
    },
  );

  const { shell, messages } = bridge();
  const host = new ExtensionHost(":memory:", shell);
  const [ext] = host.loadAll(root).loaded;
  await host.startBackground(ext);
  await Bun.sleep(100);

  expect(String(messages[0].message)).toContain("not implemented");
  host.stop();
});

test("a background script pointing outside the extension is refused", async () => {
  const root = extensionDir({
    manifest_version: 3,
    name: "Escapee",
    version: "1.0",
    background: { service_worker: "../../../etc/passwd", type: "module" },
  });

  const { shell } = bridge();
  const host = new ExtensionHost(":memory:", shell);
  const [ext] = host.loadAll(root).loaded;
  await expect(host.startBackground(ext)).rejects.toThrow(/escapes/);
  host.stop();
});

test("a broken manifest is reported, not thrown", () => {
  const root = extensionDir({ manifest_version: 2, name: "Old", version: "1" });
  const { shell } = bridge();
  const host = new ExtensionHost(":memory:", shell);
  const report = host.loadAll(root);
  expect(report.loaded).toEqual([]);
  expect(report.failures[0].errors[0]).toContain("manifest_version");
  host.stop();
});

test("__MSG_ placeholders in the name are resolved from _locales", () => {
  // Store extensions routinely ship `"name": "__MSG_extName__"`; left alone
  // that is what the tab strip would display. uBlock Origin Lite is a real
  // example, which is how this was found.
  const root = extensionDir({
    manifest_version: 3,
    name: "__MSG_extName__",
    description: "__MSG_extDesc__",
    version: "1.0",
    default_locale: "en",
  });
  const locales = join(root, "sample", "_locales", "en");
  mkdirSync(locales, { recursive: true });
  writeFileSync(
    join(locales, "messages.json"),
    JSON.stringify({
      extName: { message: "Resolved Name" },
      extDesc: { message: "Resolved description" },
    }),
  );

  const { shell } = bridge();
  const host = new ExtensionHost(":memory:", shell);
  const [extension] = host.loadAll(root).loaded;
  expect(extension.manifest.name).toBe("Resolved Name");
  expect(extension.manifest.description).toBe("Resolved description");
  host.stop();
});

test("a missing locale file leaves the placeholder rather than throwing", () => {
  const root = extensionDir({
    manifest_version: 3,
    name: "__MSG_extName__",
    version: "1.0",
    default_locale: "en",
  });
  const { shell } = bridge();
  const host = new ExtensionHost(":memory:", shell);
  const [extension] = host.loadAll(root).loaded;
  expect(extension.manifest.name).toBe("__MSG_extName__");
  host.stop();
});

test("a leading slash means the extension root, not the filesystem root", async () => {
  // Real store extensions write "/js/background.js"; uBlock Origin Lite does.
  // Treating that as an absolute path refused to start their background page.
  const root = extensionDir(
    {
      manifest_version: 3,
      name: "Root Relative",
      version: "1.0",
      background: { service_worker: "/js/bg.js", type: "module" },
    },
  );
  mkdirSync(join(root, "sample", "js"), { recursive: true });
  writeFileSync(join(root, "sample", "js", "bg.js"), `await browser.runtime.getManifest();`);

  const { shell } = bridge();
  const host = new ExtensionHost(":memory:", shell);
  const [extension] = host.loadAll(root).loaded;
  await host.startBackground(extension);
  host.stop();
});

test("climbing out of the extension directory is still refused", async () => {
  const root = extensionDir({
    manifest_version: 3,
    name: "Escapee",
    version: "1.0",
    background: { service_worker: "/../../../etc/passwd", type: "module" },
  });
  const { shell } = bridge();
  const host = new ExtensionHost(":memory:", shell);
  const [extension] = host.loadAll(root).loaded;
  await expect(host.startBackground(extension)).rejects.toThrow(/escapes/);
  host.stop();
});
