"""End-to-end click-through of every dashboard page and flow (PLAN.md §5.5, W), with screenshots.

Runs against the fixture server (web/test/fixtures/mock-server.mjs, test hooks under /__mock/).
Each viewport gets a fresh state. On every page it asserts: 0 console errors, no horizontal
overflow, no forbidden copy words (receipt, seen, answered, webhook, delivered, lease, envelope,
ChatGPT), no visible text under 13px, and >= 44px tap targets.

    node web/test/fixtures/mock-server.mjs &           # :8829
    python3 web/test/test_e2e.py [--base http://localhost:8829] [--only phone|desktop]
"""
import argparse, os, pathlib, re, sys, time
from playwright.sync_api import sync_playwright, expect

ROOT = pathlib.Path(__file__).resolve().parents[2]
SHOTS = ROOT / "web" / "shots"
FORBIDDEN = re.compile(r"\b(receipts?|seen|answered|webhooks?|delivered|leases?|envelopes?|chatgpt)\b", re.I)
VIEWPORTS = {"phone": {"width": 390, "height": 844}, "desktop": {"width": 1440, "height": 900}}
# signed in = the URL path IS /rooms; the glob "**/rooms" also matches /login?return_to=/rooms, so a wait on it returned
# before dev-login finished and the next navigation cancelled the login (real server: dev-login 500 "context canceled")
ROOMS_URL = re.compile(r"^[a-z]+://[^/]+/rooms(?:[?#].*)?$")

AUDIT_JS = r"""
(skipCopy) => {
  const out = { overflow: document.documentElement.scrollWidth - window.innerWidth, small: [], targets: [], text: "" };
  const visible = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none" && cs.opacity !== "0"; };
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const seen = new Set();
  while (walker.nextNode()) {
    const n = walker.currentNode; const el = n.parentElement;
    if (!n.textContent.trim() || !el || seen.has(el)) continue; seen.add(el);
    if (el.closest("svg, .sr-only, [aria-hidden='true'], dialog:not([open]), script, style, noscript")) continue;
    if (!visible(el)) continue;
    const fs = parseFloat(getComputedStyle(el).fontSize);
    if (fs < 13) out.small.push(`${el.tagName}.${el.className} "${n.textContent.trim().slice(0, 30)}" ${fs}px`);
  }
  for (const el of document.querySelectorAll("a[href], button, input, textarea, select, [role=menuitem]")) {
    if (!visible(el) || el.closest("[aria-hidden='true'], .prose, .hc-turnstile")) continue;
    if (el.tagName === "A" && el.closest("p, li.checklist, .need-fine")) continue; // inline text links
    const r = el.getBoundingClientRect();
    if (r.height < 43.5 || r.width < 43.5) out.targets.push(`${el.tagName}.${el.className} "${(el.textContent || el.getAttribute("aria-label") || "").trim().slice(0, 24)}" ${Math.round(r.width)}x${Math.round(r.height)}`);
  }
  if (!skipCopy) out.text = document.body.innerText;
  return out;
}
"""

# Seat labels must not sit on the table top (unreadable over the rim), under the landing's Done card, or be cut
# off by a clipping ancestor. Returns a list of problems.
TABLE_JS = r"""
() => {
  const out = [];
  const vis = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none"; };
  const hit = (a, b) => a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
  for (const scene of document.querySelectorAll(".table-scene")) {
    if (!vis(scene)) continue;
    const surf = scene.querySelector(".table-surface").getBoundingClientRect();
    // table top ellipse (viewBox 600x330, preserveAspectRatio none): cx 300, cy 162..178 (depth), rx 286, ry 140
    const sx = surf.width / 600, sy = surf.height / 330;
    const inTable = (x, y) => [162, 178].some((cy) => ((x - surf.left) / sx - 300) ** 2 / 286 ** 2 + ((y - surf.top) / sy - cy) ** 2 / 140 ** 2 < 1);
    const done = scene.querySelector(".done-card");
    const doneR = done && getComputedStyle(done).visibility !== "hidden" && getComputedStyle(done).opacity !== "0" ? done.getBoundingClientRect() : null;
    for (const lab of scene.querySelectorAll(".seat-name, .seat-sub")) {
      if (!vis(lab)) continue;
      // the text's own box (labels are block-level; measure the text run)
      const rg = document.createRange(); rg.selectNodeContents(lab); const r = rg.getBoundingClientRect();
      if (!r.width) continue;
      const name = lab.textContent.trim();
      const tag = lab.closest(".seat-tag");
      const opaque = tag && /^rgb\(/.test(getComputedStyle(tag).backgroundColor);  // a place card covers the rim cleanly
      let onTable = 0;
      for (let i = 0; i <= 6; i++) for (let j = 0; j <= 2; j++) if (inTable(r.left + (r.width * i) / 6, r.top + (r.height * j) / 2)) onTable++;
      if (onTable > 2 && !opaque) out.push(`label "${name}" sits on the table (${onTable}/21 points)`);
      if (doneR && (hit(r, doneR) || (tag && hit(tag.getBoundingClientRect(), doneR)))) out.push(`label "${name}" overlaps the Done card`);
      for (let a = scene.parentElement; a && a !== document.body; a = a.parentElement) {
        const cs = getComputedStyle(a);
        if (/(hidden|clip)/.test(cs.overflowX + cs.overflowY)) {
          const ar = a.getBoundingClientRect();
          if (r.left < ar.left - 0.5 || r.right > ar.right + 0.5 || r.top < ar.top - 0.5 || r.bottom > ar.bottom + 0.5) out.push(`label "${name}" is cut off by ${a.tagName}.${a.className}`);
          break;
        }
      }
      if (lab.scrollWidth > lab.clientWidth + 1) out.push(`label "${name}" is truncated`);
    }
  }
  return out;
}
"""


