"""Landing page check (views/landing.js): 390x844 and 1440x900, light and dark, plus the theme switch.

Asserts: 0 console errors, 0 failed requests, no horizontal overflow, every app icon loaded, one wire per visible chat,
no visible text under 13px, >= 44px tap targets, WCAG AA contrast on every visible text run, no forbidden or internal
words, links point at real routes, and a remembered theme applies before first paint (no flash).
Security is the pitch: the hero's safety line, every "How it's secured" step (title, text, limit) and the note are on
the page exactly as web/public/assets/landing-claims.json says, every rendered step has an entry with sources, and the
"see the actual signed request" link opens the trust page at its anchor.
Screenshots land in web/test/shots-landing/; --founder-shots <dir> also saves the hero and the security section as
landing-{hero,secured}-{desktop,phone}-{light,dark}.png there.

    node web/test/fixtures/mock-server.mjs &           # :8829
    python3 web/test/test_landing.py [--base http://localhost:8829]
"""
import argparse, codecs, json, pathlib, re, sys, urllib.request
from playwright.sync_api import sync_playwright

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from test_e2e import AUDIT_JS, VIEWPORTS  # noqa: E402

SHOTS = pathlib.Path(__file__).resolve().parent / "shots-landing"
CLAIMS = json.loads((pathlib.Path(__file__).resolve().parents[1] / "public" / "assets" / "landing-claims.json").read_text())
PUBLIC = pathlib.Path(__file__).resolve().parents[1] / "public"
SUPPORT = json.loads((PUBLIC / "assets" / "app-support.json").read_text())
# internal names, rot13-encoded so the names themselves are not spelled in this public file
_INTERNAL = "|".join(codecs.decode(w, "rot13") for w in ("rqvgu", "pnera", "nfgen", "zbxh", "fq frafrv", "yvtugfyvcf", "snoyr"))
BAD = re.compile(r"\b(receipts?|seen|answered|webhooks?|delivered|leases?|envelopes?|chatgpt|beta|early access|coming soon|joining soon|" + _INTERNAL + r")\b", re.I)

CONTRAST_JS = r"""
() => {
  const parse = (c) => {
    let m = c.match(/rgba?\(([\d.]+),?\s*([\d.]+),?\s*([\d.]+)(?:[,\/]\s*([\d.]+))?\)/);
    if (m) return [+m[1] / 255, +m[2] / 255, +m[3] / 255, m[4] === undefined ? 1 : +m[4]];
    m = c.match(/color\(srgb ([\d.e-]+) ([\d.e-]+) ([\d.e-]+)(?: \/ ([\d.]+))?\)/);
    if (m) return [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]];
    return null;
  };
  const lum = ([r, g, b]) => { const f = (v) => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const over = (top, bot) => { const a = top[3]; return [0, 1, 2].map((i) => top[i] * a + bot[i] * (1 - a)).concat(1); };
  const bgOf = (el) => {
    const layers = [];
    for (let a = el; a; a = a.parentElement) {
      const c = parse(getComputedStyle(a).backgroundColor);
      if (c && c[3] > 0) { layers.push(c); if (c[3] >= 1) break; }
    }
    let bg = [1, 1, 1, 1];
    for (let i = layers.length - 1; i >= 0; i--) bg = over(layers[i], bg);
    return bg;
  };
  const out = [];
  const walker = document.createTreeWalker(document.querySelector("#app"), NodeFilter.SHOW_TEXT);
  const done = new Set();
  while (walker.nextNode()) {
    const el = walker.currentNode.parentElement;
    if (!walker.currentNode.textContent.trim() || !el || done.has(el)) continue;
    done.add(el);
    if (el.closest("svg, .sr-only, noscript, [hidden]")) continue;
    const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
    if (!r.width || !r.height || cs.visibility === "hidden" || cs.opacity === "0") continue;
    const fg = parse(cs.color); if (!fg) { out.push(`unparsed colour ${cs.color}`); continue; }
    const bg = bgOf(el);
    const f = over(fg, bg);
    const L1 = lum(f), L2 = lum(bg);
    const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
    const size = parseFloat(cs.fontSize), bold = parseInt(cs.fontWeight) >= 700;
    const need = size >= 24 || (bold && size >= 18.66) ? 3 : 4.5;
    if (ratio < need) out.push(`${ratio.toFixed(2)} < ${need}: "${walker.currentNode.textContent.trim().slice(0, 40)}" (${el.tagName}.${el.className})`);
  }
  return out;
}
"""

