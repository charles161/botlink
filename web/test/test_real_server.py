"""Dashboard against the REAL Go server + the REAL client CLI (no fixtures).

The browser signs genesis / member_add / member_rekey / person_add / device_add / removes; the chats
are real `client/dist/cli.js` processes with their own key stores. Asserts the chat's printed code
and key equal what the approve card computed, the chat's approval self-check passes, and the room
fingerprint the chat prints equals the one on the room page.

    BOTLINK_ENV=dev BOTLINK_ADDR=127.0.0.1:8828 BOTLINK_DEV_LOGIN=1 BOTLINK_HUMAN_CHECK=stub \
      BOTLINK_APP_ORIGIN=http://localhost:8828 BOTLINK_WEB_DIR=web/public BOTLINK_METRICS_ADDR=off \
      BOTLINK_ADMIN_EMAILS=ops@botlink.test \
      BOTLINK_DATABASE_URL=postgres://botlink@127.0.0.1:55432/botlink_dev .dev/bin/botlink &
    python3 web/test/test_real_server.py [--base http://localhost:8828] [--only phone|desktop] [--admin-only]

The admin pass signs in as BOTLINK_ADMIN_EMAILS' first address (default ops@botlink.test; override with
--admin-email), so start the server with it.

Each selected viewport runs once in light mode and once in dark mode.
"""
import argparse, os, re, subprocess, sys, tempfile, pathlib, time
from playwright.sync_api import sync_playwright, expect
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from test_e2e import Run, VIEWPORTS, ROOMS_URL, approve_dialog  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parents[2]
CLI = ROOT / "client" / "dist" / "cli.js"


class Chat:
    """One chat on one 'machine' (its own BOTLINK_HOME)."""
    def __init__(self, base, tag):
        self.home = tempfile.mkdtemp(prefix=f"bl-{tag}-")
        self.env = dict(os.environ, BOTLINK_SERVER=base, BOTLINK_HOME=self.home, BOTLINK_KEYCHAIN="0", BOTLINK_SESSION=f"sess-{tag}-{os.urandom(3).hex()}")

    def run(self, *args, timeout=120):
        # cwd: the folder the chat runs in (its join request's folder); None runs where the test runs
        r = subprocess.run(["node", str(CLI), *args], env=self.env, capture_output=True, text=True, timeout=timeout, cwd=getattr(self, "cwd", None))
        return r.returncode, r.stdout + r.stderr

    def join(self, invite, name, app="claude-code", job="Helps with the launch."):
        extra = ("--app-name", "OpenCode") if app == "other" else ()  # the client asks for the app's name for "other"
        self.app = app  # the wait must be the same app (join --wait finishes only this chat's own request)
        rc, out = self.run("join", invite, "--name", name, "--job", job, "--no-setup", "--app", app, *extra)
        # r2 item 9: 6 characters shown as K7Q-2MX, after the approve link
        m = re.search(r"Code ([2-9A-Z]{3})-([2-9A-Z]{3}) · key ([0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4})", out)
        assert rc == 0 and m, f"join failed rc={rc}: {out}"
        link = re.search(r"Approve in the browser: (\S+/approve/[0-9a-f-]{36})", out)
        assert link, f"join printed no approve link: {out}"
        self.approve_url = link.group(1)
        return m.group(1) + m.group(2), m.group(3)

    def wait(self, *cmd):
        rc, out = self.run(*(cmd or ("join", "--wait", "--app", getattr(self, "app", "claude-code"))), timeout=600)
        return rc, out


