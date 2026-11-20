// Lists that can grow without bound (activity, members, what needs you) scroll inside their panel instead of
// growing the page: the panel is capped (CSS .is-capped), its header and footer stay put, the body scrolls on its
// own (keyboard-focusable region; at its ends the page scrolls on), the edges fade when there's more to see, and items that
// arrive while you're scrolled away show a "N new" pill that takes you to them.
import { h, reducedMotion } from "./dom.js";
import { icon } from "./art.js";

/**
 * Wrap `body` (an element you keep filling) in a scroll area. Place `area.el` where `body` would have gone.
 * After each redraw call `area.track(items)` with [{key, el}] in display order.
 *   cap: "panel" (cap the enclosing .panel, body takes the rest) | "list" (cap just this list)
 *   newestFirst: new items arrive at the top (only items above the previous first one count as new)
 */
export function scrollArea(body, { label, cap = "panel", newestFirst = false } = {}) {
  body.classList.add("scroll-body");
  body.tabIndex = 0;
  body.setAttribute("role", "region");
  body.setAttribute("aria-label", label);
  const count = h("span", { class: "new-pill-count" });
  const pill = h("button", { type: "button", class: "new-pill", hidden: true }, icon("arrowUp", { size: 16 }), count);
  const el = h("div", { class: ["scroll-area", `cap-${cap}`] }, pill, body);
  let known = null; // Set of keys seen so far (null before the first draw)
  let pending = []; // elements that arrived while scrolled away
  let wasScrollable = false;

  const atTop = () => body.scrollTop <= 4;
  const fades = () => {
    const more = body.scrollHeight - body.clientHeight > 2;
    el.classList.toggle("fade-top", more && !atTop());
    el.classList.toggle("fade-bottom", more && body.scrollTop + body.clientHeight < body.scrollHeight - 4);
    if (more !== wasScrollable) { wasScrollable = more; body.tabIndex = more ? 0 : -1; }
  };
  const seenPending = () => {
    if (!pending.length) return;
    const top = body.getBoundingClientRect().top;
    pending = pending.filter((x) => x.isConnected && x.getBoundingClientRect().bottom < top + 4);
    if (!pending.length) pill.hidden = true;
    else count.textContent = `${pending.length} new`;
  };
  body.addEventListener("scroll", () => { fades(); if (atTop() && newestFirst) { pending = []; pill.hidden = true; } else seenPending(); }, { passive: true });
  pill.addEventListener("click", () => {
    const first = pending.find((x) => x.isConnected);
    const behavior = reducedMotion() ? "auto" : "smooth";
    if (newestFirst || !first) body.scrollTo({ top: 0, behavior });
    else body.scrollTo({ top: first.offsetTop - body.offsetTop - 8, behavior });
    pending = []; pill.hidden = true;
    (first || body).focus?.({ preventScroll: true });
  });
  if (typeof ResizeObserver === "function") new ResizeObserver(fades).observe(body);

  function track(items) {
    const keys = items.map((x) => x.key);
    if (known) {
      let fresh;
      if (newestFirst) {
        const firstOld = keys.findIndex((k) => known.has(k));
        fresh = items.slice(0, firstOld < 0 ? items.length : firstOld);
      } else fresh = items.filter((x) => !known.has(x.key));
      // Re-rendered elements replace old ones: keep pending pointed at the live nodes.
      const live = new Map(items.map((x) => [x.key, x.el]));
      pending = pending.map((p) => live.get(p.dataset.scrollKey)).filter(Boolean);
      const away = newestFirst ? !atTop() : body.scrollTop + body.clientHeight < body.scrollHeight - 4;
      if (fresh.length && away) pending.push(...fresh.map((x) => x.el));
      for (const x of items) x.el.dataset.scrollKey = x.key;
      if (pending.length) { count.textContent = `${pending.length} new`; pill.hidden = false; }
      else pill.hidden = true;
    } else for (const x of items) x.el.dataset.scrollKey = x.key;
    known = new Set(keys);
    requestAnimationFrame(fades);
  }

  return { el, body, track };
}

/** Stable keys for a list whose items may repeat (same text): text + occurrence number, counted from the
 * oldest end (fromEnd for newest-first lists) so a new look-alike item never renames the old ones. */
export function keyed(els, keyOf, { fromEnd = false } = {}) {
  const seen = new Map();
  const order = fromEnd ? [...els].reverse() : els;
  const out = order.map((el) => {
    const base = keyOf(el);
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    return { key: `${base}#${n}`, el };
  });
  return fromEnd ? out.reverse() : out;
}

/** Key for a "What needs you" card (kind + the request/subject it's about). */
export const needKey = (el) => `${el.dataset.need}|${el.getAttribute("aria-labelledby") || el.querySelector(".need-title")?.textContent || ""}`;