PAGE_JS = r"""
() => ({
  imgs: [...document.querySelectorAll("#main img")].map((i) => ({ src: i.getAttribute("src"), ok: i.complete && i.naturalWidth > 0 })),
  chats: [...document.querySelectorAll(".lp-chat")].filter((c) => getComputedStyle(c).display !== "none").length,
  wires: document.querySelectorAll(".lp-wires .lp-wire").length,
  links: [...document.querySelectorAll("#app a[href]")].map((a) => a.getAttribute("href")),
  theme: document.documentElement.dataset.theme || null,
  bg: getComputedStyle(document.body).backgroundColor,
})
"""

# The public repository (web/scripts/copy-check.mjs REPO_URL): the landing page links it, typed in its copy.
REPO = "https://github.com/charles161/botlink"
ROUTES = re.compile(r"^(/|/docs|/llms\.txt|/envelope\.md|/api/openapi\.yaml|/(security|privacy|terms)\.html|/trust\.html#server|/rooms|/new|/login\?return_to=%2F(new|rooms)|#(main|connect|how|safety|apps)|" + re.escape(REPO) + r")$")
REPO_JS = """() => [...document.querySelectorAll('#app a[data-repo-link]')].map((a) => ({ href: a.getAttribute("href"), rel: a.getAttribute("rel") || "",
  target: a.getAttribute("target") || "", text: a.textContent.trim(), line: a.parentElement.textContent.replace(/\\s+/g, " ").trim(),
  visible: a.getBoundingClientRect().width > 0 && getComputedStyle(a).visibility !== "hidden" }))"""

SECURED_JS = r"""
() => {
  const t = (el) => (el ? el.textContent.replace(/\s+/g, " ").trim() : null);
  const sec = document.querySelector("#safety");
  return {
    hero: t(document.querySelector(".lp-hero [data-claim=hero]")),
    order: [...document.querySelectorAll("#main section[id]")].map((s) => s.id),
    steps: [...document.querySelectorAll("#safety .lp-secured > li")].map((li) => ({
      id: li.dataset.claim || null, title: t(li.querySelector("h3")), short: t(li.querySelector("h3 + p.lp-short")),
      open: li.querySelector("details.lp-more") ? li.querySelector("details.lp-more").open : null,
      summary: t(li.querySelector("details.lp-more > summary")),
      text: t(li.querySelector("details.lp-more .lp-detail")), limit: t(li.querySelector("details.lp-more .lp-limit")),
      visible: li.getBoundingClientRect().width > 0, right: li.getBoundingClientRect().right })),
    height: sec ? sec.getBoundingClientRect().height : 0,
    hint: t(sec && sec.querySelector(".lp-open-hint")),
    note: t(sec && sec.querySelector("[data-claim=note]")),
    head: t(sec && sec.querySelector(".lp-safe-head")),
    trust: sec && sec.querySelector("a[data-claim-link=trust]") ? sec.querySelector("a[data-claim-link=trust]").getAttribute("href") : null,
    width: document.documentElement.clientWidth,
  };
}
"""


# Measured 16 Nov 2026 at 390x844, every step closed: 1843px (it was 4334px before the steps folded). About two phone
# screens (844px each), with a 57px margin.
SECURED_MAX_PHONE = 1900


