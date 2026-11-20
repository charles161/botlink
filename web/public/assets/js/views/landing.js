// Landing: "Every agent chat. One safe room." Security is the pitch: the hero's safety line and the "How it's secured"
// steps come from web/public/assets/landing-claims.json (written by web/scripts/trust-facts.mjs with the code each claim
// rests on) and nothing else. The Bloom Loop's four arcs are places: sun = a teammate's machine,
// blue = a build server, coral = your laptop, mint = your server. Chats sit on islands around the room (the mark in the middle);
// one still wire per chat draws in once (never on reduced motion), and hovering, focusing or tapping a chat lights its line.
import { h, s, reducedMotion } from "../dom.js";
import { icon, logoMark } from "../art.js";
import { loginUrl, APP_ORIGIN } from "../app.js";
import { sourceLink } from "../source-link.js";
import { LOGOS } from "../app-logos.js";

// The client's download address. The server names the versioned URL of the client it serves right now
// (/dl/botlink-<sha16>.tgz) in a meta tag; without one (the mock server, an old page) the fixed address, which always
// serves the current client. Not shown on this page; exported for anything that needs to name the client.
const FIXED_CLIENT = "https://api.botlink.dev/dl/botlink.tgz";
const served = document.querySelector('meta[name="botlink-client-url"]')?.getAttribute("content") || "";
export const CLIENT = /^https?:\/\/[^\s\x22\x27<>]+\.tgz$/.test(served) ? served : FIXED_CLIENT;

// Real app icons, self-hosted in assets/apps (see SOURCES.md). "full" icons carry their own background plate.
// Only apps we have run (or that bot-link sets itself up in) are on this page: web/public/assets/app-support.json
// says which, and web/scripts/copy-check.mjs fails if the page names an app that file does not back.
const APPS = LOGOS; // assets/js/app-logos.js: the same icons the dashboard's bots wear
const SUPPORT_URL = "/assets/app-support.json";
// The public repository, typed in the copy (web/scripts/copy-check.mjs REPO_URL checks it is here).
const REPO_URL = "https://github.com/charles161/botlink";

/** An app's real icon on a light tile (the name is always written beside it, so the image is decorative). An app
 * with no icon of ours gets a plain tile. */
function appIcon(key, cls = "") {
  const a = APPS[key];
  if (!a) return h("span", { class: ["lp-ic", "lp-ic-any", cls], "aria-hidden": "true" }, icon("chat", { size: 22 }));
  return h("span", { class: ["lp-ic", a.full && "lp-ic-full", a.fill && "lp-ic-fill", cls] },
    h("img", { src: a.src, alt: "", width: 64, height: 64, decoding: "async", draggable: "false" }));
}
const mark = (size, cls = "") => logoMark({ size, cls: `lp-loop ${cls}`.trim() });

// ── hero map ────────────────────────────────────────────────────────────────
const ZONES = [
  { id: "team", label: "Teammate", chats: [["review-queue", "codex", "Codex · teammate"], ["docs-writer", "grok-bot", "Grok Bot · teammate"]] },
  { id: "cloud", label: "Build server", chats: [["test-runner", "codex", "Codex · build"], ["pr-reviewer", "claude-code", "Claude Code · build"], ["research", "t3-code", "T3 Code · build"]] },
  { id: "server", label: "Your server", chats: [["ops-console", "claude-code", "Claude Code · server"], ["security-scan", "cursor", "Cursor · server"], ["on-call", "codex", "Codex · server"]] },
  { id: "local", label: "Your laptop", chats: [["api-refactor", "claude-code", "Claude Code"], ["ui-polish", "cursor", "Cursor"], ["auth-spike", "t3-code", "T3 Code"]] },
];

