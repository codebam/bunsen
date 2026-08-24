// SPDX-License-Identifier: MIT OR Apache-2.0
import { expect, test } from "bun:test";
import { parseManifest } from "./manifest";

const base = { manifest_version: 3, name: "Test", version: "1.0" };

test("a minimal manifest parses", () => {
  const { manifest, errors } = parseManifest(base, "fallback");
  expect(errors).toEqual([]);
  expect(manifest?.name).toBe("Test");
  expect(manifest?.id).toBe("fallback");
  expect(manifest?.background).toBeNull();
});

test("manifest v2 is refused rather than half-understood", () => {
  const { manifest, errors } = parseManifest({ ...base, manifest_version: 2 }, "x");
  expect(manifest).toBeNull();
  expect(errors[0]).toContain("manifest_version");
});

test("MV2 background.scripts is an error, not a silent no-op", () => {
  const { manifest, errors } = parseManifest(
    { ...base, background: { scripts: ["bg.js"] } },
    "x",
  );
  expect(manifest).toBeNull();
  expect(errors[0]).toContain("service_worker");
});

test("unsupported permissions are dropped with a warning, not granted", () => {
  const { manifest, warnings } = parseManifest(
    { ...base, permissions: ["storage", "nativeMessaging", "tabs"] },
    "x",
  );
  expect([...manifest!.permissions]).toEqual(["storage", "tabs"]);
  expect(warnings.some((w) => w.includes("nativeMessaging"))).toBe(true);
});

test("invalid host permissions are dropped with a warning", () => {
  const { manifest, warnings } = parseManifest(
    { ...base, host_permissions: ["https://ok.test/*", "garbage"] },
    "x",
  );
  expect(manifest!.hostPermissions.matches("https://ok.test/a")).toBe(true);
  expect(warnings.some((w) => w.includes("garbage"))).toBe(true);
});

test("content scripts with nothing to inject are skipped", () => {
  const { manifest, warnings } = parseManifest(
    {
      ...base,
      content_scripts: [
        { matches: ["https://a.test/*"], js: ["a.js"], run_at: "document_start" },
        { matches: ["https://b.test/*"] },
        { matches: ["nonsense"], js: ["c.js"] },
      ],
    },
    "x",
  );
  expect(manifest!.contentScripts).toHaveLength(1);
  expect(manifest!.contentScripts[0].runAt).toBe("document_start");
  expect(warnings).toHaveLength(3); // bad pattern, plus two skipped entries
});

test("run_at defaults to document_idle for anything unrecognised", () => {
  const { manifest } = parseManifest(
    { ...base, content_scripts: [{ matches: ["https://a.test/*"], js: ["a.js"], run_at: "whenever" }] },
    "x",
  );
  expect(manifest!.contentScripts[0].runAt).toBe("document_idle");
});

test("garbage input does not throw", () => {
  expect(parseManifest(null, "x").manifest).toBeNull();
  expect(parseManifest([], "x").manifest).toBeNull();
  expect(parseManifest("nope", "x").manifest).toBeNull();
});
