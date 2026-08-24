// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * The Bun half of the Blitz backend's JavaScript engine.
 *
 * One of these runs per loaded document, spawned by src/js.rs. The contract is
 * one JSON object per line on stdin/stdout:
 *
 *   in:  {op:"load", url, html}          parse, run scripts, keep answering timers
 *   in:  {op:"inject", items:[{ext,code}]}   run content scripts in this DOM
 *   in:  {op:"page", payload}            message from the extension host
 *   out: {t:"ready"}
 *   out: {t:"html", html}                serialized DOM after mutations
 *   out: {t:"title", title}
 *   out: {t:"console", level, text}
 *   out: {t:"error", stage, message}
 *   out: {t:"navigate", url}
 *   out: {t:"page", payload}             message toward the extension host
 *
 * The DOM here is a plain tree of records. When it changes we serialize the
 * whole thing back to HTML and the Rust side reparses it into the real
 * (Stylo/Taffy) document — crude, but stateless on the wire and impossible to
 * desynchronize. Script tags are omitted from that serialization: the worker
 * owns them once, and the display copy never needs them again.
 */

import vm from "node:vm";

type Kind = "el" | "text" | "comment";

/**
 * One registration made by addEventListener. `capture` is part of a
 * listener's identity (a callback may be registered once per phase), which is
 * why removal matches on the pair rather than on the callback alone.
 */
interface ListenerRec {
  fn: any;
  capture: boolean;
  once: boolean;
  passive: boolean;
  signal?: any;
  removed?: boolean;
}

interface Node {
  kind: Kind;
  tag: string; // lower-case for elements, "#root"/"#fragment" for containers
  attrs: Record<string, string>;
  children: Node[];
  parent: Node | null;
  text: string;
  listeners: Record<string, ListenerRec[]>;
  _el?: unknown;
  /** Spec's "already started" flag: a script element executes at most once. */
  _started?: boolean;
  /** Set once a custom-element definition has upgraded this element. */
  _ceDef?: any;
  _ceConnected?: boolean;
}

const VOID = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link",
  "meta", "param", "source", "track", "wbr",
]);
const RAWTEXT = new Set(["script", "style", "textarea", "title"]);

function makeNode(kind: Kind, tag = ""): Node {
  return {
    kind,
    tag,
    attrs: {},
    children: [],
    parent: null,
    text: "",
    listeners: {},
  };
}

// -------------------------------------------------------------------- parser

function parseHTML(html: string): Node {
  const root = makeNode("el", "#root");
  let cur = root;
  let i = 0;
  const n = html.length;

  const pushText = (s: string): void => {
    if (!s) return;
    const t = makeNode("text");
    t.text = s;
    t.parent = cur;
    cur.children.push(t);
  };

  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      pushText(html.slice(i));
      break;
    }
    if (lt > i) pushText(html.slice(i, lt));

    if (html.startsWith("<!--", lt)) {
      let end = html.indexOf("-->", lt + 4);
      if (end < 0) end = n - 3;
      const c = makeNode("comment");
      c.text = html.slice(lt + 4, Math.max(lt + 4, end));
      c.parent = cur;
      cur.children.push(c);
      i = end + 3;
      continue;
    }
    // doctype and other <! ... > / <? ... > forms
    if (html[lt + 1] === "!" || html[lt + 1] === "?") {
      const end = html.indexOf(">", lt);
      i = end < 0 ? n : end + 1;
      continue;
    }

    const close = /^<\/([a-zA-Z][a-zA-Z0-9:-]*)[^>]*>/.exec(html.slice(lt));
    if (close) {
      const name = close[1].toLowerCase();
      let p: Node | null = cur;
      while (p && p.tag !== name) p = p.parent;
      if (p?.parent) cur = p.parent; // stray closers are dropped
      i = lt + close[0].length;
      continue;
    }

    const open = /^<([a-zA-Z][a-zA-Z0-9:-]*)/.exec(html.slice(lt));
    if (!open) {
      pushText("<"); // a bare '<' that starts no tag is text
      i = lt + 1;
      continue;
    }
    const tag = open[1].toLowerCase();
    let j = lt + open[0].length;

    const el = makeNode("el", tag);
    for (;;) {
      while (j < n && /\s/.test(html[j])) j++;
      if (j >= n || html[j] === ">" || (html[j] === "/" && html[j + 1] === ">")) break;
      const am = /^([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]*)))?/.exec(
        html.slice(j),
      );
      if (!am || !am[1]) break;
      el.attrs[am[1].toLowerCase()] =
        am[2] ?? am[3] ?? am[4] ?? "";
      j += am[0].length;
    }

    const selfClosed = html[j] === "/" && html[j + 1] === ">";
    i = j + (selfClosed ? 2 : 1);
    el.parent = cur;
    cur.children.push(el);

    if (selfClosed || VOID.has(tag)) continue;

    if (RAWTEXT.has(tag)) {
      const cm = new RegExp(`</${tag}\\s*>`, "i").exec(html.slice(i));
      const rawEnd = cm ? i + cm.index : n;
      if (tag === "textarea" || tag === "title") {
        if (rawEnd > i) {
          const t = makeNode("text");
          t.text = html.slice(i, rawEnd);
          t.parent = el;
          el.children.push(t);
        }
      } else {
        // script/style contents ride in a private attribute so the
        // serializer can reproduce them without treating them as markup.
        el.attrs["#raw"] = html.slice(i, rawEnd);
      }
      i = cm ? rawEnd + cm[0].length : n;
      continue;
    }
    cur = el;
  }
  return root;
}

// --------------------------------------------------------------- serializer

function escText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

/**
 * The `style` attribute is the only home for inline style: `el.style` is a
 * live view over it, so a declaration written either way is visible from the
 * other and the serializer has nothing extra to merge in.
 */
function parseStyleAttr(src: string): Record<string, string> {
  const props: Record<string, string> = {};
  for (const decl of src.split(";")) {
    const c = decl.indexOf(":");
    if (c < 0) continue;
    const k = normalizeProp(decl.slice(0, c));
    if (k) props[k] = decl.slice(c + 1).trim();
  }
  return props;
}

function styleText(props: Record<string, string>): string {
  return Object.entries(props)
    .map(([k, v]) => `${k}:${v}`)
    .join(";");
}

function writeStyleProps(node: Node, props: Record<string, string>): void {
  const text = styleText(props);
  // An emptied style object drops the attribute rather than leaving `style=""`.
  if (text) setAttr(node, "style", text);
  else removeAttr(node, "style");
}

/** Serialize for display: no script tags, no comments worth keeping. */
export function serializeDisplay(node: Node): string {
  if (node.kind === "text") return escText(node.text);
  if (node.kind === "comment") return "";
  if (node.tag === "#root" || node.tag === "#fragment")
    return node.children.map(serializeDisplay).join("");
  if (node.tag === "script") return ""; // the worker owns scripts

  const parts: string[] = [`<${node.tag}`];
  for (const [k, v] of Object.entries(node.attrs)) {
    if (k === "#raw") continue;
    parts.push(v === "" ? ` ${k}` : ` ${k}="${escAttr(v)}"`);
  }
  parts.push(">");

  if (node.tag === "style") parts.push(styleOrRaw(node));
  else if (node.tag === "script") parts.push("");
  else for (const c of node.children) parts.push(serializeDisplay(c));

  if (!VOID.has(node.tag)) parts.push(`</${node.tag}>`);
  return parts.join("");
}

function styleOrRaw(node: Node): string {
  return node.attrs["#raw"] ?? "";
}

/** Full serialization, scripts included — used for debugging only. */
function serializeAll(node: Node): string {
  if (node.kind === "text") return escText(node.text);
  if (node.kind === "comment") return `<!--${node.text}-->`;
  if (node.tag === "#root" || node.tag === "#fragment")
    return node.children.map(serializeAll).join("");

  const parts: string[] = [`<${node.tag}`];
  for (const [k, v] of Object.entries(node.attrs)) {
    if (v === "") parts.push(` ${k}`);
    else parts.push(` ${k}="${escAttr(v)}"`);
  }
  parts.push(">");
  if (node.tag === "style") parts.push(styleOrRaw(node));
  else for (const c of node.children) parts.push(serializeAll(c));
  if (!VOID.has(node.tag)) parts.push(`</${node.tag}>`);
  return parts.join("");
}

// ------------------------------------------------------------------ selectors

/**
 * A small Selectors-4 subset: type/id/class/attribute/`*` compounds, the four
 * combinators, selector lists, and the structural pseudo-classes pages
 * actually branch on. Unknown pseudo-classes never match, which keeps a
 * stylesheet-driven `:hover` rule from silently selecting everything.
 */
type Combinator = " " | ">" | "+" | "~";

interface Step {
  comb: Combinator; // how this compound attaches to the one on its left
  sel: string;
}

/** Split on `sep` only where it is not nested inside (...) or [...]. */
function splitTop(src: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let buf = "";
  for (const c of src) {
    if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (c === sep && depth === 0) {
      out.push(buf);
      buf = "";
      continue;
    }
    buf += c;
  }
  out.push(buf);
  return out;
}

function parseComplex(sel: string): Step[] {
  const steps: Step[] = [];
  let depth = 0;
  let buf = "";
  let comb: Combinator = " ";
  let sawSpace = false;
  const flush = (next: Combinator): void => {
    if (buf) steps.push({ comb, sel: buf });
    buf = "";
    comb = next;
    sawSpace = false;
  };
  for (const c of sel) {
    if (depth === 0 && /\s/.test(c)) {
      if (buf) sawSpace = true;
      continue;
    }
    if (depth === 0 && (c === ">" || c === "+" || c === "~")) {
      flush(c);
      continue;
    }
    if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    if (sawSpace) flush(" ");
    buf += c;
  }
  if (buf) steps.push({ comb, sel: buf });
  return steps;
}

function prevElement(nd: Node): Node | null {
  const p = nd.parent;
  if (!p) return null;
  for (let i = p.children.indexOf(nd) - 1; i >= 0; i--) {
    if (p.children[i].kind === "el") return p.children[i];
  }
  return null;
}

function elementSiblings(nd: Node): Node[] {
  return nd.parent ? nd.parent.children.filter((c) => c.kind === "el") : [nd];
}

/** `an+b`, plus the `odd`/`even` keywords and a bare index. */
function parseNth(arg: string): { a: number; b: number } | null {
  const t = arg.trim().toLowerCase().replace(/\s+/g, "");
  if (t === "odd") return { a: 2, b: 1 };
  if (t === "even") return { a: 2, b: 0 };
  if (/^[+-]?\d+$/.test(t)) return { a: 0, b: Number(t) };
  const m = /^([+-]?\d*)n([+-]\d+)?$/.exec(t);
  if (!m) return null;
  const a = m[1] === "" || m[1] === "+" ? 1 : m[1] === "-" ? -1 : Number(m[1]);
  return { a, b: m[2] ? Number(m[2]) : 0 };
}

