// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * Proof that page JavaScript actually runs in the Blitz backend.
 *
 * The Blitz renderer does not embed a JS engine: it spawns one `bun`
 * subprocess per document which hosts a TypeScript DOM
 * (packages/render-blitz/js/engine.ts) and streams results back over stdio.
 * Every one of those hops -- shell command -> renderer -> worker -> DOM ->
 * worker -> renderer -> shell event -- has to work before a single line of
 * page script has any observable effect, so the only honest way to test it is
 * end to end.
 *
 * The observation channel is `document.title`: the worker emits a `title`
 * line the moment a script assigns to it, the renderer turns that into a
 * `tab_title` event, and the shell sees it. So each page below runs its
 * checks, encodes the outcome into the title as `name:check=value ...`, and
 * the test decodes it. Anything the engine gets wrong shows up as a `FAIL`
 * token rather than a hang.
 *
 * Only one in-process (ffi) backend may exist per process -- a guard in the
 * library returns NULL for a second one -- so a single backend is started
 * once here and every page gets its own tab on it.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";

import { createBackend } from "./client";
import type { BackendEvent, RenderBackend } from "./types";

const BUILD = join(import.meta.dir, "../../../../target/debug");
const LIB = Bun.env.BUNSEN_BLITZ_LIB_PATH ?? join(BUILD, "libbunsen_render_blitz.so");

// No compositor means no window, and the renderer needs one to exist at all.
const headless = !Bun.env.DISPLAY && !Bun.env.WAYLAND_DISPLAY;

/** Pages are registered by name and served from one loopback origin. */
const pages = new Map<string, string>();
let server: ReturnType<typeof Bun.serve> | undefined;
let backend: RenderBackend | undefined;
const events: BackendEvent[] = [];
let nextTab = 1;

/**
 * The prelude every page script gets. `ok()` records a boolean check, `val()`
 * records an observed value, and `done()` publishes the lot through the title.
 * It stays a plain `var`/function preamble: those bind on the global object
 * rather than in the shared global lexical scope, so a page that also declares
 * its own top-level `const` in an earlier <script> cannot collide with it.
 */
const PRELUDE = `
  var __r = [];
  function ok(name, cond, extra) {
    __r.push(name + "=" + (cond ? "ok" : "FAIL" + (extra === undefined ? "" : "<" + extra + ">")));
  }
  function val(name, v) { __r.push(name + "=" + String(v)); }
  function done(name) { document.title = name + ":" + __r.join(" "); }
`;

function html(name: string, body: string, script: string): string {
  return `<!doctype html><html><head><title>static-${name}</title></head><body>${body}
    <script>
    ${PRELUDE}
    try {
      ${script}
    } catch (e) {
      document.title = ${JSON.stringify(name)} + ":threw=" + (e && e.message);
    }
    </script></body></html>`;
}

/**
 * Load a page in a fresh tab and wait for the title it reports back.
 * Returns the decoded `check -> value` map.
 */
async function run(
  name: string,
  body: string,
  script: string,
  timeoutMs = 25_000,
): Promise<Record<string, string>> {
  pages.set(name, html(name, body, script));
  const id = nextTab++;
  const prefix = `${name}:`;

  backend!.send({ op: "tab_create", id, url: `http://127.0.0.1:${server!.port}/${name}` });
  backend!.send({ op: "tab_activate", id });
  backend!.flush();

  const deadline = Date.now() + timeoutMs;
  let title: string | undefined;
  while (Date.now() < deadline) {
    title = events
      .filter((e) => e.ev === "tab_title" && e.id === id && e.title.startsWith(prefix))
      .map((e) => (e as { title: string }).title)
      .at(-1);
    if (title !== undefined) break;
    await Bun.sleep(25);
  }
  backend!.send({ op: "tab_close", id });
  backend!.flush();

  if (title === undefined) {
    throw new Error(
      `page "${name}" never reported a title; titles seen: ` +
        JSON.stringify(
          events.filter((e) => e.ev === "tab_title").map((e) => (e as { title: string }).title),
        ),
    );
  }

  const out: Record<string, string> = {};
  for (const tok of title.slice(prefix.length).split(" ").filter(Boolean)) {
    const eq = tok.indexOf("=");
    out[tok.slice(0, eq)] = tok.slice(eq + 1);
  }
  return out;
}

/**
 * Every check the page recorded, minus the ones that passed. A `threw` token
 * counts as a failure too: a script that dies partway through simply stops
 * recording checks, and without this an empty list would read as a pass.
 */
function failures(res: Record<string, string>): string[] {
  return Object.entries(res)
    .filter(([k, v]) => k === "threw" || v.startsWith("FAIL"))
    .map(([k, v]) => `${k}=${v}`);
}

beforeAll(async () => {
  if (headless) return;
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const name = new URL(req.url).pathname.replace(/^\//, "");
      const doc = pages.get(name);
      if (doc === undefined) return new Response("not found", { status: 404 });
      return new Response(doc, { headers: { "content-type": "text/html" } });
    },
  });
  backend = createBackend("ffi", { library: LIB, host: "" });
  backend.onEvent((ev) => events.push(ev));
  await backend.start({ chrome_url: "about:blank", width: 800, height: 600 });
});

afterAll(() => {
  backend?.stop();
  server?.stop(true);
});

test.skipIf(headless)("a script runs at all and its title assignment reaches the shell", async () => {
  const res = await run(
    "boot",
    "<h1>hi</h1>",
    `ok("ran", true);
     ok("hasDocument", typeof document === "object");
     ok("hasWindow", typeof window === "object");
     ok("body", !!document.body);
     ok("head", !!document.head);
     ok("documentElement", !!document.documentElement);
     ok("locationHref", String(location.href).indexOf("/boot") > -1, location.href);
     done("boot");`,
  );
  expect(failures(res)).toEqual([]);
}, 60_000);