def disclosure_checks(pg, tag, fails):
    """Each step's details open by click and by keyboard, and close again."""
    steps = pg.locator("#safety details.lp-more")
    if steps.count() != len(CLAIMS["steps"]): fails.append(f"{tag} {steps.count()} disclosures for {len(CLAIMS['steps'])} steps"); return
    for i in range(steps.count()):
        d = steps.nth(i)
        summ = d.locator("summary")
        summ.click()
        if not d.evaluate("e => e.open"): fails.append(f"{tag} step {i + 1}: a click does not open its details")
        elif not d.locator(".lp-limit, .lp-detail").first.is_visible(): fails.append(f"{tag} step {i + 1}: open details show nothing")
        summ.click()
        if d.evaluate("e => e.open"): fails.append(f"{tag} step {i + 1}: a second click does not close it")
        summ.focus(); pg.keyboard.press("Enter")
        if not d.evaluate("e => e.open"): fails.append(f"{tag} step {i + 1}: Enter on its label does not open its details")
        pg.keyboard.press("Space")
        if d.evaluate("e => e.open"): fails.append(f"{tag} step {i + 1}: Space on its label does not close it")


def secured_checks(pg, base, tag, fails):
    """The security pitch on the page is the generated claims, all of them and nothing more."""
    sq = lambda x: re.sub(r"\s+", " ", x or "").strip()
    d = pg.evaluate(SECURED_JS)
    if d["hero"] != sq(CLAIMS["hero"]["text"]): fails.append(f"{tag} hero safety line is {d['hero']!r}, not the generated one")
    if d["order"][:2] != ["safety", "how"]: fails.append(f"{tag} the security steps should come right after the hero: {d['order']}")
    if "apps" not in d["order"] or d["order"].index("apps") < d["order"].index("safety"): fails.append(f"{tag} the support table should stay, below the security steps: {d['order']}")
    by_id = {c["id"]: c for c in CLAIMS["steps"]}
    if len(d["steps"]) != len(CLAIMS["steps"]): fails.append(f"{tag} {len(d['steps'])} steps rendered, {len(CLAIMS['steps'])} in the claims")
    for i, st in enumerate(d["steps"]):
        c = by_id.get(st["id"])
        if not c: fails.append(f"{tag} step {i + 1} ({st['title']!r}) has no entry in landing-claims.json"); continue
        if not c.get("sources"): fails.append(f"{tag} step {st['id']} has an entry with no source")
        if CLAIMS["steps"][i]["id"] != st["id"]: fails.append(f"{tag} step {i + 1} is {st['id']}, the claims put {CLAIMS['steps'][i]['id']} there")
        if st["title"] != f"Step {i + 1}: {sq(c['title'])}": fails.append(f"{tag} step {st['id']} title {st['title']!r}")
        if st["short"] != sq(c["short"]): fails.append(f"{tag} step {st['id']} short sentence {st['short']!r} differs from the claim")
        if st["open"] is not False: fails.append(f"{tag} step {st['id']}: its details should start closed (open={st['open']})")
        if st["summary"] != sq(CLAIMS["section"]["details_label"]): fails.append(f"{tag} step {st['id']} disclosure label {st['summary']!r}")
        if st["text"] != sq(c["text"]): fails.append(f"{tag} step {st['id']} full text (in the closed details) differs from the claim")
        want = f"{sq(CLAIMS['section']['limit_label'])} {sq(c['caveat'])}" if c.get("caveat") else None
        if st["limit"] != want: fails.append(f"{tag} step {st['id']} limit {st['limit']!r}, want {want!r}")
        if not st["visible"] or st["right"] > d["width"] + 0.5: fails.append(f"{tag} step {st['id']} is cut off ({st['right']:.0f} > {d['width']})")
    if d["hint"] != sq(CLAIMS["section"]["open_hint"]): fails.append(f"{tag} the line saying every step opens to its limits is {d['hint']!r}")
    if tag.startswith("[phone") and d["height"] > SECURED_MAX_PHONE: fails.append(f"{tag} the security section is {d['height']:.0f}px tall at 390 wide with every step closed; at most {SECURED_MAX_PHONE} (about two screens)")
    if d["note"] != sq(CLAIMS["note"]["text"]): fails.append(f"{tag} the note under the steps differs from the claim")
    for k in ("kicker", "title", "lead"):
        if sq(CLAIMS["section"][k]) not in (d["head"] or ""): fails.append(f"{tag} section {k} {CLAIMS['section'][k]!r} not on the page")
    href = CLAIMS["section"]["trust_link"]["href"]
    if d["trust"] != href: fails.append(f"{tag} trust link {d['trust']!r}, want {href!r}")
    else:
        page, anchor = href.split("#")
        try:
            body = urllib.request.urlopen(base + page, timeout=10).read().decode()
            if f'id="{anchor}"' not in body: fails.append(f"{tag} {page} has no #{anchor}")
            if "X-Botlink-Signature" not in body: fails.append(f"{tag} {page} does not show a signed request")
        except Exception as e:
            fails.append(f"{tag} trust link {href} does not resolve: {e}")