function nthMatches(nth: { a: number; b: number }, index: number): boolean {
  if (nth.a === 0) return index === nth.b;
  const k = (index - nth.b) / nth.a;
  return Number.isInteger(k) && k >= 0;
}

function matchesAttrSel(el: Node, body: string): boolean {
  const m = /^\s*([\w:-]+)\s*(?:([~^$*|]?=)([\s\S]*))?$/.exec(body);
  if (!m) return false;
  const name = m[1].toLowerCase();
  if (!(name in el.attrs)) return false;
  if (!m[2]) return true;

  let raw = (m[3] ?? "").trim();
  let ci = false;
  // The i/s flag is only unambiguous after a quoted value; an unquoted value
  // containing whitespace is invalid anyway, so nothing else can be eaten.
  const flag = /\s+([isIS])$/.exec(raw);
  if (flag && /^["']/.test(raw)) {
    ci = flag[1].toLowerCase() === "i";
    raw = raw.slice(0, flag.index);
  }
  if (/^["'][\s\S]*["']$/.test(raw)) raw = raw.slice(1, -1);

  const have = ci ? el.attrs[name].toLowerCase() : el.attrs[name];
  const want = ci ? raw.toLowerCase() : raw;
  switch (m[2]) {
    case "=": return have === want;
    case "^=": return want !== "" && have.startsWith(want);
    case "$=": return want !== "" && have.endsWith(want);
    case "*=": return want !== "" && have.includes(want);
    case "~=": return want !== "" && have.split(/\s+/).includes(want);
    case "|=": return have === want || have.startsWith(`${want}-`);
    default: return false;
  }
}

function matchesPseudo(el: Node, name: string, arg: string): boolean {
  switch (name) {
    case "not":
      return !matches(el, arg);
    case "is":
    case "where":
    case "matches":
    case "any":
      return matches(el, arg);
    case "has":
      return queryAll(el, arg.trim().replace(/^[>+~]/, "")).length > 0;
    case "root":
      return el.tag === "html";
    case "scope":
      return true;
    case "empty":
      return !el.children.some((c) => c.kind === "el" || (c.kind === "text" && c.text !== ""));
    case "first-child":
      return prevElement(el) === null;
    case "last-child":
      return elementSiblings(el).at(-1) === el;
    case "only-child":
      return elementSiblings(el).length === 1;
    case "first-of-type":
      return elementSiblings(el).find((s) => s.tag === el.tag) === el;
    case "last-of-type":
      return elementSiblings(el).filter((s) => s.tag === el.tag).at(-1) === el;
    case "checked":
      return "checked" in el.attrs || "selected" in el.attrs;
    case "disabled":
      return "disabled" in el.attrs;
    case "enabled":
      return !("disabled" in el.attrs);
    case "required":
      return "required" in el.attrs;
    case "nth-child":
    case "nth-last-child":
    case "nth-of-type":
    case "nth-last-of-type": {
      const nth = parseNth(arg);
      if (!nth) return false;
      let sibs = elementSiblings(el);
      if (name.endsWith("of-type")) sibs = sibs.filter((s) => s.tag === el.tag);
      if (name.startsWith("nth-last")) sibs = sibs.slice().reverse();
      return nthMatches(nth, sibs.indexOf(el) + 1);
    }
    default:
      return false;
  }
}

/** One compound selector: no combinators, no commas. */
function matchesCompound(el: Node, sel: string): boolean {
  if (el.kind !== "el" || el.tag.startsWith("#")) return false;
  const s = sel.trim();
  if (!s) return false;

  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "*") {
      i++;
    } else if (c === "#") {
      const m = /^#([\w-]+)/.exec(s.slice(i));
      if (!m || el.attrs.id !== m[1]) return false;
      i += m[0].length;
    } else if (c === ".") {
      const m = /^\.([\w-]+)/.exec(s.slice(i));
      if (!m || !(el.attrs.class ?? "").split(/\s+/).includes(m[1])) return false;
      i += m[0].length;
    } else if (c === "[") {
      let depth = 0;
      let end = -1;
      for (let j = i; j < s.length; j++) {
        if (s[j] === "[") depth++;
        else if (s[j] === "]" && --depth === 0) { end = j; break; }
      }
      if (end < 0 || !matchesAttrSel(el, s.slice(i + 1, end))) return false;
      i = end + 1;
    } else if (c === ":") {
      const m = /^::?([\w-]+)/.exec(s.slice(i));
      if (!m) return false;
      i += m[0].length;
      let arg = "";
      if (s[i] === "(") {
        let depth = 0;
        let end = -1;
        for (let j = i; j < s.length; j++) {
          if (s[j] === "(") depth++;
          else if (s[j] === ")" && --depth === 0) { end = j; break; }
        }
        if (end < 0) return false;
        arg = s.slice(i + 1, end);
        i = end + 1;
      }
      // A pseudo-element never matches an element in this engine.
      if (s.startsWith("::", i - m[0].length)) return false;
      if (!matchesPseudo(el, m[1].toLowerCase(), arg)) return false;
    } else {
      const m = /^[\w-]+/.exec(s.slice(i));
      if (!m || el.tag !== m[0].toLowerCase()) return false;
      i += m[0].length;
    }
  }
  return true;
}

function matchSteps(el: Node, steps: Step[], at: number): boolean {
  if (!matchesCompound(el, steps[at].sel)) return false;
  if (at === 0) return true;
  switch (steps[at].comb) {
    case ">":
      return !!el.parent && matchSteps(el.parent, steps, at - 1);
    case "+": {
      const prev = prevElement(el);
      return !!prev && matchSteps(prev, steps, at - 1);
    }
    case "~": {
      for (let s = prevElement(el); s; s = prevElement(s)) {
        if (matchSteps(s, steps, at - 1)) return true;
      }
      return false;
    }
    default: {
      for (let p = el.parent; p; p = p.parent) {
        if (matchSteps(p, steps, at - 1)) return true;
      }
      return false;
    }
  }
}

/** True when `el` matches any selector in the comma-separated list. */
function matches(el: Node, selectorList: string): boolean {
  for (const group of splitTop(selectorList, ",")) {
    const steps = parseComplex(group);
    if (steps.length && matchSteps(el, steps, steps.length - 1)) return true;
  }
  return false;
}

function walk(root: Node, fn: (n: Node) => void): void {
  for (const c of root.children) {
    fn(c);
    walk(c, fn);
  }
}

function queryAll(root: Node, selector: string): Node[] {
  const groups = splitTop(selector, ",")
    .map((g) => parseComplex(g))
    .filter((steps) => steps.length);
  const out: Node[] = [];
  if (!groups.length) return out;
  // One tree pass so the result stays in document order across a list.
  walk(root, (nd) => {
    if (nd.kind !== "el" || nd === root) return;
    if (groups.some((steps) => matchSteps(nd, steps, steps.length - 1))) out.push(nd);
  });
  return out;
}

// ------------------------------------------------------------------ DOM model

class CSSStyleDecl {
  constructor(public node: Node) {}
  private props(): Record<string, string> {
    return parseStyleAttr(this.node.attrs.style ?? "");
  }
  get cssText(): string {
    return this.node.attrs.style ?? "";
  }
  set cssText(v: string) {
    writeStyleProps(this.node, parseStyleAttr(String(v)));
  }
  get length(): number {
    return Object.keys(this.props()).length;
  }
  item(i: number): string {
    return Object.keys(this.props())[i] ?? "";
  }
  getPropertyValue(k: string): string {
    return this.props()[normalizeProp(k)] ?? "";
  }
  setProperty(k: string, v: string): void {
    const props = this.props();
    // Assigning "" is how pages clear a declaration, and the spec drops it.
    if (v === "") delete props[normalizeProp(k)];
    else props[normalizeProp(k)] = v;
    writeStyleProps(this.node, props);
  }
  removeProperty(k: string): void {
    const props = this.props();
    delete props[normalizeProp(k)];
    writeStyleProps(this.node, props);
  }
}

function normalizeProp(k: string): string {
  return k.trim().replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

class DOMTokenList {
  constructor(private node: Node, private attr: string) {}
  private list(): string[] {
    return (this.node.attrs[this.attr] ?? "").split(/\s+/).filter(Boolean);
  }
  private save(v: string[]): void {
    setAttr(this.node, this.attr, v.join(" "));
  }
  contains(t: string): boolean {
    return this.list().includes(t);
  }
  add(...ts: string[]): void {
    const l = this.list();
    l.push(...ts.filter((t) => !l.includes(t)));
    this.save(l);
  }
  remove(...ts: string[]): void {
    this.save(this.list().filter((t) => !ts.includes(t)));
  }
  toggle(t: string): boolean {
    const l = this.list();
    const on = !l.includes(t);
    this.save(on ? [...l, t] : l.filter((x) => x !== t));
    return on;
  }
  toString(): string {
    return this.node.attrs[this.attr] ?? "";
  }
  get length(): number {
    return this.list().length;
  }
}

class DOMException extends Error {
  constructor(msg: string, public name = "Error") {
    super(msg);
  }
}

class Event {
  NONE = 0;
  CAPTURING_PHASE = 1;
  AT_TARGET = 2;
  BUBBLING_PHASE = 3;
  defaultPrevented = false;
  eventPhase = 0;
  target: any = null;
  currentTarget: any = null;
  timeStamp = Date.now();
  _stop = false;
  _stopImmediate = false;
  _path: any[] = [];
  constructor(
    public type: string,
    public init: Record<string, unknown> = {},
  ) {}
  get detail(): unknown {
    return this.init.detail;
  }
  get bubbles(): boolean {
    return !!this.init.bubbles;
  }
  get cancelable(): boolean {
    return !!this.init.cancelable;
  }
  get isTrusted(): boolean {
    return false;
  }
  get srcElement(): any {
    return this.target;
  }
  composedPath(): any[] {
    return this._path;
  }
  preventDefault(): void {
    if (this.cancelable) this.defaultPrevented = true;
  }
  stopPropagation(): void {
    this._stop = true;
  }
  stopImmediatePropagation(): void {
    this._stop = true;
    this._stopImmediate = true;
  }
}

function normalizeListenerOpts(o: unknown): {
  capture: boolean;
  once: boolean;
  passive: boolean;
  signal?: any;
} {
  if (typeof o === "boolean") return { capture: o, once: false, passive: false };
  if (o && typeof o === "object") {
    const r = o as Record<string, unknown>;
    return {
      capture: !!r.capture,
      once: !!r.once,
      passive: !!r.passive,
      signal: r.signal ?? undefined,
    };
  }
  return { capture: false, once: false, passive: false };
}

function addListener(node: Node, type: string, fn: any, opts?: unknown): void {
  if (typeof fn !== "function" && typeof fn?.handleEvent !== "function") return;
  const o = normalizeListenerOpts(opts);
  if (o.signal?.aborted) return;
  const list = (node.listeners[type] ??= []);
  // (callback, capture) is a listener's identity: re-adding the same pair is a
  // no-op, so `once`/`passive` on the duplicate are discarded, not merged.
  if (list.some((r) => r.fn === fn && r.capture === o.capture)) return;
  const rec: ListenerRec = {
    fn,
    capture: o.capture,
    once: o.once,
    passive: o.passive,
    signal: o.signal,
  };
  list.push(rec);
  if (typeof o.signal?.addEventListener === "function") {
    o.signal.addEventListener("abort", () => dropListener(node, type, rec), { once: true });
  }
}

/**
 * Removal marks the record dead as well as unlinking it: a dispatch already in
 * flight iterates a snapshot, and the spec says a listener removed mid-dispatch
 * must not be called.
 */
function dropListener(node: Node, type: string, rec: ListenerRec): void {
  rec.removed = true;
  const l = node.listeners[type];
  if (l) node.listeners[type] = l.filter((r) => r !== rec);
}

function removeListener(node: Node, type: string, fn: any, opts?: unknown): void {
  const { capture } = normalizeListenerOpts(opts);
  for (const rec of node.listeners[type] ?? []) {
    if (rec.fn === fn && rec.capture === capture) dropListener(node, type, rec);
  }
}

function invokeListener(fn: any, ev: Event): void {
  if (typeof fn === "function") fn.call(ev.currentTarget, ev);
  else fn.handleEvent(ev);
}

/** Full three-phase dispatch: capture root-to-target, target, bubble back up. */
function dispatchOn(target: Node, ev: any, owner: Doc): boolean {
  const path: Node[] = [];
  for (let p = target.parent; p; p = p.parent) path.push(p);

  ev.target = Element.wrap(target, owner);
  ev._path = [ev.target, ...path.map((nd) => Element.wrap(nd, owner))];
  ev._stop = false;
  ev._stopImmediate = false;
  ev.defaultPrevented = false;

  const phase = (node: Node, which: number): void => {
    ev.eventPhase = which;
    ev.currentTarget = Element.wrap(node, owner);
    for (const rec of [...(node.listeners[ev.type] ?? [])]) {
      if (rec.removed) continue;
      if (which === 1 && !rec.capture) continue;
      if (which === 3 && rec.capture) continue;
      if (rec.once) dropListener(node, ev.type, rec);
      try {
        invokeListener(rec.fn, ev);
      } catch (e) {
        report("listener", e);
      }
      if (ev._stopImmediate) return;
    }
  };

  for (let i = path.length - 1; i >= 0 && !ev._stop; i--) phase(path[i], 1);
  if (!ev._stop) phase(target, 2);
  if (ev.bubbles) for (let i = 0; i < path.length && !ev._stop; i++) phase(path[i], 3);

  ev.eventPhase = 0;
  ev.currentTarget = null;
  return !ev.defaultPrevented;
}

class CustomEvent extends Event {}
class MouseEvent extends Event {
  get clientX(): number { return 0; }
  get clientY(): number { return 0; }
}
class InputEvent extends Event {}
class KeyboardEvent extends Event {
  get key(): string { return String(this.init.key ?? ""); }
}

class NodeList extends Array<any> {}

class Element {
  node: Node;
  ownerDoc: Doc;

  static wrap(node: Node, owner: Doc): any {
    if (node._el) return node._el;
    const el: any =
      node.kind === "text"
        ? new Text(node, owner)
        : node.kind === "comment"
          ? new Comment(node, owner)
          : new Element(node, owner);
    node._el = el;
    return el;
  }

  constructor(node?: Node, owner?: Doc) {
    // A page's `class Foo extends HTMLElement` calls `super()` with nothing.
    // Either we are mid-upgrade (adopt that element) or the page constructed
    // the class directly, in which case a fresh element of the registered
    // name is created -- the two paths the spec's HTMLElement constructor has.
    if (!node) {
      const t = ceUpgradeTarget;
      if (t) {
        ceUpgradeTarget = null;
        node = t.node;
        owner = t.owner;
        node._el = this;
      } else {
        let name = "";
        for (const d of ceRegistry.values()) {
          if (this instanceof d.ctor) {
            name = d.name;
            break;
          }
        }
        if (!name) throw new DOMException("Illegal constructor", "TypeError");
        node = makeNode("el", name);
        node._el = this;
        node._ceDef = ceRegistry.get(name);
        owner = doc;
      }
    }
    this.node = node;
    this.ownerDoc = owner as Doc;
  }

  get nodeType(): number {
    if (this instanceof Text) return 3;
    if (this instanceof Comment) return 8;
    if (this.node.tag === "#fragment") return 11;
    return 1;
  }
  get tagName(): string {
    return this.node.tag.toUpperCase();
  }
  get nodeName(): string {
    return this.tagName;
  }
  get id(): string {
    return this.node.attrs.id ?? "";
  }
  set id(v: string) {
    setAttr(this.node, "id", v);
  }
  get className(): string {
    return this.node.attrs.class ?? "";
  }
  set className(v: string) {
    setAttr(this.node, "class", v);
  }
  get classList(): DOMTokenList {
    return new DOMTokenList(this.node, "class");
  }
  get style(): CSSStyleDecl {
    return styleProxy(this.node);
  }
  get children(): NodeList {
    return NodeList.from(
      this.node.children.filter((c) => c.kind === "el"),
      (c) => Element.wrap(c, this.ownerDoc),
    );
  }
  get childNodes(): NodeList {
    return NodeList.from(this.node.children, (c) =>
      Element.wrap(c, this.ownerDoc),
    );
  }
  get firstChild(): any {
    return this.node.children.length
      ? Element.wrap(this.node.children[0], this.ownerDoc)
      : null;
  }
  get lastChild(): any {
    const ch = this.node.children;
    return ch.length ? Element.wrap(ch[ch.length - 1], this.ownerDoc) : null;
  }
  get firstElementChild(): any {
    return this.children[0] ?? null;
  }
  get lastElementChild(): any {
    const els = this.children;
    return els[els.length - 1] ?? null;
  }
  get parentNode(): any {
    return this.node.parent
      ? Element.wrap(this.node.parent, this.ownerDoc)
      : null;
  }
  get parentElement(): any {
    const p = this.parentNode;
    return p && p.nodeType === 1 ? p : null;
  }
  get nextSibling(): any {
    const p = this.node.parent;
    if (!p) return null;
    const i = p.children.indexOf(this.node);
    return i >= 0 && i + 1 < p.children.length
      ? Element.wrap(p.children[i + 1], this.ownerDoc)
      : null;
  }
  get previousSibling(): any {
    const p = this.node.parent;
    if (!p) return null;
    const i = p.children.indexOf(this.node);
    return i > 0 ? Element.wrap(p.children[i - 1], this.ownerDoc) : null;
  }
  get nextElementSibling(): any {
    let s = this.nextSibling;
    while (s && s.nodeType !== 1) s = s.nextSibling;
    return s;
  }
  get previousElementSibling(): any {
    let s = this.previousSibling;
    while (s && s.nodeType !== 1) s = s.previousSibling;
    return s;
  }
  get innerHTML(): string {
    return this.node.children.map(serializeDisplay).join("");
  }
  set innerHTML(v: string) {
    const frag = parseHTML(`<div>${String(v)}</div>`);
    const box = frag.children.find((c) => c.tag === "div");
    const removed = this.node.children;
    const added = [...(box?.children ?? [])];
    for (const c of added) markFragmentScripts(c);
    this.node.children = [];
    for (const c of removed) c.parent = null;
    for (const c of added) reparent(c, this.node);
    dirty();
    notifyChildList(this.node, added, removed, null, null);
  }
  get outerHTML(): string {
    return serializeDisplay(this.node);
  }
  set outerHTML(v: string) {
    const frag = parseHTML(`<div>${String(v)}</div>`);
    const p = this.node.parent;
    if (!p) return;
    const at = p.children.indexOf(this.node);
    if (at < 0) return;
    const added = (frag.children.find((c) => c.tag === "div")?.children ?? []).map((c) => {
      markFragmentScripts(c);
      c.parent = p;
      return c;
    });
    const old = this.node;
    p.children.splice(at, 1, ...added);
    old.parent = null;
    dirty();
    notifyChildList(p, added, [old], p.children[at - 1] ?? null, p.children[at + added.length] ?? null);
  }
  get textContent(): string {
    if (this.node.kind === "text") return this.node.text;
    let out = "";
    walk(this.node, (nd) => {
      if (nd.kind === "text") out += nd.text;
    });
    return out;
  }
  set textContent(v: string) {
    if (this.node.kind !== "el") {
      setText(this.node, String(v));
      return;
    }
    const removed = this.node.children;
    const added: Node[] = [];
    if (String(v) !== "") {
      const t = makeNode("text");
      t.text = String(v);
      t.parent = this.node;
      added.push(t);
    }
    this.node.children = added;
    for (const c of removed) c.parent = null;
    dirty();
    notifyChildList(this.node, added, removed, null, null);
  }
  /** `script.text` / `option.text`: the same store as textContent. */
  get text(): string {
    return this.node.attrs["#raw"] ?? this.textContent;
  }
  set text(v: string) {
    delete this.node.attrs["#raw"];
    this.textContent = String(v);
  }
  get innerText(): string {
    return this.textContent;
  }
  set innerText(v: string) {
    this.textContent = v;
  }
  get value(): string {
    return this.node.attrs.value ?? this.node.attrs["#raw"] ?? "";
  }
  set value(v: string) {
    setAttr(this.node, "value", v);
  }
  get src(): string {
    return this.node.attrs.src ?? "";
  }
  set src(v: string) {
    setAttr(this.node, "src", v);
  }
  get href(): string {
    return this.node.attrs.href ?? "";
  }
  set href(v: string) {
    setAttr(this.node, "href", v);
  }
  get hidden(): boolean {
    return "hidden" in this.node.attrs;
  }
  set hidden(v: boolean) {
    if (v) setAttr(this.node, "hidden", "");
    else removeAttr(this.node, "hidden");
  }
  get disabled(): boolean {
    return "disabled" in this.node.attrs;
  }
  set disabled(v: boolean) {
    if (v) setAttr(this.node, "disabled", "");
    else removeAttr(this.node, "disabled");
  }
  get checked(): boolean {
    return "checked" in this.node.attrs;
  }
  set checked(v: boolean) {
    if (v) setAttr(this.node, "checked", "");
    else removeAttr(this.node, "checked");
  }
  get dataset(): Record<string, string> {
    return datasetProxy(this.node);
  }
  get title(): string {
    return this.node.attrs.title ?? "";
  }
  set title(v: string) {
    setAttr(this.node, "title", v);
  }
  get lang(): string {
    return this.node.attrs.lang ?? "";
  }
  set lang(v: string) {
    setAttr(this.node, "lang", v);
  }
  get dir(): string {
    return this.node.attrs.dir ?? "";
  }
  set dir(v: string) {
    setAttr(this.node, "dir", v);
  }
  get tabIndex(): number {
    return Number(this.node.attrs.tabindex ?? -1);
  }
  set tabIndex(v: number) {
    setAttr(this.node, "tabindex", String(v));
  }

  getAttribute(name: string): string | null {
    const k = name.toLowerCase();
    return k in this.node.attrs ? this.node.attrs[k] : null;
  }
  setAttribute(name: string, v: string): void {
    setAttr(this.node, name, v);
  }
  removeAttribute(name: string): void {
    removeAttr(this.node, name);
  }
  hasAttribute(name: string): boolean {
    return name.toLowerCase() in this.node.attrs;
  }
  toggleAttribute(name: string, force?: boolean): boolean {
    const k = name.toLowerCase();
    const on = force ?? !(k in this.node.attrs);
    if (on) setAttr(this.node, k, "");
    else removeAttr(this.node, k);
    return on;
  }
  appendChild(child: any): any {
    const cn: Node | undefined = child?.node;
    if (!cn) throw new DOMException("appendChild: argument is not a Node", "HierarchyRequestError");
    if (cn === this.node) throw new DOMException("cannot append a node to itself");
    insertNodes(this.node, takeInsertable(cn, this.node), this.node.children.length);
    return child;
  }
  prepend(...nodes: any[]): void {
    const incoming: Node[] = [];
    for (const nd of nodes) incoming.push(...toNodes(nd, this.node));
    insertNodes(this.node, incoming, 0);
  }
  append(...nodes: any[]): void {
    const incoming: Node[] = [];
    for (const nd of nodes) incoming.push(...toNodes(nd, this.node));
    insertNodes(this.node, incoming, this.node.children.length);
  }
  insertBefore(child: any, ref: any): any {
    const cn: Node | undefined = child?.node;
    if (!cn) return this.appendChild(child);
    // The reference index is read after the incoming node has been unlinked
    // from wherever it was, which may itself have been this same parent.
    const incoming = takeInsertable(cn, this.node);
    const idx = ref?.node ? this.node.children.indexOf(ref.node) : -1;
    insertNodes(this.node, incoming, idx < 0 ? this.node.children.length : idx);
    return child;
  }
  removeChild(child: any): any {
    if (child?.node && this.node.children.includes(child.node)) detach(child.node);
    return child;
  }
  replaceChild(nu: any, old: any): any {
    if (!nu?.node || !old?.node) return old;
    const incoming = takeInsertable(nu.node, this.node);
    const at = this.node.children.indexOf(old.node);
    if (at < 0) {
      // `old` was not ours after all -- undo, so `nu` is not silently moved.
      for (const c of incoming) detach(c);
      return old;
    }
    detach(old.node);
    insertNodes(this.node, incoming, at);
    return old;
  }
  remove(): void {
    this.parentNode?.removeChild(this);
  }
  replaceWith(...nodes: any[]): void {
    const p = this.node.parent;
    if (!p) return;
    const incoming: Node[] = [];
    for (const nd of nodes) incoming.push(...toNodes(nd, p));
    const at = p.children.indexOf(this.node);
    if (at < 0) return;
    detach(this.node);
    insertNodes(p, incoming, at);
  }
  querySelector(sel: string): any {
    return (
      queryAll(this.node, sel)
        .filter((nd) => nd !== this.node)
        .map((nd) => Element.wrap(nd, this.ownerDoc))[0] ?? null
    );
  }
  querySelectorAll(sel: string): NodeList {
    return NodeList.from(
      queryAll(this.node, sel).filter((nd) => nd !== this.node),
      (nd) => Element.wrap(nd, this.ownerDoc),
    );
  }
  matches(sel: string): boolean {
    return matches(this.node, sel);
  }
  webkitMatchesSelector(sel: string): boolean {
    return this.matches(sel);
  }
  closest(sel: string): any {
    let n: Node | null = this.node;
    while (n) {
      if (n.kind === "el" && matches(n, sel)) {
        return Element.wrap(n, this.ownerDoc);
      }
      n = n.parent;
    }
    return null;
  }
  getElementsByTagName(tag: string): NodeList {
    const t = tag.toLowerCase();
    return NodeList.from(
      queryAll(this.node, "*").filter((nd) => t === "*" || nd.tag === t),
      (nd) => Element.wrap(nd, this.ownerDoc),
    );
  }
  getElementsByClassName(cls: string): NodeList {
    const sel = cls.trim().split(/\s+/).map((c) => `.${c}`).join("");
    return NodeList.from(
      queryAll(this.node, sel),
      (nd) => Element.wrap(nd, this.ownerDoc),
    );
  }
  addEventListener(type: string, fn: any, opts?: unknown): void {
    addListener(this.node, type, fn, opts);
  }
  removeEventListener(type: string, fn: any, opts?: unknown): void {
    removeListener(this.node, type, fn, opts);
  }
  dispatchEvent(ev: any): boolean {
    return dispatchOn(this.node, ev, this.ownerDoc);
  }
  click(): void {
    this.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  }
  focus(): void {}
  blur(): void {}
  scrollIntoView(): void {}
  scroll(): void {}
  scrollTo(): void {}
  getBoundingClientRect(): Record<string, number> {
    return { x: 0, y: 0, top: 0, left: 0, right: 1280, bottom: 720, width: 1280, height: 720 };
  }
  get scrollWidth(): number { return 1280; }
  get scrollHeight(): number { return 720; }
  get clientWidth(): number { return 1280; }
  get clientHeight(): number { return 720; }
  get offsetWidth(): number { return 1280; }
  get offsetHeight(): number { return 720; }
  contains(other: any): boolean {
    let n: Node | null = other?.node;
    while (n) {
      if (n === this.node) return true;
      n = n.parent;
    }
    return false;
  }
  cloneNode(deep = false): any {
    return Element.wrap(deepClone(this.node, deep), this.ownerDoc);
  }
}

function deepClone(nd: Node, deep: boolean): Node {
  const cp = makeNode(nd.kind, nd.tag);
  cp.attrs = { ...nd.attrs };
  cp.text = nd.text;
  if (deep) {
    for (const c of nd.children) {
      const cc = deepClone(c, true);
      cc.parent = cp;
      cp.children.push(cc);
    }
  }
  return cp;
}

class Text extends Element {
  get data(): string {
    return this.node.text;
  }
  set data(v: string) {
    setText(this.node, String(v));
  }
}

class Comment extends Element {}

function reparent(child: Node, parent: Node): void {
  detach(child);
  child.parent = parent;
  parent.children.push(child);
}

/**
 * What actually gets spliced into `parent`. A DocumentFragment is a transparent
 * carrier: its children move and the fragment is left empty, per spec, rather
 * than the "#fragment" wrapper landing in the tree.
 */
function takeInsertable(child: Node, parent: Node): Node[] {
  if (child.tag === "#fragment") {
    const kids = child.children;
    child.children = [];
    for (const k of kids) k.parent = parent;
    return kids;
  }
  detach(child);
  child.parent = parent;
  return [child];
}

/**
 * Unlink a node from its parent, announcing the removal. Every removal path
 * goes through here so a move (detach + insert) reports both halves, exactly
 * as a browser does.
 */
function detach(child: Node): void {
  const p = child.parent;
  if (!p) return;
  const at = p.children.indexOf(child);
  if (at < 0) {
    child.parent = null;
    return;
  }
  const prev = p.children[at - 1] ?? null;
  const next = p.children[at + 1] ?? null;
  p.children.splice(at, 1);
  child.parent = null;
  dirty();
  notifyChildList(p, [], [child], prev, next);
}

/** Splice already-detached nodes in at `at` and announce the insertion. */
function insertNodes(parent: Node, incoming: Node[], at: number): void {
  if (!incoming.length) return;
  const prev = parent.children[at - 1] ?? null;
  const next = parent.children[at] ?? null;
  parent.children.splice(at, 0, ...incoming);
  for (const c of incoming) c.parent = parent;
  dirty();
  notifyChildList(parent, incoming, [], prev, next);
}

/** Coerce one `append`/`prepend`/`replaceWith` argument into insertable nodes. */
function toNodes(x: any, parent: Node): Node[] {
  if (x?.node) return takeInsertable(x.node, parent);
  const t = makeNode("text");
  t.text = String(x);
  t.parent = parent;
  return [t];
}

// ------------------------------------------------- mutation / lifecycle hooks

/**
 * Everything that changes the tree funnels through this section so the three
 * observers a page can install -- MutationObserver, custom-element reactions,
 * and the "insert a <script> and it runs" behaviour -- all see the same events.
 * DOM writes elsewhere in this file call `setAttr`/`removeAttr`/`setText`/
 * `notifyChildList` instead of touching `attrs`/`text`/`children` directly.
 */

function connected(nd: Node): boolean {
  for (let p: Node | null = nd; p; p = p.parent) if (doc && p === doc.node) return true;
  return false;
}

/** `nd` and every element descendant, in document order. */
function forEachEl(nd: Node, fn: (n: Node) => void): void {
  if (nd.kind === "el" && !nd.tag.startsWith("#")) fn(nd);
  walk(nd, (c) => {
    if (c.kind === "el" && !c.tag.startsWith("#")) fn(c);
  });
}

interface MoOpts {
  childList: boolean;
  subtree: boolean;
  attributes: boolean;
  attributeOldValue: boolean;
  characterData: boolean;
  characterDataOldValue: boolean;
  attributeFilter?: string[];
}

interface MoReg {
  obs: any;
  target: Node;
  opts: MoOpts;
}

const moRegs: MoReg[] = [];
const moPending = new Set<any>();
let moScheduled = false;

function moSchedule(obs: any): void {
  moPending.add(obs);
  if (moScheduled) return;
  moScheduled = true;
  // The spec delivers records from a microtask checkpoint, and pages rely on
  // that timing: a mutation made now must be visible to the callback before
  // the next timer fires, but never synchronously inside the mutating call.
  queueMicrotask(() => {
    moScheduled = false;
    const batch = [...moPending];
    moPending.clear();
    for (const o of batch) o._deliver();
  });
}

/**
 * Offer a record to every registration whose target is `target` itself or,
 * with `subtree`, one of its ancestors. `make` may return null to decline
 * (an attributeFilter that does not list the attribute).
 */
function moEnqueue(
  kind: "childList" | "attributes" | "characterData",
  target: Node,
  make: (o: MoOpts) => any,
): void {
  if (!moRegs.length) return;
  for (const reg of [...moRegs]) {
    if (kind === "childList" && !reg.opts.childList) continue;
    if (kind === "attributes" && !reg.opts.attributes) continue;
    if (kind === "characterData" && !reg.opts.characterData) continue;
    if (reg.target !== target) {
      if (!reg.opts.subtree) continue;
      let hit = false;
      for (let p = target.parent; p; p = p.parent) {
        if (p === reg.target) {
          hit = true;
          break;
        }
      }
      if (!hit) continue;
    }
    const rec = make(reg.opts);
    if (!rec) continue;
    reg.obs._records.push(rec);
    moSchedule(reg.obs);
  }
}

function emptyList(): NodeList {
  return NodeList.from([]);
}

function baseRecord(type: string, target: Node): any {
  return {
    type,
    target: Element.wrap(target, doc),
    addedNodes: emptyList(),
    removedNodes: emptyList(),
    previousSibling: null,
    nextSibling: null,
    attributeName: null,
    attributeNamespace: null,
    oldValue: null,
  };
}

class MutationObserver {
  _records: any[] = [];
  constructor(private cb: (records: any[], obs: any) => void) {
    if (typeof cb !== "function") {
      throw new DOMException("MutationObserver requires a callback", "TypeError");
    }
  }
  observe(target: any, init?: any): void {
    const nd: Node | undefined = target?.node;
    if (!nd) throw new DOMException("observe: argument is not a Node", "TypeError");
    const i = (init ?? {}) as Record<string, unknown>;
    const filter = Array.isArray(i.attributeFilter)
      ? (i.attributeFilter as string[]).map((a) => String(a).toLowerCase())
      : undefined;
    // `attributeOldValue`/`attributeFilter` imply `attributes`, and likewise
    // for characterData -- pages routinely pass only the modifier.
    const opts: MoOpts = {
      childList: !!i.childList,
      subtree: !!i.subtree,
      attributes:
        i.attributes === undefined
          ? i.attributeOldValue !== undefined || filter !== undefined
          : !!i.attributes,
      attributeOldValue: !!i.attributeOldValue,
      characterData:
        i.characterData === undefined ? i.characterDataOldValue !== undefined : !!i.characterData,
      characterDataOldValue: !!i.characterDataOldValue,
      attributeFilter: filter,
    };
    if (!opts.childList && !opts.attributes && !opts.characterData) {
      throw new DOMException(
        "observe: one of childList, attributes or characterData is required",
        "TypeError",
      );
    }
    // Re-observing a node replaces that node's registration rather than
    // stacking a second one, so records are not delivered twice.
    for (let n = moRegs.length - 1; n >= 0; n--) {
      if (moRegs[n].obs === this && moRegs[n].target === nd) moRegs.splice(n, 1);
    }
    moRegs.push({ obs: this, target: nd, opts });
  }
  disconnect(): void {
    for (let n = moRegs.length - 1; n >= 0; n--) if (moRegs[n].obs === this) moRegs.splice(n, 1);
    this._records = [];
    moPending.delete(this);
  }
  takeRecords(): any[] {
    const out = this._records;
    this._records = [];
    return out;
  }
  _deliver(): void {
    const recs = this.takeRecords();
    if (!recs.length) return;
    try {
      this.cb(recs, this);
    } catch (e) {
      report("MutationObserver callback", e);
    }
  }
}

// ------------------------------------------------------------ custom elements

interface CeDef {
  name: string;
  ctor: any;
  observed: string[];
}

const ceRegistry = new Map<string, CeDef>();
const ceWaiting = new Map<string, ((c: any) => void)[]>();
/**
 * The element a custom-element constructor is about to adopt. `super()` in the
 * page's class reaches `Element`'s constructor with no arguments, which is how
 * the real HTMLElement constructor learns which element it is upgrading.
 */
let ceUpgradeTarget: { node: Node; owner: Doc } | null = null;

function ceDefine(name: string, ctor: any, _opts?: unknown): void {
  const n = String(name).toLowerCase();
  if (typeof ctor !== "function") {
    throw new DOMException("define: constructor is not callable", "TypeError");
  }
  if (!n.includes("-")) {
    throw new DOMException(`"${n}" is not a valid custom element name`, "SyntaxError");
  }
  if (ceRegistry.has(n)) {
    throw new DOMException(`"${n}" has already been defined`, "NotSupportedError");
  }
  // Customized built-ins (`{extends: "button"}`) are not implemented: the
  // second argument is accepted and ignored, so `is=` markup stays inert.
  let observed: string[] = [];
  try {
    const list = ctor.observedAttributes;
    if (Array.isArray(list)) observed = list.map((a: unknown) => String(a).toLowerCase());
  } catch (e) {
    report(`observedAttributes ${n}`, e);
  }
  const def: CeDef = { name: n, ctor, observed };
  ceRegistry.set(n, def);
  if (doc) {
    forEachEl(doc.node, (nd) => {
      if (nd.tag === n) ceUpgrade(nd, def);
    });
  }
  for (const r of ceWaiting.get(n) ?? []) r(ctor);
  ceWaiting.delete(n);
}

/**
 * Run the definition's constructor for an existing element. The instance
 * replaces whatever plain `Element` wrapper the page may already hold for this
 * node -- a real browser mutates the object in place, which is not possible
 * here, so a handle taken before `define()` keeps the old prototype.
 */
function ceUpgrade(node: Node, def: CeDef): void {
  if (node._ceDef) return;
  node._ceDef = def;
  const prev = ceUpgradeTarget;
  ceUpgradeTarget = { node, owner: doc };
  try {
    const inst = new def.ctor();
    node._el = inst;
  } catch (e) {
    report(`custom element ${def.name}`, e);
    ceUpgradeTarget = prev;
    return;
  }
  ceUpgradeTarget = prev;
  for (const a of def.observed) {
    if (a in node.attrs) ceAttrChanged(node, a, null);
  }
  if (connected(node)) ceConnectNow(node);
}

function ceConnect(node: Node): void {
  const def = ceRegistry.get(node.tag);
  if (def && !node._ceDef) {
    ceUpgrade(node, def); // upgrading a connected node fires connectedCallback
    return;
  }
  if (node._ceDef) ceConnectNow(node);
}

function ceConnectNow(node: Node): void {
  if (node._ceConnected) return;
  node._ceConnected = true;
  try {
    (node._el as any)?.connectedCallback?.();
  } catch (e) {
    report(`connectedCallback ${node.tag}`, e);
  }
}

function ceDisconnect(node: Node): void {
  if (!node._ceConnected) return;
  node._ceConnected = false;
  try {
    (node._el as any)?.disconnectedCallback?.();
  } catch (e) {
    report(`disconnectedCallback ${node.tag}`, e);
  }
}

function ceAttrChanged(node: Node, name: string, oldValue: string | null): void {
  const def = node._ceDef;
  if (!def || !def.observed.includes(name)) return;
  const nv = name in node.attrs ? node.attrs[name] : null;
  try {
    (node._el as any)?.attributeChangedCallback?.(name, oldValue, nv, null);
  } catch (e) {
    report(`attributeChangedCallback ${node.tag}`, e);
  }
}

const customElementsRegistry = {
  define(name: string, ctor: any, opts?: unknown): void {
    ceDefine(name, ctor, opts);
  },
  get(name: string): any {
    return ceRegistry.get(String(name).toLowerCase())?.ctor;
  },
  getName(ctor: any): string | null {
    for (const d of ceRegistry.values()) if (d.ctor === ctor) return d.name;
    return null;
  },
  upgrade(root: any): void {
    const nd: Node | undefined = root?.node;
    if (!nd) return;
    forEachEl(nd, (el) => {
      const d = ceRegistry.get(el.tag);
      if (d) ceUpgrade(el, d);
    });
  },
  whenDefined(name: string): Promise<any> {
    const n = String(name).toLowerCase();
    const d = ceRegistry.get(n);
    if (d) return Promise.resolve(d.ctor);
    return new Promise((res) => {
      const list = ceWaiting.get(n) ?? [];
      list.push(res);
      ceWaiting.set(n, list);
    });
  },
};

// ------------------------------------------------------------- mutation entry

function setAttr(node: Node, name: string, value: string): void {
  const k = name.toLowerCase();
  const old = k in node.attrs ? node.attrs[k] : null;
  node.attrs[k] = String(value);
  attrChanged(node, k, old);
  dirty();
}

function removeAttr(node: Node, name: string): void {
  const k = name.toLowerCase();
  if (!(k in node.attrs)) return;
  const old = node.attrs[k];
  delete node.attrs[k];
  attrChanged(node, k, old);
  dirty();
}

function attrChanged(node: Node, name: string, oldValue: string | null): void {
  moEnqueue("attributes", node, (o) => {
    if (o.attributeFilter && !o.attributeFilter.includes(name)) return null;
    const rec = baseRecord("attributes", node);
    rec.attributeName = name;
    rec.oldValue = o.attributeOldValue ? oldValue : null;
    return rec;
  });
  ceAttrChanged(node, name, oldValue);
}

function setText(node: Node, v: string): void {
  const old = node.text;
  node.text = String(v);
  moEnqueue("characterData", node, (o) => {
    const rec = baseRecord("characterData", node);
    rec.oldValue = o.characterDataOldValue ? old : null;
    return rec;
  });
  dirty();
}

/**
 * The single childList notification. `runScripts` is false for the fragment
 * parsers (innerHTML and friends), which per spec produce scripts that are
 * already "started" and therefore never execute.
 */
function notifyChildList(
  parent: Node,
  added: Node[],
  removed: Node[],
  prev: Node | null,
  next: Node | null,
): void {
  if (added.length || removed.length) {
    moEnqueue("childList", parent, () => {
      const rec = baseRecord("childList", parent);
      rec.addedNodes = NodeList.from(added, (n: Node) => Element.wrap(n, doc));
      rec.removedNodes = NodeList.from(removed, (n: Node) => Element.wrap(n, doc));
      rec.previousSibling = prev ? Element.wrap(prev, doc) : null;
      rec.nextSibling = next ? Element.wrap(next, doc) : null;
      return rec;
    });
  }
  for (const nd of removed) forEachEl(nd, ceDisconnect);
  for (const nd of added) {
    if (!connected(nd)) continue;
    forEachEl(nd, (el) => {
      ceConnect(el);
      if (el.tag === "script") void runInsertedScript(el);
    });
  }
}

/**
 * Mark every script in a parsed fragment as already started. The HTML fragment
 * parsing algorithm does this so that `el.innerHTML = "<script>...</script>"`
 * inserts inert markup, which is the whole reason that assignment is not an
 * arbitrary-code-execution sink.
 */
function markFragmentScripts(nd: Node): void {
  forEachEl(nd, (el) => {
    if (el.tag === "script") el._started = true;
  });
}

// ------------------------------------------------------------------- document

class Storage {
  #map = new Map<string, string>();
  getItem(k: string): string | null {
    return this.#map.get(String(k)) ?? null;
  }
  setItem(k: string, v: string): void {
    this.#map.set(String(k), String(v));
  }
  removeItem(k: string): void {
    this.#map.delete(String(k));
  }
  clear(): void {
    this.#map.clear();
  }
  key(i: number): string | null {
    return [...this.#map.keys()][i] ?? null;
  }
  get length(): number {
    return this.#map.size;
  }
}

function storageKeys(s: Storage): string[] {
  return Array.from({ length: s.length }, (_v, i) => s.key(i) as string);
}

/**
 * Storage is exposed as a Proxy so `localStorage.foo` is an alias for
 * `getItem("foo")`, as pages assume. The class's own members win over stored
 * keys, matching the browser: a key named "length" is only reachable through
 * getItem.
 */
function makeStorage(): Storage {
  return new Proxy(new Storage(), {
    get(t, k) {
      if (typeof k === "symbol" || k in t) {
        const v = Reflect.get(t, k, t);
        // Bound to the target: a method reached through the proxy would
        // otherwise run with `this` === proxy and lose the private store.
        return typeof v === "function" ? v.bind(t) : v;
      }
      return t.getItem(k) ?? undefined;
    },
    set(t, k, v) {
      if (typeof k === "symbol" || k in t) return Reflect.set(t, k, v, t);
      t.setItem(k, String(v));
      return true;
    },
    has(t, k) {
      return typeof k !== "symbol" && t.getItem(k) !== null ? true : Reflect.has(t, k);
    },
    deleteProperty(t, k) {
      if (typeof k !== "symbol") t.removeItem(k);
      return true;
    },
    ownKeys(t) {
      return storageKeys(t);
    },
    getOwnPropertyDescriptor(t, k) {
      if (typeof k === "symbol") return undefined;
      const v = t.getItem(k);
      return v === null
        ? undefined
        : { value: v, writable: true, enumerable: true, configurable: true };
    },
  });
}

function datasetAttr(k: string): string {
  return `data-${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
}

function datasetKey(attr: string): string {
  return attr.slice(5).replace(/-(\w)/g, (_m, ch) => ch.toUpperCase());
}

/** A live view over the element's `data-*` attributes, writes included. */
function datasetProxy(node: Node): Record<string, string> {
  return new Proxy({} as Record<string, string>, {
    get(_t, k) {
      return typeof k === "symbol" ? undefined : node.attrs[datasetAttr(k)];
    },
    set(_t, k, v) {
      if (typeof k === "symbol") return true;
      setAttr(node, datasetAttr(k), String(v));
      return true;
    },
    has(_t, k) {
      return typeof k !== "symbol" && datasetAttr(k) in node.attrs;
    },
    deleteProperty(_t, k) {
      if (typeof k !== "symbol") removeAttr(node, datasetAttr(k));
      return true;
    },
    ownKeys() {
      return Object.keys(node.attrs).filter((a) => a.startsWith("data-")).map(datasetKey);
    },
    getOwnPropertyDescriptor(_t, k) {
      if (typeof k === "symbol") return undefined;
      const a = datasetAttr(k);
      return a in node.attrs
        ? { value: node.attrs[a], writable: true, enumerable: true, configurable: true }
        : undefined;
    },
  });
}

class Doc extends Element {
  head: Element;
  body: Element;
  documentElement: Element;
  readyState = "loading";
  localStorage = makeStorage();
  sessionStorage = makeStorage();

  constructor(root: Node) {
    super(root, null as unknown as Doc);
    const self = this as unknown as Doc;
    // Claim the root wrapper so an event dispatched at the document reports
    // `document` as its target rather than an anonymous Element around #root.
    root._el = self;
    this.documentElement = Element.wrap(
      queryAll(root, "html")[0] ?? root,
      self,
    );
    this.head = Element.wrap(queryAll(root, "head")[0] ?? root, self);
    this.body = Element.wrap(queryAll(root, "body")[0] ?? root, self);
    this.ownerDoc = self;
  }

  getElementById(id: string): any {
    let found: Node | null = null;
    walk(this.node, (nd) => {
      if (!found && nd.kind === "el" && nd.attrs.id === id) found = nd;
    });
    return found ? Element.wrap(found, this.ownerDoc) : null;
  }
  createElement(tag: string): any {
    const nd = makeNode("el", tag.toLowerCase());
    // A defined name is upgraded at creation, before the element is in the
    // tree, so `document.createElement("x-y")` hands back the page's class.
    const def = ceRegistry.get(nd.tag);
    if (def) {
      ceUpgrade(nd, def);
      if (nd._el) return nd._el;
    }
    return Element.wrap(nd, this.ownerDoc);
  }
  createElementNS(_ns: unknown, tag: string): any {
    return this.createElement(tag);
  }
  createTextNode(text: string): any {
    const t = makeNode("text");
    t.text = String(text);
    return Element.wrap(t, this.ownerDoc);
  }
  createComment(text: string): any {
    const c = makeNode("comment");
    c.text = String(text);
    return Element.wrap(c, this.ownerDoc);
  }
  createDocumentFragment(): any {
    return Element.wrap(makeNode("el", "#fragment"), this.ownerDoc);
  }
  createEvent(): Event {
    return new Event("");
  }
  get cookie(): string {
    return readCookies();
  }
  set cookie(v: string) {
    writeCookie(String(v));
  }
  get domain(): string {
    return locationUrl.hostname;
  }
  get title(): string {
    return this.head.node.children.find((c) => c.tag === "title")
      ?.children[0]?.text ?? "";
  }
  set title(v: string) {
    let t = this.head.node.children.find((c) => c.tag === "title");
    if (!t) {
      t = makeNode("el", "title");
      t.parent = this.head.node;
      this.head.node.children.unshift(t);
    }
    t.children = [];
    const txt = makeNode("text");
    txt.text = String(v);
    txt.parent = t;
    t.children.push(txt);
    line({ t: "title", title: String(v) });
    dirty();
  }
  hasFocus(): boolean {
    return true;
  }
  execCommand(): boolean {
    return false;
  }
  get activeElement(): any {
    return this.body;
  }
}

// ------------------------------------------------------------------- cookies

/**
 * An in-engine cookie jar for this document only.
 *
 * IMPORTANT and not a small caveat: this jar is NOT shared with the Rust-side
 * network stack. Cookies set from JavaScript are never sent on requests made
 * by the renderer or by `fetch`/XHR, and `Set-Cookie` headers coming back from
 * the network are never added here. It is enough for pages that write a value
 * and read it back themselves (consent banners, A/B flags, "seen this" marks)
 * and nothing more -- a login session will not survive it.
 *
 * Domain/Secure/SameSite/HttpOnly attributes are parsed and then ignored,
 * since a single-document jar has no other origin to protect the value from.
 */
interface CookieRec {
  name: string;
  value: string;
  path: string;
  expires: number | null; // epoch ms, null for a session cookie
}

const cookieJar: CookieRec[] = [];

/** The spec's default-path: the request path with its last segment removed. */
function defaultCookiePath(): string {
  const p = locationUrl.pathname;
  if (!p.startsWith("/")) return "/";
  const cut = p.lastIndexOf("/");
  return cut <= 0 ? "/" : p.slice(0, cut);
}

function cookiePathMatches(path: string): boolean {
  const req = locationUrl.pathname || "/";
  if (path === "/" || req === path) return true;
  if (!req.startsWith(path)) return false;
  return path.endsWith("/") || req[path.length] === "/";
}

function readCookies(): string {
  const now = Date.now();
  return cookieJar
    .filter((c) => (c.expires === null || c.expires > now) && cookiePathMatches(c.path))
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
}

function writeCookie(src: string): void {
  const parts = src.split(";");
  const first = parts.shift() ?? "";
  const eq = first.indexOf("=");
  if (eq < 0) return; // a bare token with no "=" sets nothing
  const name = first.slice(0, eq).trim();
  const value = first.slice(eq + 1).trim();
  if (!name) return;

  let path = defaultCookiePath();
  let expires: number | null = null;
  for (const attr of parts) {
    const c = attr.indexOf("=");
    const key = (c < 0 ? attr : attr.slice(0, c)).trim().toLowerCase();
    const av = c < 0 ? "" : attr.slice(c + 1).trim();
    if (key === "path" && av.startsWith("/")) path = av;
    else if (key === "max-age") {
      const secs = Number(av);
      if (Number.isFinite(secs)) expires = Date.now() + secs * 1000;
    } else if (key === "expires" && expires === null) {
      const when = Date.parse(av);
      if (!Number.isNaN(when)) expires = when;
    }
  }

  const at = cookieJar.findIndex((c) => c.name === name && c.path === path);
  // An expiry in the past is how a page deletes a cookie.
  if (expires !== null && expires <= Date.now()) {
    if (at >= 0) cookieJar.splice(at, 1);
    return;
  }
  const rec: CookieRec = { name, value, path, expires };
  if (at >= 0) cookieJar[at] = rec;
  else cookieJar.push(rec);
}

// --------------------------------------------------------------- page globals

function line(obj: unknown): void {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function report(stage: string, e: unknown): void {
  const msg = e instanceof Error ? `${e.message}\n${e.stack ?? ""}` : String(e);
  line({ t: "error", stage, message: msg.slice(0, 4000) });
}

let dirtyScheduled = false;
let lastFlush = 0;
let doc: Doc;
let locationUrl = new URL("about:blank");

function dirty(): void {
  if (dirtyScheduled) return;
  dirtyScheduled = true;
  // Coalesce bursts of mutations; back off when flushes are landing hot so a
  // requestAnimationFrame loop costs at most one reparse per interval.
  setTimeout(flush, Math.max(33, 120 - (Date.now() - lastFlush)));
}

function flush(): void {
  dirtyScheduled = false;
  lastFlush = Date.now();
  line({ t: "html", html: serializeDisplay(doc.node).slice(0, 16_000_000) });
}

function styleProxy(node: Node): CSSStyleDecl {
  return new Proxy(new CSSStyleDecl(node), {
    get(t, k: string) {
      if (k in t) return Reflect.get(t, k, t);
      return t.getPropertyValue(String(k));
    },
    set(t, k: string, v) {
      if (k === "cssText") t.cssText = String(v);
      else t.setProperty(normalizeProp(String(k)), String(v));
      return true;
    },
  }) as CSSStyleDecl;
}

function logLine(level: string, args: unknown[]): void {
  const text = args
    .map((a) => {
      if (typeof a === "string") return a;
      try {
        return JSON.stringify(a) ?? String(a);
      } catch {
        return String(a);
      }
    })
    .join(" ");
  line({ t: "console", level, text: text.slice(0, 2000) });
}

function navigateTo(url: string): void {
  try {
    line({ t: "navigate", url: new URL(url, locationUrl).href });
  } catch (e) {
    report("navigate", e);
  }
}

function installWindowGlobals(): void {
  const w = globalThis as unknown as Record<string, unknown>;

  const location = {
    get href(): string {
      return locationUrl.href;
    },
    set href(v: string) {
      navigateTo(v);
    },
    assign(v: string): void {
      navigateTo(v);
    },
    replace(v: string): void {
      navigateTo(v);
    },
    reload(): void {
      line({ t: "navigate", url: locationUrl.href });
    },
    toString(): string {
      return locationUrl.href;
    },
    get origin(): string {
      return locationUrl.origin;
    },
    get host(): string {
      return locationUrl.host;
    },
    get hostname(): string {
      return locationUrl.hostname;
    },
    get protocol(): string {
      return `${locationUrl.protocol}`;
    },
    get pathname(): string {
      return locationUrl.pathname;
    },
    get search(): string {
      return locationUrl.search;
    },
    get hash(): string {
      return locationUrl.hash;
    },
  };

  const historyObj = {
    pushState(_s: unknown, _t: unknown, url?: string): void {
      if (url) locationUrl = new URL(url, locationUrl);
    },
    replaceState(_s: unknown, _t: unknown, url?: string): void {
      if (url) locationUrl = new URL(url, locationUrl);
    },
    back(): void {},
    forward(): void {},
    go(): void {},
    state: null,
    get length(): number {
      return 1;
    },
    scrollRestoration: "auto",
  };

  const navigator = {
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 BunsenBlitz/0.1",
    appVersion: "5.0 (X11; Linux x86_64) BunsenBlitz/0.1",
    language: "en-US",
    languages: Object.freeze(["en-US", "en"]),
    platform: "Linux x86_64",
    vendor: "",
    hardwareConcurrency: 4,
    maxTouchPoints: 0,
    onLine: true,
    cookieEnabled: true,
    pdfViewerEnabled: false,
    clipboard: {
      writeText: async () => undefined,
      readText: async () => "",
    },
    geolocation: undefined,
    connection: undefined,
    mediaDevices: undefined,
    serviceWorker: undefined,
    getGamepads(): null {
      return null;
    },
    sendBeacon(): boolean {
      return false;
    },
  };

  const RawResponse = Response;
  // Capture Bun's real fetch before we shadow it on globalThis — the page
  // gets a same-origin-resolving wrapper, but it must call the original.
  const rawFetch = globalThis.fetch;
  const fetchImpl: any = async (input: any, init?: any): Promise<any> => {
    const url =
      typeof input === "string"
        ? new URL(input, locationUrl).href
        : input instanceof URL
          ? new URL(input.href, locationUrl).href
          : input?.url
            ? new URL(input.url, locationUrl).href
            : String(input);
    const res = await rawFetch(url, init);
    return {
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
      url: res.url || url,
      redirected: res.redirected,
      type: "basic",
      bodyUsed: false,
      text: () => res.text(),
      json: () => res.json(),
      arrayBuffer: () => res.arrayBuffer(),
      blob: () => res.blob(),
      formData: () => res.formData(),
    };
  };
  fetchImpl.raw = fetch;

  class XMLHttpRequest {
    UNSENT = 0;
    OPENED = 1;
    HEADERS_RECEIVED = 2;
    LOADING = 3;
    DONE = 4;
    readyState = 0;
    status = 0;
    statusText = "";
    responseText = "";
    response = "";
    responseType = "";
    responseURL = "";
    withCredentials = false;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    ontimeout: (() => void) | null = null;
    onprogress: (() => void) | null = null;
    onreadystatechange: (() => void) | null = null;
    #method = "GET";
    #url = "";

    open(method: string, url: string): void {
      this.#method = String(method).toUpperCase();
      this.#url = new URL(url, locationUrl).href;
      this.readyState = 1;
    }
    setRequestHeader(): void {}
    overrideMimeType(): void {}
    send(body?: string): void {
      fetchImpl(this.#url, { method: this.#method, body })
        .then(async (r: any) => {
          this.status = r.status;
          this.responseURL = r.url;
          this.responseText = await r.text();
          this.response =
            this.responseType === "json"
              ? JSON.parse(this.responseText)
              : this.responseText;
          this.readyState = 4;
          this.onload?.();
          this.onreadystatechange?.();
        })
        .catch(() => {
          this.onerror?.();
          this.onreadystatechange?.();
        });
    }
    abort(): void {
      this.onabort?.();
    }
    getAllResponseHeaders(): string {
      return "";
    }
    getResponseHeader(): string | null {
      return null;
    }
    addEventListener(type: string, fn: () => void): void {
      if (type === "load") this.onload = fn;
      if (type === "error") this.onerror = fn;
      if (type === "readystatechange") this.onreadystatechange = fn;
    }
    removeEventListener(): void {}
  }

  const matchMediaResult = () => ({
    matches: false,
    media: "",
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent(): boolean {
      return false;
    },
  });

  Object.assign(w, {
    window: w,
    self: w,
    top: w,
    parent: w,
    frames: w,
    document: doc,
    location,
    history: historyObj,
    navigator,
    XMLHttpRequest,
    fetch: fetchImpl,
    Request,
    Response: class {
      constructor(public body: any, public init: any = {}) {
        void init;
      }
      get ok(): boolean {
        return true;
      }
      get status(): number {
        return 200;
      }
      async text(): Promise<string> {
        return String(this.body ?? "");
      }
      async json(): Promise<unknown> {
        return JSON.parse(String(this.body ?? "null"));
      }
    },
    Headers,
    URL,
    URLSearchParams,
    FormData: class {
      append(): void {}
      get(): null {
        return null;
      }
      entries(): IterableIterator<[never, never]> {
        return [][Symbol.iterator]();
      }
    },
    Blob,
    File: class extends Blob {},
    FileReader: class {
      readAsDataURL(): void {}
      readAsText(): void {}
      get result(): null {
        return null;
      }
    },
    Image: class {
      src = "";
      alt = "";
      width = 0;
      height = 0;
      complete = true;
      naturalWidth = 100;
      naturalHeight = 100;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
    },
    Audio: class {
      src = "";
      play(): Promise<void> {
        return Promise.resolve();
      }
      pause(): void {}
    },
    WebSocket: WebSocket,
    EventSource: class {
      close(): void {}
      set onmessage(_: unknown) {}
      set onopen(_: unknown) {}
      set onerror(_: unknown) {}
    },
    Worker: class {
      postMessage(): void {}
      terminate(): void {}
      set onmessage(_: unknown) {}
      set onerror(_: unknown) {}
    },
    SharedWorker: class {
      port = { postMessage(): void {}, addEventListener(): void {} };
    },
    localStorage: doc.localStorage,
    sessionStorage: doc.sessionStorage,
    screen: {
      width: 1920,
      height: 1080,
      availWidth: 1920,
      availHeight: 1040,
      colorDepth: 24,
      pixelDepth: 24,
      orientation: { type: "landscape-primary", angle: 0 },
    },
    devicePixelRatio: 1,
    visualViewport: { width: 1280, height: 720, scale: 1 },
    innerWidth: 1280,
    innerHeight: 720,
    outerWidth: 1280,
    outerHeight: 780,
    pageXOffset: 0,
    pageYOffset: 0,
    scrollX: 0,
    scrollY: 0,
    screenX: 0,
    screenY: 0,
    scrollTo() {},
    scrollBy() {},
    scroll() {},
    matchMedia: matchMediaResult,
    getComputedStyle(el: any): CSSStyleDecl {
      return el?.node ? styleProxy(el.node) : styleProxy(makeNode("el"));
    },
    requestAnimationFrame(cb: (t: number) => void): number {
      return setTimeout(() => cb(Date.now()), 16) as unknown as number;
    },
    cancelAnimationFrame(id: number): void {
      clearTimeout(id);
    },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    structuredClone,
    btoa,
    atob,
    Event,
    CustomEvent,
    MouseEvent,
    InputEvent,
    KeyboardEvent,
    ErrorEvent: Event,
    PromiseRejectionEvent: Event,
    MessageEvent: class extends Event {
      get data(): unknown {
        return this.init.data;
      }
    },
    CloseEvent: class extends Event {},
    ProgressEvent: class extends Event {},
    StorageEvent: class extends Event {},
    UIEvent: Event,
    FocusEvent: Event,
    WheelEvent: MouseEvent,
    TouchEvent: Event,
    AnimationEvent: Event,
    TransitionEvent: Event,
    DOMException,
    AbortController,
    AbortSignal,
    TextEncoder,
    TextDecoder,
    Node: {
      ELEMENT_NODE: 1,
      TEXT_NODE: 3,
      COMMENT_NODE: 8,
      DOCUMENT_NODE: 9,
      DOCUMENT_FRAGMENT_NODE: 11,
    },
    NodeFilter: { SHOW_ALL: -1, SHOW_ELEMENT: 1, SHOW_TEXT: 4 },
    DocumentFragment: class {},
    ShadowRoot: class {},
    ElementClass: Element,
    Element,
    HTMLElement: Element,
    HTMLHtmlElement: Element,
    HTMLBodyElement: Element,
    HTMLDivElement: Element,
    HTMLSpanElement: Element,
    HTMLInputElement: Element,
    HTMLButtonElement: Element,
    HTMLAnchorElement: Element,
    HTMLImageElement: Element,
    HTMLScriptElement: Element,
    HTMLStyleElement: Element,
    HTMLIFrameElement: Element,
    HTMLCanvasElement: Element,
    SVGElement: Element,
    Text: Text,
    Comment: Comment,
    CharacterData: Element,
    Range: class {
      setStart() {}
      setEnd() {}
      collapse() {}
      selectNodeContents() {}
      getBoundingClientRect(): Record<string, number> {
        return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
      }
      getClientRects(): unknown[] {
        return [];
      }
    },
    Selection: class {},
    getSelection() {
      return {
        rangeCount: 0,
        getRangeAt(): any {
          return null;
        },
        removeAllRanges(): void {},
        addRange(): void {},
        toString(): string {
          return "";
        },
      };
    },
    TreeWalker: class {},
    NodeIterator: class {},
    DOMParser: class {
      parseFromString(html: string): Doc {
        const root = parseHTML(`<body>${html}</body>`);
        const d = new Doc(root);
        d.readyState = "complete";
        return d;
      }
    },
    customElements: customElementsRegistry,
    CustomElementRegistry: class {},
    MutationObserver,
    MutationRecord: class {},
    ResizeObserver: class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
    IntersectionObserver: class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
      takeRecords(): unknown[] {
        return [];
      }
    },
    PerformanceObserver: class {
      observe(): void {}
      disconnect(): void {}
    },
    performance,
    crypto,
    fetchImplUnused: undefined,
    console: {
      assert(c: unknown, ...a: unknown[]): void {
        if (!c) logLine("error", ["assertion failed", ...a]);
      },
      log: (...a: unknown[]) => logLine("log", a),
      info: (...a: unknown[]) => logLine("info", a),
      warn: (...a: unknown[]) => logLine("warn", a),
      error: (...a: unknown[]) => logLine("error", a),
      debug: (...a: unknown[]) => logLine("debug", a),
      trace: (...a: unknown[]) => logLine("trace", a),
      dir: (...a: unknown[]) => logLine("log", a),
      table: (...a: unknown[]) => logLine("log", a),
      group: (...a: unknown[]) => logLine("debug", a),
      groupEnd(): void {},
      time(): void {},
      timeEnd(): void {},
      timeLog(): void {},
      count(): void {},
      countReset(): void {},
      clear(): void {},
    },
    alert: (m: unknown) => logLine("alert", [m]),
    confirm: (m: unknown) => {
      logLine("confirm", [m]);
      return false;
    },
    prompt: (m: unknown) => {
      logLine("prompt", [m]);
      return null;
    },
    print(): void {},
    open: (url?: string) => {
      if (url) navigateTo(url);
      return null;
    },
    close(): void {},
    stop(): void {},
    focus(): void {},
    blur(): void {},
    name: "",
    closed: false,
    status: "",
    origin: locationUrl.origin,
    onbeforeunload: null,
    onunload: null,
    onload: null,
    onerror: null,
    onresize: null,
    onpopstate: null,
    onhashchange: null,
    onmessage: null,
    addEventListener(type: string, fn: any, opts?: unknown): void {
      // `window` has no node of its own; it shares the document's so that a
      // handler registered either way sees the same events.
      addListener(doc.node, type, fn, opts);
    },
    removeEventListener(type: string, fn: any, opts?: unknown): void {
      removeListener(doc.node, type, fn, opts);
    },
    dispatchEvent(ev: any): boolean {
      return doc.dispatchEvent(ev);
    },
  });

  // RawResponse keeps Bun's real Response reachable for anything that needs it.
  void RawResponse;
}

// ---------------------------------------------------------------- script load

/**
 * Every classic script shares one evaluation context.
 *
 * `(0, eval)` gave each <script> its own lexical environment, so a top-level
 * `let`/`const`/`class` in one script was invisible to the next -- the single
 * most confusing difference from a real browser, where scripts share the
 * realm's global lexical environment. `vm.runInThisContext` compiles each
 * script against that shared environment instead, so declarations carry over
 * and a duplicate `let` in a second script is a redeclaration error, both as
 * specified. `var` and function declarations still land on globalThis.
 */
function evalGlobal(code: string, name: string): void {
  vm.runInThisContext(code, { filename: name });
}

async function fetchScriptText(src: string): Promise<string> {
  const res = await fetch(new URL(src, locationUrl).href, {
    signal: AbortSignal.timeout(20_000),
  });
  return res.text();
}

/** The inline source of a script element, however the page supplied it. */
function scriptSource(sc: Node): string {
  if (sc.attrs["#raw"] !== undefined) return sc.attrs["#raw"];
  let out = "";
  walk(sc, (nd) => {
    if (nd.kind === "text") out += nd.text;
  });
  return out;
}

function isExecutableScript(sc: Node): boolean {
  const kind = sc.attrs.type || "text/javascript";
  if (/json|importmap|speculationrules|template/i.test(kind)) return false;
  // `type="module"` is evaluated as a classic script: close enough for the
  // bundled output most sites ship, and wrong for anything using `import`.
  return true;
}

/**
 * Run a script element that has just been inserted into the document --
 * `document.body.appendChild(script)`, the loader pattern half the web uses.
 *
 * Ordering is deliberately loose: an inline script runs synchronously with the
 * insertion (as specified), and a `src` script runs whenever its fetch lands,
 * which makes every external script behave like `async` regardless of the
 * `async`/`defer` attributes. Getting one to run at all is the win here;
 * reproducing the parser-blocking and defer queues is not attempted.
 */
async function runInsertedScript(sc: Node): Promise<void> {
  if (sc._started) return;
  sc._started = true;
  if (!isExecutableScript(sc)) return;
  const src = sc.attrs.src;
  try {
    const code = src ? await fetchScriptText(src) : scriptSource(sc);
    if (code.trim()) evalGlobal(code, src || "inline-script");
    if (src) dispatchOn(sc, new Event("load"), doc);
  } catch (e) {
    report(src ? `script ${src}` : "inline script", e);
    if (src) dispatchOn(sc, new Event("error"), doc);
  }
}

async function runScripts(scripts: Node[]): Promise<void> {
  for (const sc of scripts) {
    if (sc._started) continue; // already run because something inserted it
    sc._started = true;
    if (!isExecutableScript(sc)) continue;
    const src = sc.attrs.src;
    try {
      const code = src ? await fetchScriptText(src) : scriptSource(sc);
      if (!code.trim()) continue;
      evalGlobal(code, src || "inline-script");
    } catch (e) {
      report(src ? `script ${src}` : "inline script", e);
    }
  }
}

function collectScripts(root: Node): Node[] {
  const out: Node[] = [];
  walk(root, (nd) => {
    if (nd.kind === "el" && nd.tag === "script") out.push(nd);
  });
  return out;
}

// ---------------------------------------------------------------------- main

process.on("uncaughtException", (e) => report("uncaught", e));
process.on("unhandledRejection", (e) => report("rejection", e));

let pendingInput = "";

void (async () => {
  const reader = Bun.stdin.stream().getReader();
  const decoder = new TextDecoder();
  let lastLineSeen = Date.now();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    lastLineSeen = Date.now();
    pendingInput += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = pendingInput.indexOf("\n")) >= 0) {
      const raw = pendingInput.slice(0, nl);
      pendingInput = pendingInput.slice(nl + 1);
      if (!raw.trim()) continue;
      try {
        handleMessage(JSON.parse(raw));
      } catch (e) {
        report("stdin", e);
      }
    }
  }
  // EOF on stdin means the renderer is gone. Nothing can consume what this
  // process produces any more, so staying alive only leaks: a killed test run
  // used to leave engines resident for half an hour, and enough of them piled
  // up to make page loads miss their deadlines.
  //
  // A short grace period lets an in-flight microtask finish and its output
  // drain before exit; there is no reason to wait longer than that, because
  // nobody is listening.
  const grace = setTimeout(() => process.exit(0), 2_000);
  // Do not hold the loop open on account of the timer itself.
  grace.unref?.();
})().catch((e) => report("stdin-loop", e));

function handleMessage(msg: any): void {
  switch (msg.op) {
    case "load": {
      ourTabId = Number(msg.tab ?? 0);
      locationUrl = safeURL(msg.url);
      const parsed = parseHTML(String(msg.html ?? ""));
      doc = new Doc(parsed);
      installWindowGlobals();
      doc.readyState = "interactive";
      line({ t: "ready" });

      const scripts = collectScripts(parsed);
      void (async () => {
        await runScripts(scripts);
        // "interactive" is what a browser reports while DOMContentLoaded runs;
        // frameworks branch on it to decide whether to defer their own boot.
        fireRootEvent("DOMContentLoaded");
        doc.readyState = "complete";
        fireRootEvent("readystatechange");
        fireRootEvent("load");
        dirty(); // snapshot whatever boot scripts changed
      })().catch((e) => report("boot", e));
      return;
    }
    case "inject": {
      for (const item of msg.items ?? []) {
        try {
          (0, eval)(makeContentSandbox(item.ext, item.code));
        } catch (e) {
          report(`content script ${item.ext}`, e);
        }
      }
      dirty();
      return;
    }
    case "page": {
      deliverPageMessage(msg.payload);
      return;
    }
  }
}

function safeURL(raw: unknown): URL {
  try {
    return new URL(String(raw));
  } catch {
    return new URL("about:blank");
  }
}

function fireRootEvent(type: string): void {
  try {
    doc.dispatchEvent(new Event(type));
  } catch (e) {
    report(`${type} listener`, e);
  }
}

// --------------------------------------------------- content-script plumbing

interface ExtBridge {
  sendMessage(msg: unknown): Promise<unknown>;
  onMessage(fn: (msg: unknown, sender: unknown) => void): void;
  getURL(path: string): string;
}

const extBridges = new Map<string, ExtBridge>();
const extListeners = new Map<string, ((msg: unknown, sender: unknown) => void)[]>();

function bridgeFor(ext: string): ExtBridge {
  let b = extBridges.get(ext);
  if (!b) {
    b = {
      sendMessage(msg: unknown): Promise<unknown> {
        return new Promise((resolveMsg) => {
          const ticket = `m${Math.random().toString(36).slice(2)}`;
          pendingReplies.set(ticket, resolveMsg);
          line({
            t: "page",
            payload: { kind: "sendMessage", ext, ticket, senderTab: ourTabId, message: msg },
          });
        });
      },
      onMessage(fn: (msg: unknown, sender: unknown) => void): void {
        (extListeners.get(ext) ?? extListeners.set(ext, []).get(ext)!).push(fn);
      },
      getURL(path: string): string {
        return `bunsen-extension://${ext}/${String(path).replace(/^\//, "")}`;
      },
    };
    extBridges.set(ext, b);
  }
  return b;
}

