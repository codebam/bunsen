// SPDX-License-Identifier: MIT OR Apache-2.0
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Session } from "./session";

const root = mkdtempSync(join(tmpdir(), "bunsen-session-"));
let n = 0;
const session = () => new Session(join(root, `s${n++}.json`));

afterAll(() => rmSync(root, { recursive: true, force: true }));

test("a saved session comes back on the next start", () => {
  const s = session();
  s.save([
    { url: "https://a.test/", title: "A", active: false },
    { url: "https://b.test/", title: "B", active: true },
  ]);
  s.flush();
  expect(s.restore()).toEqual([
    { url: "https://a.test/", title: "A", active: false },
    { url: "https://b.test/", title: "B", active: true },
  ]);
});

test("a missing file restores nothing", () => {
  expect(session().restore()).toEqual([]);
});

test("a corrupt file never stops the browser starting", () => {
  const path = join(root, "corrupt.json");
  const s = new Session(path);
  for (const junk of ["{ not json", "", "   ", "null", "42", '"a string"', "{}", "[1,2,3]"]) {
    writeFileSync(path, junk);
    expect(s.restore()).toEqual([]);
  }
  // Truncated mid-object, i.e. what a crash during a naive write would leave.
  writeFileSync(path, '{"version":1,"tabs":[{"url":"https://a.test/","ti');
  expect(s.restore()).toEqual([]);
});

test("entries of the wrong shape are skipped, not fatal", () => {
  const path = join(root, "mixed.json");
  const s = new Session(path);
  writeFileSync(
    path,
    JSON.stringify({
      tabs: [
        null,
        "https://string.test/",
        { title: "no url", active: true },
        { url: 42 },
        { url: "https://good.test/", title: 7, active: "yes" },
      ],
    }),
  );
  expect(s.restore()).toEqual([{ url: "https://good.test/", title: "", active: true }]);
});

test("non-http urls are dropped on save and on restore", () => {
  const s = session();
  s.save([
    { url: "about:blank", title: "", active: true },
    { url: "file:///etc/hosts", title: "hosts", active: false },
    { url: "javascript:alert(1)", title: "x", active: false },
    { url: "https://keep.test/", title: "Keep", active: false },
  ]);
  s.flush();
  expect(s.restore().map((t) => t.url)).toEqual(["https://keep.test/"]);

  const path = join(root, "schemes.json");
  const other = new Session(path);
  writeFileSync(
    path,
    JSON.stringify({ tabs: [{ url: "about:blank", title: "", active: true }] }),
  );
  expect(other.restore()).toEqual([]);
});

test("exactly one tab ends up active", () => {
  const path = join(root, "active.json");
  const s = new Session(path);

  writeFileSync(
    path,
    JSON.stringify({
      tabs: [
        { url: "https://a.test/", title: "A", active: false },
        { url: "https://b.test/", title: "B", active: false },
      ],
    }),
  );
  expect(s.restore().map((t) => t.active)).toEqual([true, false]);

  writeFileSync(
    path,
    JSON.stringify({
      tabs: [
        { url: "https://a.test/", title: "A", active: true },
        { url: "https://b.test/", title: "B", active: true },
      ],
    }),
  );
  expect(s.restore().map((t) => t.active)).toEqual([true, false]);
});

test("the restored tab count is capped", () => {
  const s = session();
  const many = Array.from({ length: 500 }, (_, i) => ({
    url: `https://tab.test/${i}`,
    title: `T${i}`,
    active: i === 0,
  }));
  s.save(many);
  s.flush();
  const back = s.restore();
  expect(back).toHaveLength(100);
  expect(back[0].url).toBe("https://tab.test/0");
});

test("saves coalesce: only the last state reaches disk", async () => {
  const s = session();
  s.save([{ url: "https://one.test/", title: "1", active: true }]);
  s.save([{ url: "https://two.test/", title: "2", active: true }]);
  s.save([{ url: "https://three.test/", title: "3", active: true }]);
  // Nothing written yet — save() only arms the timer.
  expect(s.restore()).toEqual([]);
  await Bun.sleep(400);
  expect(s.restore().map((t) => t.url)).toEqual(["https://three.test/"]);
});

test("clear forgets the session and a pending write", () => {
  const s = session();
  s.save([{ url: "https://a.test/", title: "A", active: true }]);
  s.flush();
  expect(s.restore()).toHaveLength(1);
  s.clear();
  expect(s.restore()).toEqual([]);
  s.save([{ url: "https://b.test/", title: "B", active: true }]);
  s.clear();
  s.flush();
  expect(s.restore()).toEqual([]);
});

test("a plain array is accepted as well as the versioned object", () => {
  const path = join(root, "array.json");
  const s = new Session(path);
  writeFileSync(path, JSON.stringify([{ url: "https://a.test/", title: "A", active: true }]));
  expect(s.restore()).toEqual([{ url: "https://a.test/", title: "A", active: true }]);
});