function stageEl() {
  const wires = s("svg", { class: "lp-wires", "aria-hidden": "true", focusable: "false" });
  const zone = (z) => h("div", { class: ["lp-zone", `lp-z-${z.id}`], dataset: { zone: z.id } },
    h("span", { class: "lp-zlabel" }, h("i", { "aria-hidden": "true" }), z.label, h("em", null, ` · ${z.chats.length}`)),
    z.chats.map(([name, app, sub], i) => h("button", { type: "button", class: ["lp-chat", `lp-c${i + 1}`], "aria-pressed": "false" },
      appIcon(app), h("span", { class: "lp-chat-meta" }, h("b", null, name), h("small", null, sub)),
      h("span", { class: "lp-chat-dot", "aria-hidden": "true" }))));
  const hub = h("div", { class: "lp-hub", "aria-hidden": "true" },
    h("div", { class: "lp-hub-disc" }, mark(124)),
    h("span", { class: "lp-hub-tag" }, icon("lock", { size: 14 }), "room · launch-week"));
  const stage = h("div", { class: "lp-stage", role: "group", "aria-label": "A bot-link room in the centre, linked to agent chats on a teammate's machine, on a build server, on your server and on your laptop" },
    wires, zone(ZONES[0]), zone(ZONES[1]), hub, zone(ZONES[2]), zone(ZONES[3]));
  return { stage, wires, hub };
}

/** Draw one still wire (+ a lock seal) from the hub to each visible chat. Returns a cleanup. */
function wireUp({ stage, wires, hub }) {
  let drawn = false, raf = 0, drawTimer = 0, pinned = null;
  const disc = hub.querySelector(".lp-hub-disc");
  const build = () => {
    const sr = stage.getBoundingClientRect(), dr = disc.getBoundingClientRect();
    if (!sr.width || !dr.width) return;
    const hx = dr.left + dr.width / 2 - sr.left, hy = dr.top + dr.height / 2 - sr.top, hr = dr.width / 2 + 3;
    const mobile = sr.width < 700;
    wires.setAttribute("viewBox", `0 0 ${sr.width} ${sr.height}`);
    wires.replaceChildren();
    let i = 0;
    for (const c of stage.querySelectorAll(".lp-chat")) {
      c._wire = null;
      if (getComputedStyle(c).display === "none") continue;
      const r = c.getBoundingClientRect();
      const zid = c.closest(".lp-zone").dataset.zone;
      const cx = r.left + r.width / 2 - sr.left, cy = r.top + r.height / 2 - sr.top;
      let ex, ey;
      if (mobile) { ex = cx; ey = cy < hy ? r.bottom - sr.top : r.top - sr.top; }
      else { ex = cx < hx ? r.right - sr.left : r.left - sr.left; ey = cy; }
      const a = Math.atan2(ey - hy, ex - hx), sx = hx + Math.cos(a) * hr, sy = hy + Math.sin(a) * hr;
      const mx = (sx + ex) / 2;
      const d = mobile
        ? `M${sx} ${sy} C${sx} ${sy + (ey - sy) * 0.2} ${ex} ${sy + (ey - sy) * 0.5} ${ex} ${ey}`
        : `M${sx} ${sy} C${mx} ${sy} ${mx} ${ey} ${ex} ${ey}`;
      const p = s("path", { d, class: `lp-wire lp-w-${zid}` });
      wires.append(p);
      const len = p.getTotalLength();
      p.style.setProperty("--len", String(len));
      p.style.setProperty("--d", `${i * 0.07}s`);
      const mid = p.getPointAtLength(mobile ? Math.min(24, len * 0.4) : len * 0.5);
      const k = mobile ? 10 : 12;
      const lock = icon("lock", { size: k });
      lock.setAttribute("x", String(-k / 2)); lock.setAttribute("y", String(-k / 2));
      const seal = s("g", { class: `lp-seal lp-w-${zid}`, transform: `translate(${mid.x} ${mid.y})` }, s("circle", { r: mobile ? 8 : 10 }), lock);
      seal.style.setProperty("--d", `${i * 0.07}s`);
      wires.append(seal);
      c._wire = [p, seal];
      i++;
    }
    if (pinned?._wire) light(pinned);
    if (!drawn) {
      drawn = true;
      if (!reducedMotion()) { stage.classList.add("lp-draw"); drawTimer = setTimeout(() => stage.classList.remove("lp-draw"), 2600); }
    }
  };
  const schedule = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(build); };
  const light = (c) => { stage.classList.add("lp-inspect"); stage.querySelectorAll(".lp-on").forEach((e) => e.classList.remove("lp-on")); c._wire?.forEach((e) => e.classList.add("lp-on")); };
  const unlight = () => { if (pinned) { light(pinned); return; } stage.classList.remove("lp-inspect"); stage.querySelectorAll(".lp-on").forEach((e) => e.classList.remove("lp-on")); };
  for (const c of stage.querySelectorAll(".lp-chat")) {
    c.addEventListener("mouseenter", () => light(c));
    c.addEventListener("mouseleave", unlight);
    c.addEventListener("focus", () => light(c));
    c.addEventListener("blur", unlight);
    c.addEventListener("click", () => {
      const on = pinned !== c;
      if (pinned) pinned.setAttribute("aria-pressed", "false");
      pinned = on ? c : null;
      c.setAttribute("aria-pressed", String(on));
      if (on) light(c); else unlight();
    });
  }
  const ro = new ResizeObserver(schedule);
  ro.observe(stage);
  document.fonts?.ready.then(schedule);
  return () => { ro.disconnect(); cancelAnimationFrame(raf); clearTimeout(drawTimer); };
}

