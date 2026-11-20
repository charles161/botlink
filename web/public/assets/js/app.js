// bot-link dashboard: boot, session + device key, router, layout, live updates.
import { h, $, clear, toast, reducedMotion, fill } from "./dom.js";
import { get, post, setCsrf, setUnauthenticatedHandler, errorText } from "./api.js";
import { loadDevice, createDevice, forgetDevice, deviceLabel, ed25519Supported } from "./crypto.js";
import { icon, logo, logoMark, avatar } from "./art.js";
import "./recovery.js"; // the passkey-reset and removed-browser banner on every signed-in page
import "./notify.js"; // requests to join: a card on every page, the count in the tab title, browser notifications
import "./deletebanner.js"; // a waiting account delete, on every signed-in page
import { hostRoute } from "./hosts.js"; // which host owns a path: the server's host table
import { PAID_TEXT } from "./paid-text.js";

// ── theme (auto, with a remembered override) ────────────────────────────────
const THEME_KEY = "botlink-theme";
function applyTheme(t) {
  if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
  const dark = t === "dark" || (t !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
  $('meta[name="theme-color"]')?.setAttribute("content", dark ? "#0e1c1d" : "#f6f2e8");
}
const storedTheme = () => { try { return localStorage.getItem(THEME_KEY); } catch { return null; } };
applyTheme(storedTheme());
function toggleTheme() {
  const next = themeIsDark() ? "light" : "dark";
  try { localStorage.setItem(THEME_KEY, next); } catch { /* private mode: this page only */ }
  applyTheme(next);
}
// Following the system (no remembered choice): keep the toggle's icon and theme-color in step with it.
matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => { if (!storedTheme()) { applyTheme(null); renderNav(); } });

// ── which host this page is on ──────────────────────────────────────────────
// With a separate public site, the server names the host in three meta tags. "site": the landing page and the docs,
// never signed in. "app": the product; its "/" is the rooms list, or the sign-in page when signed out. A path the
// other host owns (the host table, ./hosts.js) loads there by its full address. No tags (one host serves everything,
// as in development): nothing here applies.
const hostMeta = (n) => document.querySelector(`meta[name="${n}"]`)?.getAttribute("content") || "";
export const HOST = hostMeta("botlink-host");
export const APP_ORIGIN = hostMeta("botlink-app-origin");
export const SITE_ORIGIN = hostMeta("botlink-site-origin");
export const onSite = HOST === "site" && !!APP_ORIGIN;
const onApp = HOST === "app" && !!SITE_ORIGIN;
const oneHost = !onSite && !onApp;   // one host serves the site and the app (staging, development)
const ownerOf = (p) => hostRoute(p)?.owner || "";
/** The origin that serves path p when it is not this page's host ("" = this host). */
const hostFor = (p) => (onSite && ownerOf(p) === "app" ? APP_ORIGIN : onApp && ownerOf(p) === "site" ? SITE_ORIGIN : "");
// The staging server lives on test.botlink.dev (deploy/STAGING.md): a mark in the header so nobody takes it for the real one.
const STAGING = /^test[.-]/.test(location.hostname);

// ── app state ───────────────────────────────────────────────────────────────
export const app = {
  me: null,            // AppMe or null
  device: null,        // {id, pk, label, keyPair} from IndexedDB
  cryptoOk: true,      // WebCrypto Ed25519 available
  needs: null,         // NeedsYou
  listeners: new Set(),
};
const emit = () => app.listeners.forEach((fn) => { try { fn(); } catch (e) { console.warn(e); } });
/** Plans, credits and billing exist only when the server says so (BOTLINK_PAYWALL, default off). */
export const paywallOn = () => app.me?.paywall === true;
export const onChange = (fn) => { app.listeners.add(fn); return () => app.listeners.delete(fn); };

// A non-secret hint that this browser probably has a session, so signed-out visitors to open pages
// don't trigger a 401 (and a console error) on every load. The cookie itself stays HttpOnly.
const HINT = "botlink-session-hint";
export const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* private mode */ } },
};
export const markSignedIn = () => store.set(HINT, "1");