APPS_JS = r"""
() => ({
  meta: document.querySelector('meta[name="description"]')?.getAttribute("content") || "",
  eyebrow: (document.querySelector(".lp-eyebrow")?.textContent || "").replace(/\s+/g, " ").trim(),
  rows: [...document.querySelectorAll("#apps .lp-app")].map((li) => {
    const img = li.querySelector(".lp-ic img"), r = img ? img.getBoundingClientRect() : null;
    return { name: (li.querySelector("b")?.textContent || "").trim(), plain: !!li.querySelector(".lp-ic-any"),
      src: img ? img.getAttribute("src") : null, ok: !!img && img.complete && img.naturalWidth > 0, w: r ? r.width : 0, h: r ? r.height : 0,
      turn: (li.querySelector(".lp-app-turn")?.textContent || "").trim() };
  }),
  hero: [...document.querySelectorAll(".lp-chat")].filter((c) => getComputedStyle(c).display !== "none").map((c) => {
    const img = c.querySelector(".lp-ic img");
    return { sub: (c.querySelector("small")?.textContent || "").trim(), src: img ? img.getAttribute("src") : null, ok: !!img && img.complete && img.naturalWidth > 0 };
  }),
})
"""


def apps_checks(pg, tag, fails):
    """Every supported app (a tested row of app-support.json) is in the meta description and the support table with
    how its chats get a turn; an app with an icon of ours shows that icon, loaded, not the plain tile. Grok Bot is in
    the hero too (17 Nov 2026: it was run with bot-link and missing from the page)."""
    d = pg.evaluate(APPS_JS)
    by_name = {r["name"]: r for r in d["rows"]}
    for app in SUPPORT["apps"]:
        if app["state"] not in ("tested", "setup"): continue
        row = by_name.get(app["name"])
        if not row: fails.append(f"{tag} support table has no row for {app['name']}"); continue
        icon = next((f"/assets/apps/{app['key']}.{e}" for e in ("svg", "png") if (PUBLIC / "assets" / "apps" / f"{app['key']}.{e}").exists()), None)
        if icon:
            if row["plain"] or row["src"] != icon: fails.append(f"{tag} {app['name']}: icon {row['src']!r} (plain tile: {row['plain']}), want {icon}")
            elif not row["ok"] or row["w"] < 16 or row["h"] < 16: fails.append(f"{tag} {app['name']}: icon {icon} not rendered (loaded {row['ok']}, {row['w']:.0f}x{row['h']:.0f})")
        if app["state"] == "tested":
            if app["name"] not in d["meta"]: fails.append(f"{tag} meta description does not name {app['name']}: {d['meta']!r}")
            if row["turn"] != app.get("turn"): fails.append(f"{tag} {app['name']}: turn line {row['turn']!r}, want {app.get('turn')!r}")
    if "Grok Bot" not in by_name: fails.append(f"{tag} Grok Bot is not in the support table")
    if "Grok Bot" not in d["eyebrow"]: fails.append(f"{tag} hero eyebrow does not name Grok Bot: {d['eyebrow']!r}")
    grok = [c for c in d["hero"] if c["sub"].startswith("Grok Bot")]
    if not grok: fails.append(f"{tag} no Grok Bot chat visible in the hero map")
    for c in grok:
        if c["src"] != "/assets/apps/grok-bot.png" or not c["ok"]: fails.append(f"{tag} hero Grok Bot chat icon {c['src']!r} loaded {c['ok']}")