class Run:
    def __init__(self, browser, base, vp_name, scheme="light", viewport=None):
        self.base, self.vp = base, vp_name
        self.ctx = browser.new_context(viewport=viewport or VIEWPORTS[vp_name], color_scheme=scheme, device_scale_factor=2 if vp_name == "phone" else 1,
                                       permissions=["clipboard-read", "clipboard-write"])
        self.pg = self.ctx.new_page()
        self.errors, self.failures = [], []
        self.pg.on("console", lambda m: self.errors.append(f"[{self.vp}] console.{m.type}: {m.text} @ {m.location.get('url', '')}") if m.type == "error" else None)
        self.pg.on("pageerror", lambda e: self.errors.append(f"[{self.vp}] pageerror: {e}"))

    def go(self, path):
        self.pg.goto(self.base + path)
        self.pg.wait_for_selector("#main > *")  # SSE keeps the network busy, so no networkidle
        self.pg.wait_for_timeout(250)

    def settle(self, ms=500):
        self.pg.wait_for_timeout(ms)

    def shot(self, name, full=False):
        SHOTS.mkdir(exist_ok=True)
        if full: self.pg.evaluate("() => { const n = document.querySelector('.nav'); if (n) n.style.position = 'relative'; }")
        self.pg.screenshot(path=str(SHOTS / f"{self.vp}-{name}.png"), full_page=full)
        if full: self.pg.evaluate("() => { const n = document.querySelector('.nav'); if (n) n.style.position = ''; }")

    def audit(self, name, skip_copy=False):
        r = self.pg.evaluate(AUDIT_JS, skip_copy)
        if r["overflow"] > 0: self.failures.append(f"[{self.vp}] {name}: horizontal overflow {r['overflow']}px")
        for s in r["small"][:5]: self.failures.append(f"[{self.vp}] {name}: text < 13px: {s}")
        for t in r["targets"][:8]: self.failures.append(f"[{self.vp}] {name}: tap target < 44px: {t}")
        # no page links to a repository unless the server names one (BOTLINK_SOURCE_URL / MOCK_SOURCE_URL; test_source_link.py),
        # except the typed link to the public repository (web/scripts/copy-check.mjs REPO_URL; test_landing.py checks it)
        repo = self.pg.evaluate("() => Array.from(document.querySelectorAll('a')).map((a) => a.href).filter((u) => /github\\.com/i.test(u) && u !== 'https://github.com/charles161/botlink')")
        if repo and not os.environ.get("MOCK_SOURCE_URL"): self.failures.append(f"[{self.vp}] {name}: links to a repository with no source setting: {repo[:3]}")
        if not skip_copy:
            m = FORBIDDEN.findall(r["text"])
            if m: self.failures.append(f"[{self.vp}] {name}: forbidden words {sorted(set(x.lower() for x in m))}")

    def tables(self, name):
        for p in self.pg.evaluate(TABLE_JS): self.failures.append(f"[{self.vp}] {name}: {p}")

    def check(self, cond, msg):
        if not cond: self.failures.append(f"[{self.vp}] {msg}")

    def mock(self, path, data):
        r = self.pg.request.post(self.base + "/__mock/" + path, data=data)
        assert r.ok, r.text()
        return r.json()

    def close(self):
        self.ctx.close()


CAPS_JS = r"""
() => Array.from(document.querySelectorAll(".scroll-area")).filter((a) => a.getBoundingClientRect().height > 0).map((a) => {
  const panel = a.classList.contains("cap-panel") ? a.closest(".panel") : a;
  const body = a.querySelector(".scroll-body");
  return { label: body.getAttribute("aria-label"), cap: a.classList.contains("cap-panel") ? "panel" : "list",
    h: panel.getBoundingClientRect().height, max: parseFloat(getComputedStyle(panel).maxHeight), vh: innerHeight,
    scrollable: body.scrollHeight > body.clientHeight + 2, tabindex: body.tabIndex, role: body.getAttribute("role") };
})
"""


def check_caps(r, name):
    for c in r.pg.evaluate(CAPS_JS):
        # "What needs you" is deliberately NOT capped: a capped card hid Approve; the page scrolls instead
        if not (c["label"] or "").startswith("What needs you"):
            r.check(c["max"] > 0 and c["h"] <= c["max"] + 1, f"{name}: {c['label']} list isn't capped ({c['h']:.0f}px, max {c['max']})")
        r.check(c["role"] == "region" and (c["tabindex"] == 0 or not c["scrollable"]), f"{name}: {c['label']} scroll region not keyboard-focusable")


def capped_lists(r, room, prefix="", require_short=False):
    """Activity piles up: the panel stays capped, the list scrolls inside it, and a new item while scrolled away shows a pill."""
    import datetime
    pg = r.pg
    t0 = datetime.datetime.now(datetime.timezone.utc)
    names = ["bugfix", "deployer", "designer", "ops-bot"]
    items = [{"from": names[i % 4], "to": names[(i + 1) % 4], "at": (t0 - datetime.timedelta(minutes=5 + i)).isoformat().replace("+00:00", "Z")} for i in range(45)]
    r.mock("activity", {"room": room, "items": items})
    expect(pg.locator(".activity .act")).to_have_count(30, timeout=5000)  # first page; "Show older" for the rest
    r.settle(400)
    body = pg.get_by_role("region", name="Activity list")
    panel = pg.locator(".activity-panel")
    vh = VIEWPORTS[r.vp]["height"]
    ph = panel.bounding_box()["height"]
    cap = max(340, vh * 0.55) if r.vp == "phone" else max(360, vh * 0.6)
    r.check(ph <= cap + 1, f"activity: panel grew to {ph:.0f}px (cap {cap:.0f})")
    m = body.evaluate("(b) => ({ sh: b.scrollHeight, ch: b.clientHeight, ob: getComputedStyle(b).overscrollBehaviorY, ti: b.tabIndex })")
    r.check(m["sh"] > m["ch"] + 50, f"activity: list doesn't scroll inside the panel {m}")
    # no overscroll containment: at the list's end the page scrolls on; scroll_chain() checks the wheel
    r.check(m["ob"] == "auto" and m["ti"] == 0, f"activity: overscroll/keyboard {m}")
    head = panel.locator(".panel-head")
    y0 = head.bounding_box()["y"]
    body.evaluate("(b) => { b.scrollTop = 400; }"); r.settle(300)
    r.check(abs(head.bounding_box()["y"] - y0) < 1, "activity: header moved while the list scrolled")
    r.check(pg.locator(".activity-panel .scroll-area.fade-top").count() == 1, "activity: no top fade while scrolled")
    r.check(pg.locator(".activity-panel .new-pill").is_hidden(), "activity: pill shown with nothing new")
    panel.screenshot(path=str(SHOTS / f"{r.vp}-{prefix}09b-activity-scrolled.png"))
    r.mock("activity", {"room": room, "items": [{"from": "designer", "to": "bugfix"}]})
    pill = pg.locator(".activity-panel .new-pill")
    expect(pill).to_be_visible(timeout=5000)
    r.check(pill.inner_text().strip() == "1 new", f"activity: pill says {pill.inner_text()!r}")
    r.settle(500)  # the pill scales in (.35 s): measure its tap target after the animation, not during it (busy box)
    r.audit("activity-pill"); panel.screenshot(path=str(SHOTS / f"{r.vp}-{prefix}09c-activity-new-pill.png"))
    pill.click(); r.settle(900)
    r.check(body.evaluate("(b) => b.scrollTop") <= 4, "activity: pill didn't scroll to the newest")
    r.check(pill.is_hidden(), "activity: pill still shown after going to the top")
    # At the top, a new item just appears (no pill).
    r.mock("activity", {"room": room, "items": [{"from": "ops-bot", "to": None}]})
    r.settle(900)
    r.check(pill.is_hidden(), "activity: pill shown although the list was at the top")
    body.focus(); pg.keyboard.press("End"); r.settle(500)
    r.check(body.evaluate("(b) => b.scrollTop") > 100, "activity: list not keyboard-scrollable")
    body.evaluate("(b) => { b.scrollTop = 0; }")
    scroll_chain(r, body, require_short=require_short)
    check_caps(r, "room")