export async function loadMe() {
  if (onSite) { app.me = null; return null; }   // /app/v1 is not on the site host
  const dev = app.device;
  try {
    app.me = await get(`/app/v1/me${dev ? `?device_id=${dev.id}` : ""}`, { quiet401: true });
    setCsrf(app.me.csrf_token);
    markSignedIn();
  } catch (e) {
    if (e.status === 401) { app.me = null; setCsrf(null); store.set(HINT, null); } else throw e;
  }
  return app.me;
}

/** Make sure this browser has a registered device key (ENVELOPE §1, SPEC §4.2). */
export async function ensureDevice() {
  if (!app.me || !app.cryptoOk) return app.device;
  let dev = app.device || await loadDevice();
  if (!dev) dev = await createDevice(deviceLabel());
  app.device = dev;
  if (!app.me.device || app.me.device.id !== dev.id) {
    try {
      await post("/app/v1/devices", { id: dev.id, ed25519_pk: dev.pk, label: dev.label });
    } catch (e) {
      if (e.code === "id_conflict" || e.code === "key_in_use") {
        // Stale local key that the server knows differently: start over with a fresh key.
        await forgetDevice();
        dev = await createDevice(deviceLabel());
        app.device = dev;
        await post("/app/v1/devices", { id: dev.id, ed25519_pk: dev.pk, label: dev.label });
      } else throw e;
    }
    await loadMe();
  }
  return dev;
}

export async function refreshNeeds() {
  if (!app.me) { app.needs = null; return null; }
  try { app.needs = await get("/app/v1/needs-you"); } catch (e) { if (e.status !== 401) console.warn(e); }
  emit();
  return app.needs;
}
export const needsCount = () => !app.needs ? 0 : app.needs.join_requests.length + app.needs.person_requests.length + app.needs.attention.length + (app.needs.event_urls?.length || 0);

/** True when this browser may sign for rooms (certified somewhere, or has no rooms yet). */
export const browserUncertified = () => !!(app.me?.device && app.me.device.certified_rooms === 0 && app.me.device.pending_rooms > 0);

// ── router ──────────────────────────────────────────────────────────────────
const routes = [
  { re: /^\/$/, load: () => import("./views/landing.js"), name: "landing" },
  { re: /^\/login\/?$/, load: () => import("./views/login.js"), name: "login" },
  { re: /^\/rooms\/?$/, load: () => import("./views/rooms.js"), auth: true, name: "rooms" },
  { re: /^\/new\/?$/, load: () => import("./views/new-room.js"), auth: true, name: "new" },
  { re: /^\/rooms\/([0-9a-f-]{36})\/?$/, load: () => import("./views/room.js"), auth: true, name: "room", keys: ["id"] },
  { re: /^\/p\/([23456789A-Za-z]{16})\/?$/, load: () => import("./views/person-invite.js"), name: "person-invite", keys: ["code"] },
  { re: /^\/devices\/?$/, load: () => import("./views/devices.js"), auth: true, name: "devices" },
  { re: /^\/help\/lost-passkey\/?$/, load: () => import("./views/help-lost.js"), name: "help-lost" },
  { re: /^\/docs\/?$/, load: () => import("./views/docs.js"), name: "docs" },
  { re: /^\/admin\/?$/, load: () => import("./views/admin.js"), auth: true, name: "admin" },
  { re: /^\/approve\/([0-9a-f-]{36})\/?$/, load: () => import("./views/approve.js"), auth: true, name: "approve", keys: ["id"] },
  { re: /^\/create\/([0-9a-f-]{36})\/?$/, load: () => import("./views/create.js"), auth: true, name: "create", keys: ["id"] },
  { re: /^\/approve-url\/([0-9a-f-]{36})\/?$/, load: () => import("./views/approve-url.js"), auth: true, name: "approve-url", keys: ["id"] },
  { re: /^\/usage\/?$/, load: () => import("./views/usage.js"), auth: true, name: "usage", paid: true },
  { re: /^\/billing(\/fake(\/portal)?)?\/?$/, load: () => import("./views/billing.js"), auth: true, name: "billing", paid: true },
  { re: /^\/account\/?$/, load: () => import("./views/account.js"), auth: true, name: "account" },
];
// "/" signed in is the rooms list. Signed out: the sign-in page on the app host; the landing page on the site host and
// on one host (sign-in is one click away there). The address stays "/".
const home = () => (app.me ? "/rooms" : onApp ? "/login" : "/");
// a paid page (usage, billing) is no route at all while the server says the paywall is off
const routeFor = (p) => routes.find((r) => r.re.test(p === "/" && (onApp || oneHost) ? home() : p) && !(r.paid && app.me && !paywallOn()));
let current = null;   // {view, cleanup, refresh}
export const refreshView = () => { renderNav(); current?.refresh?.(); }; // after refreshNeeds() outside the event stream
let navToken = 0;
let rendered = false;

