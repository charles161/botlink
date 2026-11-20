"""No paywall (lane FREE, 16 Nov 2026: launch with no paywall), on the fixture server at its default (MOCK_PAYWALL off).

With the paywall off, nothing a signed-in person or the admin sees on any dashboard screen mentions plans, pricing,
credits, upgrades or billing. This walks every screen test_e2e.py visits (its flow, dark pass and admin pass, reused:
every audit and screenshot point is scanned) plus account (and its delete dialog), devices, docs, admin (unlocked,
every section, the refuse-sends dialog), help-lost, login, landing and not-found, signed out, as a person and as the
admin, phone 390x844 and desktop 1440x900. It scans the page text, the document title, every link target (href)
and the open account menu for: plan(s), pricing, price(s), credit(s), upgrade(s), billing, paying phrases with subscription,
"per month", a currency sign before a digit; Pro and Team as case-sensitive whole words. A link to /usage, /billing
or /pricing fails too. Hits on the landing page (views/landing.js, lane LANDING) are printed on their own.
It also checks the mock's half of the contract: /app/v1/me says "paywall": false, every paid route and page is 404,
/usage and /billing are the not-found page, /me/delete has no plan_renews, the admin plans section is gone and the
storage list with "refuse sends" is there.

    python3 web/test/test_free.py                     # starts its own mock (paywall off) on :9710 and stops it after
    python3 web/test/test_free.py --base http://localhost:9711   # a mock you started (MOCK_PAYWALL unset or off)
    python3 web/test/test_free.py --skip-e2e          # only this file's own screens (quicker)
"""
import argparse, os, pathlib, re, subprocess, sys, tempfile, time, traceback, urllib.request
from playwright.sync_api import sync_playwright, expect

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import test_e2e  # noqa: E402
from test_e2e import Run, sign_in, approve_dialog, VIEWPORTS, ADMIN_EMAIL  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parents[2]

WORDS = [
    re.compile(r"\b(plans?|pricing|prices?|credits?|upgrades?|billing|per month)\b", re.I),
    # "subscription" alone is the events and MCP word; only the paying phrases count (as in web/scripts/copy-check.mjs)
    re.compile(r"\b(paid subscriptions?|subscription (plans?|fees?|prices?|tiers?|renews?|renewals?|charges?|costs?)|your subscriptions?|(monthly|yearly|annual) subscriptions?|subscribe to (Pro|Team|a plan|bot-link))\b", re.I),
    re.compile(r"\b(Pro|Team)\b"),
    re.compile(r"[$€£₹]\s?\d"),
]
PAID_PATH = re.compile(r"^/(usage|billing|pricing)(?![\w-])")
# Exact text that holds a listed word but is not about paying, each with its reason. Empty on purpose: add one only
# for a real false hit, never for paid wording.
EXCEPTIONS = [
    ("Owns the pricing page copy and layout.", "a chat's job text that test_e2e.py:386 itself sets (data in a room, not product text)"),
    ("Reads competitor pricing pages and summarizes.", "a chat's job text that test_e2e.py:480 itself sets (data in a room, not product text)"),
]

PAID_PAGES = ["/usage", "/billing", "/billing/fake", "/billing/fake/portal", "/pricing.html", "/pricing.css"]
PAID_GET = ["/app/v1/plan", "/app/v1/usage", "/app/v1/credits", "/app/v1/pricing",
            "/app/v1/admin/plans", "/app/v1/admin/account?account_id=x", "/app/v1/admin/limit-changes", "/app/v1/admin/over-limit"]
PAID_POST = ["/app/v1/billing/checkout", "/app/v1/billing/portal", "/app/v1/billing/fake/pay", "/app/v1/billing/events/dodo",
             "/app/v1/admin/plans/update", "/app/v1/admin/account/raise", "/app/v1/admin/account/boost", "/app/v1/admin/credits/grant"]

SCAN_JS = r"""
() => {
  const main = document.querySelector("#main");
  const shown = (el) => {
    if (["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT", "HEAD"].includes(el.tagName)) return false;
    if (el.tagName === "DIALOG" && !el.open) return false;
    const cs = getComputedStyle(el);
    return cs.display !== "none" && cs.visibility !== "hidden";
  };
  const shell = [];  // everything outside #main: nav, open account menu, footer, banners, dialogs, toasts
  for (let n = main; n && n !== document.body; n = n.parentElement)
    for (const s of n.parentElement.children) if (s !== n && shown(s)) shell.push(s.innerText);
  return {
    route: document.body.dataset.route || "", path: location.pathname, title: document.title,
    main: main ? main.innerText : "", shell: shell.join("\n"),
    links: [...document.querySelectorAll("a[href]")].map((a) => ({ href: a.getAttribute("href"), path: new URL(a.href, location.href).pathname,
      same: new URL(a.href, location.href).origin === location.origin, main: !!(main && main.contains(a)) })),
  };
}
"""