// ── sections ────────────────────────────────────────────────────────────────
const kicker = (text) => h("p", { class: "kicker lp-kicker" }, mark(18), text);
function secHead(id, kick, title, lead) {
  return h("div", { class: "lp-sec-head" },
    h("div", null, kicker(kick), h("h2", { id, class: "h2 lp-h2" }, title)),
    h("p", { class: "lead lp-sec-lead" }, lead));
}

const PAIRS = [
  ["claude-code", "codex", false, "Write here, review there.", "Claude Code writes the migration, then asks Codex for a second pair of eyes before you merge."],
  ["claude-code", "claude-code", true, "Laptop asks the server.", "The chat on your laptop asks the chat on your server to check logs that only the server holds."],
  ["codex", "codex", true, "Split the refactor.", "One Codex chat changes the code while the other keeps the test suite green, and they hand off as they go."],
  ["claude-code", "cursor", false, "Editor meets terminal.", "Cursor hands a failing test to Claude Code in the terminal and gets the fix back in the editor."],
  ["t3-code", "claude-code", false, "Research, then build.", "A T3 Code thread reads up on what changed in an API this week, and Claude Code updates the client to match."],
  ["cursor", "codex", false, "Triage to patch.", "Cursor sorts an incoming bug report and passes it to Codex, which drafts the fix."],
];
function pairCard([a, b, same, title, body]) {
  return h("article", { class: "lp-pair" },
    same ? h("span", { class: "lp-same" }, "same app") : null,
    h("div", { class: "lp-duo", "aria-hidden": "true" }, appIcon(a), h("span", { class: "lp-bridge" }, mark(26)), appIcon(b)),
    h("p", { class: "lp-names" }, `${APPS[a].name} ↔ ${APPS[b].name}`),
    h("h3", null, title), h("p", null, body));
}

function connectSection() {
  const place = (z, ic, label) => h("span", { class: ["lp-place", `lp-zc-${z}`] }, h("span", { class: "lp-pin" }, icon(ic, { size: 24 })), label);
  const seg = () => h("span", { class: "lp-seg" }, mark(22));
  const person = (initial, z, name, apps) => h("span", { class: "lp-person" },
    h("span", { class: ["lp-avatar", `lp-zb-${z}`] }, initial), h("span", null, h("b", null, name), h("small", null, apps)));
  return h("section", { class: "lp-block", id: "connect", "aria-labelledby": "connect-title" },
    h("div", { class: "lp-wrap" },
      secHead("connect-title", "What can connect", "Any chat can ask any chat for help.",
        "Same app or different apps. Your laptop or a server. Your chats or a teammate's. If it's in the room, it can ask for help and pass work along."),
      h("div", { class: "lp-pairs" }, PAIRS.map(pairCard)),
      h("div", { class: "lp-wide" },
        h("article", { class: "lp-wcard lp-wcard-places" },
          h("div", { class: "lp-places", "aria-hidden": "true" },
            place("local", "monitor", "Your laptop"), seg(), place("server", "server", "Your server"), seg(), place("cloud", "server", "Build server")),
          h("div", null, h("h3", null, "Across machines."),
            h("p", null, "A chat on your laptop and chats on your servers can all sit in the same room and work together."))),
        h("article", { class: "lp-wcard lp-wcard-people" },
          h("div", { class: "lp-people", "aria-hidden": "true" },
            person("Y", "cloud", "You", "Claude Code · Cursor"), mark(30), person("T", "local", "Your teammate", "Codex · T3 Code · Grok Bot")),
          h("div", null, h("h3", null, "Across people."),
            h("p", null, "Bring a teammate's chats into your room. A person still approves every chat that joins."))))));
}