export function navigate(to, { replace = false } = {}) {
  const url = new URL(to, location.origin);
  if (url.origin !== location.origin) { location.href = to; return; }
  if (hostFor(url.pathname)) { location.href = hostFor(url.pathname) + url.pathname + url.search + url.hash; return; }
  if (replace) history.replaceState({}, "", url.pathname + url.search + url.hash);
  else history.pushState({}, "", url.pathname + url.search + url.hash);
  render();
}
export const loginUrl = (returnTo = location.pathname + location.search) => `${hostFor("/login")}/login?return_to=${encodeURIComponent(onSite && ownerOf(new URL(returnTo, location.origin).pathname) !== "app" ? "/rooms" : returnTo)}`;

function loadingView(name = "page") {
  const card = () => h("div", { class: "route-sk-card" },
    h("span", { class: "sk route-sk-art" }),
    h("span", { class: "sk sk-line w60" }),
    h("span", { class: "sk sk-line w80" }));
  return h("section", { class: ["page", "route-loading", `route-loading-${name}`], "aria-label": "Loading page" },
    h("p", { class: "sr-only", role: "status" }, "Loading…"),
    h("div", { class: "route-sk-head", "aria-hidden": "true" },
      h("span", { class: "sk route-sk-title" }),
      h("span", { class: "sk sk-line w60" })),
    h("div", { class: "route-sk-grid", "aria-hidden": "true" }, card(), card(), card()));
}

async function render() {
  const token = ++navToken;
  const path = location.pathname;
  const route = routeFor(path);
  const params = {};
  if (route?.keys) { const m = route.re.exec(path); route.keys.forEach((k, i) => { params[k] = m[i + 1]; }); }
  if (route?.auth && !app.me) { navigate(loginUrl(), { replace: true }); return; }

  const main = $("#main");
  const progress = $("#progress");
  const slow = setTimeout(() => {
    progress.classList.add("on");
    if (!main.childElementCount) {
      main.setAttribute("aria-busy", "true");
      fill(main, loadingView(route?.name || "not-found"));
    }
  }, 120);
  let result;
  try {
    const mod = route ? await route.load() : await import("./views/not-found.js");
    result = await mod.default({ params, query: new URLSearchParams(location.search), app });
  } catch (e) {
    console.error(e);
    const mod = await import("./views/not-found.js");
    result = await mod.default({ params, error: e, app });
  } finally {
    clearTimeout(slow);
    progress.classList.remove("on");
  }
  if (token !== navToken) { result?.cleanup?.(); return; }

  const swap = () => {
    current?.cleanup?.();
    current = result;
    main.removeAttribute("aria-busy");
    fill(main, result.el);
    document.body.dataset.route = route?.name || "not-found";
    document.title = result.title ? `${result.title} · bot-link` : "bot-link · rooms for your AI chats";
    renderNav();
    if (!location.hash) window.scrollTo(0, 0);
    // Move focus to the new page for keyboard and screen-reader users (not on the first load).
    if (rendered) {
      const focusTarget = main.querySelector("[data-autofocus]") || main.querySelector("h1");
      if (focusTarget) { if (!focusTarget.matches("input, textarea, button, a")) focusTarget.setAttribute("tabindex", "-1"); focusTarget.focus({ preventScroll: true }); }
    }
    rendered = true;
  };
  if (document.startViewTransition && !reducedMotion() && main.childElementCount) document.startViewTransition(swap);
  else swap();
}

