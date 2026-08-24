// SPDX-License-Identifier: MIT OR Apache-2.0
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Downloads, dispositionFilename, safeFilename } from "./downloads";

const root = mkdtempSync(join(tmpdir(), "bunsen-downloads-"));
let n = 0;
/** A fresh directory per test, so collision tests cannot see each other's files. */
const dir = () => {
  const d = join(root, `d${n++}`);
  mkdirSync(d, { recursive: true });
  return d;
};

// Everything is served locally on an ephemeral port: the suite must not touch
// the network, and cancellation needs a body it can hold open on purpose.
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const { pathname } = new URL(req.url);
    if (pathname === "/hello.txt") return new Response("hello world");
    if (pathname === "/no-length") {
      // An async pull keeps Bun from buffering the stream and computing a
      // Content-Length for it, which is what makes this case interesting.
      let sent = false;
      return new Response(
        new ReadableStream({
          async pull(c) {
            await Bun.sleep(5);
            if (sent) return c.close();
            sent = true;
            c.enqueue(new TextEncoder().encode("chunked"));
          },
        }),
      );
    }
    if (pathname === "/disposition") {
      return new Response("body", {
        headers: { "content-disposition": 'attachment; filename="report.pdf"' },
      });
    }
    if (pathname === "/disposition-utf8") {
      return new Response("body", {
        headers: {
          "content-disposition": "attachment; filename=\"fallback.bin\"; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf",
        },
      });
    }
    if (pathname === "/evil-disposition") {
      return new Response("pwned", {
        headers: { "content-disposition": 'attachment; filename="../../../../etc/passwd"' },
      });
    }
    if (pathname === "/slow") {
      // Emits forever until aborted, which is what a cancel must interrupt.
      return new Response(
        new ReadableStream({
          async pull(c) {
            await Bun.sleep(20);
            c.enqueue(new Uint8Array(1024));
          },
        }),
      );
    }
    if (pathname === "/big") {
      // Deliberately dribbled out so the client sees many chunks: one progress
      // event for a whole file would prove nothing about progress reporting.
      let sent = 0;
      return new Response(
        new ReadableStream({
          async pull(c) {
            if (sent >= 64) return c.close();
            await Bun.sleep(1);
            sent++;
            c.enqueue(new Uint8Array(4096));
          },
        }),
      );
    }
    if (pathname === "/boom") return new Response("nope", { status: 500 });
    return new Response("not found", { status: 404 });
  },
});
const base = `http://localhost:${server.port}`;

afterAll(() => {
  server.stop(true);
  rmSync(root, { recursive: true, force: true });
});

const store = () => new Downloads(":memory:", join(root, "default"));

test("a body is streamed to disk and the record completes", async () => {
  const d = store();
  const into = dir();
  const rec = await d.start(`${base}/hello.txt`, { directory: into });
  expect(rec.state).toBe("pending");
  const done = await d.settled(rec.id);
  expect(done.state).toBe("complete");
  expect(done.filename).toBe("hello.txt");
  expect(done.received).toBe(11);
  expect(done.total).toBe(11);
  expect(await Bun.file(done.path).text()).toBe("hello world");
  expect(d.get(rec.id)!.state).toBe("complete");
  d.close();
});

test("a missing Content-Length leaves total null but still records bytes", async () => {
  const d = store();
  const rec = await d.start(`${base}/no-length`, { directory: dir() });
  const done = await d.settled(rec.id);
  expect(done.total).toBeNull();
  expect(done.received).toBe(7);
  expect(done.state).toBe("complete");
  d.close();
});

test("an explicit filename wins over Content-Disposition", async () => {
  const d = store();
  const into = dir();
  const rec = await d.start(`${base}/disposition`, { directory: into, filename: "mine.txt" });
  const done = await d.settled(rec.id);
  expect(done.filename).toBe("mine.txt");
  d.close();
});

test("Content-Disposition names the file, filename* preferred", async () => {
  const d = store();
  const a = await d.settled((await d.start(`${base}/disposition`, { directory: dir() })).id);
  expect(a.filename).toBe("report.pdf");
  const b = await d.settled((await d.start(`${base}/disposition-utf8`, { directory: dir() })).id);
  expect(b.filename).toBe("résumé.pdf");
  d.close();
});

test("with no hints the last url segment is used, else a fallback", async () => {
  const d = store();
  const into = dir();
  const rec = await d.settled((await d.start(`${base}/hello.txt`, { directory: into })).id);
  expect(rec.filename).toBe("hello.txt");
  d.close();
});

test("a server-controlled filename cannot escape the download directory", async () => {
  const d = store();
  const into = dir();
  const done = await d.settled((await d.start(`${base}/evil-disposition`, { directory: into })).id);
  expect(done.filename).toBe("passwd");
  expect(done.path).toBe(join(into, "passwd"));
  expect(done.path.includes("..")).toBe(false);
  expect(readdirSync(into)).toEqual(["passwd"]);
  d.close();
});

test("safeFilename reduces hostile names to one harmless component", () => {
  expect(safeFilename("../../etc/passwd")).toBe("passwd");
  expect(safeFilename("/etc/shadow")).toBe("shadow");
  expect(safeFilename("..%2F..%2Fetc%2Fpasswd")).toBe("passwd");
  expect(safeFilename("%2e%2e%2f%2e%2e%2fboot.ini")).toBe("boot.ini");
  expect(safeFilename("..\\..\\windows\\system32\\evil.dll")).toBe("evil.dll");
  expect(safeFilename("..")).toBe("download");
  expect(safeFilename("...")).toBe("download");
  expect(safeFilename("/")).toBe("download");
  expect(safeFilename("")).toBe("download");
  expect(safeFilename(null)).toBe("download");
  expect(safeFilename("   ")).toBe("download");
  expect(safeFilename("ok\u0000.txt")).toBe("ok.txt");
  expect(safeFilename("a\nb.txt")).toBe("ab.txt");
  expect(safeFilename("x".repeat(400)).length).toBe(200);
  // A legitimate name survives untouched.
  expect(safeFilename("Annual Report (final).pdf")).toBe("Annual Report (final).pdf");
});

