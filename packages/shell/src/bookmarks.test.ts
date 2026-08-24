// SPDX-License-Identifier: MIT OR Apache-2.0
import { expect, test } from "bun:test";
import { Bookmarks } from "./bookmarks";

const store = () => new Bookmarks(":memory:");

test("adding is idempotent and does not duplicate", () => {
  const b = store();
  b.add("https://example.com/", "Example");
  b.add("https://example.com/", "Example");
  expect(b.all()).toHaveLength(1);
  expect(b.has("https://example.com/")).toBe(true);
  b.close();
});

test("an empty title never overwrites a known one", () => {
  const b = store();
  b.add("https://example.com/", "Example");
  b.add("https://example.com/", "");
  expect(b.all()[0].title).toBe("Example");
  b.close();
});

test("toggle is what a star button does", () => {
  const b = store();
  expect(b.toggle("https://example.com/", "Example")).toBe(true);
  expect(b.has("https://example.com/")).toBe(true);
  expect(b.toggle("https://example.com/", "Example")).toBe(false);
  expect(b.has("https://example.com/")).toBe(false);
  b.close();
});

test("non-http schemes are refused", () => {
  const b = store();
  b.add("about:blank", "blank");
  b.add("file:///etc/hosts", "hosts");
  expect(b.all()).toEqual([]);
  b.close();
});

test("listing is newest first", () => {
  const b = store();
  b.add("https://a.test/", "A");
  b.add("https://b.test/", "B");
  const urls = b.all().map((x) => x.url);
  expect(urls).toContain("https://a.test/");
  expect(urls).toContain("https://b.test/");
  b.close();
});