def run(browser, base, vp, scheme, fails, founder=None):
    ctx = browser.new_context(viewport=VIEWPORTS[vp], color_scheme=scheme, device_scale_factor=2 if vp == "phone" else 1)
    pg = ctx.new_page()
    tag = f"[{vp} {scheme}]"
    errs = []
    pg.on("console", lambda m: errs.append(f"console.{m.type}: {m.text}") if m.type == "error" else None)
    pg.on("pageerror", lambda e: errs.append(f"pageerror: {e}"))
    pg.on("requestfailed", lambda r: errs.append(f"request failed: {r.url} {r.failure}"))
    pg.on("response", lambda r: errs.append(f"HTTP {r.status}: {r.url}") if r.status >= 400 else None)
    pg.goto(base + "/")
    pg.wait_for_selector(".lp-stage")
    pg.wait_for_selector(".lp-secured")
    pg.wait_for_timeout(3000)  # fonts, wires drawn in
    SHOTS.mkdir(exist_ok=True)
    name = f"{vp}-{scheme}"
    pg.screenshot(path=str(SHOTS / f"{name}-hero.png"))
    if founder:
        founder.mkdir(parents=True, exist_ok=True)
        pg.screenshot(path=str(founder / f"landing-hero-{name}.png"))
        pg.evaluate("() => { document.querySelector('.nav').style.position = 'relative'; }")
        pg.locator("#safety").screenshot(path=str(founder / f"landing-secured-{name}.png"))
        if scheme == "light":
            pg.locator("#safety details.lp-more").nth(1).evaluate("e => { e.open = true; }")
            pg.locator("#safety").screenshot(path=str(founder / f"landing-secured-{name}-open.png"))
            pg.locator("#safety details.lp-more").nth(1).evaluate("e => { e.open = false; }")
        pg.evaluate("() => { document.querySelector('.nav').style.position = ''; window.scrollTo(0, 0); }")
    pg.evaluate("() => { document.querySelector('.nav').style.position = 'relative'; }")
    pg.screenshot(path=str(SHOTS / f"{name}-full.png"), full_page=True)
    pg.evaluate("() => { document.querySelector('.nav').style.position = ''; }")
    for sec in ("connect", "how", "safety", "apps"):
        pg.locator(f"#{sec}").screenshot(path=str(SHOTS / f"{name}-{sec}.png"))
    a = pg.evaluate(AUDIT_JS, False)
    if a["overflow"] > 0: fails.append(f"{tag} horizontal overflow {a['overflow']}px")
    for s in a["small"]: fails.append(f"{tag} text < 13px: {s}")
    for t in a["targets"]: fails.append(f"{tag} tap target < 44px: {t}")
    words = BAD.findall(a["text"])
    if words: fails.append(f"{tag} forbidden words {sorted(set(w.lower() for w in words))}")
    if re.search(r"\bClaude\b(?! Code| Desktop)", a["text"]): fails.append(f"{tag} says 'Claude' without 'Code'")
    for c in pg.evaluate(CONTRAST_JS): fails.append(f"{tag} contrast {c}")
    p = pg.evaluate(PAGE_JS)
    for i in p["imgs"]:
        if not i["ok"]: fails.append(f"{tag} icon not loaded: {i['src']}")
    if len(p["imgs"]) < 20: fails.append(f"{tag} only {len(p['imgs'])} icons on the page")
    if p["wires"] != p["chats"] or not p["chats"]: fails.append(f"{tag} {p['wires']} wires for {p['chats']} chats")
    for href in p["links"]:
        if not ROUTES.match(href): fails.append(f"{tag} unexpected link {href}")
    if pg.locator("[data-cta=start]").count() != 1: fails.append(f"{tag} hero should have exactly one [data-cta=start]")
    # content: yesterday's headline (owner reverted, 2026-11-12), no founder story, no one-command box,
    # no demo slot, footer links to the security / privacy / terms pages, no em dashes
    if pg.locator("h1").inner_text().replace("\n", " ").strip() != "Every agent chat. One safe room.": fails.append(f"{tag} hero title")
    if pg.locator("#story, .lp-story, #demo, .lp-cmd").count(): fails.append(f"{tag} founder story, demo slot or command box is back")
    secured_checks(pg, base, tag, fails)
    apps_checks(pg, tag, fails)
    disclosure_checks(pg, tag, fails)
    for href in ("/security.html", "/privacy.html", "/terms.html", "/trust.html#server"):
        if not pg.locator(f'a[href="{href}"]').count(): fails.append(f"{tag} no link to {href}")
    # the public repository: one plain link, its address typed in the copy, opened in the same tab
    want = {"href": REPO, "rel": "noopener noreferrer", "target": "", "text": "github.com/charles161/botlink", "visible": True}
    repo = pg.evaluate(REPO_JS)
    if len(repo) != 1 or {k: repo[0][k] for k in want} != want: fails.append(f"{tag} want exactly one repository link {want}, got {repo}")
    elif repo[0]["line"] != "The source code is public: github.com/charles161/botlink": fails.append(f"{tag} repository line reads {repo[0]['line']!r}")
    if "\u2014" in a["text"]: fails.append(f"{tag} em dash on the page")
    # a chat lights its line (hover on desktop, tap on phone)
    chat = pg.locator(".lp-chat:visible").first
    chat.click()
    if pg.locator(".lp-inspect .lp-wire.lp-on").count() != 1: fails.append(f"{tag} tapping a chat did not light exactly one line")
    if chat.get_attribute("aria-pressed") != "true": fails.append(f"{tag} tapped chat not aria-pressed")
    if vp == "desktop":
        pg.locator(".lp-chat:visible").nth(3).hover(); pg.wait_for_timeout(350)
        pg.screenshot(path=str(SHOTS / f"{name}-hero-inspect.png"))
    for e in errs: fails.append(f"{tag} {e}")
    ctx.close()


