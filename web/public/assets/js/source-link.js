// "Self-host it": a link to the public repository, shown only when the server names one (BOTLINK_SOURCE_URL, injected
// as <meta name="botlink-source-url">; server/internal/pages/source.go). No meta, or anything but a repository address
// on github.com over https (FORM): no link. A plain external link that makes no claim about the code.
import { h } from "./dom.js";

const FORM = /^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;

export function sourceURL() {
  const u = document.querySelector('meta[name="botlink-source-url"]')?.getAttribute("content") || "";
  return FORM.test(u) ? u : "";
}

/** The link element, or null when the server names no repository. */
export function sourceLink(cls, ...before) {
  const u = sourceURL();
  return u ? h("a", { href: u, class: cls, rel: "noopener noreferrer", "data-native": "", "data-source-link": "" }, ...before, "Self-host it") : null;
}
