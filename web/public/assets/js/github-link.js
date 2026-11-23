// The header's GitHub link: the mark and "GitHub", to the repository the server names (BOTLINK_SOURCE_URL,
// source-link.js), in a new tab. No setting: no link. The star count comes from the server (GET /site/github.json,
// server/internal/pages/github_stars.go), which leaves it out under 50 and on any failure; shown only when present.
import { h } from "./dom.js";
import { githubMark } from "./art.js";
import { sourceURL } from "./source-link.js";

/** 1234 → "1.2k" from 1000 up (rounded down, never more than the real count); the number itself below. */
export const starText = (n) => (n >= 1000 ? `${(Math.floor(n / 100) / 10).toFixed(1).replace(/\.0$/, "")}k` : String(n));

let stars = null;
let asked = false;
function askStars() {
  if (asked) return;
  asked = true;
  fetch("/site/github.json", { credentials: "omit", headers: { Accept: "application/json" } })
    .then((r) => (r.ok ? r.json() : {}))
    .then((j) => {
      if (!Number.isSafeInteger(j?.stars) || j.stars < 50) return;
      stars = j.stars;
      document.querySelectorAll("[data-github-link]").forEach(withCount);
    })
    .catch(() => {});
}

const NEW_TAB = "opens in a new tab";
function withCount(a) {
  if (stars === null || a.querySelector(".gh-stars")) return a;
  a.append(h("span", { class: "gh-stars" }, starText(stars)));
  a.setAttribute("aria-label", `GitHub, ${starText(stars)} stars (${NEW_TAB})`);
  return a;
}

/** The link element, or null when the server names no repository. */
export function githubLink() {
  const u = sourceURL();
  if (!u) return null;
  askStars();
  return withCount(h("a", { href: u, class: "nav-link gh-link", target: "_blank", rel: "noopener noreferrer", "data-native": "", "data-github-link": "", "aria-label": `GitHub (${NEW_TAB})` },
    githubMark(), h("span", { class: "gh-label" }, "GitHub")));
}