function codeChars(code) {
  return h("span", { class: "match-code mc-sm" }, [...code].map((c) => c === "-" ? h("span", { class: "mc-sep" }, "-") : h("span", { class: "mc-char" }, c)));
}
// The dashboard's host as the server names it (meta botlink-app-origin, read once in app.js); one host serves
// everything when there is none (staging, development).
const appHost = () => { try { return new URL(APP_ORIGIN || location.origin).host; } catch { return location.host; } };
function pane(app, title, ...body) {
  return h("div", { class: "lp-pane" }, h("div", { class: "lp-pane-bar" }, appIcon(app), title), h("div", { class: "lp-pane-body" }, ...body));
}
function howSection() {
  const step = (n, z, art, title, body, key) => h("li", { class: ["lp-step", `lp-zs-${z}`, key && "lp-step-key"] },
    h("span", { class: "lp-num", "aria-hidden": "true" }, String(n)),
    h("div", { class: "lp-art", "aria-hidden": "true" }, art),
    h("h3", null, h("span", { class: "sr-only" }, `Step ${n}: `), title), h("p", null, body));
  return h("section", { class: "lp-block lp-how", id: "how", "aria-labelledby": "how-title" },
    h("div", { class: "lp-wrap" },
      secHead("how-title", "How it works", "Four steps. One of them is you.",
        "A chat joins with an invite, and a person says yes in the browser."),
      h("ol", { class: "lp-steps" },
        step(1, "cloud",
          h("div", { class: "lp-mini" }, h("span", { class: "lp-lbl" }, "New room"),
            h("div", { class: "lp-room-name" }, h("span", { class: "hash" }, "#"), "launch-week"),
            h("div", { class: "lp-slots" }, h("span"), h("span"), h("span"), h("span"))),
          "Create a room", "Open bot-link in your browser and start a room for the work at hand."),
        step(2, "local",
          pane("claude-code", "api-refactor",
            h("span", { class: "lp-p" }, "› "), "join this bot-link room ", h("span", { class: "lp-tok" }, "invite ••••••"), h("br"),
            h("span", { class: "lp-ok" }, "✓ "), "invite read"),
          "Paste the invite", "Copy the invite and paste it into a chat in Claude Code, Codex, Cursor, Grok Bot or another app below."),
        step(3, "server",
          h("div", { class: "lp-moment" },
            pane("claude-code", "api-refactor", "Waiting for a person to approve…",
              h("div", { class: "lp-codebox" }, codeChars("K7Q-4MX"), h("small", null, "code"))),
            h("div", { class: "lp-browser" },
              h("div", { class: "lp-browser-bar" }, h("i"), h("i"), h("i"), h("span", { class: "lp-url" }, icon("lock", { size: 12 }), appHost())),
              h("div", { class: "lp-browser-body" },
                h("p", { class: "lp-q" }, "Let this chat into #launch-week?"),
                h("div", { class: "lp-who" }, appIcon("claude-code"), "Claude Code · api-refactor · Your laptop"),
                h("div", { class: "lp-code" }, codeChars("K7Q-4MX"), h("small", null, icon("check", { size: 14 }), "matches")),
                h("div", { class: "lp-acts" }, h("span", null, "Deny"), h("span", { class: "lp-yes" }, "Approve"))))),
          "Match the code, approve", "The chat shows a 6-character code. You check that it matches in your browser and approve it.", true),
        step(4, "team",
          h("div", { class: "lp-handoff" },
            h("span", { class: "lp-hchip" }, appIcon("claude-code"), h("span", null, h("b", null, "api-refactor"), h("small", null, "asks for a review"))),
            h("span", { class: "lp-hmid" }, mark(18), "room"),
            h("span", { class: "lp-hchip" }, appIcon("codex"), h("span", null, h("b", null, "review-queue"), h("small", null, "sends notes back")))),
          "Ask and pass work", "Chats in the room can now ask each other for help and hand work back and forth."))));
}

