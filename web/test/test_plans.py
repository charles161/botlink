"""Plans, limits, credits and billing pages (lane D2) on the mock, with screenshots.

Usage page (under a limit, over in count mode, over in block mode, a boost ending, billing off and on), the checkout
flow with its honest waiting state, the admin plans and limits screens (the only-up input, the server's refusal shown),
and the public pricing page with and without the API. Phone 390x844 and desktop 1440x900, light and dark. Every page:
0 console errors, no horizontal overflow, no forbidden words, no text under 13px, tap targets of 44px.

    python3 web/test/test_plans.py                       # starts its own mock on :8945 and stops it after
    MOCK_PAYWALL=on PORT=8829 node web/test/fixtures/mock-server.mjs &
    python3 web/test/test_plans.py --base http://localhost:8829   # a mock you started yourself (paywall on)
"""
import argparse, datetime, json, os, pathlib, re, subprocess, sys, tempfile, time, urllib.request
from playwright.sync_api import sync_playwright, expect

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from test_e2e import Run, sign_in, approve_dialog, VIEWPORTS, SHOTS  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parents[2]
ADMIN_EMAIL = "ops@botlink.test"
COUNT_LINE = "Plan limits block nothing during the beta. Rooms stay readable."


def P(r, name):
    """Screenshot name: plans-<scheme>-<name> (Run.shot adds the viewport)."""
    return f"plans-{r.scheme}-{name}"


def new_run(browser, base, vp, scheme):
    r = Run(browser, base, vp, scheme=scheme)
    r.scheme = scheme
    return r


def person(browser, base, vp, scheme, who, fixture, runs, **mock):
    """A fresh browser signed in as a new account holding one of the mock's fixtures (asha, ben, cara, fresh)."""
    r = new_run(browser, base, vp, scheme)
    runs.append(r)
    email = f"{who}-{vp}-{scheme}@plans.test"
    r.mock("plans", {**mock, "email": email, "display_name": who.capitalize(), "fixture": fixture})
    sign_in(r, email, who.capitalize())
    return r, r.pg


def collect(runs):
    errs, fails = [], []
    for r in runs:
        errs += r.errors; fails += r.failures
        r.close()
    return errs, fails