def scroll_chain(r, activity, require_short=False):
    """: an inner list that is at its end, or has nothing to scroll, must hand the wheel to the page.
    Every .scroll-body must compute overscroll-behavior-y 'auto'; a wheel over the capped activity list scrolls the
    list while it can, then (at the bottom) scrolls the PAGE, as does every other overflowing list at its bottom; a
    wheel over a list with no overflow scrolls the page (require_short: the room must show one, e.g. a 3-member list)."""
    pg = r.pg
    obs = pg.evaluate("() => [...document.querySelectorAll('.scroll-body')].map((b) => [b.getAttribute('aria-label'), getComputedStyle(b).overscrollBehaviorY])")
    r.check(obs and all(o == "auto" for _, o in obs), f"scroll chain: overscroll-behavior-y not 'auto' on {obs}")
    # Make sure the page itself can scroll further down whatever the viewport (the behaviour under test is the hand-off).
    pg.evaluate("() => { const s = document.createElement('div'); s.id = 'scroll-chain-spacer'; s.style.height = '3000px'; document.body.appendChild(s); }")

    def wheel_over(loc, dy=240):
        """Put `loc` in view with page room below, wheel once over its visible centre; return (page dy, list dy, hit)."""
        loc.evaluate("(b) => { const t = b.getBoundingClientRect().top + window.scrollY; window.scrollTo(0, Math.max(0, t - 120)); }")
        r.settle(250)
        pt = loc.evaluate("""(b) => { const q = b.getBoundingClientRect(); const top = Math.max(q.top, 0), bot = Math.min(q.bottom, innerHeight);
          const x = q.left + q.width / 2, y = (top + bot) / 2, hit = document.elementFromPoint(x, y);
          return { x, y, hit: !!hit && b.contains(hit) }; }""")
        y0, s0 = pg.evaluate("() => window.scrollY"), loc.evaluate("(b) => b.scrollTop")
        pg.mouse.move(pt["x"], pt["y"]); pg.mouse.wheel(0, dy); r.settle(700)
        return pg.evaluate("() => window.scrollY") - y0, loc.evaluate("(b) => b.scrollTop") - s0, pt["hit"]

    # 1. capped list with room to scroll: the wheel scrolls the list (not broken by the fix)
    activity.evaluate("(b) => { b.scrollTop = 0; }")
    dpage, dlist, hit = wheel_over(activity)
    r.check(hit and dlist > 0, f"scroll chain: wheel over the activity list (top) didn't scroll the list (list +{dlist}, page +{dpage}, hit {hit})")
    # 2. every visible list scrolled to its bottom (activity; members when they overflow): a further wheel scrolls the page
    # 3. every visible list with no overflow (a short member list, a short needs list): a wheel scrolls the page
    lists = pg.locator(".scroll-body")
    n_long = n_short = 0
    for i in range(lists.count()):
        b = lists.nth(i)
        if not b.is_visible() or b.evaluate("(b) => b.getBoundingClientRect().height < 20"): continue
        label = b.get_attribute("aria-label")
        if b.evaluate("(b) => b.scrollHeight > b.clientHeight + 2"):
            n_long += 1
            b.evaluate("(b) => { b.scrollTop = b.scrollHeight; }"); r.settle(200)
            dpage, dlist, hit = wheel_over(b)
            r.check(hit and dpage > 0, f"scroll chain: at the bottom of {label!r} a wheel didn't scroll the page (page +{dpage}, list +{dlist}, hit {hit})")
            b.evaluate("(b) => { b.scrollTop = 0; }")
        else:
            n_short += 1
            dpage, dlist, hit = wheel_over(b)
            r.check(hit and dpage > 0, f"scroll chain: wheel over the short {label!r} (no overflow) didn't scroll the page (page +{dpage}, hit {hit})")
    state = pg.evaluate("() => [...document.querySelectorAll('.scroll-body')].map((b) => [b.getAttribute('aria-label'), b.scrollHeight, b.clientHeight])")
    r.check(n_long >= 1, f"scroll chain: test setup: no overflowing list {state}")
    r.check(n_short >= 1 or not require_short, f"scroll chain: test setup: no visible list without overflow to wheel over {state}")
    pg.evaluate("() => { document.getElementById('scroll-chain-spacer')?.remove(); window.scrollTo(0, 0); }")
    activity.evaluate("(b) => { b.scrollTop = 0; }"); r.settle(300)


def sign_in(r, email, name):
    r.go("/login?return_to=/rooms")
    r.pg.fill("#dev-email", email)
    r.pg.fill("#dev-name", name)
    r.pg.click("button:has-text('Sign in (dev)')")
    r.pg.wait_for_url(ROOMS_URL)
    r.settle(400)


def approve_dialog(r, label="Approve"):
    dlg = r.pg.locator("dialog[open]")
    expect(dlg).to_be_visible()
    dlg.get_by_role("button", name=label).click()
    expect(r.pg.locator("dialog[open]")).to_have_count(0, timeout=8000)
    r.settle(600)


def landing_checks(r):
    """The landing (views/landing.js): one hero CTA, no founder story, every app icon loaded, one wire per chat."""
    pg = r.pg
    r.check(pg.locator("h1").inner_text().replace("\n", " ").strip() == "Every agent chat. One safe room.", "landing: hero title")
    r.check(pg.locator("[data-cta=start]").count() == 1, "landing: hero should have exactly one CTA")
    r.check(pg.locator("#story, .lp-story").count() == 0 and pg.get_by_text("Hi, I'm Charles MJ.").count() == 0, "landing: founder story should be gone")
    for sec in ("connect", "how", "safety", "apps"):
        r.check(pg.locator(f"section#{sec}").count() == 1, f"landing: section #{sec} missing")
    broken = pg.evaluate("() => [...document.querySelectorAll('#main img')].filter((i) => !(i.complete && i.naturalWidth > 0)).map((i) => i.src)")
    r.check(not broken, f"landing: icons not loaded {broken}")
    n = pg.evaluate("() => [...document.querySelectorAll('.lp-chat')].filter((c) => getComputedStyle(c).display !== 'none').length")
    r.check(n > 0 and pg.locator(".lp-wires .lp-wire").count() == n, "landing: one wire per visible chat")


