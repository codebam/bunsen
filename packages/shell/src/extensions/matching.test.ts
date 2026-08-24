// SPDX-License-Identifier: MIT OR Apache-2.0
import { expect, test } from "bun:test";
import { MatchSet, parseMatchPattern } from "./matching";

const m = (pattern: string, url: string) => parseMatchPattern(pattern)?.matches(url) ?? false;

test("host wildcards cover subdomains but not unrelated suffixes", () => {
  expect(m("https://*.example.com/*", "https://example.com/")).toBe(true);
  expect(m("https://*.example.com/*", "https://a.b.example.com/x")).toBe(true);
  expect(m("https://*.example.com/*", "https://notexample.com/")).toBe(false);
  // The classic mistake: suffix matching without the dot.
  expect(m("https://*.example.com/*", "https://evil-example.com/")).toBe(false);
});

test("an exact host does not match its subdomains", () => {
  expect(m("https://example.com/*", "https://example.com/x")).toBe(true);
  expect(m("https://example.com/*", "https://sub.example.com/x")).toBe(false);
});

test("a wildcard scheme means web schemes, never file", () => {
  expect(m("*://example.com/*", "http://example.com/")).toBe(true);
  expect(m("*://example.com/*", "https://example.com/")).toBe(true);
  expect(m("*://example.com/*", "ftp://example.com/")).toBe(false);
  expect(m("*://*/*", "file:///etc/passwd")).toBe(false);
});

test("paths are globs, anchored at both ends", () => {
  expect(m("https://example.com/a/*", "https://example.com/a/b")).toBe(true);
  expect(m("https://example.com/a/*", "https://example.com/b/a/")).toBe(false);
  expect(m("https://example.com/exact", "https://example.com/exact")).toBe(true);
  expect(m("https://example.com/exact", "https://example.com/exactly")).toBe(false);
  // Query strings are part of what the path glob sees.
  expect(m("https://example.com/*", "https://example.com/p?q=1")).toBe(true);
});

test("path globs do not let regex metacharacters through", () => {
  expect(m("https://example.com/a.b", "https://example.com/axb")).toBe(false);
  expect(m("https://example.com/a.b", "https://example.com/a.b")).toBe(true);
});

test("<all_urls> covers the known schemes and nothing else", () => {
  expect(m("<all_urls>", "https://example.com/")).toBe(true);
  expect(m("<all_urls>", "file:///tmp/x")).toBe(true);
  expect(m("<all_urls>", "about:blank")).toBe(false);
  expect(m("<all_urls>", "javascript:alert(1)")).toBe(false);
});

test("malformed patterns are rejected rather than approximated", () => {
  for (const bad of [
    "example.com/*",            // no scheme
    "https://example.com",      // no path
    "https://*foo.example/*",   // partial host wildcard
    "https://*./*",             // empty wildcard host
    "chrome://*/*",             // unsupported scheme
    "",
  ]) {
    expect(parseMatchPattern(bad)).toBeNull();
  }
});

test("a match set is a union, and remembers what it could not parse", () => {
  const set = new MatchSet(["https://a.test/*", "nonsense", "https://b.test/*"]);
  expect(set.size).toBe(2);
  expect(set.invalid).toEqual(["nonsense"]);
  expect(set.matches("https://b.test/x")).toBe(true);
  expect(set.matches("https://c.test/x")).toBe(false);
});