class Hits:
    def __init__(self):
        self.items = {}  # (scope, where, snippet) -> set of screens

    def add(self, scope, screen, where, snippet):
        self.items.setdefault((scope, where, snippet), set()).add(screen)

    def report(self, scope):
        rows = sorted((k, v) for k, v in self.items.items() if k[0] == scope)
        for (_, where, snippet), screens in rows:
            s = sorted(screens)
            print(f"  [{where}] {snippet!r}  on {len(s)} screen(s): {', '.join(s[:6])}{' ...' if len(s) > 6 else ''}")
        return len(rows)


HITS = Hits()


def excused(text, start, end):
    for ex, _why in EXCEPTIONS:
        i = text.find(ex)
        while i >= 0:
            if i <= start and end <= i + len(ex):
                return True
            i = text.find(ex, i + 1)
    return False


def word_hits(text):
    out = []
    for rx in WORDS:
        for m in rx.finditer(text):
            if excused(text, m.start(), m.end()):
                continue
            a, b = text.rfind("\n", 0, m.start()) + 1, text.find("\n", m.end())
            line = text[a: b if b >= 0 else len(text)].strip()
            if len(line) > 140:
                c = m.start() - a
                line = ("…" if c > 60 else "") + line[max(0, c - 60): c + 70] + "…"
            out.append(line)
    return out


def scan(r, name):
    try:
        d = r.pg.evaluate(SCAN_JS)
    except Exception as e:  # a navigation in flight: the next scan point sees the page
        r.check(False, f"{name}: page not scannable ({type(e).__name__})")
        return
    screen = f"{r.vp}{'-dark' if getattr(r, 'scheme', 'light') == 'dark' else ''}:{name}"
    landing = d["route"] == "landing"
    for line in word_hits(d["title"]):
        HITS.add("dashboard", screen, "title", line)
    for line in word_hits(d["shell"]):
        HITS.add("dashboard", screen, "nav/menu/footer/dialog", line)
    for line in word_hits(d["main"]):
        HITS.add("landing" if landing else "dashboard", screen, f"page {d['path']}", line)
    for a in d["links"]:
        scope = "landing" if landing and a["main"] else "dashboard"
        if word_hits(a["href"]) or (a["same"] and not a["href"].startswith("#") and PAID_PATH.search(a["path"])):
            HITS.add(scope, screen, "link", a["href"])


def install_hooks(shots_dir):
    """Every audit() and shot() point of test_e2e.Run also scans; screenshots go to a temp dir, not web/shots."""
    test_e2e.SHOTS = shots_dir
    orig_audit, orig_shot, orig_init = Run.audit, Run.shot, Run.__init__

    def init(self, browser, base, vp_name, scheme="light", viewport=None):
        orig_init(self, browser, base, vp_name, scheme=scheme, viewport=viewport)
        self.scheme = scheme

    def audit(self, name, skip_copy=False):
        scan(self, name)
        return orig_audit(self, name, skip_copy)

    def shot(self, name, full=False):
        scan(self, name)
        return orig_shot(self, name, full)
    Run.__init__, Run.audit, Run.shot = init, audit, shot


def not_found(r, path):
    """In-app navigation (the server answers 404 for the page itself, checked in contract_checks)."""
    r.pg.evaluate("(p) => { history.pushState({}, '', p); dispatchEvent(new PopStateEvent('popstate')); }", path)
    r.settle(600)
    r.check("No seat here." in r.pg.inner_text("h1"), f"{path} should be the not-found page while the paywall is off")
    scan(r, f"{path} (not found)")


def open_menu(r, name):
    r.pg.locator(".me-btn").click(); r.settle(200)
    expect(r.pg.locator("#account-menu")).to_be_visible()
    r.check(r.pg.get_by_role("menuitem", name="Plan and usage").count() == 0, f"{name}: account menu offers Plan and usage")
    scan(r, f"{name} account menu")
    r.pg.keyboard.press("Escape"); r.settle(150)