def flow(browser, base, vp):
    r = Run(browser, base, vp)
    pg = r.pg
    r.mock("reset", {})

    # ── landing (signed out) ───────────────────────────────────────────────
    r.go("/")
    r.settle(2800); r.shot("01-landing-start")
    r.audit("landing")
    landing_checks(r)
    r.shot("01-landing-full", full=True)

    # ── docs ───────────────────────────────────────────────────────────────
    r.go("/docs"); r.settle(300)
    r.check(pg.locator(".prose h1").first.inner_text().startswith("bot-link for agents"), "docs: agents.md not rendered")
    r.check(pg.locator(".prose table").count() >= 2, "docs: tables not rendered")
    r.audit("docs", skip_copy=True)  # contract-owned agent doc (mentions /envelope.md); excluded from copy test
    r.shot("02-docs")

    # ── sign in ────────────────────────────────────────────────────────────
    r.go("/")
    pg.click("[data-cta=start]")
    pg.wait_for_url("**/login**"); r.settle(300)
    try: pg.get_by_role("link", name="Continue with GitHub").wait_for(timeout=5000)  # providers load async
    except Exception: pass
    r.check(pg.get_by_role("link", name="Continue with GitHub").is_visible(), "login: GitHub missing")
    r.check(pg.get_by_role("link", name="Continue with Google").is_visible(), "login: Google missing")
    r.check(pg.locator("#dev-email").is_visible(), "login: dev form missing although server lists dev")
    r.audit("login"); r.shot("03-sign-in")
    pg.fill("#dev-email", "nope"); pg.click("button:has-text('Sign in (dev)')"); r.settle(200)
    r.check("valid email" in pg.locator(".form-status").inner_text(), "login: invalid email not reported")
    pg.fill("#dev-email", "adam@acme.dev"); pg.fill("#dev-name", "Adam")
    pg.click("button:has-text('Sign in (dev)')")
    pg.wait_for_url("**/new"); r.settle(400)

    # ── new room ───────────────────────────────────────────────────────────
    r.audit("new-room"); r.shot("04-new-room-empty")
    pg.click("button:has-text('Start the room')"); r.settle(200)
    r.check("name" in pg.locator(".form-status").inner_text().lower(), "new room: empty name not reported")
    pg.fill("#room-name", "Acme Launch!")
    r.check(pg.input_value("#room-name") == "acme-launch", f"new room: slugify gave {pg.input_value('#room-name')}")
    pg.fill("#room-name", "acme")
    pg.fill("#room-purpose", "Ship and grow Acme")
    r.settle(300); r.shot("04-new-room-filled")
    pg.click("button:has-text('Start the room')")
    pg.wait_for_url(re.compile(r".*/rooms/[0-9a-f-]{36}$")); r.settle(1200)
    room_url = pg.url
    r.check(pg.locator(".room-title").inner_text().replace("\n", "") == "#acme", "room: title")
    expect(pg.locator(".fp-chip.ok")).to_be_visible(timeout=5000)  # member list verified in this browser
    r.audit("room-empty"); r.tables("room-empty"); r.shot("05-room-empty", full=True)

    # Name taken on a second create.
    r.go("/new"); pg.fill("#room-name", "acme"); pg.click("button:has-text('Start the room')"); r.settle(600)
    r.check("already have a room" in pg.locator(".form-status").inner_text(), "new room: name_taken not explained")
    pg.fill("#room-name", "side-project"); pg.click("button:has-text('Start the room')")
    pg.wait_for_url(re.compile(r".*/rooms/[0-9a-f-]{36}$")); r.settle(500)

    # ── chat invite: copy, off, on, renew ──────────────────────────────────
    pg.goto(room_url); r.settle(900)
    code_before = pg.locator(".invite-url").inner_text()
    pg.locator(".copy-btn").click(); r.settle(300)
    clip = pg.evaluate("navigator.clipboard.readText()")
    r.check(clip.startswith("join http") and code_before in clip, f"invite: clipboard got {clip!r}")
    pg.locator(".invite-panel details.more > summary", has_text="Options").click(); r.settle(200)
    pg.get_by_role("button", name="Turn off").click(); r.settle(500)
    r.check(pg.locator(".invite-box.is-off").count() == 1, "invite: turning off didn't show")
    r.shot("06-invite-off")
    pg.get_by_role("button", name="Turn on").click(); r.settle(500)
    if pg.locator(".invite-panel details.more[open]").count() == 0: pg.locator(".invite-panel details.more > summary", has_text="Options").click(); r.settle(200)
    pg.get_by_role("button", name="Renew").click(); r.settle(500)
    r.check(pg.locator(".invite-url").inner_text() != code_before, "invite: renew didn't change the code")

    # ── a chat asks to join → approve with the human check ────────────────
    j = r.mock("join", {"room": "acme", "name": "bugfix", "app": "claude-code", "turn": "wake"})
    expect(pg.locator("[data-need=join]")).to_be_visible(timeout=5000)  # arrives via SSE, no reload
    card = pg.locator("[data-need=join]").first
    r.check(card.locator(".match-code").get_attribute("aria-label") == "Code " + " ".join(j["match_code"]), "join card: match code")
    expect(card.locator(".code-row .fp")).to_have_text(j["fingerprint"])  # computed by the browser
    r.check("Approve only if bugfix shows the same code." in card.inner_text(), "join card: match copy")
    # calm pass: the key is proof behind Details, not on the main surface
    r.check(not card.locator(".code-row details.more").first.evaluate("(d) => d.open"), "join card: key details open by default")
    # item 9: who is asking, where it runs, big; the 6-character code in two groups
    facts = card.locator(".rq-facts").inner_text()
    r.check(all(x in facts for x in ["bugfix", "Claude Code", "adams-macbook", "~/acme"]), f"join card: request facts missing ({facts!r})")
    r.check(len(j["match_code"]) == 6 and card.locator(".match-code .mc-sep").count() == 1, "join card: 6-character code not grouped")
    r.audit("room-join-request"); r.shot("07-join-request", full=vp == "desktop")
    card.scroll_into_view_if_needed(); r.shot("07-join-request-card")
    # the needs list scrolls inside its panel, but one whole request (with its Approve button) always fits
    fits = card.evaluate("(c) => { const b = c.closest('.scroll-body'); const br = b.getBoundingClientRect(), cr = c.getBoundingClientRect(); return cr.height <= br.height + 1; }")
    r.check(fits, "needs: a join request card doesn't fit in the capped panel")
    card.get_by_role("button", name="Approve").click()
    expect(pg.locator("dialog[open]")).to_be_visible()
    r.settle(500); r.audit("approve-dialog"); r.shot("08-approve-human-check")
    approve_dialog(r)
    expect(pg.locator(".roster-item", has_text="bugfix")).to_be_visible(timeout=5000)
    r.check("Ready anytime" in pg.locator(".roster-item", has_text="bugfix").inner_text(), "roster: turn label missing")
    expect(pg.locator(".fp-chip.ok")).to_be_visible(timeout=5000)

    # More members so the table looks lived in; one claude-code, codex, cursor, always-on.
    for name, app, turn in [("deployer", "codex", "on_turn"), ("designer", "cursor", "listening"), ("ops-bot", "other", "always_on")]:
        r.mock("join", {"room": "acme", "name": name, "app": app, "turn": turn, "job": {"deployer": "Deploys Acme to prod after checks pass.", "designer": "Owns the pricing page copy and layout.", "ops-bot": "Watches sign-ups and errors around the clock."}[name]})
        expect(pg.locator("[data-need=join]", has_text=name)).to_be_visible(timeout=5000)
        pg.locator("[data-need=join]", has_text=name).get_by_role("button", name="Approve").click()
        approve_dialog(r)
    # item 9: the chat's approve link opens exactly its card; an unknown id is the generic not-found
    j2 = r.mock("join", {"room": "acme", "name": "linked", "app": "codex", "turn": "on_turn", "job": "Came in through the approve link."})
    pg.goto(base + "/approve/" + j2["id"]); r.settle(900)
    expect(pg.locator("[data-need=join]", has_text="linked")).to_be_visible(timeout=5000)
    r.check(pg.locator("[data-need=join]").count() == 1, "approve link: shows more than its own card")
    r.audit("approve-link"); r.shot("07b-approve-link")
    pg.locator("[data-need=join]", has_text="linked").get_by_role("button", name="Approve").click()
    approve_dialog(r)
    expect(pg.locator("text=Done.")).to_be_visible(timeout=5000)
    pg.goto(base + "/approve/01a1b2c3-0000-7000-8000-000000000000"); r.settle(700)
    r.check("No seat here." in pg.locator("main").inner_text(), "approve link: an unknown request isn't the generic not-found")
    pg.goto(room_url); r.settle(900)
    # Reject one.
    r.mock("join", {"room": "acme", "name": "intruder", "app": "other"})
    expect(pg.locator("[data-need=join]", has_text="intruder")).to_be_visible(timeout=5000)
    pg.locator("[data-need=join]", has_text="intruder").get_by_role("button", name="Reject").click()
    expect(pg.locator("[data-need=join]", has_text="intruder")).to_have_count(0, timeout=5000)

    # Activity: metadata only.
    r.mock("activity", {"room": "acme", "items": [{"from": "bugfix", "to": "deployer"}, {"from": "deployer", "to": "bugfix"}, {"from": "designer", "to": None}, {"from": "ops-bot", "to": "bugfix"}]})
    r.settle(900)
    act = pg.locator(".activity").inner_text()
    r.check("bugfix" in act and "everyone" in act, "activity: missing who → whom")
    r.check(pg.locator(".activity .act").count() >= 8, "activity: expected joins + messages")
    capped_lists(r, "acme")

    # Attention items: stuck (Retry), question waiting, can't wake.
    r.mock("attention", {"room": "acme", "kind": "stuck", "member": "deployer"})
    r.mock("attention", {"room": "acme", "kind": "needs_you", "member": "designer"})
    r.mock("attention", {"room": "acme", "kind": "cannot_wake", "member": "bugfix"})
    expect(pg.locator("[data-need=stuck]")).to_be_visible(timeout=5000)
    r.settle(700)
    r.audit("room-full"); r.tables("room-full"); check_caps(r, "room-full"); r.shot("09-room-full", full=True)
    r.pg.locator(".table-scene").first.screenshot(path=str(SHOTS / f"{r.vp}-09-room-table.png"))
    r.shot("09-room-top")
    pg.locator("[data-need=stuck]").get_by_role("button", name="Retry").click()
    expect(pg.locator("[data-need=stuck]")).to_have_count(0, timeout=5000)
    pg.locator("[data-need=needs_you]").get_by_role("button", name="Done").click()
    expect(pg.locator("[data-need=needs_you]")).to_have_count(0, timeout=5000)

    # Member sheet.
    pg.locator(".roster-item", has_text="designer").click()
    expect(pg.locator("dialog[open]")).to_be_visible(); r.settle(400)
    r.audit("member-sheet"); r.shot("10-member-sheet")
    pg.locator("dialog[open] .sheet-close").click(); r.settle(300)

    # Machine move (claim) for bugfix.
    mv = r.mock("join", {"room": "acme", "name": "bugfix", "kind": "claim", "app": "codex", "machine": "laptop-2"})
    expect(pg.locator("[data-need=join]", has_text="move to a new machine")).to_be_visible(timeout=5000)
    pg.locator("[data-need=join]", has_text="move to a new machine").scroll_into_view_if_needed(); r.shot("11-move-request-card")
    pg.locator("[data-need=join]", has_text="move to a new machine").get_by_role("button", name="Approve the move").click()
    approve_dialog(r)
    pg.locator(".roster-item", has_text="bugfix").click()
    expect(pg.locator("dialog[open] .fp")).to_have_text(mv["fingerprint"])
    pg.locator("dialog[open] .sheet-close").click(); r.settle(200)

    # ── person invite: Priya in a second browser ──────────────────────────
    pg.get_by_role("button", name="Invite a person").click(); r.settle(700)
    pinv = pg.evaluate("navigator.clipboard.readText()")
    r.check("/p/" in pinv, f"person invite: clipboard got {pinv!r}")
    r.shot("12-person-invite-created")
    priya = Run(browser, base, vp)
    priya.go("/p/" + pinv.rsplit("/", 1)[1])
    priya.settle(300); priya.audit("person-invite-signed-out"); priya.shot("13-person-invite-signed-out")
    priya.pg.get_by_role("link", name="Sign in to continue").click()
    priya.pg.wait_for_url("**/login**")
    priya.pg.fill("#dev-email", "priya@lumen.ai"); priya.pg.fill("#dev-name", "Priya Sharma")
    priya.pg.click("button:has-text('Sign in (dev)')")
    priya.pg.wait_for_url("**/p/**"); priya.settle(800)
    priya.audit("person-invite"); priya.shot("14-person-invite")
    # before approval: a member count, never who the chats are
    body = priya.pg.locator("main").inner_text()
    priya.check(not any(n in body for n in ("bugfix", "designer")), f"person invite shows member names: {body!r}")
    priya.check(re.search(r"\d+ chats? here", body) is not None, f"person invite lacks the member count: {body!r}")
    priya.pg.get_by_role("button", name="Ask to join").click()
    expect(priya.pg.get_by_role("heading", name="Asked.")).to_be_visible(timeout=5000)
    priya.shot("15-person-asked")
    # Used invite can't be reused.
    priya.go("/p/" + pinv.rsplit("/", 1)[1]); priya.settle(300)
    priya.check("can't be used" in priya.pg.locator("h1").inner_text(), "person invite: reuse not refused")
    expect(pg.locator("[data-need=person]")).to_be_visible(timeout=5000)
    r.shot("16-person-request")
    pg.locator("[data-need=person]").get_by_role("button", name="Approve").click()
    approve_dialog(r)
    expect(pg.locator(".person-row", has_text="Priya Sharma")).to_be_visible(timeout=5000)
    # Priya now sees the room and approves her own chat.
    priya.go("/rooms"); priya.settle(500)
    expect(priya.pg.locator(".room-card", has_text="#acme")).to_be_visible()
    priya.audit("rooms-priya"); priya.shot("17-your-rooms-priya")
    priya.pg.locator(".room-card", has_text="#acme").click(); priya.settle(900)
    pj = priya.mock("join", {"room": "acme", "name": "research", "app": "cursor", "turn": "listening", "for_email": "priya@lumen.ai", "job": "Reads competitor pricing pages and summarizes."})
    expect(priya.pg.locator("[data-need=join]")).to_be_visible(timeout=5000)
    priya.pg.locator("[data-need=join]").get_by_role("button", name="Approve").click()
    approve_dialog(priya)
    expect(priya.pg.locator(".roster-item", has_text="research")).to_be_visible(timeout=5000)
    r.check(pj["fingerprint"] != "", "priya join")
    # Owner sees it live, and as a membership notice (a security event for every other person in the room).
    expect(pg.locator(".roster-item", has_text="research")).to_be_visible(timeout=6000)
    mj = pg.locator("[data-need=member_joined]", has_text="research")
    expect(mj).to_be_visible(timeout=6000)
    r.check("Priya" in mj.inner_text() and "never earlier ones" in mj.inner_text(), f"member_joined card: {mj.inner_text()[:200]}")
    mj.scroll_into_view_if_needed(); r.audit("member-joined"); r.shot("17b-member-joined")
    r.check(priya.pg.locator("[data-need=member_joined]", has_text="research").count() == 0, "the approving person got a notice about their own approval")
    mj.get_by_role("button", name="Got it").click()
    expect(pg.locator("[data-need=member_joined]", has_text="research")).to_have_count(0, timeout=6000)
    # a chat in an app bot-link has no built-in name for (T3 Code): the notice names the app, never "Other app"
    r.mock("attention", {"room": "acme", "kind": "member_joined", "member": "t3chat", "data": {"name": "t3chat", "app": "other", "app_name": "T3 Code", "person_name": "Priya Sharma", "how": "joined", "room_name": "acme", "job": "Reviews pull requests."}})
    t3 = pg.locator("[data-need=member_joined]", has_text="t3chat")
    expect(t3).to_be_visible(timeout=6000)
    r.check("T3 Code" in t3.inner_text() and "Other app" not in t3.inner_text(), f"member_joined card for an app without a built-in name: {t3.inner_text()[:200]}")
    t3.get_by_role("button", name="Got it").click()
    expect(pg.locator("[data-need=member_joined]", has_text="t3chat")).to_have_count(0, timeout=6000)

    # item 11: Priya's chat used Adam's chat invite (the card is Adam's). Priya opens its approve link: she is offered
    # to make it hers, then approves it as her own chat; it leaves Adam's dashboard.
    wl = r.mock("join", {"room": "acme", "name": "wronglink", "app": "codex", "turn": "on_turn", "machine": "priyas-mac", "job": "Pasted the wrong link."})
    expect(pg.locator("[data-need=join]", has_text="wronglink")).to_be_visible(timeout=5000)
    r.check("This becomes YOUR chat." in pg.locator("[data-need=join]", has_text="wronglink").inner_text(), "join card lacks 'This becomes YOUR chat.'")
    priya.go("/approve/" + wl["id"]); priya.settle(900)
    expect(priya.pg.get_by_role("heading", name="This used Adam's link")).to_be_visible(timeout=5000)
    priya.audit("approve-readdress"); priya.shot("17c-approve-readdress")
    priya.pg.get_by_role("button", name="Make it my chat").click()
    expect(priya.pg.locator("[data-need=join]", has_text="wronglink")).to_be_visible(timeout=5000)
    r.check("Adam's chat invite" in priya.pg.locator("[data-need=join]", has_text="wronglink").inner_text(), "taken-over card does not say whose invite it used")
    expect(pg.locator("[data-need=join]", has_text="wronglink")).to_have_count(0, timeout=6000)
    priya.pg.locator("[data-need=join]", has_text="wronglink").get_by_role("button", name="Approve").click()
    approve_dialog(priya)
    expect(priya.pg.locator("text=Done.")).to_be_visible(timeout=5000)
    # anyone else (Adam, the owner) gets the generic not-found for it now
    pg.goto(base + "/approve/" + wl["id"]); r.settle(700)
    r.check("No seat here." in pg.locator("main").inner_text(), "approve link of a decided request isn't the generic not-found")
    pg.goto(room_url); r.settle(900)
    mj2 = pg.locator("[data-need=member_joined]", has_text="wronglink")
    if mj2.count():
        mj2.get_by_role("button", name="Got it").click()

    # ── a new browser for Adam → approve from the first browser ───────────
    adam2 = Run(browser, base, vp)
    sign_in(adam2, "adam@acme.dev", "Adam")
    expect(adam2.pg.locator(".banner", has_text="This browser is new here")).to_be_visible()
    adam2.shot("18-new-browser-banner")
    expect(pg.locator("[data-need=new_device]")).to_be_visible(timeout=6000)
    pg.locator("[data-need=new_device]").scroll_into_view_if_needed(); r.shot("19-new-browser-request")
    pg.locator("[data-need=new_device]").get_by_role("button", name="Approve").click()
    approve_dialog(r)
    adam2.go("/rooms"); adam2.settle(400)
    adam2.check(adam2.pg.locator(".banner", has_text="This browser is new here").count() == 0, "new browser still uncertified after approve")
    adam2.go("/devices"); adam2.settle(600)
    adam2.audit("devices"); adam2.shot("20-devices")
    # security review: "Sign out other browsers" ends the account's other sessions, not this one. A separate account
    # with two browsers, the other one closed first (an open page would log the 401 it then gets as a console error).
    solo1, solo2 = Run(browser, base, vp), Run(browser, base, vp)
    sign_in(solo1, "solo@acme.dev", "Solo"); sign_in(solo2, "solo@acme.dev", "Solo")
    solo1.close()
    solo2.go("/devices"); solo2.settle(600)
    solo2.pg.get_by_role("button", name="Sign out other browsers").click()
    expect(solo2.pg.get_by_text("Signed out 1 other sign-in.")).to_be_visible(timeout=5000)
    solo2.go("/rooms"); solo2.settle(400)
    solo2.check("/login" not in solo2.pg.url, "sign out others signed this browser out too")
    r.errors += solo1.errors + solo2.errors; r.failures += solo1.failures + solo2.failures
    solo2.close()
    adam2.close()

    # ── remove a chat, remove a person, a person leaves ───────────────────
    pg.goto(room_url); r.settle(900)
    r.check(pg.locator(".roster-item", has_text="intruder").count() == 0, "rejected chat got a seat")
    pg.locator(".roster-item", has_text="ops-bot").click()
    pg.locator("dialog[open]").get_by_role("button", name="Remove my chat").click()
    expect(pg.locator("dialog[open]")).to_be_visible(); r.settle(300); r.shot("21-confirm-remove")
    pg.locator("dialog[open]").get_by_role("button", name="Remove").click()
    expect(pg.locator(".roster-item", has_text="ops-bot")).to_have_count(0, timeout=5000)
    expect(pg.locator(".fp-chip.ok")).to_be_visible(timeout=5000)
    # security review (item 9): Remove is on every member row the owner may remove, not only in its details
    row = pg.locator(".ri-row", has_text="deployer")
    expect(row.get_by_role("button", name="Remove deployer")).to_be_visible(timeout=5000)
    row.get_by_role("button", name="Remove deployer").click()
    pg.locator("dialog[open]").get_by_role("button", name="Remove").click()
    expect(pg.locator(".roster-item", has_text="deployer")).to_have_count(0, timeout=5000)
    # mute someone else's chat for my chats (wakes only); the row says so
    pg.locator(".roster-item", has_text="research").click()
    pg.locator("dialog[open]").get_by_role("button", name="Mute for my chats").click()
    expect(pg.locator(".roster-item", has_text="research").locator(".badge", has_text="muted")).to_be_visible(timeout=5000)
    r.shot("21b-muted-member")
    # Priya sees Remove only on her own chat, never on Adam's
    priya.go(room_url.replace(base, "")); priya.settle(800)
    priya.check(priya.pg.locator(".ri-row", has_text="research").count() == 1, "priya has no Remove on her own chat")
    priya.check(priya.pg.locator(".ri-row", has_text="bugfix").count() == 0, "priya can remove the owner's chat")
    # Priya leaves (signs person_remove with her own device).
    priya.go(room_url.replace(base, "")); priya.settle(800)
    priya.pg.get_by_role("button", name="Leave this room").click()
    priya.pg.locator("dialog[open]").get_by_role("button", name="Leave").click()
    priya.pg.wait_for_url(ROOMS_URL); priya.settle(400)
    priya.check(priya.pg.locator(".room-card", has_text="#acme").count() == 0, "priya still sees #acme after leaving")
    expect(pg.locator(".person-row", has_text="Priya Sharma")).to_have_count(0, timeout=6000)
    expect(pg.locator(".roster-item", has_text="research")).to_have_count(0, timeout=6000)
    expect(pg.locator(".fp-chip.ok")).to_be_visible(timeout=5000)

    # ── your rooms + menu + sign out ──────────────────────────────────────
    r.go("/rooms"); r.settle(500)
    r.audit("rooms"); check_caps(r, "rooms"); r.shot("22-your-rooms")
    # security review (item 9): pause all my chats, and resume
    pg.get_by_role("button", name="Pause all my chats").click()
    expect(pg.locator("[data-banner=paused]")).to_be_visible(timeout=5000)
    r.audit("rooms-paused"); r.shot("22b-paused")
    pg.get_by_role("button", name="Resume my chats").click()
    expect(pg.locator("[data-banner=paused]")).to_have_count(0, timeout=5000)
    pg.locator(".me-btn").click(); r.settle(250)
    r.audit("menu"); r.shot("23-account-menu")
    pg.keyboard.press("Escape")
    # Delete the side room.
    pg.locator(".room-card", has_text="#side-project").click(); r.settle(800)
    pg.get_by_role("button", name="Delete this room").click()
    pg.locator("dialog[open]").get_by_role("button", name="Delete room").click()
    pg.wait_for_url(ROOMS_URL); r.settle(500)
    r.check(pg.locator(".room-card", has_text="#side-project").count() == 0, "deleted room still listed")
    pg.locator(".me-btn").click(); pg.get_by_role("menuitem", name="Sign out").click()
    pg.wait_for_url(base + "/"); r.settle(400)
    expect(pg.locator("#nav-side").get_by_role("link", name="Sign in")).to_be_visible(timeout=5000)

    # ── not found ──────────────────────────────────────────────────────────
    r.go("/rooms/00000000-0000-7000-8000-000000000000") ; r.settle(300)  # signed out → login
    r.check("/login" in pg.url, "signed-out room visit should go to login")
    priya.go("/rooms/00000000-0000-7000-8000-000000000000"); priya.settle(400)
    priya.check("No seat here." in priya.pg.inner_text("h1"), "unknown room: not-found page")
    priya.audit("not-found"); priya.shot("24-not-found")
    # Deliberate negative paths log a "Failed to load resource" line each; drop exactly those.
    expected = [(r"401 .*@ .*/app/v1/me", 1), (r"409 .*@ .*/app/v1/rooms$", 1)]
    expected_p = [(r"404 .*@ .*/app/v1/person-invites/[A-Z0-9]{16}$", 1), (r"404 .*@ .*/app/v1/rooms/00000000-", 1)]
    def drop(errs, exp):
        out = list(errs)
        for pat, n in exp:
            for _ in range(n):
                hit = next((e for e in out if re.search(pat, e)), None)
                if hit: out.remove(hit)
        return out
    r.errors = drop(r.errors, expected); priya.errors = drop(priya.errors, expected_p)
    errs, fails = r.errors + priya.errors, r.failures + priya.failures
    priya.close(); r.close()
    return errs, fails