test("dispositionFilename handles both header forms", () => {
  expect(dispositionFilename(null)).toBeNull();
  expect(dispositionFilename("attachment")).toBeNull();
  expect(dispositionFilename('attachment; filename="a b.txt"')).toBe("a b.txt");
  expect(dispositionFilename("attachment; filename=plain.txt")).toBe("plain.txt");
  expect(dispositionFilename("attachment; filename*=UTF-8''caf%C3%A9.txt")).toBe("café.txt");
  // RFC 5987 says the extended form wins when both are present.
  expect(
    dispositionFilename("attachment; filename=\"old.txt\"; filename*=UTF-8''new.txt"),
  ).toBe("new.txt");
  expect(dispositionFilename('attachment; filename="quo\\"te.txt"')).toBe('quo"te.txt');
});

test("colliding names get a numeric suffix instead of overwriting", async () => {
  const d = store();
  const into = dir();
  const names: string[] = [];
  for (let i = 0; i < 3; i++) {
    const rec = await d.settled((await d.start(`${base}/hello.txt`, { directory: into })).id);
    names.push(rec.filename);
  }
  expect(names).toEqual(["hello.txt", "hello (1).txt", "hello (2).txt"]);
  // The original is untouched, not truncated by the later ones.
  expect(await Bun.file(join(into, "hello.txt")).text()).toBe("hello world");
});

test("a pre-existing unrelated file is never clobbered", async () => {
  const d = store();
  const into = dir();
  writeFileSync(join(into, "hello.txt"), "PRECIOUS");
  const rec = await d.settled((await d.start(`${base}/hello.txt`, { directory: into })).id);
  expect(rec.filename).toBe("hello (1).txt");
  expect(await Bun.file(join(into, "hello.txt")).text()).toBe("PRECIOUS");
  d.close();
});

test("an error status fails the download and leaves no file", async () => {
  const d = store();
  const into = dir();
  await expect(d.start(`${base}/boom`, { directory: into })).rejects.toThrow("HTTP 500");
  const [rec] = d.list();
  expect(rec.state).toBe("failed");
  expect(rec.error).toBe("HTTP 500");
  expect(existsSync(into) ? readdirSync(into) : []).toEqual([]);
  d.close();
});

test("cancel aborts the transfer and removes the partial file", async () => {
  const d = store();
  const into = dir();
  const rec = await d.start(`${base}/slow`, { directory: into, filename: "slow.bin" });
  expect(existsSync(rec.path)).toBe(true);
  await Bun.sleep(80);
  d.cancel(rec.id);
  const done = await d.settled(rec.id);
  expect(done.state).toBe("cancelled");
  expect(done.error).toBeNull();
  expect(existsSync(rec.path)).toBe(false);
  expect(d.get(rec.id)!.state).toBe("cancelled");
  d.close();
});

test("cancelling an unknown or finished download is a no-op", async () => {
  const d = store();
  const rec = await d.settled((await d.start(`${base}/hello.txt`, { directory: dir() })).id);
  d.cancel(rec.id);
  d.cancel(9999);
  expect(d.get(rec.id)!.state).toBe("complete");
  d.close();
});

test("progress events report growing byte counts", async () => {
  const d = store();
  const seen: number[] = [];
  d.addEventListener("progress", (e) => seen.push((e as CustomEvent).detail.received));
  const ends: string[] = [];
  d.addEventListener("end", (e) => ends.push((e as CustomEvent).detail.state));
  const rec = await d.start(`${base}/big`, { directory: dir() });
  const done = await d.settled(rec.id);
  expect(seen.length).toBeGreaterThan(1);
  expect(seen[seen.length - 1]).toBe(done.received);
  expect(done.received).toBe(64 * 4096);
  // Monotonic: a shelf that shows progress going backwards is a bug.
  expect(seen.every((v, i) => i === 0 || v > seen[i - 1])).toBe(true);
  expect(ends).toEqual(["complete"]);
  d.close();
});

test("list is newest first and get returns a single record", async () => {
  const d = store();
  const into = dir();
  const a = await d.start(`${base}/hello.txt`, { directory: into });
  await d.settled(a.id);
  const b = await d.start(`${base}/hello.txt`, { directory: into });
  await d.settled(b.id);
  const list = d.list();
  expect(list).toHaveLength(2);
  expect(list[0].id).toBe(b.id);
  expect(d.get(a.id)!.url).toBe(`${base}/hello.txt`);
  expect(d.get(12345)).toBeUndefined();
  expect(d.list(1)).toHaveLength(1);
  d.close();
});

test("a download interrupted by a restart is recorded as failed, not pending", async () => {
  const file = join(root, "records.db");
  const d = new Downloads(file);
  const rec = await d.start(`${base}/slow`, { directory: dir(), filename: "slow2.bin" });
  expect(d.get(rec.id)!.state).toBe("pending");
  d.close();
  const reopened = new Downloads(file);
  expect(reopened.get(rec.id)!.state).toBe("failed");
  reopened.close();
});