def usage_pages(browser, base, vp, scheme):
    runs = []
    # ── under every limit (Pro, billing off): no over state, no billing buttons ──
    r, pg = person(browser, base, vp, scheme, "ben", "ben", runs, gateway="off", mode="count")
    pg.locator(".me-btn").click(); r.settle(200)
    item = pg.get_by_role("menuitem", name="Plan and usage")
    r.check(item.count() == 1, "usage: no 'Plan and usage' entry in the account menu")
    item.click()
    pg.wait_for_url("**/usage")
    expect(pg.locator(".lim")).to_have_count(5, timeout=5000)
    r.settle(300)
    r.check("Pro" in pg.inner_text("h1"), f"usage: h1 should name the plan, got {pg.inner_text('h1')!r}")
    r.check(pg.locator(".lim.is-over").count() == 0, "usage (ben): a limit shows over")
    r.check(pg.locator(".usage-over").count() == 0, "usage (ben): over notice shown")
    r.check(pg.locator("[data-checkout], [data-portal]").count() == 0, "usage (ben, billing off): billing buttons shown")
    r.check(pg.locator(".ud-bar").count() == 30, f"usage: expected 30 daily bars, got {pg.locator('.ud-bar').count()}")
    r.check(pg.locator(".credit-balance").inner_text().strip() == "0", "usage (ben): credit balance should be 0")
    for lim in pg.locator(".lim:not([data-limit=storage_mb])").all():
        r.check(lim.locator(".lim-src").inner_text().strip() == "Pro plan", f"usage (ben): source should be 'Pro plan': {lim.inner_text()!r}")
    # stored messages (plan storage_mb): Pro's 1024 MB is capped by the server's per-account ceiling (256 by default)
    st = pg.locator(".lim[data-limit=storage_mb]")
    r.check(st.count() == 1, "usage: no 'Stored messages' row (plan storage_mb)")
    if st.count():
        r.check(st.locator(".lim-name").inner_text().strip() == "Stored messages", f"usage: storage row name {st.locator('.lim-name').inner_text()!r}")
        r.check(st.locator(".lim-num").inner_text().strip() == "1 MB of 256 MB", f"usage (ben): storage numbers {st.locator('.lim-num').inner_text()!r}")
        r.check(st.locator(".lim-src").inner_text().strip() == "the most any account can have", f"usage (ben): storage source {st.locator('.lim-src').inner_text()!r}")
    fine = pg.locator(".usage-limits").inner_text()
    r.check("Past 256 MB, the most any account can have, new messages are refused in every plan" in fine, f"usage: the storage ceiling is not explained: {fine!r}")
    r.check("nothing blocked" not in fine.lower(), f"usage: says nothing is blocked although the storage ceiling refuses: {fine!r}")
    bars = pg.locator(".lim-bar[role=meter]")
    r.check(bars.count() == 4, f"usage: expected 4 meters (history has none), got {bars.count()}")
    r.check(bars.first.get_attribute("aria-valuenow") == "2" and bars.first.get_attribute("aria-valuemax") == "20", "usage: rooms meter values")
    r.audit("usage-under"); r.shot(P(r, "01-usage-under"), full=True)

    # billing on for a paying account: Manage billing, no upgrade
    r.mock("plans", {"gateway": "fake"})
    r.go("/usage"); expect(pg.locator(".lim")).to_have_count(5, timeout=5000)
    r.check(pg.locator("[data-portal]").count() == 1, "usage (ben, billing on): no Manage billing button")
    r.check(pg.locator("[data-checkout^=pro]").count() == 0, "usage (ben, billing on): upgrade offered to a Pro account")
    r.audit("usage-pro-billing")

    # ── over in count mode, a raise, a boost ending in 5 days (Free, asha) ──
    r, pg = person(browser, base, vp, scheme, "asha", "asha", runs, gateway="off", mode="count")
    r.go("/usage"); expect(pg.locator(".lim")).to_have_count(5, timeout=5000); r.settle(300)
    over = pg.locator(".usage-over")
    r.check(over.count() == 1, "usage (asha): no over notice")
    if over.count():
        t = over.inner_text()
        r.check(COUNT_LINE in t, f"usage (asha, count): over notice should say {COUNT_LINE!r}: {t!r}")
        r.check("You have 4 rooms. Your plan allows 3." in t, f"usage (asha): over notice numbers: {t!r}")
        r.check("block mode" not in t, "usage: internal words 'block mode' shown to the person")
    rooms = pg.locator(".lim[data-limit=rooms]")
    r.check("is-over" in (rooms.get_attribute("class") or ""), "usage (asha): rooms row not marked over")
    r.check(rooms.locator(".lim-src").inner_text().strip() == "Free plan", "usage (asha): rooms source")
    r.check(pg.locator(".lim[data-limit=people_per_room] .lim-src").inner_text().strip() == "raised for you", "usage (asha): people source should be 'raised for you'")
    r.check(pg.locator(".lim[data-limit=storage_mb] .lim-num").inner_text().strip() == "41 MB of 256 MB", "usage (asha): storage numbers")
    end = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(days=5))
    end_txt = f"{end.day} {end.strftime('%b')}"
    src = pg.locator(".lim[data-limit=agents_per_room] .lim-src").inner_text().strip()
    r.check(src == f"boost until {end_txt}", f"usage (asha): members source should be 'boost until {end_txt}', got {src!r}")
    r.check("#design" in pg.locator(".lim[data-limit=agents_per_room]").inner_text(), "usage (asha): fullest room not named")
    heads = pg.locator(".usage-note.is-boost")
    r.check(heads.count() == 1 and "end on" in heads.inner_text(), "usage (asha): no boost heads-up")
    r.check(pg.locator(".credit-balance").inner_text().strip() == "250", "usage (asha): credit balance")
    r.check(pg.locator(".ledger tbody tr").count() == 3, "usage (asha): ledger rows")
    r.check("Early tester" in pg.locator(".ledger").inner_text(), "usage (asha): ledger reason missing")
    r.check(pg.locator("[data-checkout], [data-portal]").count() == 0, "usage (asha, billing off): billing buttons shown")
    pg.locator(".ud-more > summary").click(); r.settle(200)
    r.check(pg.locator(".ud-table tbody tr").count() == 30, "usage: daily table should have 30 rows")
    r.audit("usage-over-count"); r.shot(P(r, "02-usage-over-count"), full=True); r.shot(P(r, "02-usage-over-count-top"))

    # ── the same account in block mode: the wording follows the mode ──
    r.mock("plans", {"mode": "block"})
    r.go("/usage"); expect(pg.locator(".usage-over")).to_be_visible(timeout=5000)
    t = pg.locator(".usage-over").inner_text()
    r.check(COUNT_LINE not in t and "can't add more" in t and "stay readable" in t, f"usage (block): wording should follow the mode: {t!r}")
    r.audit("usage-over-block"); r.shot(P(r, "03-usage-over-block"))
    r.mock("plans", {"mode": "off"})
    r.go("/usage"); expect(pg.locator(".lim")).to_have_count(5, timeout=5000)
    r.check(pg.locator(".usage-over").count() == 0 and pg.locator(".lim.is-over").count() == 0, "usage (off): over shown although limits are off")
    r.mock("plans", {"mode": "count"})

    # ── billing on: upgrade buttons and the credits pack, no Manage billing yet ──
    r.mock("plans", {"gateway": "fake"})
    r.go("/usage"); expect(pg.locator(".lim")).to_have_count(5, timeout=5000); r.settle(300)
    r.check(pg.locator("[data-checkout=pro_monthly]").count() == 1 and pg.locator("[data-checkout=pro_yearly]").count() == 1, "usage (billing on): upgrade buttons missing")
    up = pg.locator(".usage-upgrade").inner_text() if pg.locator(".usage-upgrade").count() else ""
    r.check("$15" in up and "$12" in up and "$144" in up, f"usage: upgrade prices {up!r}")
    r.check(pg.locator("[data-checkout=credits_pack]").count() == 1, "usage (billing on): credits pack button missing")
    r.check(pg.locator("[data-portal]").count() == 0, "usage (asha): Manage billing shown without a billing account")
    r.audit("usage-billing-on"); r.shot(P(r, "04-usage-billing-on"), full=True)
    r.mock("plans", {"gateway": "off"})

    # ── cara: Pro ending (cancelled), the plan-ending notice ──
    r, pg = person(browser, base, vp, scheme, "cara", "cara", runs)
    r.go("/usage"); expect(pg.locator(".lim")).to_have_count(5, timeout=5000); r.settle(300)
    r.check(pg.locator(".usage-note.is-ending").count() == 1, "usage (cara): no plan-ending notice")
    r.check("won't renew" in pg.locator(".usage-sub").inner_text(), f"usage (cara): billing line {pg.locator('.usage-sub').inner_text()!r}")
    r.audit("usage-ending"); r.shot(P(r, "05-usage-plan-ending"))
    return collect(runs)


