// SPDX-License-Identifier: MIT OR Apache-2.0
import { expect, test } from "bun:test";
import { ExtensionStorage, LOCAL_QUOTA_BYTES } from "./storage";

const store = () => new ExtensionStorage(":memory:");

test("values round trip with their types intact", () => {
  const s = store();
  s.set("ext", "local", { n: 1, s: "x", b: true, o: { a: [1, 2] }, nul: null });
  expect(s.get("ext", "local", null)).toEqual({
    n: 1,
    s: "x",
    b: true,
    o: { a: [1, 2] },
    nul: null,
  });
  s.close();
});

test("one extension cannot see another's keys", () => {
  const s = store();
  s.set("a", "local", { secret: 1 });
  s.set("b", "local", { other: 2 });
  expect(s.get("b", "local", null)).toEqual({ other: 2 });
  s.close();
});

test("areas are separate namespaces", () => {
  const s = store();
  s.set("ext", "local", { k: "local" });
  s.set("ext", "sync", { k: "sync" });
  s.set("ext", "session", { k: "session" });
  expect(s.get("ext", "local", null)).toEqual({ k: "local" });
  expect(s.get("ext", "sync", null)).toEqual({ k: "sync" });
  expect(s.get("ext", "session", null)).toEqual({ k: "session" });
  s.close();
});

test("a key filter returns only what was asked for", () => {
  const s = store();
  s.set("ext", "local", { a: 1, b: 2, c: 3 });
  expect(s.get("ext", "local", ["a", "c", "missing"])).toEqual({ a: 1, c: 3 });
  s.close();
});

test("remove and clear do what they say", () => {
  const s = store();
  s.set("ext", "local", { a: 1, b: 2 });
  s.remove("ext", "local", ["a"]);
  expect(s.get("ext", "local", null)).toEqual({ b: 2 });
  s.clear("ext", "local");
  expect(s.get("ext", "local", null)).toEqual({});
  s.close();
});

test("exceeding the quota fails the whole write", () => {
  const s = store();
  s.set("ext", "local", { keep: "value" });
  expect(() => s.set("ext", "local", { big: "x".repeat(LOCAL_QUOTA_BYTES + 1) })).toThrow(
    /quota/,
  );
  // The transaction rolled back, so the oversized key was not committed and
  // the pre-existing one survived.
  expect(s.get("ext", "local", null)).toEqual({ keep: "value" });
  s.close();
});
