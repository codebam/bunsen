// SPDX-License-Identifier: MIT OR Apache-2.0
/** Turn whatever was typed into something navigable. */

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
// A bare host: at least one dot, no spaces, optional port/path.
const HOSTISH = /^[^\s/]+\.[^\s/]{2,}(:\d+)?(\/.*)?$/;

export function resolve(input: string): string {
  const text = input.trim();
  if (!text) return "about:blank";
  if (SCHEME.test(text)) return text;
  if (text === "localhost" || text.startsWith("localhost:")) return `http://${text}`;
  if (HOSTISH.test(text)) return `https://${text}`;
  return `https://duckduckgo.com/?q=${encodeURIComponent(text)}`;
}