def checkout(browser, base, vp, scheme, still_waiting=False):
    r = new_run(browser, base, vp, scheme)
    pg = r.pg
    email = f"dev-{vp}-{scheme}-{'wait' if still_waiting else 'pay'}@plans.test"
    # the payment is confirmed only when the test says so (apply_pending), so the waiting state is always seen
    r.mock("plans", {"gateway": "fake", "mode": "count", "pay_delay_ms": -1, "email": email, "display_name": "Dev", "fixture": "fresh"})
    sign_in(r, email, "Dev")
    r.go("/usage"); expect(pg.locator("[data-checkout=pro_monthly]")).to_be_visible(timeout=5000)
    pg.locator("[data-checkout=pro_monthly]").click()
    pg.wait_for_url(re.compile(r".*/billing/fake\?checkout=[\w-]+$"), timeout=8000)
    expect(pg.get_by_role("button", name="Pay (test)")).to_be_visible(timeout=5000)
    r.settle(300); r.audit("checkout-fake"); r.shot(P(r, "06-checkout-test-pay"))
    pg.get_by_role("button", name="Pay (test)").click()
    pg.wait_for_url(re.compile(r".*/billing\?checkout=[\w-]+$"), timeout=8000)
    status = pg.locator(".bill-status")
    expect(status).to_contain_text("Waiting for the payment to confirm", timeout=3000)
    r.settle(200); r.audit("checkout-waiting"); r.shot(P(r, "07-checkout-waiting"))
    if still_waiting:
        expect(status).to_contain_text("Still waiting for the payment to confirm", timeout=25000)
        r.check(pg.get_by_role("button", name="Check again").count() == 1, "checkout: no 'Check again' while still waiting")
        r.check(pg.locator("h1").inner_text().strip() != "You're on Pro", "checkout: claimed Pro without the payment")
        r.audit("checkout-still-waiting"); r.shot(P(r, "08-checkout-still-waiting"))
        r.mock("plans", {"apply_pending": True})
        pg.get_by_role("button", name="Check again").click()
        expect(pg.locator("h1")).to_have_text("You're on Pro", timeout=8000)
    else:
        r.settle(1600)
        r.check(pg.locator("h1").inner_text().strip() == "Checking your payment", "checkout: the plan changed before the payment was confirmed")
        r.mock("plans", {"apply_pending": True})
        expect(pg.locator("h1")).to_have_text("You're on Pro", timeout=8000)
        r.audit("checkout-done"); r.shot(P(r, "08-checkout-done"))
        pg.get_by_role("link", name="See your plan").click()
        pg.wait_for_url("**/usage")
        expect(pg.locator(".lim")).to_have_count(5, timeout=5000)
        r.check(pg.locator("h1").inner_text().strip() == "Pro plan", f"checkout: usage h1 after paying {pg.locator('h1').inner_text()!r}")
        r.check(pg.locator("[data-checkout^=pro]").count() == 0, "checkout: still offering Pro after paying")
        r.check(pg.locator("[data-portal]").count() == 1, "checkout: no Manage billing after paying")
        pg.locator("[data-portal]").click()
        pg.wait_for_url(re.compile(r".*/billing/fake/portal\?customer=[\w-]+$"), timeout=8000)
        expect(pg.locator("h1")).to_have_text("Manage billing (test)", timeout=5000)
        r.audit("billing-portal-test")
    errs, fails = r.errors, r.failures
    r.close()
    return errs, fails


