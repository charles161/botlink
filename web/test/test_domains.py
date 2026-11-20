"""The site, the app and the API on separate hosts, and all three on one host, against the REAL Go server.

Split (prod): one server, one port, three host names: the site `localhost`, the app `app.localhost` (a separate host
whose cookie the site never gets, as with botlink.dev and app.botlink.dev), the API `127.0.0.1` (the client reaches it).

    BOTLINK_ENV=dev BOTLINK_ADDR=127.0.0.1:9780 BOTLINK_DEV_LOGIN=1 BOTLINK_HUMAN_CHECK=stub BOTLINK_METRICS_ADDR=off \\
      BOTLINK_APP_ORIGIN=http://app.localhost:9780 BOTLINK_APP_HOST=app.localhost BOTLINK_API_HOST=127.0.0.1 \\
      BOTLINK_SITE_HOST=localhost BOTLINK_WEBAUTHN_RP_ID=app.localhost BOTLINK_WEB_DIR=web/public \\
      BOTLINK_DATABASE_URL=postgres://botlink@127.0.0.1:55725/botlink_dev .dev/bin/botlink &

One host (staging, test.botlink.dev): the same without BOTLINK_APP_HOST, BOTLINK_API_HOST and BOTLINK_SITE_HOST, with
BOTLINK_APP_ORIGIN=http://127.0.0.1:9781 and BOTLINK_CLIENT_TGZ set, on :9781.

    python3 web/test/test_domains.py [--port 9780] [--one-port 9781] [--only phone|desktop]

Needs client/dist (cd client && npm ci && npm run build): a real chat asks to join. At 390x844 and 1440x900:
- site: the landing page; its "Start a room" and "Sign in" (targets read from the page) end on the app host; it asks
  nothing of /app/v1 and opens no key store; the browser never sends the app's cookie to it; a signed-in person sees
  no app chrome there; back and forward across the two hosts work;
- app: "/" signed out is the sign-in page itself (no landing content, the address stays "/"); "/" signed in is the
  rooms list with "Start a room" and a chat's request to join above the rooms; docs open on the site; signing out
  ends on the sign-in page at "/";
- one host: "/" signed out is the landing page, sign-in one click away on the same host; "/" signed in is the rooms
  list; the client URL is on the host; nothing leaves the host;
- 0 console errors and 0 failed requests.
"""
import argparse, os, pathlib, re, subprocess, sys, tempfile
from playwright.sync_api import sync_playwright, expect

ROOT = pathlib.Path(__file__).resolve().parents[2]
CLI = ROOT / "client" / "dist" / "cli.js"
VIEWPORTS = {"phone": {"width": 390, "height": 844}, "desktop": {"width": 1440, "height": 900}}


def chat_join(api, invite, name):
    """A real chat asks to join (the client against the API host); returns its output."""
    env = dict(os.environ, BOTLINK_SERVER=api, BOTLINK_HOME=tempfile.mkdtemp(prefix=f"bl-dom-{name}-"), BOTLINK_KEYCHAIN="0",
               BOTLINK_SESSION=f"sess-{name}-{os.urandom(3).hex()}")
    r = subprocess.run(["node", str(CLI), "join", invite, "--name", name, "--job", "Checks the host split.", "--no-setup", "--app", "claude-code"],
                       env=env, capture_output=True, text=True, timeout=120)
    assert r.returncode == 0 and "/approve/" in r.stdout + r.stderr, f"join failed: {r.stdout}{r.stderr}"
    return r.stdout