test.skipIf(headless)("queries find elements the parser produced", async () => {
  const res = await run(
    "query",
    `<div id="one" class="box tall" data-kind="first">alpha</div>
     <div class="box" data-kind="second"><span class="leaf">beta</span></div>
     <p class="box">gamma</p>`,
    `var one = document.getElementById("one");
     ok("byId", one !== null && one.textContent === "alpha", one && one.textContent);
     ok("byIdMissing", document.getElementById("nope") === null);
     ok("qsTag", document.querySelector("p").textContent === "gamma");
     ok("qsClass", document.querySelector(".box").id === "one");
     ok("qsId", document.querySelector("#one") === one);
     ok("qsaClass", document.querySelectorAll(".box").length === 3,
        document.querySelectorAll(".box").length);
     ok("qsaDescendant", document.querySelectorAll("div .leaf").length === 1,
        document.querySelectorAll("div .leaf").length);
     ok("qsaAttr", document.querySelectorAll("[data-kind=second]").length === 1,
        document.querySelectorAll("[data-kind=second]").length);
     ok("qsaGroup", document.querySelectorAll("p, span").length === 2,
        document.querySelectorAll("p, span").length);
     ok("qsaIsArrayLike", typeof document.querySelectorAll(".box").forEach === "function");
     ok("byTagName", document.getElementsByTagName("div").length === 2);
     ok("byClassName", document.getElementsByClassName("box").length === 3);
     ok("scopedQuery", document.querySelector(".box + *") !== null ||
        document.getElementById("one").querySelectorAll("*").length === 0);
     ok("closest", document.querySelector(".leaf").closest("div") !== null);
     ok("matches", document.querySelector(".leaf").matches(".leaf"));
     done("query");`,
  );
  expect(failures(res)).toEqual([]);
}, 60_000);

test.skipIf(headless)("created nodes are inserted and stay findable", async () => {
  const res = await run(
    "create",
    `<div id="host"></div>`,
    `var host = document.getElementById("host");
     var made = document.createElement("section");
     made.id = "made";
     made.textContent = "created text";
     host.appendChild(made);

     // Re-query rather than trusting the handle: this proves the node really
     // joined the document tree, not just a detached wrapper.
     var found = document.getElementById("made");
     ok("appended", found !== null);
     ok("sameNode", found === made);
     ok("textContent", found && found.textContent === "created text", found && found.textContent);
     ok("tagName", found && found.tagName === "SECTION", found && found.tagName);
     ok("parent", found && found.parentElement === host);
     ok("inHostChildren", host.children.length === 1, host.children.length);
     ok("qsFindsIt", document.querySelector("#made") === made);

     var t = document.createTextNode(" tail");
     made.appendChild(t);
     ok("textNode", document.getElementById("made").textContent === "created text tail",
        document.getElementById("made").textContent);

     var first = document.createElement("b");
     host.insertBefore(first, made);
     ok("insertBefore", host.children[0].tagName === "B", host.children[0].tagName);

     made.remove();
     ok("removed", document.getElementById("made") === null);
     ok("innerHTML", host.innerHTML.indexOf("<b>") > -1, host.innerHTML);

     host.innerHTML = '<i id="ital">x</i>';
     ok("innerHTMLSet", document.getElementById("ital") !== null);
     done("create");`,
  );
  expect(failures(res)).toEqual([]);
}, 60_000);

test.skipIf(headless)("attributes, classList and style round-trip", async () => {
  const res = await run(
    "attrs",
    `<div id="d" class="a b" data-user-id="7" title="t"></div>`,
    `var d = document.getElementById("d");
     d.setAttribute("data-x", "1");
     ok("getAttribute", d.getAttribute("data-x") === "1", d.getAttribute("data-x"));
     ok("getAttributeMissing", d.getAttribute("nope") === null);
     ok("hasAttribute", d.hasAttribute("title"));
     d.removeAttribute("title");
     ok("removeAttribute", !d.hasAttribute("title"));

     ok("className", d.className === "a b", d.className);
     ok("classContains", d.classList.contains("a") && !d.classList.contains("z"));
     d.classList.add("c");
     ok("classAdd", d.classList.contains("c") && d.className.indexOf("c") > -1, d.className);
     d.classList.remove("a");
     ok("classRemove", !d.classList.contains("a"), d.className);
     ok("classToggleOn", d.classList.toggle("t1") === true && d.classList.contains("t1"));
     ok("classToggleOff", d.classList.toggle("t1") === false && !d.classList.contains("t1"));
     ok("classLength", d.classList.length === 2, d.classList.length);
     // The attribute is the source of truth, so a re-query must agree.
     ok("classPersists", document.querySelector(".c") === d);

     ok("datasetRead", d.dataset.userId === "7", d.dataset.userId);
     ok("datasetCamel", d.dataset.x === "1", d.dataset.x);

     d.style.color = "red";
     ok("styleSet", d.style.color === "red", d.style.color);
     d.style.backgroundColor = "blue";
     ok("styleCamelRead", d.style.backgroundColor === "blue", d.style.backgroundColor);
     ok("styleCssText", d.style.cssText.indexOf("background-color") > -1, d.style.cssText);
     // The style attribute is the storage for inline style, so both directions
     // observe the same declarations.
     ok("styleReachesAttribute", (d.getAttribute("style") || "").indexOf("color:red") > -1,
        d.getAttribute("style"));
     d.setAttribute("style", "margin-top: 4px; color: green");
     ok("attributeReachesStyle", d.style.marginTop === "4px" && d.style.color === "green",
        d.style.cssText);
     ok("attributeReplacesStyle", d.style.backgroundColor === "", d.style.backgroundColor);
     d.style.removeProperty("color");
     ok("removeProperty", d.getAttribute("style").indexOf("color") === -1, d.getAttribute("style"));
     d.style.cssText = "";
     ok("emptyStyleDropsAttribute", d.getAttribute("style") === null, d.getAttribute("style"));

     d.id = "renamed";
     ok("idSetter", document.getElementById("renamed") === d);
     done("attrs");`,
  );
  expect(failures(res)).toEqual([]);
}, 60_000);

