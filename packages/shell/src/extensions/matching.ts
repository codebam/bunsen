// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * WebExtension match patterns.
 *
 * These decide what an extension is allowed to touch, so getting them subtly
 * wrong is a security bug rather than a formatting one. The rules are from
 * the WebExtensions spec: `<scheme>://<host><path>`, where the scheme may be
 * `*` (meaning http or https only, never file:), the host may lead with `*.`
 * to mean "this domain or any subdomain", and the path is a glob where `*`
 * matches any run of characters.
 *
 * `<all_urls>` is accepted as a whole-pattern special case.
 */

const SCHEMES = ["http", "https", "file", "ftp", "ws", "wss", "data"];
/** A bare `*` scheme means web schemes only. Notably not file:. */
const WILDCARD_SCHEMES = ["http", "https", "ws", "wss"];

export interface MatchPattern {
  readonly source: string;
  matches(url: string): boolean;
}

class AllUrls implements MatchPattern {
  readonly source = "<all_urls>";
  matches(url: string): boolean {
    try {
      return SCHEMES.includes(new URL(url).protocol.replace(":", ""));
    } catch {
      return false;
    }
  }
}

class Pattern implements MatchPattern {
  constructor(
    readonly source: string,
    private schemes: string[],
    private host: string | null,
    private anySubdomain: boolean,
    private path: RegExp,
  ) {}

  matches(url: string): boolean {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }

    const scheme = parsed.protocol.replace(":", "");
    if (!this.schemes.includes(scheme)) return false;

    if (this.host !== null) {
      const host = parsed.hostname.toLowerCase();
      const ok = this.anySubdomain
        ? host === this.host || host.endsWith(`.${this.host}`)
        : host === this.host;
      if (!ok) return false;
    }

    return this.path.test(parsed.pathname + parsed.search);
  }
}

export function parseMatchPattern(pattern: string): MatchPattern | null {
  if (pattern === "<all_urls>") return new AllUrls();

  const split = pattern.indexOf("://");
  if (split < 1) return null;

  const rawScheme = pattern.slice(0, split).toLowerCase();
  const schemes =
    rawScheme === "*" ? WILDCARD_SCHEMES : SCHEMES.includes(rawScheme) ? [rawScheme] : null;
  if (!schemes) return null;

  const rest = pattern.slice(split + 3);
  const slash = rest.indexOf("/");
  // A pattern must have a path. "https://example.com" is not valid.
  if (slash < 0) return null;

  const rawHost = rest.slice(0, slash).toLowerCase();
  const rawPath = rest.slice(slash);

  let host: string | null;
  let anySubdomain = false;
  if (rawHost === "*") {
    host = null;
  } else if (rawHost.startsWith("*.")) {
    host = rawHost.slice(2);
    anySubdomain = true;
    // "*." on its own, or a host that still contains a wildcard, is invalid.
    if (!host || host.includes("*")) return null;
  } else if (rawHost.includes("*")) {
    return null;
  } else {
    host = rawHost;
    // file: URLs have no host; everything else needs one.
    if (!host && !schemes.includes("file")) return null;
    if (!host) host = null;
  }

  return new Pattern(pattern, schemes, host, anySubdomain, globToRegExp(rawPath));
}

/** `*` matches any run of characters, including none. Nothing else is special. */
function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

/** A set of patterns, matched as a union. */
export class MatchSet {
  #patterns: MatchPattern[];
  /** Patterns that were not valid, kept so the loader can complain about them. */
  readonly invalid: string[];

  constructor(patterns: string[]) {
    this.#patterns = [];
    this.invalid = [];
    for (const p of patterns) {
      const parsed = parseMatchPattern(p);
      if (parsed) this.#patterns.push(parsed);
      else this.invalid.push(p);
    }
  }

  get size(): number {
    return this.#patterns.length;
  }

  /**
   * The patterns as written. The renderer does its own matching against the
   * page URL, so it needs the source strings rather than our compiled form.
   */
  get sources(): string[] {
    return this.#patterns.map((p) => p.source);
  }

  matches(url: string): boolean {
    return this.#patterns.some((p) => p.matches(url));
  }
}