def dark_pass(browser, base, vp):
    """Dark mode pass on a fresh account (a new browser for Adam would rightly be uncertified)."""
    r = Run(browser, base, vp, scheme="dark")
    r.go("/"); r.settle(2800); r.shot("dark-01-landing"); r.audit("dark-landing")
    landing_checks(r)
    r.shot("dark-01-landing-full", full=True)
    sign_in(r, f"dana-{vp}@studio.dev", "Dana")
    r.audit("dark-rooms-empty"); r.shot("dark-03-your-rooms-empty")
    r.go("/new"); r.pg.fill("#room-name", "studio"); r.pg.fill("#room-purpose", "Make the spring campaign")
    r.pg.click("button:has-text('Start the room')")
    r.pg.wait_for_url(re.compile(r".*/rooms/[0-9a-f-]{36}$")); r.settle(900)
    for name, app, turn in [("builder", "claude-code", "wake"), ("shipper", "codex", "on_turn")]:
        r.mock("join", {"room": "studio", "name": name, "app": app, "turn": turn})
        expect(r.pg.locator("[data-need=join]", has_text=name)).to_be_visible(timeout=5000)
        r.pg.locator("[data-need=join]", has_text=name).get_by_role("button", name="Approve").click()
        approve_dialog(r)
    r.mock("join", {"room": "studio", "name": "reviewer", "app": "cursor"})
    expect(r.pg.locator("[data-need=join]")).to_be_visible(timeout=5000)
    r.mock("activity", {"room": "studio", "items": [{"from": "builder", "to": "shipper"}, {"from": "shipper", "to": None}]})
    r.settle(900)
    r.audit("dark-room"); r.tables("dark-room"); r.shot("dark-09-room", full=True)
    capped_lists(r, "studio", prefix="dark-", require_short=True)  # 2 members + a request: short lists
    r.pg.locator(".table-scene").first.screenshot(path=str(SHOTS / f"{r.vp}-dark-09-room-table.png"))
    r.pg.locator("[data-need=join]").get_by_role("button", name="Approve").click(); r.settle(500)
    r.shot("dark-08-approve")
    approve_dialog(r)
    r.go("/rooms"); r.audit("dark-rooms"); check_caps(r, "dark-rooms"); r.shot("dark-22-your-rooms")
    errs, fails = r.errors, r.failures
    r.close()
    return errs, fails