test.skipIf(headless)("dataset is a live view over data-* attributes", async () => {
  const res = await run(
    "dataset",
    `<div id="d" data-a="1"></div>`,
    `var d = document.getElementById("d");
     d.dataset.b = "2";
     ok("writeVisible", d.dataset.b === "2", d.dataset.b);
     ok("writeAsAttribute", d.getAttribute("data-b") === "2", d.getAttribute("data-b"));
     d.dataset.longName = "3";
     ok("camelToKebab", d.getAttribute("data-long-name") === "3", d.getAttribute("data-long-name"));
     d.setAttribute("data-from-attr", "4");
     ok("kebabToCamel", d.dataset.fromAttr === "4", d.dataset.fromAttr);
     ok("readExisting", d.dataset.a === "1", d.dataset.a);
     ok("missingIsUndefined", d.dataset.nope === undefined);
     ok("inOperator", ("a" in d.dataset) && !("nope" in d.dataset));
     ok("enumerates", Object.keys(d.dataset).sort().join(",") === "a,b,fromAttr,longName",
        Object.keys(d.dataset).sort().join(","));
     delete d.dataset.b;
     ok("deletes", d.getAttribute("data-b") === null && d.dataset.b === undefined,
        d.getAttribute("data-b"));
     done("dataset");`,
  );
  expect(failures(res)).toEqual([]);
}, 60_000);

test.skipIf(headless)("listeners fire, bubble and can be removed", async () => {
  const res = await run(
    "events",
    `<div id="outer"><button id="btn">go</button></div>`,
    `var outer = document.getElementById("outer");
     var btn = document.getElementById("btn");
     var log = [];

     btn.addEventListener("ping", function (e) { log.push("target:" + e.type); });
     btn.dispatchEvent(new Event("ping"));
     ok("dispatch", log.length === 1 && log[0] === "ping" || log[0] === "target:ping", log.join("|"));

     var seen = null;
     outer.addEventListener("boom", function (e) { seen = e; });
     btn.dispatchEvent(new CustomEvent("boom", { bubbles: true, detail: { n: 42 } }));
     ok("bubbles", seen !== null);
     ok("detail", seen && seen.detail && seen.detail.n === 42, seen && JSON.stringify(seen.detail));
     ok("target", seen && seen.target === btn);
     ok("eventType", seen && seen.type === "boom", seen && seen.type);

     var nobubble = false;
     outer.addEventListener("quiet", function () { nobubble = true; });
     btn.dispatchEvent(new Event("quiet"));
     ok("noBubbleByDefault", nobubble === false);

     var clicks = 0;
     var onClick = function () { clicks++; };
     btn.addEventListener("click", onClick);
     btn.click();
     ok("clickMethod", clicks === 1, clicks);
     btn.removeEventListener("click", onClick);
     btn.click();
     ok("removeEventListener", clicks === 1, clicks);

     var cancel = new Event("cancelme", { cancelable: true });
     btn.addEventListener("cancelme", function (e) { e.preventDefault(); });
     ok("preventDefault", btn.dispatchEvent(cancel) === false);

     // A throwing listener must not take the rest of the page with it.
     var after = false;
     btn.addEventListener("risky", function () { throw new Error("boom"); });
     btn.addEventListener("risky", function () { after = true; });
     btn.dispatchEvent(new Event("risky"));
     ok("listenerThrowIsolated", after === true);

     ok("documentListener", (function () {
       var hit = false;
       document.addEventListener("docping", function () { hit = true; });
       document.dispatchEvent(new Event("docping"));
       return hit;
     })());
     done("events");`,
  );
  expect(failures(res)).toEqual([]);
}, 60_000);