def contract_checks(r, base):
    """The mock's half of the contract while off (the real server: server/ tests)."""
    pg = r.pg
    me = pg.request.get(base + "/app/v1/me").json()
    r.check(me.get("paywall") is False, f"/app/v1/me paywall should be false, got {me.get('paywall')!r}")
    for path in PAID_GET:
        res = pg.request.get(base + path)
        ok = res.status == 404 and (res.json().get("error") or {}).get("code") == "not_found"
        r.check(ok, f"GET {path}: want 404 not_found, got {res.status}")
    csrf = me.get("csrf_token", "")
    for path in PAID_POST:
        res = pg.request.post(base + path, data={}, headers={"X-CSRF-Token": csrf, "Origin": base})
        ok = res.status == 404 and (res.json().get("error") or {}).get("code") == "not_found"
        r.check(ok, f"POST {path}: want 404 not_found, got {res.status}")
    for path in PAID_PAGES:
        res = pg.request.get(base + path)
        r.check(res.status == 404, f"page {path}: want 404, got {res.status}")
    dele = pg.request.get(base + "/app/v1/me/delete").json()
    r.check("plan_renews" not in dele, "/app/v1/me/delete still has plan_renews")
    exp = pg.request.get(base + "/app/v1/me/export").json()
    r.check("plan" not in exp, "/app/v1/me/export still has a plan group")


def own_screens(browser, base, vp):
    """The screens this file adds on top of test_e2e's: signed out, a person, the admin."""
    out = Run(browser, base, vp)
    for path in ["/", "/login", "/docs", "/help/lost-passkey"]:
        out.go(path); out.settle(2800 if path == "/" else 300)
        scan(out, f"signed out {path}")
    not_found(out, "/no-such-page")  # the mock answers an unknown page with a plain 404, so navigate in the app
    res = out.pg.request.get(base + "/app/v1/pricing")
    out.check(res.status == 404, f"signed out GET /app/v1/pricing: want 404, got {res.status}")

    # a person
    p = Run(browser, base, vp)
    sign_in(p, f"nora-{vp}@free.dev", f"Nora {vp}")
    contract_checks(p, base)
    p.go("/rooms"); p.settle(300); scan(p, "rooms (empty)")
    open_menu(p, "person")
    p.go("/new"); p.settle(300); scan(p, "new room")
    p.pg.fill("#room-name", f"standup-{vp}"); p.pg.fill("#room-purpose", "Daily notes")
    p.pg.click("button:has-text('Start the room')")
    p.pg.wait_for_url(re.compile(r".*/rooms/[0-9a-f-]{36}$")); p.settle(900)
    scan(p, "room")
    p.mock("join", {"room": f"standup-{vp}", "name": "scribe", "app": "claude-code"})
    expect(p.pg.locator("[data-need=join]", has_text="scribe")).to_be_visible(timeout=5000)
    p.pg.locator("[data-need=join]", has_text="scribe").get_by_role("button", name="Approve").click()
    p.settle(300); scan(p, "approve dialog")
    approve_dialog(p)
    scan(p, "room with a member")
    for path in ["/rooms", "/devices", "/docs", "/help/lost-passkey"]:
        p.go(path); p.settle(400); scan(p, f"person {path}")
    p.go("/account"); p.settle(500); scan(p, "account")
    p.pg.fill("#delete-confirm", f"nora-{vp}@free.dev")
    p.pg.get_by_role("button", name="Ask to delete my account").click()
    expect(p.pg.locator("dialog[open]")).to_be_visible(timeout=5000)
    p.settle(300); scan(p, "account delete dialog")
    p.pg.keyboard.press("Escape"); p.settle(300)
    for path in ["/usage", "/billing", "/billing/fake", "/billing/fake/portal", "/nope"]:
        not_found(p, path)

    # the admin
    a = Run(browser, base, vp)
    sign_in(a, ADMIN_EMAIL, "Ops")
    open_menu(a, "admin")
    a.go("/admin")
    expect(a.pg.locator(".adm-lock")).to_be_visible(timeout=5000)
    scan(a, "admin locked")
    a.pg.get_by_role("button", name="Confirm it's you").click()
    expect(a.pg.locator("dialog[open]")).to_be_visible()
    a.settle(300); scan(a, "admin human check")
    approve_dialog(a, "Open admin")
    expect(a.pg.locator(".adm-stats")).to_be_visible(timeout=8000)
    storage = a.pg.locator("#storage")
    expect(storage.locator("table, .adm-empty").first).to_be_visible(timeout=8000)
    a.check(a.pg.locator("#plans").count() == 0, "admin: the plans section is on the page while the paywall is off")
    a.pg.evaluate("() => document.querySelectorAll('details').forEach((d) => { d.open = true; })")
    a.settle(300); scan(a, "admin (every section open)")
    row = storage.locator("tr", has_text=f"Nora {vp}")
    a.check(row.count() >= 1, f"admin storage: Nora {vp} is not listed")
    if row.count():
        row.first.get_by_role("button", name="Refuse sends").click()
        dlg = a.pg.locator("dialog[open]")
        expect(dlg).to_be_visible(timeout=5000)
        a.settle(200); scan(a, "admin refuse sends dialog")
        dlg.locator("input[name=reason]").fill("Test of the stop")
        dlg.get_by_role("button", name="Refuse sends").click()
        expect(a.pg.locator("dialog[open]")).to_have_count(0, timeout=8000)
        expect(storage.locator("tr", has_text=f"Nora {vp}").first).to_contain_text("Refused", timeout=8000)
        a.settle(200); scan(a, "admin after refuse sends")
        storage.locator("tr", has_text=f"Nora {vp}").first.get_by_role("button", name="Allow sends").click()
        dlg = a.pg.locator("dialog[open]")
        expect(dlg).to_be_visible(timeout=5000)
        dlg.locator("input[name=reason]").fill("Test over")
        dlg.get_by_role("button", name="Allow sends").click()
        expect(a.pg.locator("dialog[open]")).to_have_count(0, timeout=8000)
        expect(storage.locator("tr", has_text=f"Nora {vp}").first).not_to_contain_text("Refused", timeout=8000)
    for path in ["/rooms", "/account", "/devices", "/docs"]:
        a.go(path); a.settle(400); scan(a, f"admin {path}")
    for path in ["/usage", "/billing"]:
        not_found(a, path)
    errs = out.errors + p.errors + a.errors
    fails = out.failures + p.failures + a.failures
    for x in (out, p, a):
        x.close()
    return errs, fails