def flow(browser, base, vp, scheme="light"):
    tag = f"{vp[:1]}{os.urandom(2).hex()}"
    room = f"acme-{tag}"
    r = Run(browser, base, vp, scheme=scheme)
    pg = r.pg
    fails = []
    shot_prefix = "dark-real" if scheme == "dark" else "real"

    def shot(name, full=False):
        r.shot(f"{shot_prefix}-{name}", full)

    r.go(f"/login?return_to=/new")
    pg.fill("#dev-email", f"adam-{tag}@acme.dev"); pg.fill("#dev-name", "Adam")
    pg.click("button:has-text('Sign in (dev)')")
    pg.wait_for_url("**/new")
    pg.fill("#room-name", room); pg.fill("#room-purpose", "Ship and grow Acme")
    pg.click("button:has-text('Start the room')")
    pg.wait_for_url(re.compile(r".*/rooms/[0-9a-f-]{36}$"))
    room_url = pg.url
    expect(pg.locator(".fp-chip.ok")).to_be_visible(timeout=8000)
    room_fp = pg.locator(".fp-chip code").text_content().strip()
    invite = pg.locator(".invite-url").inner_text()
    r.audit("real-room-empty"); shot("05-room-empty", full=True)

    # ── M1: a real chat joins ──────────────────────────────────────────────
    bugfix = Chat(base, f"{tag}-bugfix")
    code, key = bugfix.join(invite, "bugfix", job="Fixed the checkout double-charge bug (commit a1b2c3).")
    # the chat's approve link opens exactly its card (after sign-in, for the invite's person)
    pg.goto(bugfix.approve_url.replace("http://localhost:8828", base)); r.settle(900)
    expect(pg.locator("[data-need=join]", has_text="bugfix")).to_be_visible(timeout=8000)
    r.check(pg.locator("[data-need=join]").count() == 1, "approve link: not exactly its own card")
    facts = pg.locator(".rq-facts").inner_text()
    r.check("bugfix" in facts and "Claude Code" in facts, f"approve link: request facts missing ({facts!r})")
    shot("07b-approve-link")
    pg.goto(room_url); r.settle(900)
    card = pg.locator("[data-need=join]", has_text="bugfix")
    expect(card).to_be_visible(timeout=8000)
    r.check(card.locator(".match-code").get_attribute("aria-label") == "Code " + " ".join(code), "approve card code != chat's code")
    expect(card.locator(".code-row .fp")).to_have_text(key)  # browser-computed key == chat-printed key
    r.audit("real-join-card"); card.scroll_into_view_if_needed(); shot("07-join-request-card")
    card.get_by_role("button", name="Approve").click()
    r.settle(400); shot("08-approve")
    approve_dialog(r)
    rc, out = bugfix.wait()
    r.check(rc == 0 and f"Joined #{room} as bugfix" in out, f"join --wait: rc={rc} {out}")
    r.check(room_fp in out, f"chat's room fingerprint doesn't match the room page ({room_fp}): {out}")
    expect(pg.locator(".roster-item", has_text="bugfix")).to_be_visible(timeout=8000)
    expect(pg.locator(".fp-chip.ok")).to_be_visible(timeout=8000)

    # Reject path.
    intruder = Chat(base, f"{tag}-intruder")
    intruder.join(invite, "intruder", app="other")
    expect(pg.locator("[data-need=join]", has_text="intruder")).to_be_visible(timeout=8000)
    pg.locator("[data-need=join]", has_text="intruder").get_by_role("button", name="Reject").click()
    rc, out = intruder.wait()
    r.check(rc == 4, f"rejected chat should exit 4, got {rc}: {out}")

    # A Codex chat too.
    deployer = Chat(base, f"{tag}-deployer")
    deployer.join(invite, "deployer", app="codex", job="Deploys Acme to prod after checks pass.")
    expect(pg.locator("[data-need=join]", has_text="deployer")).to_be_visible(timeout=8000)
    pg.locator("[data-need=join]", has_text="deployer").get_by_role("button", name="Approve").click()
    approve_dialog(r)
    rc, out = deployer.wait()
    r.check(rc == 0, f"deployer join: {out}")

    # ── move bugfix to a new machine ───────────────────────────────────────
    laptop2 = Chat(base, f"{tag}-laptop2")
    rc, out = laptop2.run("claim", "bugfix", "--invite", invite, "--no-setup", "--app", "codex")
    m = re.search(r"key ([0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4})", out)
    r.check(rc == 0 and m, f"claim --invite: {rc} {out}")
    mv = pg.locator("[data-need=join]", has_text="move to a new machine")
    expect(mv).to_be_visible(timeout=8000)
    if m: expect(mv.locator(".code-row .fp")).to_have_text(m.group(1))
    mv.scroll_into_view_if_needed(); shot("11-move-request")
    mv.get_by_role("button", name="Approve the move").click()
    approve_dialog(r)
    rc, out = laptop2.wait("claim", "--wait")
    r.check(rc == 0, f"claim --wait: {rc} {out}")
    expect(pg.locator(".fp-chip.ok")).to_be_visible(timeout=8000)

    # ── person invite + Priya's own chat ───────────────────────────────────
    pg.get_by_role("button", name="Invite a person").click()
    expect(pg.locator(".pinv.is-fresh")).to_be_visible(timeout=8000)
    pinv = pg.locator(".pinv.is-fresh .pinv-url").inner_text().rsplit("/", 1)[1]
    priya = Run(r.ctx.browser, base, vp, scheme=scheme)
    priya.go(f"/login?return_to=/p/{pinv}")
    priya.pg.fill("#dev-email", f"priya-{tag}@lumen.ai"); priya.pg.fill("#dev-name", "Priya Sharma")
    priya.pg.click("button:has-text('Sign in (dev)')")
    priya.pg.wait_for_url(f"**/p/{pinv}")
    expect(priya.pg.get_by_role("button", name="Ask to join")).to_be_visible(timeout=8000)
    priya.audit("real-person-invite"); priya.shot(f"{shot_prefix}-14-person-invite")
    priya.pg.get_by_role("button", name="Ask to join").click()
    expect(priya.pg.get_by_role("heading", name="Asked.")).to_be_visible(timeout=8000)
    pr = pg.locator("[data-need=person]")
    expect(pr).to_be_visible(timeout=8000)
    pr.get_by_role("button", name="Approve").click()
    approve_dialog(r)
    expect(pg.locator(".person-row", has_text="Priya Sharma")).to_be_visible(timeout=8000)
    priya.go(room_url.replace(base, ""))
    expect(priya.pg.locator(".fp-chip.ok")).to_be_visible(timeout=8000)
    priya_invite = priya.pg.locator(".invite-url").inner_text()
    research = Chat(base, f"{tag}-research")
    research.join(priya_invite, "research", app="cursor", job="Reads competitor pricing pages.")
    expect(priya.pg.locator("[data-need=join]")).to_be_visible(timeout=8000)
    r.check(pg.locator("[data-need=join]", has_text="research").count() == 0, "owner must not see Priya's chat request")
    priya.pg.locator("[data-need=join]").get_by_role("button", name="Approve").click()
    approve_dialog(priya)
    rc, out = research.wait()
    r.check(rc == 0, f"research join: {out}")
    expect(pg.locator(".roster-item", has_text="research")).to_be_visible(timeout=8000)
    r.settle(800)
    r.audit("real-room-full"); shot("09-room-full", full=True)

    # ── a new browser for Adam, approved from the first ────────────────────
    adam2 = Run(r.ctx.browser, base, vp, scheme=scheme)
    adam2.go("/login?return_to=/rooms")
    adam2.pg.fill("#dev-email", f"adam-{tag}@acme.dev"); adam2.pg.click("button:has-text('Sign in (dev)')")
    adam2.pg.wait_for_url(ROOMS_URL)
    expect(adam2.pg.locator(".banner", has_text="This browser is new here")).to_be_visible(timeout=8000)
    nd = pg.locator("[data-need=new_device]")
    expect(nd).to_be_visible(timeout=8000)
    nd.get_by_role("button", name="Approve").click()
    approve_dialog(r)
    adam2.go("/rooms")
    expect(adam2.pg.locator(".banner", has_text="This browser is new here")).to_have_count(0, timeout=8000)
    adam2.go("/devices"); adam2.settle(600); adam2.audit("real-devices"); adam2.shot(f"{shot_prefix}-20-devices")

    # ── remove, leave, activity ────────────────────────────────────────────
    pg.locator(".roster-item", has_text="deployer").click()
    pg.locator("dialog[open]").get_by_role("button", name="Remove my chat").click()
    pg.locator("dialog[open]").get_by_role("button", name="Remove").click()
    expect(pg.locator(".roster-item", has_text="deployer")).to_have_count(0, timeout=8000)
    priya.pg.get_by_role("button", name="Leave this room").click()
    priya.pg.locator("dialog[open]").get_by_role("button", name="Leave").click()
    priya.pg.wait_for_url(ROOMS_URL)
    expect(pg.locator(".person-row", has_text="Priya Sharma")).to_have_count(0, timeout=8000)
    expect(pg.locator(".roster-item", has_text="research")).to_have_count(0, timeout=8000)
    expect(pg.locator(".fp-chip.ok")).to_be_visible(timeout=8000)
    act = pg.locator(".activity").inner_text()
    r.check("bugfix" in act, f"activity missing joins: {act[:200]}")
    r.audit("real-room-after"); shot("21-room-after", full=True)

    # ── rooms list, delete, sign out ───────────────────────────────────────
    r.go("/rooms"); r.audit("real-rooms"); shot("22-your-rooms")
    pg.goto(room_url); expect(pg.get_by_role("button", name="Delete this room")).to_be_visible(timeout=8000)
    pg.get_by_role("button", name="Delete this room").click()
    pg.locator("dialog[open]").get_by_role("button", name="Delete room").click()
    pg.wait_for_url(ROOMS_URL)
    pg.locator(".me-btn").click(); pg.get_by_role("menuitem", name="Sign out").click()
    expect(pg.locator("#nav-side").get_by_role("link", name="Sign in")).to_be_visible(timeout=8000)

    errs = r.errors + priya.errors + adam2.errors
    fails = r.failures + priya.failures + adam2.failures
    for x in (adam2, priya, r): x.close()
    return errs, fails