test.skipIf(headless)("addEventListener options and propagation control", async () => {
  const res = await run(
    "listenopts",
    `<div id="outer"><button id="btn">go</button></div>`,
    `var outer = document.getElementById("outer");
     var btn = document.getElementById("btn");

     var order = [];
     outer.addEventListener("cap", function () { order.push("outerCapture"); }, true);
     outer.addEventListener("cap", function () { order.push("outerBubble"); });
     btn.addEventListener("cap", function () { order.push("target"); });
     btn.dispatchEvent(new Event("cap", { bubbles: true }));
     ok("threePhaseOrder", order.join(">") === "outerCapture>target>outerBubble", order.join(">"));

     var phases = [];
     outer.addEventListener("ph", function (e) { phases.push(e.eventPhase); }, { capture: true });
     btn.addEventListener("ph", function (e) { phases.push(e.eventPhase); });
     outer.addEventListener("ph", function (e) { phases.push(e.eventPhase); });
     btn.dispatchEvent(new Event("ph", { bubbles: true }));
     ok("eventPhase", phases.join("") === "123", phases.join(""));

     // A capturing listener on an ancestor still runs for a non-bubbling event.
     var capturedQuiet = false;
     outer.addEventListener("cq", function () { capturedQuiet = true; }, true);
     btn.dispatchEvent(new Event("cq"));
     ok("captureWithoutBubbles", capturedQuiet === true);

     var onceHits = 0;
     btn.addEventListener("one", function () { onceHits++; }, { once: true });
     btn.dispatchEvent(new Event("one"));
     btn.dispatchEvent(new Event("one"));
     ok("once", onceHits === 1, onceHits);

     var ac = new AbortController();
     var sigHits = 0;
     btn.addEventListener("sig", function () { sigHits++; }, { signal: ac.signal });
     btn.dispatchEvent(new Event("sig"));
     ac.abort();
     btn.dispatchEvent(new Event("sig"));
     ok("signalRemoves", sigHits === 1, sigHits);

     var dead = new AbortController();
     dead.abort();
     var deadHits = 0;
     btn.addEventListener("dead", function () { deadHits++; }, { signal: dead.signal });
     btn.dispatchEvent(new Event("dead"));
     ok("abortedSignalNeverAdds", deadHits === 0, deadHits);

     var passiveHit = false;
     btn.addEventListener("pas", function () { passiveHit = true; }, { passive: true });
     btn.dispatchEvent(new Event("pas"));
     ok("passiveStillFires", passiveHit === true);

     // (callback, capture) is the identity of a registration: the same function
     // can sit in both phases, and removal has to name the right one.
     var dual = 0;
     var fn = function () { dual++; };
     btn.addEventListener("dual", fn, true);
     btn.addEventListener("dual", fn, false);
     btn.dispatchEvent(new Event("dual"));
     ok("captureIsPartOfIdentity", dual === 2, dual);
     btn.removeEventListener("dual", fn, true);
     btn.dispatchEvent(new Event("dual"));
     ok("removeMatchesCapture", dual === 3, dual);
     btn.addEventListener("dup", fn, false);
     btn.addEventListener("dup", fn, false);
     var dupBefore = dual;
     btn.dispatchEvent(new Event("dup"));
     ok("duplicateIgnored", dual - dupBefore === 1, dual - dupBefore);

     var sawOuter = false;
     outer.addEventListener("stop", function () { sawOuter = true; });
     btn.addEventListener("stop", function (e) { e.stopPropagation(); });
     btn.dispatchEvent(new Event("stop", { bubbles: true }));
     ok("stopPropagation", sawOuter === false);

     var hits = [];
     btn.addEventListener("sip", function (e) { hits.push("a"); e.stopImmediatePropagation(); });
     btn.addEventListener("sip", function () { hits.push("b"); });
     outer.addEventListener("sip", function () { hits.push("outer"); });
     btn.dispatchEvent(new Event("sip", { bubbles: true }));
     ok("stopImmediatePropagation", hits.join(",") === "a", hits.join(","));

     var reachedTarget = false;
     outer.addEventListener("capstop", function (e) { e.stopPropagation(); }, true);
     btn.addEventListener("capstop", function () { reachedTarget = true; });
     btn.dispatchEvent(new Event("capstop", { bubbles: true }));
     ok("captureCanStopBeforeTarget", reachedTarget === false);

     ok("handleEventObject", (function () {
       var seen = false;
       var obj = { handleEvent: function () { seen = true; } };
       btn.addEventListener("hev", obj);
       btn.dispatchEvent(new Event("hev"));
       return seen;
     })());
     done("listenopts");`,
  );
  expect(failures(res)).toEqual([]);
}, 60_000);

test.skipIf(headless)("selector combinators, pseudo-classes and groups", async () => {
  const res = await run(
    "selectors",
    `<ul id="list">
       <li class="item a" data-n="one">1</li>
       <li class="item b" data-n="two">2</li>
       <li class="item c" data-n="three">3</li>
       <li class="item d last" data-n="four">4</li>
     </ul>
     <div id="wrap"><p id="p1">x</p><span id="s1">y</span><span id="s2">z</span></div>`,
    `function ids(sel) {
       return Array.prototype.map.call(document.querySelectorAll(sel), function (e) {
         return e.className || e.id;
       }).join(",");
     }
     ok("child", document.querySelectorAll("#list > li").length === 4,
        document.querySelectorAll("#list > li").length);
     ok("childIsNotDescendant", document.querySelectorAll("body > li").length === 0,
        document.querySelectorAll("body > li").length);
     ok("descendant", document.querySelectorAll("#list li").length === 4,
        document.querySelectorAll("#list li").length);
     ok("adjacent", document.querySelector("#p1 + span") === document.getElementById("s1"));
     ok("adjacentIsOnlyNext", document.querySelectorAll("#p1 + span").length === 1,
        document.querySelectorAll("#p1 + span").length);
     ok("sibling", document.querySelectorAll("#p1 ~ span").length === 2,
        document.querySelectorAll("#p1 ~ span").length);
     ok("not", ids("#list li:not(.a)") === "item b,item c,item d last", ids("#list li:not(.a)"));
     ok("notGroup", document.querySelectorAll("#list li:not(.a, .b)").length === 2,
        document.querySelectorAll("#list li:not(.a, .b)").length);
     ok("nthChild", document.querySelector("#list li:nth-child(2)").className === "item b",
        document.querySelector("#list li:nth-child(2)").className);
     ok("nthOdd", ids("#list li:nth-child(odd)") === "item a,item c", ids("#list li:nth-child(odd)"));
     ok("nthEven", ids("#list li:nth-child(even)") === "item b,item d last",
        ids("#list li:nth-child(even)"));
     ok("nthAnPlusB", ids("#list li:nth-child(2n+1)") === "item a,item c",
        ids("#list li:nth-child(2n+1)"));
     ok("nthPlainIndex", ids("#list li:nth-child(3)") === "item c", ids("#list li:nth-child(3)"));
     ok("firstChild", document.querySelector("#list li:first-child").textContent === "1",
        document.querySelector("#list li:first-child").textContent);
     ok("lastChild", document.querySelector("#list li:last-child").textContent === "4",
        document.querySelector("#list li:last-child").textContent);
     ok("chainedCombinators", document.querySelectorAll("#wrap > p + span ~ span").length === 1,
        document.querySelectorAll("#wrap > p + span ~ span").length);
     ok("groupWithCombinators", document.querySelectorAll("#wrap > p, #wrap > span").length === 3,
        document.querySelectorAll("#wrap > p, #wrap > span").length);
     ok("groupIsDocumentOrder", document.querySelectorAll("span, p")[0].id === "p1",
        document.querySelectorAll("span, p")[0].id);
     ok("groupDedupes", document.querySelectorAll("#p1, p").length === 1,
        document.querySelectorAll("#p1, p").length);
     ok("attrPrefix", document.querySelectorAll("[data-n^=t]").length === 2,
        document.querySelectorAll("[data-n^=t]").length);
     ok("attrSuffix", document.querySelectorAll("[data-n$=ee]").length === 1,
        document.querySelectorAll("[data-n$=ee]").length);
     ok("attrContains", document.querySelectorAll('[data-n*="o"]').length === 3,
        document.querySelectorAll('[data-n*="o"]').length);

     var b = document.querySelector(".b");
     ok("matchesChild", b.matches("#list > li.b"));
     ok("matchesSibling", b.matches(".a + li"));
     ok("matchesNot", b.matches("li:not(.a)") && !b.matches("li:not(.b)"));
     ok("matchesNth", b.matches(":nth-child(2)") && !b.matches(":nth-child(3)"));
     ok("matchesGroup", b.matches("p, li"));
     ok("matchesRejects", !b.matches("span, #wrap > *"));
     ok("closestGroup", document.getElementById("s1").closest("#nope, #wrap") ===
        document.getElementById("wrap"));
     ok("closestCombinator", b.closest("#list > li") === b);
     ok("querySelectorFirstInOrder", document.querySelector("#list li:not(.a)").className === "item b",
        document.querySelector("#list li:not(.a)").className);
     ok("scopedChild", document.getElementById("wrap").querySelectorAll(":scope > span").length === 2 ||
        document.getElementById("wrap").querySelectorAll("span").length === 2);
     done("selectors");`,
  );
  expect(failures(res)).toEqual([]);
}, 60_000);