class Page:
    def __init__(self, browser, vp):
        self.vp, self.fails, self.errors, self.requests = vp, [], [], []
        self.ctx = browser.new_context(viewport=VIEWPORTS[vp])
        self.pg = self.ctx.new_page()
        pg = self.pg
        pg.on("console", lambda m: self.errors.append(f"[{vp}] console.{m.type}: {m.text} @ {m.location.get('url', '')}") if m.type == "error" else None)
        pg.on("pageerror", lambda e: self.errors.append(f"[{vp}] pageerror: {e}"))
        pg.on("request", lambda q: self.requests.append(q))
        pg.on("requestfailed", lambda q: self.errors.append(f"[{vp}] request failed: {q.url}") if "/app/v1/events" not in q.url else None)

    def check(self, cond, msg):
        if not cond:
            self.fails.append(f"[{self.vp}] {msg}")

    def go(self, url):
        self.pg.goto(url)
        self.settle()

    def settle(self, ms=300):
        self.pg.wait_for_selector("#main > *")
        self.pg.wait_for_timeout(ms)

    def route(self):
        return self.pg.evaluate("document.body.dataset.route")

    def route_is(self, want, ms=8000):
        """The router drew `want`. The address changes before the page is drawn (pushState, then the view's module
        loads), and the loading skeleton satisfies settle(): under load a fixed wait read the previous route."""
        try:
            self.pg.wait_for_function("(w) => document.body.dataset.route === w", arg=want, timeout=ms)
        except Exception:
            pass
        return self.route() == want

    def calls(self, origin):
        return [q.url for q in self.requests if q.url.startswith(origin) and ("/app/v1/" in q.url or "/api/v1/" in q.url)]

    def link(self, name):
        loc = self.pg.get_by_role("link", name=re.compile(name)).first
        return loc, loc.get_attribute("href") or ""

    def sign_in_dev(self, email, name="Dana"):
        self.pg.wait_for_selector("#dev-email")
        self.pg.fill("#dev-email", email)
        self.pg.fill("#dev-name", name)
        self.pg.click("button:has-text('Sign in (dev)')")