def admin_plans(browser, base, vp, scheme, full=True):
    r = new_run(browser, base, vp, scheme)
    pg = r.pg
    target = f"asha-admin-{vp}-{scheme}@plans.test"
    r.mock("plans", {"reset": True, "mode": "count", "gateway": "off", "email": target, "display_name": "Asha", "fixture": "asha"})
    sign_in(r, ADMIN_EMAIL, "Ops")
    r.go("/admin")
    expect(pg.locator(".adm-lock")).to_be_visible(timeout=5000)
    r.check(pg.locator("#plans").count() == 0 or pg.locator("#plans").is_hidden(), "admin: plans shown while locked")
    pg.get_by_role("button", name="Confirm it's you").click()
    approve_dialog(r, "Open admin")
    plans = pg.locator("#plans")
    expect(plans.locator(".plan-form")).to_have_count(3, timeout=8000)
    r.settle(300)
    free = plans.locator(".plan-form[data-plan=free]")
    note = free.locator(".plan-note")
    free.locator("input[name=rooms]").fill("4")
    r.check(re.search(r"Raises rooms for all \d+ accounts on Free now", note.inner_text() or ""), f"admin: raise note {note.inner_text()!r}")
    free.locator("input[name=agents_per_room]").fill("4")
    t = note.inner_text()
    r.check("new accounts only" in t, f"admin: lowering note should say new accounts only: {t!r}")
    free.locator("input[name=agents_per_room]").fill("5")
    # what gets saved: a longer history for everyone on Free (rooms back to 3, so Asha stays over on rooms)
    free.locator("input[name=rooms]").fill("3")
    free.locator("input[name=history_days]").fill("14")
    r.check("Raises days of history for all" in note.inner_text(), f"admin: history raise note {note.inner_text()!r}")
    r.check(free.get_by_role("button", name="Save").is_disabled(), "admin: Save enabled without a reason")
    free.locator("input[name=reason]").fill("Launch week")
    r.check(free.get_by_role("button", name="Save").is_enabled(), "admin: Save disabled with a change and a reason")
    if full:
        free.get_by_role("button", name="Save").click()
        expect(free.locator(".form-status")).to_contain_text("apply to every account on this plan now", timeout=5000)
        expect(plans.locator(".change-log")).to_contain_text("Launch week", timeout=5000)
        r.check(free.locator("input[name=history_days]").input_value() == "14", "admin: plan form not updated after save")

    # find the account (by exact email: shown in full) and raise a limit
    plans.locator("input[name=who]").fill(target)
    plans.get_by_role("button", name="Find").click()
    acct = plans.locator(".acct")
    expect(acct).to_be_visible(timeout=5000)
    r.check(target in acct.inner_text(), "admin: email looked up by should show in full")
    raise_form = acct.locator(".raise-form")
    raise_form.locator("select[name=limit]").select_option("people_per_room")
    val = raise_form.locator("input[name=value]")
    r.check(val.get_attribute("min") == "7", f"admin: raise min should be 7 (current 6), got {val.get_attribute('min')}")
    raise_form.locator("input[name=reason]").fill("Asked for a bigger room")
    val.fill("5")
    r.check(raise_form.get_by_role("button", name="Raise").is_disabled(), "admin: Raise enabled with a lower value")
    r.check(val.get_attribute("aria-invalid") == "true", "admin: a lower value is not marked invalid")
    val.blur(); r.settle(100)
    r.check(val.input_value() == "7", f"admin: a lower value should be lifted to the minimum on blur, got {val.input_value()!r}")
    r.audit("admin-plans"); r.shot(P(r, "10-admin-plans"), full=True)
    if not full:
        errs, fails = r.errors, r.failures
        r.close()
        return errs, fails
    val.fill("8")
    raise_form.get_by_role("button", name="Raise").click()
    expect(acct.locator(".acct-limits")).to_contain_text("8", timeout=5000)
    r.check("raised for you" in acct.locator(".acct-limits").inner_text(), "admin: raise not shown on the account")

    # someone else raised it meanwhile: the page still says 8, the server says 12 and refuses 10; its message shows
    me = pg.request.get(base + "/app/v1/me").json()
    acct_id = acct.get_attribute("data-account")
    res = pg.request.post(base + "/app/v1/admin/account/raise", headers={"X-CSRF-Token": me["csrf_token"], "Origin": base},
                          data={"account_id": acct_id, "limit": "people_per_room", "value": 12, "reason": "other admin"})
    r.check(res.ok, f"admin: direct raise failed {res.status}")
    raise_form = acct.locator(".raise-form")
    raise_form.locator("select[name=limit]").select_option("people_per_room")
    raise_form.locator("input[name=value]").fill("10")
    raise_form.locator("input[name=reason]").fill("Stale page")
    before = len(r.errors)
    raise_form.get_by_role("button", name="Raise").click()
    expect(raise_form.locator(".form-status")).to_contain_text("A limit can only go up. This account already has 12.", timeout=5000)
    r.errors[before:] = [e for e in r.errors[before:] if "status of 409" not in e]  # the refusal under test
    r.check(raise_form.locator("input[name=value]").get_attribute("min") == "13", "admin: after the refusal the minimum should follow the server (13)")

    # a boost with an end date
    boost = acct.locator(".boost-form")
    boost.locator("select[name=limit]").select_option("history_days")
    boost.locator("input[name=value]").fill("14")
    end = (datetime.date.today() + datetime.timedelta(days=10)).isoformat()
    boost.locator("input[name=ends]").fill(end)
    boost.locator("input[name=reason]").fill("Workshop")
    boost.get_by_role("button", name="Add boost").click()
    expect(acct.locator(".acct-boosts")).to_contain_text("Workshop", timeout=5000)

    # free credits with a reason
    grant = acct.locator(".grant-form")
    grant.locator("input[name=amount]").fill("100")
    grant.locator("input[name=reason]").fill("Thanks for testing")
    grant.get_by_role("button", name="Grant credits").click()
    expect(acct.locator(".acct-balance")).to_have_text("350", timeout=5000)
    expect(plans.locator(".change-log")).to_contain_text("Thanks for testing", timeout=5000)

    # who is over a limit (emails stay shortened, like the overview)
    ol = plans.locator(".over-list")
    expect(ol).to_contain_text("Asha", timeout=5000)
    r.check("•••@" in ol.inner_text() and target not in ol.inner_text(), "admin: over-limit list should show shortened emails")
    r.settle(5600)  # one overview refresh: the plans section keeps its state
    r.check(acct.is_visible(), "admin: the live refresh wiped the plans section")
    r.audit("admin-plans-after"); r.shot(P(r, "11-admin-plans-after"), full=True)
    errs, fails = r.errors, r.failures
    r.close()
    return errs, fails