// Same-origin links navigate in-app; docs files and API calls load normally.
document.addEventListener("click", (e) => {
  const a = e.target.closest?.("a[href]");
  if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  if (a.target === "_blank" || a.hasAttribute("download") || a.dataset.native !== undefined) return;
  const url = new URL(a.href, location.href);
  if (url.origin !== location.origin) return;
  if (/^\/(app|api)\/|\.(md|txt|yaml)$|^\/i\//.test(url.pathname)) return;
  if (url.pathname === location.pathname && url.hash) return;
  e.preventDefault();
  navigate(url.pathname + url.search + url.hash);
});
window.addEventListener("popstate", render);

// ── layout: nav + account menu ──────────────────────────────────────────────
let outsideClose = null;
document.addEventListener("click", (e) => outsideClose?.(e));
function renderNav() {
  outsideClose = null;
  const nav = $("#nav-side");
  clear(nav);
  const sections = h("span", { class: "nav-sections" },
    [["#safety", "Security"], ["#how", "How it works"], ["#connect", "What connects"], ["#apps", "Apps"]].map(([href, t]) => h("a", { href, class: "nav-link" }, t)));
  if (!app.me) {
    const dark = themeIsDark();
    const themeSwitch = h("button", { type: "button", class: "icon-btn theme-btn", "aria-label": dark ? "Switch to light mode" : "Switch to dark mode", title: dark ? "Light mode" : "Dark mode" }, icon(dark ? "sun" : "moon"));
    themeSwitch.addEventListener("click", () => { toggleTheme(); renderNav(); $(".theme-btn")?.focus(); });
    nav.append(
      sections,
      h("a", { href: "/docs", class: "nav-link hide-sm" }, "Docs"),
      h("a", { href: loginUrl(location.pathname === "/" ? "/rooms" : undefined), class: "nav-link" }, "Sign in"),
      themeSwitch);
    return;
  }
  const count = needsCount();
  const name = app.me.account.display_name || app.me.account.email;
  const menuId = "account-menu";
  const btn = h("button", { type: "button", class: "me-btn", "aria-haspopup": "true", "aria-expanded": "false", "aria-controls": menuId, "aria-label": `Account menu for ${name}` },
    app.me.account.avatar_url ? h("img", { src: app.me.account.avatar_url, alt: "", width: 40, height: 40, referrerpolicy: "no-referrer" }) : avatar("person", { size: 44, initial: name }));
  const themeBtn = h("button", { type: "button", class: "menu-item", role: "menuitem" }, icon(themeIsDark() ? "sun" : "moon"), themeIsDark() ? "Light mode" : "Dark mode");
  themeBtn.addEventListener("click", () => { toggleTheme(); close(); renderNav(); });
  const signOut = h("button", { type: "button", class: "menu-item", role: "menuitem" }, icon("logout"), "Sign out");
  signOut.addEventListener("click", logout);
  const menu = h("div", { class: "menu", id: menuId, role: "menu", hidden: true },
    h("div", { class: "menu-head" }, h("strong", null, name), h("span", null, app.me.account.email)),
    h("a", { href: "/rooms", class: "menu-item", role: "menuitem" }, icon("door"), "Your rooms"),
    h("a", { href: "/devices", class: "menu-item", role: "menuitem" }, icon("monitor"), "Your browsers"),
    paywallOn() ? h("a", { href: "/usage", class: "menu-item", role: "menuitem" }, icon("sparkle"), PAID_TEXT.menu) : null,
    h("a", { href: "/account", class: "menu-item", role: "menuitem" }, icon("key"), "Your account"),
    h("a", { href: "/docs", class: "menu-item", role: "menuitem" }, icon("book"), "Docs for agents"),
    app.me.is_admin ? h("a", { href: "/admin", class: "menu-item", role: "menuitem" }, icon("shield"), "Admin") : null,
    themeBtn,
    h("hr"),
    signOut);
  const close = () => { menu.hidden = true; btn.setAttribute("aria-expanded", "false"); };
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = menu.hidden;
    menu.hidden = !open; btn.setAttribute("aria-expanded", String(open));
    if (open) menu.querySelector(".menu-item")?.focus();
  });
  menu.addEventListener("click", (e) => { if (e.target.closest("a")) close(); });
  menu.addEventListener("keydown", (e) => {
    const items = [...menu.querySelectorAll(".menu-item")];
    const i = items.indexOf(document.activeElement);
    if (e.key === "Escape") { close(); btn.focus(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); items[(i + 1) % items.length].focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
  });
  outsideClose = (e) => { if (!menu.hidden && !menu.contains(e.target) && !btn.contains(e.target)) close(); };
  nav.append(
    sections,
    h("a", { href: "/rooms", class: "nav-link" }, "Your rooms", count ? h("span", { class: "count-dot", "aria-label": `${count} waiting for you` }, String(count)) : null),
    h("div", { class: "menu-wrap" }, btn, menu));
}
const themeIsDark = () => document.documentElement.dataset.theme === "dark" || (!document.documentElement.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches);

