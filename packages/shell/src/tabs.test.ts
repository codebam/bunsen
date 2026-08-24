// SPDX-License-Identifier: MIT OR Apache-2.0
import { expect, test } from "bun:test";
import { TabStore } from "./tabs";

test("first tab becomes active", () => {
  const s = new TabStore();
  const t = s.create("https://a");
  expect(s.activeId).toBe(t.id);
});

test("a tab opened by another lands directly to its right", () => {
  const s = new TabStore();
  const a = s.create("https://a");
  const b = s.create("https://b");
  const child = s.create("https://child", a.id);
  expect(s.list().map((t) => t.id)).toEqual([a.id, child.id, b.id]);
});

test("closing the active tab activates its neighbour", () => {
  const s = new TabStore();
  const a = s.create("https://a");
  const b = s.create("https://b");
  const c = s.create("https://c");
  s.activate(b.id);
  expect(s.close(b.id)).toBe(c.id);
  expect(s.list().map((t) => t.id)).toEqual([a.id, c.id]);
});

test("closing the last tab leaves nothing active", () => {
  const s = new TabStore();
  const a = s.create("https://a");
  expect(s.close(a.id)).toBe(null);
  expect(s.size).toBe(0);
});

test("closing a background tab does not steal focus", () => {
  const s = new TabStore();
  const a = s.create("https://a");
  const b = s.create("https://b");
  s.activate(a.id);
  expect(s.close(b.id)).toBe(a.id);
});

test("ids are never reused", () => {
  const s = new TabStore();
  const a = s.create("https://a");
  s.close(a.id);
  expect(s.create("https://b").id).not.toBe(a.id);
});