def split(browser, site, app, api, vp):
    p = Page(browser, vp)
    pg, check = p.pg, p.check

    # ── the site host: the landing page, nothing of the app ────────────────
    p.go(site + "/")
    check(p.route_is("landing"), f"site / is not the landing page: {p.route()}")
    check(not p.calls(site), f"the site host called /app/v1 or /api/v1: {p.calls(site)}")
    check(pg.evaluate("indexedDB.databases ? indexedDB.databases().then((d) => d.length) : 0") == 0, "the site host opened a browser key store")
    sign_in, sign_in_href = p.link("^Sign in$")
    start, start_href = p.link("Start a room")
    check(sign_in_href.startswith(app + "/"), f"site Sign in goes to {sign_in_href!r}, not the app host")
    check(start_href.startswith(app + "/"), f"site Start a room goes to {start_href!r}, not the app host")

    # Start a room ends on the app host's sign-in page; back and forward cross the hosts
    start.click()
    pg.wait_for_url(app + "/**")
    pg.wait_for_selector("#dev-email")
    check(pg.url == start_href, f"Start a room landed on {pg.url}, want {start_href}")
    pg.go_back()
    pg.wait_for_url(site + "/")
    p.settle()
    check(p.route_is("landing"), f"back from the app host: {pg.url} {p.route()}")
    pg.go_forward()
    pg.wait_for_url(start_href)
    pg.wait_for_selector("#dev-email")
    p.go(site + "/")
    sign_in, _ = p.link("^Sign in$")
    sign_in.click()
    pg.wait_for_url(sign_in_href)
    pg.wait_for_selector("#dev-email")

    # ── the app host signed out: "/" is the sign-in page itself ─────────────
    p.go(app + "/")
    check(pg.url == app + "/", f"app / signed out moved to {pg.url}")
    check(p.route_is("login") and pg.locator("#dev-email").is_visible(), f"app / signed out is not the sign-in page: {p.route()}")
    check(pg.locator("[data-cta=start], #how, .lp-hero").count() == 0, "app / signed out shows landing content")
    check(pg.locator("meta[name=botlink-host]").get_attribute("content") == "app", "app / is not marked as the app host")

    # sign in right there: the rooms list
    p.sign_in_dev(f"domains-{vp}-{os.urandom(2).hex()}@example.com")
    pg.wait_for_url(app + "/rooms")
    p.settle()
    names = [c["name"] for c in p.ctx.cookies(app)]
    check(names == ["bl_session"], f"session cookie on the app host: {names}")

    # a room, its invite, and a real chat asking to join
    p.go(app + "/new")
    room = f"dom-{vp[:1]}{os.urandom(2).hex()}"
    pg.fill("#room-name", room)
    pg.fill("#room-purpose", "Check the host split")
    pg.click("button:has-text('Start the room')")
    pg.wait_for_url(re.compile(r".*/rooms/[0-9a-f-]{36}$"))
    room_id = pg.url.rsplit("/", 1)[1]
    invite = pg.locator(".invite-url").inner_text().strip()
    check(invite.startswith(app + "/i/"), f"invite link {invite!r} is not on the app host")
    helper = f"helper{vp[:1]}"
    chat_join(api, invite, helper)

    # a room of someone else's that Dana sits in as a person: she may not invite people there
    other = Page(browser, vp)
    other.go(app + "/login?return_to=/new")
    other.sign_in_dev(f"olive-{vp}-{os.urandom(2).hex()}@example.com", "Olive")
    other.pg.wait_for_url(app + "/new")
    theirs = f"olive-{vp[:1]}{os.urandom(2).hex()}"
    other.pg.fill("#room-name", theirs)
    other.pg.click("button:has-text('Start the room')")
    other.pg.wait_for_url(re.compile(r".*/rooms/[0-9a-f-]{36}$"))
    other.pg.get_by_role("button", name="Invite a person").click()
    expect(other.pg.locator(".pinv.is-fresh")).to_be_visible(timeout=8000)
    pinv = other.pg.locator(".pinv.is-fresh .pinv-url").inner_text().rsplit("/", 1)[1]
    p.go(app + f"/p/{pinv}")
    pg.get_by_role("button", name="Ask to join").click()
    expect(pg.get_by_role("heading", name="Asked.")).to_be_visible(timeout=8000)
    other.pg.locator("[data-need=person]").get_by_role("button", name="Approve").click()
    expect(other.pg.locator("dialog[open]")).to_be_visible()
    other.pg.locator("dialog[open]").get_by_role("button", name="Approve").click()
    expect(other.pg.locator("dialog[open]")).to_have_count(0, timeout=8000)
    expect(other.pg.locator(".person-row", has_text="Dana")).to_be_visible(timeout=8000)
    p.errors += other.errors
    other.ctx.close()

    # "/" signed in, the home for rooms, top to bottom: the request waiting for approval (once), "Start a room", the
    # rooms; Dana's own room has an Invite control, the other person's room has none
    p.go(app + "/")
    check(pg.url == app + "/" and p.route_is("rooms"), f"app / signed in: {pg.url} {p.route()}")
    expect(pg.get_by_role("heading", name="Your rooms")).to_be_visible()
    card = pg.locator("[data-need=join]", has_text=helper).first
    expect(card).to_be_visible(timeout=8000)
    mine = pg.locator(".room-card-wrap", has_text=room).first
    theirs_card = pg.locator(".room-card-wrap", has_text=theirs).first
    expect(mine).to_be_visible()
    expect(theirs_card).to_be_visible(timeout=8000)
    p.settle(600)
    shown = pg.locator(f"[data-need=join]:has-text('{helper}'), [data-notify]:has-text('{helper}')").count()
    check(shown == 1, f"the request to join shows {shown} times on the page, want once")
    new_room = pg.locator("#main").get_by_role("link", name=re.compile("Start a room")).first
    check(new_room.is_visible(), "rooms list has no Start a room")
    ys = [card.bounding_box()["y"], new_room.bounding_box()["y"], min(mine.bounding_box()["y"], theirs_card.bounding_box()["y"])]
    check(ys == sorted(ys) and len(set(ys)) == 3, f"order on / is not request, Start a room, rooms: y={ys}")
    inv = mine.get_by_role("link", name=re.compile("^Invite"))
    check(inv.count() == 1, f"own room #{room}: {inv.count()} Invite controls, want 1")
    check(theirs_card.get_by_role("link", name=re.compile("^Invite")).count() == 0, f"#{theirs}: an Invite control where Dana may not invite")
    if inv.count() == 1:
        inv.click()
        pg.wait_for_url(f"{app}/rooms/{room_id}#invite")
        panel = pg.locator("#invite")
        expect(panel.get_by_role("button", name="Invite a person")).to_be_visible(timeout=8000)
        check(pg.locator(".room-page h1").inner_text().strip().lstrip("#") == room, f"Invite opened {pg.locator('.room-page h1').inner_text()!r}")
        top = panel.bounding_box()["y"]
        check(0 <= top < VIEWPORTS[vp]["height"], f"the invite panel is not in view after Invite (y={top})")

    # docs from inside the app open on the site
    pg.locator("footer a", has_text="Docs for agents").click()
    pg.wait_for_url(site + "/docs")
    pg.wait_for_selector("article.prose h1, article.prose h2")

    # ── a signed-in person on the site host: no app chrome, no cookie sent ──
    p.requests.clear()
    p.go(site + "/")
    check(p.route_is("landing"), f"site / after sign-in: {p.route()}")
    check(pg.locator(".me-btn").count() == 0, "the site host shows the account menu")
    check(pg.get_by_role("link", name=re.compile("^Sign in$")).count() >= 1, "the site host shows no Sign in after signing in on the app")
    check(not p.calls(site), f"the site host called /app/v1 or /api/v1 after sign-in: {p.calls(site)}")
    to_site = [q for q in p.requests if q.url.startswith(site + "/")]
    check(to_site, "no request to the site host was seen")
    sent = [q.url for q in to_site if "cookie" in q.all_headers()]
    check(not sent, f"the browser sent a cookie to the site host: {sent}")

    # sign out ends on the app's "/", the sign-in page
    p.go(app + "/rooms")
    pg.locator(".me-btn").click()
    pg.locator(".menu-item", has_text="Sign out").click()
    pg.wait_for_url(app + "/")
    pg.wait_for_selector("#dev-email")
    check(p.route_is("login"), f"after sign-out: {p.route()}")
    check(not p.ctx.cookies(app), f"cookies after sign-out: {[c['name'] for c in p.ctx.cookies(app)]}")

    p.ctx.close()
    return p.errors, p.fails


