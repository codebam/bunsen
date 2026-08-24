// SPDX-License-Identifier: MIT OR Apache-2.0
import { expect, test } from "bun:test";
import { History } from "./history";

const memory = () => new History(":memory:");

test("repeat visits collapse into one row and bump the count", () => {
  const h = memory();
  h.record("https://example.com", "Example");
  h.record("https://example.com", "Example");
  const [row] = h.recent();
  expect(row.visits).toBe(2);
  expect(h.recent()).toHaveLength(1);
  h.close();
});

test("an empty title never overwrites a known one", () => {
  const h = memory();
  h.record("https://example.com", "Example");
  h.record("https://example.com", "");
  expect(h.recent()[0].title).toBe("Example");
  h.close();
});

test("non-http schemes are not recorded", () => {
  const h = memory();
  h.record("about:blank", "");
  h.record("file:///etc/hosts", "hosts");
  expect(h.recent()).toHaveLength(0);
  h.close();
});

test("suggestions match url or title, most visited first", () => {
  const h = memory();
  h.record("https://example.com/docs", "Docs");
  h.record("https://other.test", "Something Else");
  h.record("https://other.test", "Something Else");
  expect(h.suggest("docs").map((r) => r.url)).toEqual(["https://example.com/docs"]);
  expect(h.suggest("s")[0].url).toBe("https://other.test");
  expect(h.suggest("  ")).toEqual([]);
  h.close();
});