LONG_FOLDER = "~/Library/Application Support/Claude/claude-code-sessions/" + "/".join(["a1b2c3d4e5f6-workspace-scratch"] * 3) + "/checkout-service"


def tall_path_pass(browser, base):
    """: at a 1280x736 window a join request from a ~150-character folder hid Approve inside the capped
    "What needs you" card. Approve must come into view by scrolling the PAGE only, never clipped by its panel."""
    r = Run(browser, base, "desktop", viewport={"width": 1280, "height": 736})
    r.vp = "desktop-736"
    sign_in(r, "tess@paths.dev", "Tess")
    r.go("/new"); r.pg.fill("#room-name", "paths"); r.pg.fill("#room-purpose", "Long folder paths")
    r.pg.click("button:has-text('Start the room')")
    r.pg.wait_for_url(re.compile(r".*/rooms/[0-9a-f-]{36}$")); r.settle(900)
    r.check(len(LONG_FOLDER) >= 140, f"test setup: folder is only {len(LONG_FOLDER)} chars")
    r.mock("join", {"room": "paths", "name": "scratchy", "app": "claude-code", "folder": LONG_FOLDER})
    card = r.pg.locator("[data-need=join]", has_text="scratchy")
    expect(card).to_be_visible(timeout=5000)
    r.settle(500)
    approve = card.get_by_role("button", name="Approve")
    # scroll the PAGE (the window) until Approve's bottom is in the viewport; never scroll inside the card or its panel
    r.pg.evaluate("(el) => { const b = el.getBoundingClientRect(); window.scrollBy(0, Math.max(0, b.bottom - window.innerHeight + 24)); }", approve.element_handle())
    r.settle(400)
    geo = r.pg.evaluate("""(el) => {
      const b = el.getBoundingClientRect();
      const inner = [...document.querySelectorAll('.scroll-body')].filter((x) => x.contains(el)).map((x) => x.scrollTop);
      // every ancestor that clips (overflow not visible) must contain the whole button
      const clipped = [];
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const cs = getComputedStyle(p);
        if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
        const r = p.getBoundingClientRect();
        if (b.top < r.top - 1 || b.bottom > r.bottom + 1 || b.left < r.left - 1 || b.right > r.right + 1) clipped.push(p.className || p.tagName);
      }
      const cx = b.left + b.width / 2, cy = b.top + b.height / 2;
      const hit = document.elementFromPoint(cx, cy);
      return { top: b.top, bottom: b.bottom, vh: window.innerHeight, inner, clipped, hitOk: !!hit && (hit === el || el.contains(hit)),
               overflowX: document.documentElement.scrollWidth > window.innerWidth + 1 };
    }""", approve.element_handle())
    r.check(0 <= geo["top"] and geo["bottom"] <= geo["vh"], f"tall path: Approve not inside the viewport after scrolling the page ({geo})")
    r.check(all(t == 0 for t in geo["inner"]), f"tall path: the card's panel had to scroll inside ({geo['inner']})")
    r.check(not geo["clipped"], f"tall path: Approve clipped by {geo['clipped']}")
    r.check(geo["hitOk"], "tall path: something covers Approve")
    r.check(not geo["overflowX"], "tall path: the page scrolls sideways")
    folder = card.locator(".rq-folder dd span")
    r.check(folder.count() == 1 and folder.get_attribute("title") == LONG_FOLDER and len(folder.inner_text()) < len(LONG_FOLDER), "tall path: folder not shortened with the full path on hover")
    r.shot("07-join-request-long-folder-736")
    approve.click()
    approve_dialog(r)
    expect(r.pg.locator(".roster-item", has_text="scratchy")).to_be_visible(timeout=5000)
    errs, fails = r.errors, r.failures
    r.close()
    return errs, fails