def one_host(browser, base, vp):
    p = Page(browser, vp)
    pg, check = p.pg, p.check
    p.go(base + "/")
    check(p.route_is("landing"), f"one host / signed out is not the landing page: {p.route()}")
    check(pg.locator("meta[name=botlink-host]").count() == 0, "one host names a host role")
    client = pg.locator("meta[name=botlink-client-url]").get_attribute("content") or ""
    check(client.startswith(base + "/dl/botlink"), f"one host's client URL is not on the host: {client!r}")
    sign_in, sign_in_href = p.link("^Sign in$")
    _, start_href = p.link("Start a room")
    for name, href in (("Sign in", sign_in_href), ("Start a room", start_href)):
        check(href.startswith("/") and not href.startswith("//"), f"one host {name} leaves the host: {href!r}")
    sign_in.click()
    pg.wait_for_url(base + "/login**")
    p.sign_in_dev(f"one-{vp}-{os.urandom(2).hex()}@example.com")
    pg.wait_for_url(base + "/rooms")
    p.settle()
    p.go(base + "/")
    check(pg.url == base + "/" and p.route_is("rooms"), f"one host / signed in: {pg.url} {p.route()}")
    expect(pg.get_by_role("heading", name="Your rooms")).to_be_visible()
    pg.locator("footer a", has_text="Docs for agents").click()
    pg.wait_for_url(base + "/docs")
    pg.wait_for_selector("article.prose h1, article.prose h2")
    p.go(base + "/rooms")
    pg.locator(".me-btn").click()
    pg.locator(".menu-item", has_text="Sign out").click()
    pg.wait_for_url(base + "/")
    p.settle()
    check(p.route_is("landing"), f"one host after sign-out: {p.route()}")
    off = sorted({q.url.split("/")[2] for q in p.requests if q.url.startswith("http")} - {base.split("/")[2]})
    check(not off, f"one host: requests left the host: {off}")
    p.ctx.close()
    return p.errors, p.fails


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=9780)
    ap.add_argument("--one-port", type=int, default=9781)
    ap.add_argument("--only", choices=list(VIEWPORTS))
    a = ap.parse_args()
    site, app, api, one = f"http://localhost:{a.port}", f"http://app.localhost:{a.port}", f"http://127.0.0.1:{a.port}", f"http://127.0.0.1:{a.one_port}"
    if not CLI.exists():
        sys.exit(f"no {CLI}: cd client && npm ci && npm run build")
    all_errs, all_fails = [], []
    with sync_playwright() as p:
        b = p.chromium.launch()
        for vp in ([a.only] if a.only else list(VIEWPORTS)):
            for name, run in (("split", lambda: split(b, site, app, api, vp)), ("one host", lambda: one_host(b, one, vp))):
                errs, fails = run()
                all_errs += errs
                all_fails += fails
                print(f"{vp} {name}: {len(errs)} console errors, {len(fails)} failures")
        b.close()
    for e in all_errs:
        print("ERROR", e)
    for f in all_fails:
        print("FAIL ", f)
    ok = not all_errs and not all_fails
    print("OK" if ok else "NOT OK")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