def android_to_mac(browser, base, scheme="light"):
    """Founder bug: approve the Mac on Android, then approve an agent from the Mac in a room created
    AFTER that (genesis includes every approved browser). A never-approved browser gets a clear per-room state
    and its request shows up on the Android."""
    tag = f"m{os.urandom(2).hex()}"
    email = f"founder-{tag}@acme.dev"
    android = Run(browser, base, "phone", scheme=scheme)
    mac = Run(browser, base, "desktop", scheme=scheme)
    pre = "dark-real" if scheme == "dark" else "real"

    def start_room(run, name):
        run.go("/new"); run.pg.fill("#room-name", name); run.pg.click("button:has-text('Start the room')")
        run.pg.wait_for_url(re.compile(r".*/rooms/[0-9a-f-]{36}$"))
        expect(run.pg.locator(".fp-chip.ok")).to_be_visible(timeout=8000)
        return run.pg.url

    android.go("/login?return_to=/new")
    android.pg.fill("#dev-email", email); android.pg.fill("#dev-name", "Founder")
    android.pg.click("button:has-text('Sign in (dev)')"); android.pg.wait_for_url("**/new")
    start_room(android, f"alpha-{tag}")

    # the Mac signs in: new here; the request shows up on the Android
    mac.go("/login?return_to=/rooms")
    mac.pg.fill("#dev-email", email); mac.pg.click("button:has-text('Sign in (dev)')"); mac.pg.wait_for_url(ROOMS_URL)
    expect(mac.pg.locator(".banner", has_text="This browser is new here")).to_be_visible(timeout=8000)
    android.go("/rooms")
    nd = android.pg.locator("[data-need=new_device]")
    expect(nd).to_be_visible(timeout=8000)
    nd.get_by_role("button", name="Approve").click()
    approve_dialog(android)
    mac.go("/rooms")
    expect(mac.pg.locator("[data-banner=not-signer]")).to_have_count(0, timeout=8000)

    # a room created on the Android AFTER approving the Mac: the Mac can approve a chat there
    beta_url = start_room(android, f"beta-{tag}")
    invite = android.pg.locator(".invite-url").inner_text()
    chat = Chat(base, f"{tag}-macchat")
    code, key = chat.join(invite, "mac-agent", job="Builds the Mac app.")
    mac.go(beta_url.replace(base, ""))
    expect(mac.pg.locator(".fp-chip.ok")).to_be_visible(timeout=8000)
    mac.check(mac.pg.locator("[data-banner=not-signer]").count() == 0, "mac shows not-approved banner in a room created after its approval")
    card = mac.pg.locator("[data-need=join]", has_text="mac-agent")
    expect(card).to_be_visible(timeout=8000)
    expect(card.locator(".code-row .fp")).to_have_text(key)
    mac.check(card.locator(".need-blocker").is_hidden(), "join card blocked on the mac")
    card.get_by_role("button", name="Approve").click()
    approve_dialog(mac)
    rc, out = chat.wait()
    mac.check(rc == 0 and "Joined #beta-" in out, f"mac-approved join: rc={rc} {out}")
    expect(mac.pg.locator(".roster-item", has_text="mac-agent")).to_be_visible(timeout=8000)
    # the Android (another person's view would be the same) sees the join live in activity
    android.go(beta_url.replace(base, ""))
    expect(android.pg.locator(".activity", has_text="mac-agent")).to_be_visible(timeout=8000)

    # a browser that was never approved: a clear per-room state, never a generic error; the request is on the Android
    ipad = Run(browser, base, "phone", scheme=scheme)
    ipad.go("/login?return_to=/rooms")
    ipad.pg.fill("#dev-email", email); ipad.pg.click("button:has-text('Sign in (dev)')"); ipad.pg.wait_for_url(ROOMS_URL)
    ipad.go(beta_url.replace(base, ""))
    banner = ipad.pg.locator("[data-banner=not-signer]")
    expect(banner).to_contain_text(f"isn't approved for #beta-{tag} yet", timeout=8000)
    ipad.audit("real-not-signer"); ipad.shot(f"{pre}-25-not-approved-for-room")
    android.go("/rooms")
    nd = android.pg.locator("[data-need=new_device]")
    expect(nd).to_be_visible(timeout=8000)
    android.shot(f"{pre}-26-new-browser-on-android")
    nd.get_by_role("button", name="Approve").click()
    approve_dialog(android)
    ipad.go(beta_url.replace(base, ""))
    expect(ipad.pg.locator("[data-banner=not-signer]")).to_have_count(0, timeout=8000)

    errs = android.errors + mac.errors + ipad.errors
    fails = android.failures + mac.failures + ipad.failures
    for x in (android, mac, ipad): x.close()
    return errs, fails


