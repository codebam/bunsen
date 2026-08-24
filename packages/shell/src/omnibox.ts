// SPDX-License-Identifier: MIT OR Apache-2.0
/** Turn whatever was typed into something navigable. */

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
// `localhost:3000` looks exactly like a scheme. Anything whose colon is
// followed only by digits is a port.
const HOST_PORT = /^[a-z0-9.-]+:\d+(\/.*)?$/i;
// A bare host: at least one dot, no spaces, optional port/path.
const HOSTISH = /^[^\s/]+\.[^\s/]{2,}(:\d+)?(\/.*)?$/;

export function resolve(input: string): string {
  const text = input.trim();
  if (!text) return "about:blank";
  if (text === "localhost" || /^localhost[:/]/.test(text)) return `http://${text}`;
  if (HOST_PORT.test(text)) return `https://${text}`;
  if (SCHEME.test(text)) return text;
  if (HOSTISH.test(text)) return `https://${text}`;
  return `https://duckduckgo.com/?q=${encodeURIComponent(text)}`;
}