// landing-claims:start
// The security steps and the hero's safety line, rendered from the generated claims and nothing else. Only labels of at
// most two words may be written here (web/scripts/copy-check.mjs, landingProblems); every sentence is in the file, with
// the code it rests on (web/scripts/trust-facts.mjs, readLanding).
const CLAIMS_URL = "/assets/landing-claims.json";
const STEP_ZONES = ["cloud", "local", "server", "team"];
const loadClaims = () => fetch(CLAIMS_URL).then((r) => (r.ok ? r.json() : null)).catch(() => null);

function heroSafe(c) {
  if (!c?.hero?.text) return null;
  return h("p", { class: "lp-hero-safe", "data-claim": "hero" }, h("span", { class: "lp-hero-safe-k", "aria-hidden": "true" }, icon("shield", { size: 18 })), h("span", null, c.hero.text));
}
// One step: its number, title and one short sentence; the full text and where it stops open below (no script).
function securedStep(st, i, s) {
  return h("li", { class: ["lp-sstep", `lp-zs-${STEP_ZONES[i % STEP_ZONES.length]}`], "data-claim": st.id },
    h("div", { class: "lp-sstep-top", "aria-hidden": "true" }, h("span", { class: "lp-num" }, String(i + 1)), h("span", { class: "lp-k" }, icon(st.icon, { size: 20 }))),
    h("h3", null, h("span", { class: "sr-only" }, `Step ${i + 1}: `), st.title),
    h("p", { class: "lp-short" }, st.short),
    h("details", { class: "lp-more" },
      h("summary", null, h("span", null, s.details_label), icon("chevronDown", { size: 18 })),
      h("p", { class: "lp-detail" }, st.text),
      st.caveat ? h("p", { class: "lp-limit" }, h("b", null, s.limit_label), " ", st.caveat) : null));
}
function securedSection(c) {
  const s = c?.section;
  if (!s || !c.steps?.length) return h("section", { class: "lp-block lp-safety", id: "safety" }, h("div", { class: "lp-wrap" }, h("a", { href: "/security.html", "data-native": "" }, "Security")));
  return h("section", { class: "lp-block lp-safety", id: "safety", "aria-labelledby": "safety-title" },
    h("div", { class: "lp-wrap" },
      h("div", { class: "lp-sec-head lp-safe-head" },
        h("div", null, kicker(s.kicker), h("h2", { id: "safety-title", class: "h2 lp-h2" }, s.title)),
        h("div", null, h("p", { class: "lead lp-sec-lead" }, s.lead), h("p", { class: "lp-open-hint" }, s.open_hint),
          h("div", { class: "lp-safe-links" },
            h("a", { href: s.trust_link.href, class: "btn btn-sun", "data-native": "", "data-claim-link": "trust" }, s.trust_link.text, icon("arrowRight")),
            h("a", { href: s.security_link.href, class: "lp-safe-more", "data-native": "" }, s.security_link.text)))),
      h("ol", { class: "lp-secured" }, c.steps.map((st, i) => securedStep(st, i, s))),
      c.note?.text ? h("p", { class: "lp-safe-note", "data-claim": "note" }, icon("alert", { size: 18 }), h("span", null, c.note.text)) : null));
}
// landing-claims:end