def pricing(browser, base, vp, scheme):
    r = new_run(browser, base, vp, scheme)
    pg = r.pg
    r.mock("plans", {"mode": "count"})
    # with the API: its numbers win (a changed Free plan shows), and the beta line appears in count mode
    api = json.loads(urllib.request.urlopen(base + "/app/v1/pricing").read())
    for p in api["plans"]:
        if p["id"] == "free": p["rooms"] = 5
    pg.route("**/app/v1/pricing", lambda route: route.fulfill(status=200, content_type="application/json", body=json.dumps(api)))
    pg.goto(base + "/pricing.html"); r.settle(600)
    num = lambda plan, k: pg.locator(f"[data-plan={plan}][data-k={k}]").first.inner_text().strip()
    r.check(num("free", "rooms") == "5", f"pricing: Free rooms should come from the API (5), got {num('free', 'rooms')!r}")
    r.check(num("pro", "rooms") == "20", "pricing: Pro rooms")
    r.check(pg.locator("#beta").is_visible(), "pricing: beta line hidden although the API says count")
    body = pg.inner_text("body")
    for s in ["Priced per person. Agents and messages are never billed.", "$15", "$12", "Team", "Later"]:
        r.check(s in body, f"pricing: missing {s!r}")
    r.audit("pricing-api"); r.shot(P(r, "20b-pricing-api-free-rooms-5"), full=True)
    pg.unroute("**/app/v1/pricing")

    # without the API: the decided numbers, no beta line, and the failed request is the only console noise
    pg.route("**/app/v1/pricing", lambda route: route.fulfill(status=404, content_type="application/json", body='{"error":{"code":"not_found","message":"Not found."}}'))
    before = len(r.errors)
    pg.goto(base + "/pricing.html"); r.settle(600)
    r.errors[before:] = [e for e in r.errors[before:] if "Failed to load resource" not in e]
    for plan, k, want in [("free", "rooms", "3"), ("free", "agents_per_room", "5"), ("free", "people_per_room", "4"), ("free", "history_days", "7"),
                          ("pro", "rooms", "20"), ("pro", "agents_per_room", "20"), ("pro", "people_per_room", "10"), ("pro", "history_days", "30"),
                          ("free", "storage_mb", "256"), ("pro", "storage_mb", "1024")]:
        r.check(num(plan, k) == want, f"pricing (no API): {plan} {k} should be {want}, got {num(plan, k)!r}")
    r.check(pg.locator("[data-price=pro_monthly]").inner_text().strip() == "$15" and pg.locator("[data-price=pro_yearly]").inner_text().strip() == "$12", "pricing (no API): prices")
    r.check(pg.locator("#beta").is_hidden(), "pricing (no API): beta line shown without the API saying so")
    r.audit("pricing-no-api"); r.shot(P(r, "20-pricing"), full=True)
    pg.unroute("**/app/v1/pricing")

    # not linked from the landing page, the nav or the other static pages (Charles decides when it goes live)
    r.go("/"); r.settle(300)
    r.check(pg.locator("a[href*=pricing]").count() == 0, "pricing: linked from the landing page or nav")
    for page in ["/privacy.html", "/security.html", "/terms.html"]:
        pg.goto(base + page)
        r.check(pg.locator("a[href*=pricing]").count() == 0, f"pricing: linked from {page}")
    errs, fails = r.errors, r.failures
    r.close()
    return errs, fails


