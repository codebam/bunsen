// SPDX-License-Identifier: MIT OR Apache-2.0
import { expect, test } from "bun:test";
import { resolve } from "./omnibox";

test("keeps anything already carrying a scheme", () => {
  expect(resolve("https://example.com/x")).toBe("https://example.com/x");
  expect(resolve("about:blank")).toBe("about:blank");
  expect(resolve("file:///etc/hosts")).toBe("file:///etc/hosts");
});

test("promotes bare hosts to https", () => {
  expect(resolve("example.com")).toBe("https://example.com");
  expect(resolve("example.com/a/b?c=1")).toBe("https://example.com/a/b?c=1");
  expect(resolve("sub.example.co.uk:8443")).toBe("https://sub.example.co.uk:8443");
});

test("localhost stays on http, where dev servers actually live", () => {
  expect(resolve("localhost")).toBe("http://localhost");
  expect(resolve("localhost:3000")).toBe("http://localhost:3000");
});

test("everything else is a search", () => {
  expect(resolve("how do browsers work")).toContain("duckduckgo.com/?q=");
  expect(resolve("rust ffi")).toBe("https://duckduckgo.com/?q=rust%20ffi");
  // A single word with no dot is a search, not a hostname guess.
  expect(resolve("bunsen")).toContain("q=bunsen");
});

test("empty input goes nowhere", () => {
  expect(resolve("   ")).toBe("about:blank");
});