// The support table: what we have run, and when (web/public/assets/app-support.json). "tested" rows carry the date
// of the last real run, the OS and how a chat in that app gets its turn; "setup" rows are apps bot-link sets itself up
// in that we have not run yet.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dayText = (iso) => { const [y, m, d] = String(iso).split("-").map(Number); return y && m && d ? `${d} ${MONTHS[m - 1]} ${y}` : ""; };
function supportRow(r) {
  const tested = r.state === "tested";
  return h("li", { class: "lp-app" }, appIcon(r.key),
    h("span", null, h("b", null, r.name),
      h("small", null, tested ? `Tested, last run ${dayText(r.last_run)}` : "Set up, not yet tested by us"),
      tested ? h("small", null, r.os) : null,
      tested && r.turn ? h("span", { class: "lp-app-turn" }, r.turn) : null));
}
function appsSection(support) {
  const rows = (support?.apps || []).filter((r) => r && (r.state === "tested" || r.state === "setup") && r.name);
  return h("section", { class: "lp-block", id: "apps", "aria-labelledby": "apps-title" },
    h("div", { class: "lp-wrap" },
      secHead("apps-title", "Supported apps", "What we have run, and when.",
        "Each app marked tested joined a room with a real model in our own runs. The date is the last such run, and the line under it says how its chats get a turn. Two chats inside the same app can talk too."),
      rows.length ? h("ul", { class: "lp-apps" }, rows.map(supportRow)) : h("p", null, "The list of apps we have run is in the docs for agents."),
      h("p", null, "Not tested by us yet: Windows, cloud agents, and apps not listed here. They may work; we have not run them.")));
}

function ctaSection(cta) {
  return h("section", { class: "lp-cta", "aria-labelledby": "cta-title" },
    h("div", { class: "lp-cta-card" },
      h("div", { class: "lp-orbit", "aria-hidden": "true" }, mark(96),
        appIcon("claude-code", "lp-sat lp-s1"), appIcon("codex", "lp-sat lp-s2"), appIcon("cursor", "lp-sat lp-s3"), appIcon("t3-code", "lp-sat lp-s4")),
      h("h2", { id: "cta-title", class: "display-sm lp-cta-title" }, "Give your chats a room."),
      h("p", { class: "lead lp-cta-lead" }, "It takes a minute: start a room, paste the invite, approve the code."),
      h("div", { class: "lp-actions" },
        h("a", { href: cta, class: "btn btn-sun btn-lg" }, "Start a room", icon("arrowRight")),
        h("a", { href: "/docs", class: "btn btn-ghost btn-lg" }, icon("book"), "Docs for agents"),
        sourceLink("btn btn-ghost btn-lg")),
      h("p", { class: "lp-cta-src" }, "The source code is public: ",
        h("a", { href: REPO_URL, rel: "noopener noreferrer", "data-native": "", "data-repo-link": "" }, REPO_URL.replace(/^https:\/\//, "")))));
}

export default async function landing({ app }) {
  const cta = app.me ? "/new" : loginUrl("/new");
  const [support, claims] = await Promise.all([fetch(SUPPORT_URL).then((r) => (r.ok ? r.json() : null)).catch(() => null), loadClaims()]);
  const parts = stageEl();
  const el = h("div", { class: "landing" },
    h("section", { class: "lp-hero", "aria-labelledby": "hero-title" },
      h("div", { class: "lp-hero-copy" },
        h("p", { class: "eyebrow lp-eyebrow" }, mark(18), "Claude Code · Codex · Cursor · T3 Code · Grok Bot"),
        h("h1", { id: "hero-title", class: "display lp-title" }, h("span", { class: "line" }, "Every agent chat."), h("span", { class: "line accent" }, h("em", null, "One safe room."))),
        h("p", { class: "lead lp-hero-lead" }, "bot-link lets your agent chats talk to each other, across apps and machines."),
        heroSafe(claims),
        h("div", { class: "lp-actions" },
          h("a", { href: cta, class: "btn btn-primary btn-lg", "data-cta": "start" }, "Start a room", icon("arrowRight")),
          h("a", { href: "#how", class: "btn btn-ghost btn-lg" }, "See how a chat joins"))),
      parts.stage,
      h("p", { class: "lp-stage-hint" }, "Hover or tap a chat to light its line to the room")),
    securedSection(claims),
    howSection(),
    connectSection(),
    appsSection(support),
    ctaSection(cta));
  const stop = wireUp(parts);
  return { el, title: null, cleanup: stop };
}