def start_mock(port):
    env = dict(os.environ, PORT=str(port))
    env.pop("MOCK_PAYWALL", None)  # the default must be off
    log = tempfile.NamedTemporaryFile(prefix=f"mock-free-{port}-", suffix=".log", delete=False)
    proc = subprocess.Popen(["node", str(ROOT / "web" / "test" / "fixtures" / "mock-server.mjs")], env=env, stdout=log, stderr=subprocess.STDOUT)
    base = f"http://localhost:{port}"
    for _ in range(100):
        try:
            urllib.request.urlopen(base + "/healthz", timeout=1); return proc, base
        except Exception:
            time.sleep(0.1)
    proc.terminate(); raise SystemExit("mock did not start")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base")
    ap.add_argument("--port", type=int, default=9710)
    ap.add_argument("--only", choices=list(VIEWPORTS))
    ap.add_argument("--skip-e2e", action="store_true", help="only this file's own screens")
    a = ap.parse_args()
    install_hooks(pathlib.Path(tempfile.mkdtemp(prefix="botlink-free-shots-")))
    proc, base = (None, a.base) if a.base else start_mock(a.port)
    errs, fails = [], []
    try:
        with sync_playwright() as p:
            b = p.chromium.launch()
            for vp in [a.only] if a.only else list(VIEWPORTS):
                t = time.time()
                steps = [("own screens", lambda: own_screens(b, base, vp))]
                if not a.skip_e2e:  # test_e2e's own checks are test_e2e's job; here only its screens count
                    steps = [("e2e flow", lambda: (test_e2e.flow(b, base, vp), ([], []))[1]),
                             ("e2e dark", lambda: (test_e2e.dark_pass(b, base, vp), ([], []))[1]),
                             ("e2e admin", lambda: (test_e2e.admin_pass(b, base, vp), ([], []))[1])] + steps
                for name, fn in steps:
                    try:
                        e, f = fn()
                    except Exception as ex:  # a step that breaks is a failure; the other steps still run
                        at = next((f"line {fr.lineno}" for fr in reversed(traceback.extract_tb(ex.__traceback__)) if fr.filename.endswith(("test_free.py", "test_e2e.py"))), "")
                        e, f = [], [f"[{vp}] {name} ({at}): {type(ex).__name__}: {str(ex).splitlines()[0][:300]}"]
                    errs += e; fails += f
                print(f"{vp}: {time.time() - t:.1f}s")
            b.close()
    finally:
        if proc:
            proc.terminate(); proc.wait(5)
    for e in errs: print("ERROR", e)
    for f in fails: print("FAIL ", f)
    print("Paid words on dashboard screens (nav, menu, every view, admin):")
    n_dash = HITS.report("dashboard") or print("  none")
    print("Paid words on the landing page (views/landing.js, lane LANDING):")
    n_land = HITS.report("landing") or print("  none")
    n_dash, n_land = n_dash or 0, n_land or 0
    ok = not errs and not fails and not n_dash and not n_land
    print(f"{n_dash} dashboard hits, {n_land} landing hits, {len(errs)} console errors, {len(fails)} failures")
    if not ok and not errs and not fails and not n_dash:
        print("RED ON THE LANDING ONLY")
    print("OK" if ok else "NOT OK")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