const pendingReplies = new Map<string, (v: unknown) => void>();
let ourTabId = 0;

function makeContentSandbox(ext: string, code: string): string {
  // Evaluated fresh per content script: they share the page DOM, but each
  // sees its own `chrome` bound to its own extension id.
  return `
    const bridge = __bunsenBridge(${JSON.stringify(ext)});
    const chrome = {
      runtime: bridge,
      storage: {
        local: {
          get: (keys) => __bunsenCall(${JSON.stringify(ext)}, "storage.local.get", keys),
          set: (items) => __bunsenCall(${JSON.stringify(ext)}, "storage.local.set", items),
          remove: (keys) => __bunsenCall(${JSON.stringify(ext)}, "storage.local.remove", keys),
          clear: () => __bunsenCall(${JSON.stringify(ext)}, "storage.local.clear", null),
        },
      },
      i18n: { getMessage: () => "" },
    };
    const browser = { runtime: bridge };
    (function(){ ${code}
    })();
  `;
}

(globalThis as any).__bunsenBridge = (ext: string) => bridgeFor(ext);
(globalThis as any).__bunsenCall = async (ext: string, method: string, params: unknown) => {
  return new Promise((resolveCall, rejectCall) => {
    const ticket = `c${Math.random().toString(36).slice(2)}`;
    pendingReplies.set(ticket, (v: any) =>
      v && typeof v === "object" && "error" in (v as any)
        ? rejectCall(new Error(String((v as any).error)))
        : resolveCall(v),
    );
    line({
      t: "page",
      payload: { kind: "api", ext, ticket, method, params },
    });
  });
};

function deliverPageMessage(payload: any): void {
  if (!payload || typeof payload !== "object") return;
  if (payload.ticket && pendingReplies.has(payload.ticket)) {
    const r = pendingReplies.get(payload.ticket)!;
    pendingReplies.delete(payload.ticket);
    r(payload.value);
    return;
  }
  // A message pushed from the background side to this content context.
  for (const fn of extListeners.get(payload.ext) ?? []) {
    try {
      fn(payload.message, { tab: { id: ourTabId } });
    } catch (e) {
      report("onMessage", e);
    }
  }
}