def admin_flow(browser, base, vp, email, scheme="light"):
    """Admin area on the real server: stub human check unlocks it, the page renders live data; another account
    gets 404 from every admin route, exactly like an unknown route."""
    pre = "dark-real" if scheme == "dark" else "real"
    r = Run(browser, base, vp, scheme=scheme)
    pg = r.pg
    r.go("/login?return_to=/rooms")
    pg.fill("#dev-email", email); pg.fill("#dev-name", "Ops")
    pg.click("button:has-text('Sign in (dev)')"); pg.wait_for_url(ROOMS_URL)
    r.go("/admin")
    expect(pg.locator(".adm-lock")).to_be_visible(timeout=8000)
    pg.get_by_role("button", name="Confirm it's you").click()
    approve_dialog(r, "Open admin")
    expect(pg.locator(".adm-stats")).to_be_visible(timeout=8000)
    expect(pg.locator(".panel-head h2", has_text="This server copy")).to_be_visible()
    body = pg.inner_text("#main")
    r.check(email in body, "real admin: own email missing")
    r.check("Ready" in body, "real admin: server not ready")
    r.settle(5600)
    r.check(pg.locator(".adm-stats").count() == 1, "real admin: live refresh lost the page")
    r.audit("real-admin"); r.shot(f"{pre}-26-admin", full=True)

    eve = Run(browser, base, vp, scheme=scheme)
    eve.go("/login?return_to=/rooms")
    eve.pg.fill("#dev-email", f"eve-{os.urandom(3).hex()}@acme.dev"); eve.pg.fill("#dev-name", "Eve")
    eve.pg.click("button:has-text('Sign in (dev)')"); eve.pg.wait_for_url(ROOMS_URL)
    unknown = eve.pg.request.get(base + "/app/v1/no-such-route")
    for path in ["/app/v1/admin/overview", "/app/v1/admin/status", "/app/v1/admin/x"]:
        res = eve.pg.request.get(base + path)
        eve.check(res.status == 404 and res.text() == unknown.text(), f"real non-admin GET {path}: {res.status} {res.text()[:80]}")
    me = eve.pg.request.get(base + "/app/v1/me").json()
    eve.check("is_admin" not in me, "real non-admin /me carries is_admin")
    eve.go("/admin"); eve.settle(400)
    eve.check("No seat here." in eve.pg.inner_text("h1"), "real non-admin /admin should be not-found")
    errs, fails = r.errors + eve.errors, r.failures + eve.failures
    eve.close(); r.close()
    return errs, fails


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://localhost:8828")
    ap.add_argument("--only", choices=list(VIEWPORTS))
    ap.add_argument("--admin-only", action="store_true")
    ap.add_argument("--admin-email", default=(os.environ.get("BOTLINK_ADMIN_EMAILS") or "ops@botlink.test").split(",")[0].strip())
    a = ap.parse_args()
    assert a.admin_only or CLI.exists(), f"{CLI} missing (client/ builds it)"
    E, F = [], []
    with sync_playwright() as p:
        b = p.chromium.launch()
        for vp in ([a.only] if a.only else list(VIEWPORTS)):
            for scheme in ("light", "dark"):
                t = time.time()
                e, f = admin_flow(b, a.base, vp, a.admin_email, scheme)
                print(f"{vp} {scheme}: admin {time.time() - t:.0f}s, {len(e)} console errors, {len(f)} failures")
                E += e; F += f
        for vp in ([] if a.admin_only else [a.only] if a.only else list(VIEWPORTS)):
            for scheme in ("light", "dark"):
                t = time.time()
                e, f = flow(b, a.base, vp, scheme)
                print(f"{vp} {scheme}: real flow {time.time() - t:.0f}s, {len(e)} console errors, {len(f)} failures")
                E += e; F += f
        for scheme in ([] if a.admin_only else ("light", "dark")):
            t = time.time()
            e, f = android_to_mac(b, a.base, scheme)
            print(f"android->mac {scheme}: {time.time() - t:.0f}s, {len(e)} console errors, {len(f)} failures")
            E += e; F += f
        b.close()
    for e in E: print("ERROR", e)
    for f in F: print("FAIL ", f)
    ok = not E and not F
    print("OK" if ok else "NOT OK")
    if not a.only and not a.admin_only:  # the cosmetic deploy gate needs both sizes, light + dark
        from webresult import record
        record("real", ok, a.base, [f"{vp} light+dark" for vp in VIEWPORTS])
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