ADMIN_EMAIL = "ops@botlink.test"  # the mock's default MOCK_ADMIN_EMAILS


def admin_pass(browser, base, vp, scheme="light"):
    """Admin area (owner only): locked until the human check, then the live overview; a non-admin sees no trace."""
    pre = "dark-" if scheme == "dark" else ""
    r = Run(browser, base, vp, scheme=scheme)
    pg = r.pg
    sign_in(r, ADMIN_EMAIL, "Ops")
    pg.locator(".me-btn").click(); r.settle(200)
    r.check(pg.get_by_role("menuitem", name="Admin").count() == 1, "admin: no Admin entry in the account menu")
    pg.get_by_role("menuitem", name="Admin").click()
    pg.wait_for_url("**/admin")
    expect(pg.locator(".adm-lock")).to_be_visible(timeout=5000)
    r.settle(300); r.audit(f"{pre}admin-locked"); r.shot(f"{pre}25-admin-locked")
    pg.get_by_role("button", name="Confirm it's you").click()
    expect(pg.locator("dialog[open]")).to_be_visible()
    r.settle(300); r.shot(f"{pre}25b-admin-human-check")
    approve_dialog(r, "Open admin")
    expect(pg.locator(".adm-stats")).to_be_visible(timeout=8000)
    expect(pg.locator(".adm-live")).to_contain_text("Live", timeout=5000)
    for title in ["How messages are moving", "Always-on wake-ups", "Recent server errors", "Quotas", "People", "Rooms", "Members"]:
        r.check(pg.locator(".panel-head h2", has_text=title).count() >= 1, f"admin: panel {title!r} missing")
    body = pg.inner_text("#main")
    r.check(ADMIN_EMAIL in body, "admin: own email should be shown in full")
    r.check(pg.locator(".adm-mail").count() < 2 or "•••@" in body, "admin: other emails should be masked")
    r.check("/take" in body and "/lease" not in body, "admin: route words not mapped")
    pg.locator(".adm-more > summary", has_text="quotas").click()
    r.settle(5600)  # one live refresh
    r.check(pg.locator(".adm-stats").count() == 1, "admin: refresh lost the page")
    r.check(pg.locator(".adm-more[open]").count() == 1, "admin: refresh closed 'All quotas'")
    r.audit(f"{pre}admin"); r.shot(f"{pre}26-admin", full=True); r.shot(f"{pre}26-admin-top")
    pg.get_by_role("button", name="Lock now").click()
    expect(pg.locator(".adm-lock")).to_be_visible(timeout=5000)

    # a non-admin: no menu entry, /admin is not found, the API says 404 like any unknown route
    eve = Run(browser, base, vp, scheme=scheme)
    sign_in(eve, f"eve-{vp}-{scheme}@acme.dev", "Eve")
    eve.pg.locator(".me-btn").click(); eve.settle(200)
    eve.check(eve.pg.get_by_role("menuitem", name="Admin").count() == 0, "non-admin sees the Admin menu entry")
    eve.pg.keyboard.press("Escape")
    eve.go("/admin"); eve.settle(300)
    eve.check("No seat here." in eve.pg.inner_text("h1"), "non-admin /admin should be the not-found page")
    eve.check(eve.pg.locator(".adm-lock, .adm-stats").count() == 0, "non-admin sees admin UI")
    for path in ["/app/v1/admin/overview", "/app/v1/admin/status", "/app/v1/admin/nope"]:
        res = eve.pg.request.get(base + path)
        eve.check(res.status == 404 and res.json()["error"]["code"] == "not_found", f"non-admin GET {path}: {res.status}")
    me = eve.pg.request.get(base + "/app/v1/me").json()
    eve.check("is_admin" not in me, "non-admin /me carries is_admin")
    if scheme == "light":
        eve.audit("admin-non-admin"); eve.shot("27-admin-non-admin")
    errs, fails = r.errors + eve.errors, r.failures + eve.failures
    eve.close(); r.close()
    return errs, fails


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://localhost:8829")
    ap.add_argument("--only", choices=list(VIEWPORTS))
    ap.add_argument("--admin-only", action="store_true", help="run just the admin pass (after a full run seeded the mock)")
    ap.add_argument("--tall-only", action="store_true", help="run just the 1280x736 long-folder Approve check")
    a = ap.parse_args()
    all_errs, all_fails = [], []
    with sync_playwright() as p:
        b = p.chromium.launch()
        if not a.admin_only:
            e0, f0 = tall_path_pass(b, a.base)
            all_errs += e0; all_fails += f0
            print(f"desktop-736: long-folder Approve check, {len(e0)} console errors, {len(f0)} failures")
        for vp in ([] if a.tall_only else [a.only] if a.only else list(VIEWPORTS)):
            t = time.time()
            errs, fails = ([], []) if a.admin_only else flow(b, a.base, vp)
            e2, f2 = ([], []) if a.admin_only else dark_pass(b, a.base, vp)
            for scheme in ("light", "dark"):
                e3, f3 = admin_pass(b, a.base, vp, scheme)
                e2, f2 = e2 + e3, f2 + f3
            all_errs += errs + e2; all_fails += fails + f2
            print(f"{vp}: flow done in {time.time() - t:.1f}s, {len(errs + e2)} console errors, {len(fails + f2)} failures")
        b.close()
    for e in all_errs: print("ERROR", e)
    for f in all_fails: print("FAIL ", f)
    ok = not all_errs and not all_fails
    print("OK" if ok else "NOT OK")
    if not a.only and not a.admin_only and not a.tall_only:  # the cosmetic deploy gate needs both sizes, light + dark (dark_pass)
        from webresult import record
        record("mock", ok, a.base, [f"{vp} light+dark" for vp in VIEWPORTS])
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