test.skipIf(headless)("createDocumentFragment splices its children in", async () => {
  const res = await run(
    "fragment",
    `<div id="host"></div>`,
    `var host = document.getElementById("host");
     var frag = document.createDocumentFragment();
     var a = document.createElement("span"); a.id = "fa";
     var b = document.createElement("span"); b.id = "fb";
     frag.appendChild(a);
     frag.appendChild(b);
     ok("collects", frag.childNodes.length === 2, frag.childNodes.length);
     ok("nodeType", frag.nodeType === 11, frag.nodeType);
     ok("notInDocumentYet", document.getElementById("fa") === null);

     host.appendChild(frag);
     ok("emptiedAfterInsert", frag.childNodes.length === 0, frag.childNodes.length);
     ok("childrenSpliced", host.children.length === 2, host.children.length);
     ok("noWrapperElement", host.innerHTML.indexOf("fragment") === -1, host.innerHTML);
     ok("findable", document.getElementById("fb") === b);
     ok("parentIsHost", b.parentElement === host);

     var frag2 = document.createDocumentFragment();
     var c = document.createElement("i"); c.id = "fc";
     frag2.appendChild(c);
     host.insertBefore(frag2, host.firstChild);
     ok("insertBeforeSplices", host.children.length === 3 && host.children[0].id === "fc",
        host.children.length + ":" + host.children[0].id);
     ok("fragmentQueryable", (function () {
       var f = document.createDocumentFragment();
       var d = document.createElement("em"); d.className = "inFrag";
       f.appendChild(d);
       return f.querySelector(".inFrag") === d;
     })());
     done("fragment");`,
  );
  expect(failures(res)).toEqual([]);
}, 60_000);

test.skipIf(headless)("microtasks run before timers", async () => {
  const res = await run(
    "async",
    "",
    `var order = [];
     order.push("sync");
     setTimeout(function () {
       order.push("timeout");
       ok("order", order.join(">") === "sync>micro>qmt>timeout", order.join(">"));
       ok("intervalRan", ticks > 0, ticks);
       ok("rafRan", rafHit);
       done("async");
     }, 20);
     // Both microtask sources must drain before the timer callback runs.
     Promise.resolve().then(function () { order.push("micro"); });
     queueMicrotask(function () { order.push("qmt"); });

     var ticks = 0;
     var iv = setInterval(function () { ticks++; if (ticks > 1) clearInterval(iv); }, 1);
     var rafHit = false;
     requestAnimationFrame(function () { rafHit = true; });

     var cancelled = false;
     var doomed = setTimeout(function () { cancelled = true; }, 5);
     clearTimeout(doomed);`,
  );
  expect(res.order).toBe("ok");
  expect(failures(res)).toEqual([]);
}, 60_000);

test.skipIf(headless)("async/await and promise chains resolve", async () => {
  const res = await run(
    "promises",
    "",
    `(async function () {
       var v = await Promise.resolve(1);
       ok("await", v === 1);
       var all = await Promise.all([Promise.resolve("a"), 2, new Promise(function (r) {
         setTimeout(function () { r("c"); }, 5);
       })]);
       ok("all", all.join("") === "a2c", all.join(""));
       try {
         await Promise.reject(new Error("nope"));
         ok("reject", false);
       } catch (e) {
         ok("reject", e.message === "nope", e.message);
       }
       var race = await Promise.race([
         new Promise(function (r) { setTimeout(function () { r("slow"); }, 200); }),
         Promise.resolve("fast"),
       ]);
       ok("race", race === "fast", race);
       done("promises");
     })();`,
  );
  expect(failures(res)).toEqual([]);
}, 60_000);

