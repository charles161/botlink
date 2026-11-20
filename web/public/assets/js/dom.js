// Tiny DOM helpers. Everything user- or agent-supplied goes in as text nodes, never as HTML.

const SVG_NS = "http://www.w3.org/2000/svg";

function apply(el, props) {
  if (!props) return el;
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.setAttribute("class", Array.isArray(v) ? v.filter(Boolean).join(" ") : v);
    else if (k === "on") for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k === "style" && typeof v === "object") for (const [p, val] of Object.entries(v)) el.style.setProperty(p, val);
    else if (k === "text") el.textContent = v;
    else if (k in el && !(el instanceof SVGElement) && typeof v !== "string") el[k] = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  return el;
}
function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false || c === "") continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
const isProps = (p) => p && typeof p === "object" && !(p instanceof Node) && !Array.isArray(p);

/** h("div", {class:"x", on:{click}}, "text", child) */
export function h(tag, props, ...children) {
  if (!isProps(props)) { children.unshift(props); props = null; }
  return append(apply(document.createElement(tag), props), children);
}
export function s(tag, props, ...children) {
  if (!isProps(props)) { children.unshift(props); props = null; }
  return append(apply(document.createElementNS(SVG_NS, tag), props), children);
}
export const frag = (...children) => append(document.createDocumentFragment(), children);
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const clear = (el) => { while (el.firstChild) el.firstChild.remove(); return el; };
/** Replace el's children (arrays, null and false are handled like h() children). */
export const fill = (el, ...children) => append(clear(el), children);

/** Calm disclosure: the proof (keys, fingerprints, fine print) for people who want to verify; closed by default. */
export const details = (summary, ...kids) => h("details", { class: "more" }, h("summary", null, summary), h("div", { class: "more-body" }, kids));

export const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

// ── time ────────────────────────────────────────────────────────────────────
export function ago(iso, now = Date.now()) {
  const t = typeof iso === "number" ? iso : Date.parse(iso);
  const s = Math.round((now - t) / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const hr = Math.round(m / 60);
  if (hr < 24) return `${hr} h ago`;
  const d = Math.round(hr / 24);
  if (d < 7) return d === 1 ? "yesterday" : `${d} days ago`;
  return new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}
export function until(iso, now = Date.now()) {
  const s = Math.round((Date.parse(iso) - now) / 1000);
  if (s <= 0) return null;
  const m = Math.round(s / 60);
  if (m < 1) return "under a minute";
  if (m < 60) return `${m} min`;
  const hr = Math.round(m / 60);
  if (hr < 48) return `${hr} h`;
  return `${Math.round(hr / 24)} days`;
}
export const absTime = (iso) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

// ── toasts (polite live region) ──────────────────────────────────────────────
let toastHost;
export function toast(msg, kind = "info", ms = 3200) {
  if (!toastHost) {
    toastHost = h("div", { class: "toasts", role: "status", "aria-live": "polite" });
    document.body.append(toastHost);
  }
  // Never stack more than two: the newest message wins.
  while (toastHost.childElementCount >= 2) toastHost.firstElementChild.remove();
  const t = h("div", { class: ["toast", `toast-${kind}`] }, msg);
  toastHost.append(t);
  requestAnimationFrame(() => t.classList.add("in"));
  setTimeout(() => { t.classList.remove("in"); t.classList.add("out"); setTimeout(() => t.remove(), 400); }, ms);
}

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {
    const ta = h("textarea", { class: "sr-only", "aria-hidden": "true" });
    ta.value = text; document.body.append(ta); ta.select();
    let ok = false; try { ok = document.execCommand("copy"); } catch { /* ignore */ }
    ta.remove(); return ok;
  }
}