def theme_switch(browser, base, fails):
    """The nav switch flips the theme, remembers it, and a reload applies it before first paint."""
    ctx = browser.new_context(viewport=VIEWPORTS["phone"], color_scheme="light")
    pg = ctx.new_page()
    pg.goto(base + "/"); pg.wait_for_selector(".lp-stage")
    btn = pg.locator(".theme-btn")
    if btn.get_attribute("aria-label") != "Switch to dark mode": fails.append("[theme] switch label in light mode")
    btn.click()
    if pg.evaluate("document.documentElement.dataset.theme") != "dark": fails.append("[theme] click did not switch to dark")
    if pg.evaluate("localStorage.getItem('botlink-theme')") != "dark": fails.append("[theme] choice not remembered")
    # no flash: the theme is set while the document is still parsing (before app.js, before first paint)
    pg.add_init_script("document.addEventListener('readystatechange', () => { if (document.readyState === 'interactive') window.__themeAtParse = document.documentElement.dataset.theme || 'none'; }, { once: true });")
    pg.reload(); pg.wait_for_selector(".lp-stage")
    if pg.evaluate("window.__themeAtParse") != "dark": fails.append(f"[theme] remembered theme not applied before paint: {pg.evaluate('window.__themeAtParse')}")
    if pg.locator(".theme-btn").get_attribute("aria-label") != "Switch to light mode": fails.append("[theme] switch label in dark mode")
    pg.locator(".theme-btn").click()
    if pg.evaluate("document.documentElement.dataset.theme") != "light": fails.append("[theme] second click did not switch back")
    ctx.close()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://localhost:8829")
    ap.add_argument("--founder-shots", type=pathlib.Path, default=None)
    a = ap.parse_args()
    fails = []
    with sync_playwright() as p:
        b = p.chromium.launch()
        for vp in VIEWPORTS:
            for scheme in ("light", "dark"):
                run(b, a.base, vp, scheme, fails, a.founder_shots)
        theme_switch(b, a.base, fails)
        b.close()
    for f in fails: print("FAIL ", f)
    print("OK" if not fails else f"NOT OK ({len(fails)})")
    sys.exit(0 if not fails else 1)


if __name__ == "__main__":
    main()