test.skipIf(headless)("modern JS syntax and builtins work", async () => {
  const res = await run(
    "lang",
    "",
    `var obj = { a: { b: [1, 2, 3] }, n: null };
     ok("optionalChain", obj?.a?.b?.[1] === 2);
     ok("optionalChainMissing", obj?.zz?.yy === undefined);
     ok("nullish", (obj.n ?? "dflt") === "dflt");
     ok("nullishAssign", (function () { var x = null; x ??= 5; return x === 5; })());
     ok("spread", [...obj.a.b, 4].length === 4);
     ok("destructure", (function () { var { a: { b: [first] } } = obj; return first === 1; })());
     ok("template", \`x\${1 + 1}\` === "x2");
     ok("arrow", ((n) => n * 2)(4) === 8);
     ok("classes", (function () {
       class A { constructor() { this.v = 1; } get two() { return this.v + 1; } }
       class B extends A { get three() { return this.two + 1; } }
       return new B().three === 3;
     })());
     ok("closure", (function () {
       function counter() { var n = 0; return function () { return ++n; }; }
       var c = counter(); c(); return c() === 2;
     })());
     ok("json", JSON.parse(JSON.stringify({ k: [1, "2", true, null] })).k[1] === "2");
     ok("map", (function () { var m = new Map([["k", 1]]); return m.get("k") === 1; })());
     ok("set", new Set([1, 1, 2]).size === 2);
     ok("symbolIterator", typeof Symbol.iterator === "symbol");
     ok("arrayMethods", [1, 2, 3].filter(function (n) { return n > 1; }).map(String).join() === "2,3");
     ok("flat", [[1], [2, [3]]].flat(2).length === 3);
     ok("objectEntries", Object.entries({ a: 1 })[0][0] === "a");
     ok("regex", /^ab+c$/.test("abbc"));
     ok("generator", (function () { function* g() { yield 1; yield 2; } return [...g()].length === 2; })());
     ok("btoa", atob(btoa("hi")) === "hi");
     ok("url", new URL("/x?y=1", location.href).searchParams.get("y") === "1");
     ok("structuredClone", structuredClone({ a: [1] }).a[0] === 1);
     ok("navigator", typeof navigator.userAgent === "string" && navigator.userAgent.length > 0);
     done("lang");`,
  );
  expect(failures(res)).toEqual([]);
}, 60_000);

test.skipIf(headless)("a throwing script does not stop later scripts", async () => {
  const name = "resilient";
  // Two separate <script> elements: the first blows up during evaluation, the
  // second must still run. Written by hand because the helper wraps its script
  // in a single try/catch, which would defeat the point.
  pages.set(
    name,
    `<!doctype html><html><head><title>static-${name}</title></head><body>
     <div id="d">x</div>
     <script>window.__marker = "one"; null.explode();<\/script>
     <script>window.__afterThrow = true;<\/script>
     <script>
       ${PRELUDE}
       ok("firstScriptRanBeforeThrow", window.__marker === "one", window.__marker);
       ok("scriptAfterThrowRan", window.__afterThrow === true);
       ok("domStillWorks", document.getElementById("d") !== null);
       // An unhandled rejection must not be fatal either.
       Promise.reject(new Error("ignored"));
       setTimeout(function () {
         ok("aliveAfterRejection", true);
         done("${name}");
       }, 20);
     <\/script></body></html>`,
  );
  const id = nextTab++;
  backend!.send({ op: "tab_create", id, url: `http://127.0.0.1:${server!.port}/${name}` });
  backend!.send({ op: "tab_activate", id });
  backend!.flush();

  const deadline = Date.now() + 25_000;
  let title: string | undefined;
  while (Date.now() < deadline) {
    title = events
      .filter((e) => e.ev === "tab_title" && e.id === id && e.title.startsWith(`${name}:`))
      .map((e) => (e as { title: string }).title)
      .at(-1);
    if (title !== undefined) break;
    await Bun.sleep(25);
  }
  backend!.send({ op: "tab_close", id });
  backend!.flush();

  expect(title).toBeDefined();
  expect(title).not.toContain("FAIL");
}, 60_000);

test.skipIf(headless)("DOMContentLoaded and load fire after scripts", async () => {
  const res = await run(
    "lifecycle",
    "",
    `var log = [];
     document.addEventListener("DOMContentLoaded", function () {
       log.push("dcl");
       val("readyStateAtDcl", document.readyState);
     });
     window.addEventListener("load", function () {
       log.push("load");
       ok("dclFired", log.indexOf("dcl") > -1, log.join(">"));
       ok("loadAfterDcl", log.indexOf("load") > log.indexOf("dcl"), log.join(">"));
       ok("readystatechangeFired", log.indexOf("rsc") > -1, log.join(">"));
       val("readyState", document.readyState);
       done("lifecycle");
     });
     document.addEventListener("readystatechange", function () { log.push("rsc"); });
     val("readyStateDuringScript", document.readyState);`,
  );
  expect(failures(res)).toEqual([]);
  // The document is only "complete" once `load` fires; everything before that,
  // DOMContentLoaded included, sees "interactive".
  expect(res.readyStateDuringScript).toBe("interactive");
  expect(res.readyStateAtDcl).toBe("interactive");
  expect(res.readyState).toBe("complete");
}, 60_000);

test.skipIf(headless)("localStorage and sessionStorage behave like Storage", async () => {
  const res = await run(
    "storage",
    "",
    `localStorage.setItem("k", "v");
     ok("setGet", localStorage.getItem("k") === "v", localStorage.getItem("k"));
     ok("missing", localStorage.getItem("absent") === null);
     ok("length", localStorage.length === 1, localStorage.length);
     ok("key", localStorage.key(0) === "k", localStorage.key(0));
     localStorage.setItem("k2", "v2");
     localStorage.removeItem("k");
     ok("remove", localStorage.getItem("k") === null && localStorage.length === 1);
     localStorage.clear();
     ok("clear", localStorage.length === 0);
     ok("separateStores", (function () {
       sessionStorage.setItem("s", "1");
       return localStorage.getItem("s") === null && sessionStorage.getItem("s") === "1";
     })());
     ok("coercion", (function () {
       localStorage.setItem("n", 5);
       return localStorage.getItem("n") === "5";
     })());
     // Property-style access is an alias for the item accessors.
     localStorage.setItem("prop", "yes");
     ok("propertyRead", localStorage.prop === "yes", localStorage.prop);
     localStorage.direct = "d";
     ok("propertyWrite", localStorage.getItem("direct") === "d", localStorage.getItem("direct"));
     ok("propertyCoercion", (function () { localStorage.num = 7; return localStorage.num === "7"; })(),
        localStorage.num);
     ok("propertyIn", ("direct" in localStorage) && !("absent" in localStorage));
     ok("propertyMissingIsUndefined", localStorage.absent === undefined);
     ok("propertyEnumerates", Object.keys(localStorage).indexOf("direct") > -1,
        Object.keys(localStorage).join(","));
     ok("propertyHidesMethods", Object.keys(localStorage).indexOf("setItem") === -1,
        Object.keys(localStorage).join(","));
     delete localStorage.direct;
     ok("propertyDelete", localStorage.getItem("direct") === null && !("direct" in localStorage));
     ok("methodsIntact", typeof localStorage.setItem === "function" &&
        typeof localStorage.key === "function" && typeof localStorage.length === "number");
     done("storage");`,
  );
  expect(failures(res)).toEqual([]);
}, 60_000);