def start_mock(port):
    env = dict(os.environ, PORT=str(port), MOCK_PAYWALL="on")  # these screens exist only with the paywall on
    log = tempfile.NamedTemporaryFile(prefix=f"mock-plans-{port}-", suffix=".log", delete=False)  # outside the repo
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
    ap.add_argument("--port", type=int, default=8945)
    ap.add_argument("--only", choices=list(VIEWPORTS))
    ap.add_argument("--scheme", choices=["light", "dark"])
    ap.add_argument("--skip-wait", action="store_true", help="skip the 'still waiting' checkout case (about 20 s)")
    a = ap.parse_args()
    proc = None
    base = a.base
    if not base:
        proc, base = start_mock(a.port)
    all_errs, all_fails, steps = [], [], 0
    try:
        with sync_playwright() as p:
            b = p.chromium.launch()
            for vp in [a.only] if a.only else list(VIEWPORTS):
                for scheme in [a.scheme] if a.scheme else ["light", "dark"]:
                    t = time.time()
                    for name, fn in [("usage", lambda: usage_pages(b, base, vp, scheme)),
                                     ("checkout", lambda: checkout(b, base, vp, scheme)),
                                     ("admin", lambda: admin_plans(b, base, vp, scheme, full=scheme == "light")),
                                     ("pricing", lambda: pricing(b, base, vp, scheme))]:
                        try:
                            e, f = fn()
                        except Exception as ex:  # a step that breaks is a failure; the other steps still run
                            e, f = [], [f"[{vp}-{scheme}] {name}: {type(ex).__name__}: {str(ex).splitlines()[0][:300]}"]
                        steps += 1
                        all_errs += e; all_fails += f
                        print(f"{vp}-{scheme} {name}: {len(e)} console errors, {len(f)} failures")
                    print(f"{vp}-{scheme}: {time.time() - t:.1f}s")
            if not a.skip_wait:
                e, f = checkout(b, base, a.only or "desktop", a.scheme or "light", still_waiting=True); steps += 1
                all_errs += e; all_fails += f
                print(f"still-waiting checkout: {len(e)} console errors, {len(f)} failures")
            b.close()
    finally:
        if proc:
            proc.terminate(); proc.wait(5)
    for e in all_errs: print("ERROR", e)
    for f in all_fails: print("FAIL ", f)
    ok = not all_errs and not all_fails
    print(f"{steps} steps, {len(all_errs)} console errors, {len(all_fails)} failures")
    print("OK" if ok else "NOT OK")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