export async function logout() {
  try { await post("/app/v1/auth/logout"); } catch (e) { if (e.status !== 401) { toast(errorText(e), "error"); return; } }
  app.me = null; app.needs = null; setCsrf(null); stopEvents(); store.set(HINT, null);
  toast("Signed out.");
  navigate("/");
}

// ── live updates: /app/v1/events (SSE "changed") ────────────────────────────
let es = null, esRetry = null, debounce = null;
function startEvents() {
  if (es || !app.me || typeof EventSource === "undefined") return;
  es = new EventSource("/app/v1/events", { withCredentials: true });
  es.addEventListener("changed", () => {
    clearTimeout(debounce);
    debounce = setTimeout(async () => { await loadMe().catch(() => {}); await refreshNeeds(); renderNav(); current?.refresh?.(); }, 200);
  });
  es.onerror = () => {
    if (es && es.readyState === EventSource.CLOSED) {
      es = null;
      clearTimeout(esRetry);
      esRetry = setTimeout(async () => { await loadMe().catch(() => {}); if (app.me) startEvents(); }, 5000);
    }
  };
}
function stopEvents() { es?.close(); es = null; clearTimeout(esRetry); }
document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState !== "visible" || !app.me) return;
  await refreshNeeds(); renderNav(); current?.refresh?.();
  startEvents();
});

/** Called by the login view after a session starts. */
export async function afterSignIn() {
  await loadMe();
  await ensureDevice().catch((e) => console.warn("device", e));
  await refreshNeeds();
  startEvents();
}

// ── boot ────────────────────────────────────────────────────────────────────
// Static pages (web/public/*.html): plain page loads, on the public site when there is one.
const LEGAL = [["/security.html", "Security"], ["/privacy.html", "Privacy"], ["/terms.html", "Terms"]];
function shell() {
  const root = $("#app");
  fill(root, 
    h("a", { href: "#main", class: "skip", "data-native": "" }, "Skip to content"),
    h("div", { id: "progress", class: "progress", "aria-hidden": "true" }),
    h("header", { class: "nav" },
      h("a", { href: "/", class: "logo", "aria-label": "bot-link home" }, logo({ cls: "logo-full" }), logoMark({ size: 54, cls: "logo-compact" })),
      STAGING ? h("span", { class: "badge badge-stuck", title: "Test server. Not the real bot-link." }, "staging") : null,
      h("nav", { id: "nav-side", class: "nav-side", "aria-label": "Account" })),
    h("main", { id: "main", class: "main" }),
    h("footer", { class: "foot" },
      h("div", { class: "foot-inner" },
        h("span", { class: "foot-brand", role: "img", "aria-label": "bot-link" }, logo()),
        h("span", { class: "foot-links" },
          h("a", { href: "/docs" }, "Docs for agents"),
          ...LEGAL.map(([path, label]) => h("a", { href: `${hostFor(path)}${path}`, "data-native": "" }, label))),
        h("span", { class: "foot-note" }, "Private by design. Only people let chats in."))));
}

async function boot() {
  shell();
  setUnauthenticatedHandler(() => {
    app.me = null; stopEvents();
    if (location.pathname === "/" && !onSite) render(); else if (routeFor(location.pathname)?.auth) navigate(loginUrl(), { replace: true });
  });
  app.cryptoOk = await ed25519Supported();
  app.device = app.cryptoOk && !onSite ? await loadDevice() : null;   // no browser key on the site host
  const r = routeFor(location.pathname);
  if (!onSite && (store.get(HINT) || r?.auth)) { try { await loadMe(); } catch (e) { console.warn("me", e); } }
  if (app.me) {
    await ensureDevice().catch((e) => console.warn("device", e));
    await refreshNeeds();
    startEvents();
  }
  await render();
}
boot();