test.skipIf(headless)("fetch and XMLHttpRequest reach the page's origin", async () => {
  pages.set("data.json", '{"hello":"world"}');
  const res = await run(
    "net",
    "",
    `(async function () {
       try {
         var r = await fetch("/data.json");
         var j = await r.json();
         ok("fetchRelative", j.hello === "world", JSON.stringify(j));
         ok("fetchOk", r.ok === true && r.status === 200, r.status);
       } catch (e) {
         ok("fetchRelative", false, e.message);
       }
       var x = new XMLHttpRequest();
       x.open("GET", "/data.json");
       x.onload = function () {
         ok("xhr", x.responseText.indexOf("world") > -1, x.responseText);
         done("net");
       };
       x.onerror = function () { ok("xhr", false, "onerror"); done("net"); };
       x.send();
     })();`,
  );
  expect(failures(res)).toEqual([]);
}, 60_000);

test.skipIf(headless)("console.log from a page does not break the stream", async () => {
  const res = await run(
    "console",
    "",
    `console.log("hello from the page", { a: 1 });
     console.warn("warned");
     console.error("errored");
     ok("survivedLogging", true);
     done("console");`,
  );
  expect(failures(res)).toEqual([]);
}, 60_000);

test.skipIf(headless)("classic scripts share one global lexical scope", async () => {
  const res = await run(
    "scope",
    `<script>
       const SHARED = "one";
       let mutableTop = 1;
       class Greeter { hi() { return "hi-" + SHARED; } }
       function topFn() { return "fn"; }
     </script>`,
    `ok("constAcrossScripts", SHARED === "one", typeof SHARED);
     ok("classAcrossScripts", new Greeter().hi() === "hi-one", new Greeter().hi());
     ok("letAcrossScripts", mutableTop === 1, mutableTop);
     mutableTop = 2;
     ok("letWritable", mutableTop === 2, mutableTop);
     ok("functionAcrossScripts", topFn() === "fn", topFn());

     // A script inserted later joins the same scope, not a fresh one.
     var s = document.createElement("script");
     s.text = 'window.__fromDyn = Greeter.name + ":" + SHARED;';
     document.body.appendChild(s);
     ok("dynamicSeesScope", window.__fromDyn === "Greeter:one", window.__fromDyn);
     done("scope");`,
  );
  expect(failures(res)).toEqual([]);
}, 60_000);

test.skipIf(headless)("dynamically inserted <script> elements execute", async () => {
  pages.set("dyn.js", 'window.__ext = "ext-ran";');
  const res = await run(
    "dynscript",
    "",
    `window.__dyn = "no";
     var s = document.createElement("script");
     s.text = 'window.__dyn = "ran";';
     document.body.appendChild(s);
     ok("inlineRunsSynchronously", window.__dyn === "ran", window.__dyn);

     // The "already started" flag: re-inserting the same element is inert.
     window.__dyn = "reset";
     document.body.appendChild(s);
     ok("runsOnlyOnce", window.__dyn === "reset", window.__dyn);

     // Fragment-parsed scripts never run, which is why innerHTML is not an
     // arbitrary-code-execution sink.
     window.__frag = "no";
     var box = document.createElement("div");
     box.innerHTML = "<" + "script>window.__frag = 'yes';<" + "/script>";
     document.body.appendChild(box);
     ok("innerHTMLStaysInert", window.__frag === "no", window.__frag);

     // Only insertion *into the document* runs a script.
     window.__detached = "no";
     var off = document.createElement("script");
     off.text = 'window.__detached = "yes";';
     document.createElement("div").appendChild(off);
     ok("detachedDoesNotRun", window.__detached === "no", window.__detached);

     window.__json = "no";
     var typed = document.createElement("script");
     typed.setAttribute("type", "application/json");
     typed.text = 'window.__json = "yes";';
     document.body.appendChild(typed);
     ok("nonScriptTypeIgnored", window.__json === "no", window.__json);

     var ext = document.createElement("script");
     ext.src = "/dyn.js";
     ext.addEventListener("load", function () {
       ok("srcFetchedAndRun", window.__ext === "ext-ran", window.__ext);
       done("dynscript");
     });
     ext.addEventListener("error", function () {
       ok("srcFetchedAndRun", false, "error-event");
       done("dynscript");
     });
     document.body.appendChild(ext);`,
  );
  expect(failures(res)).toEqual([]);
}, 60_000);

test.skipIf(headless)("MutationObserver reports mutations", async () => {
  const res = await run(
    "mutation",
    `<div id="host"></div>`,
    `var host = document.getElementById("host");
     var recs = [];
     var mo = new MutationObserver(function (list) { recs = recs.concat(list); });
     mo.observe(host, {
       childList: true, subtree: true,
       attributes: true, attributeOldValue: true,
       characterData: true, characterDataOldValue: true,
     });

     var kid = document.createElement("span");
     host.appendChild(kid);
     host.setAttribute("data-x", "1");
     host.setAttribute("data-x", "2");
     var t = document.createTextNode("txt");
     host.appendChild(t);
     t.data = "txt2";
     host.removeChild(kid);
     ok("noSynchronousDelivery", recs.length === 0, recs.length);

     var mo2 = new MutationObserver(function () {});
     mo2.observe(host, { childList: true });
     host.appendChild(document.createElement("i"));
     var taken = mo2.takeRecords();
     ok("takeRecords", taken.length === 1, taken.length);
     ok("takeRecordsDrains", mo2.takeRecords().length === 0);
     mo2.disconnect();

     var filtered = [];
     var mo3 = new MutationObserver(function (l) { filtered = filtered.concat(l); });
     mo3.observe(host, { attributeFilter: ["data-keep"] });
     host.setAttribute("data-keep", "y");
     host.setAttribute("data-drop", "n");

     setTimeout(function () {
       var types = recs.map(function (r) { return r.type; }).join(",");
       var added = recs.filter(function (r) { return r.type === "childList" && r.addedNodes.length; });
       var gone = recs.filter(function (r) { return r.type === "childList" && r.removedNodes.length; });
       var attrs = recs.filter(function (r) { return r.type === "attributes" && r.attributeName === "data-x"; });
       var cds = recs.filter(function (r) { return r.type === "characterData"; });

       ok("delivered", recs.length > 0, types);
       ok("childListAdd", added.length >= 2 && added[0].addedNodes[0].tagName === "SPAN",
          added.length + ":" + (added[0] && added[0].addedNodes[0].tagName));
       ok("childListTarget", added[0] && added[0].target === host);
       ok("childListRemove", gone.length === 1 && gone[0].removedNodes[0].tagName === "SPAN", gone.length);
       ok("attributeRecords", attrs.length === 2, attrs.length);
       ok("attributeOldValueFirst", attrs[0] && attrs[0].oldValue === null, attrs[0] && attrs[0].oldValue);
       ok("attributeOldValueSecond", attrs[1] && attrs[1].oldValue === "1", attrs[1] && attrs[1].oldValue);
       ok("characterData", cds.length === 1 && cds[0].oldValue === "txt",
          cds.length + ":" + (cds[0] && cds[0].oldValue));
       ok("attributeFilter", filtered.length === 1 && filtered[0].attributeName === "data-keep",
          filtered.map(function (r) { return r.attributeName; }).join(","));

       recs = [];
       mo.disconnect();
       host.setAttribute("data-after", "1");
       setTimeout(function () {
         ok("disconnect", recs.length === 0, recs.length);
         done("mutation");
       }, 30);
     }, 30);`,
  );
  expect(failures(res)).toEqual([]);
}, 60_000);

test.skipIf(headless)("customElements.define upgrades elements", async () => {
  const res = await run(
    "custom",
    `<x-card id="pre" label="a"></x-card><div id="host2"></div>`,
    `var log = [];
     class Card extends HTMLElement {
       static get observedAttributes() { return ["label"]; }
       constructor() { super(); log.push("ctor"); }
       connectedCallback() { log.push("connected"); }
       disconnectedCallback() { log.push("disconnected"); }
       attributeChangedCallback(n, o, v) { log.push("attr:" + n + "=" + o + ">" + v); }
     }
     ok("undefinedBeforeDefine", customElements.get("x-card") === undefined);

     customElements.define("x-card", Card);
     ok("registryGet", customElements.get("x-card") === Card);
     ok("upgradedExisting", log.join(",") === "ctor,attr:label=null>a,connected", log.join(","));

     var pre = document.getElementById("pre");
     ok("instanceOfDefinition", pre instanceof Card);

     log = [];
     pre.setAttribute("label", "b");
     ok("attributeChangedCallback", log.join(",") === "attr:label=a>b", log.join(","));

     log = [];
     pre.setAttribute("other", "z");
     ok("unobservedAttributeIgnored", log.length === 0, log.join(","));

     log = [];
     var made = document.createElement("x-card");
     ok("createElementUpgrades", made instanceof Card && log.join(",") === "ctor", log.join(","));

     log = [];
     document.getElementById("host2").appendChild(made);
     ok("connectedOnInsert", log.join(",") === "connected", log.join(","));

     log = [];
     made.remove();
     ok("disconnectedOnRemove", log.join(",") === "disconnected", log.join(","));

     ok("directConstruction", new Card() instanceof Card);

     var settled = "pending";
     customElements.whenDefined("x-later").then(function (c) { settled = typeof c; });
     setTimeout(function () {
       customElements.define("x-later", class extends HTMLElement {});
       setTimeout(function () {
         ok("whenDefinedSettles", settled === "function", settled);
         var already = "no";
         customElements.whenDefined("x-card").then(function () { already = "yes"; });
         setTimeout(function () {
           ok("whenDefinedAlreadyDefined", already === "yes", already);
           done("custom");
         }, 20);
       }, 20);
     }, 0);`,
  );
  expect(failures(res)).toEqual([]);
}, 60_000);

test.skipIf(headless)("document.cookie round-trips in the per-document jar", async () => {
  const res = await run(
    "cookie",
    "",
    `function jar() { return document.cookie.replace(/;\\s*/g, "|"); }
     ok("startsEmpty", document.cookie === "", jar());
     document.cookie = "a=1";
     ok("setAndGet", document.cookie === "a=1", jar());
     document.cookie = "b=2; path=/";
     ok("second", jar() === "a=1|b=2", jar());
     document.cookie = "a=9";
     ok("overwrite", jar() === "a=9|b=2", jar());
     document.cookie = "b=2; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT";
     ok("expiredIsDeleted", jar() === "a=9", jar());
     document.cookie = "c=3; max-age=0";
     ok("maxAgeZeroDeletes", jar() === "a=9", jar());
     document.cookie = "d=4; max-age=600";
     ok("maxAgeFutureKept", jar() === "a=9|d=4", jar());
     document.cookie = "e=5; path=/nowhere/deep";
     ok("pathScoped", jar() === "a=9|d=4", jar());
     document.cookie = "novalue";
     ok("bareTokenIgnored", jar() === "a=9|d=4", jar());
     ok("cookieEnabled", navigator.cookieEnabled === true);
     done("cookie");`,
  );
  expect(failures(res)).toEqual([]);
}, 60_000);

// Not implemented by js/engine.ts. Each names the missing API rather than
// pretending the behaviour exists.
test.todo("Element.attachShadow / ShadowRoot (ShadowRoot is an empty class)");
test.todo("getComputedStyle resolves cascaded values, not just inline style");
