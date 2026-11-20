"""Your account (views/account.js) on the fixture server, next to the lost-passkey parts (recovery.js), with screenshots.

The seams between lane ACCOUNT's page and lane RECOVER's banner and help, with the mock's real human check
(MOCK_HC=real: Turnstile's always-pass test key, so it needs network to challenges.cloudflare.com):
  1. /account opens on the mock; with a passkey on the account, the "lost every passkey" note links the reset on
     Your browsers and the help page.
  2. With a passkey reset waiting, the banner shows above /account and does not cover the page; no horizontal
     overflow, no small text, no small tap targets, no forbidden words. Screenshots phone 390x844 and desktop 1440x900.
  3. Deleting an account with no passkey, on a computer with no Face ID or fingerprint: the dialog does not offer
     "Sign in again instead" (the server asks for a passkey on each delete; a fresh sign-in never stands in for it).
  4. Download my data saves a file; Delete my account works (stub check) and signs out.

    python3 web/test/test_account_mock.py                    # starts its own mock (MOCK_HC=real) on :9273
    python3 web/test/test_account_mock.py --base http://localhost:8827   # a MOCK_HC=real mock you started
"""
import argparse, os, pathlib, re, subprocess, sys, tempfile, time, urllib.request
from playwright.sync_api import sync_playwright, expect

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from test_e2e import Run, sign_in, VIEWPORTS  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parents[2]

OVERLAP_JS = r"""
() => {
  const b = document.querySelector(".recovery-banners");
  const m = document.querySelector("#main .account-page");
  if (!b || !m) return "banner or page missing";
  const x = b.getBoundingClientRect(), y = m.getBoundingClientRect();
  return x.bottom <= y.top + 1 ? "" : `banner (bottom ${x.bottom}) covers the page (top ${y.top})`;
}
"""

# the delete banner (deletebanner.js) sits above the page and never covers it
DELETE_OVERLAP_JS = r"""
() => {
  const b = document.querySelector(".delete-banners");
  const m = document.querySelector("#main > *");
  if (!b || !m) return "delete banner or page missing";
  const x = b.getBoundingClientRect(), y = m.getBoundingClientRect();
  return x.bottom <= y.top + 1 ? "" : `delete banner (bottom ${x.bottom}) covers the page (top ${y.top})`;
}
"""


# both banners at once (fix-all last builder): above the page, not on each other, and together no taller than the screen
BOTH_JS = r"""
() => {
  const d = document.querySelector(".delete-banners"), r = document.querySelector(".recovery-banners"), m = document.querySelector("#main > *");
  if (!d || !r || !m) return "a banner or the page is missing";
  const a = d.getBoundingClientRect(), b = r.getBoundingClientRect(), y = m.getBoundingClientRect();
  const out = [];
  if (a.bottom > b.top + 1 && b.bottom > a.top + 1) out.push(`the banners overlap (${a.top}-${a.bottom} and ${b.top}-${b.bottom})`);
  if (Math.max(a.bottom, b.bottom) > y.top + 1) out.push(`a banner covers the page (page top ${y.top})`);
  if (a.top > b.top) out.push("the delete note sits under the reset note: the bigger loss is read first");
  const tall = Math.max(a.bottom, b.bottom) - Math.min(a.top, b.top);
  if (tall > window.innerHeight) out.push(`the two banners are ${Math.round(tall)}px tall on a ${window.innerHeight}px screen`);
  return out.join("; ");
}
"""


def flow(b, base, vp, shots):
    runs = []

    def run():
        x = Run(b, base, vp); runs.append(x); return x

    tag = os.urandom(3).hex()
    # 1 + 2: an account with a passkey asks for a reset; /account shows the banner and the lost-passkey links
    r = run()
    email = f"ada-{vp}-{tag}@acct.test"
    sign_in(r, email, "Ada")
    r.mock("passkey-here", {})  # a passkey on the account (the recovery hook takes no passkey count)
    r.go("/account")
    expect(r.pg.get_by_role("heading", name="Delete your account")).to_be_visible(timeout=8000)
    note = r.pg.locator("[data-lost-passkeys]")
    r.check(note.count() == 1, "account: no 'lost every passkey' note with a passkey on the account")
    if note.count():
        hrefs = [a.get_attribute("href") for a in note.locator("a").all()]
        r.check("/devices#reset" in hrefs, f"account: the note does not link the reset: {hrefs}")
        r.check("/help/lost-passkey" in hrefs, f"account: the note does not link the help page: {hrefs}")
    stays = r.pg.locator(".account-page").inner_text()
    r.check("as long as the law asks" not in stays, "account: still promises 'as long as the law asks' (nothing backs it)")
    r.audit("account"); r.shot("account-01")

    r.go("/devices")
    r.pg.get_by_role("button", name="Reset my passkeys").click()
    dlg = r.pg.locator("dialog[open]")
    expect(dlg).to_be_visible(timeout=8000)
    r.check(dlg.locator("a[href$='#not-back']").count() == 1, "reset dialog: no link to what a reset does not give back")
    dlg.get_by_role("button", name="Ask for a reset").click()
    expect(r.pg.locator("dialog[open]")).to_have_count(0, timeout=8000)
    r.go("/account")
    expect(r.pg.locator(".recovery-banners [data-reset]")).to_be_visible(timeout=8000)
    expect(r.pg.get_by_role("heading", name="Delete your account")).to_be_visible(timeout=8000)
    r.settle(300)
    o = r.pg.evaluate(OVERLAP_JS)
    r.check(not o, f"account with the reset banner: {o}")
    r.audit("account-with-banner"); r.shot("account-02-with-reset-banner", full=True)

    # 2b. both banners at once: the reset this browser asked for, and a delete someone else asked for which set up the
    # account's first passkey; readable on a phone; the "not you" steps are there, folded; cancelling says what went
    r.mock("account-delete", {"email": email, "ask": True, "first_passkey": True})
    r.go("/rooms")
    dban = r.pg.locator(".delete-banners [data-delete-pending=waiting]")
    expect(dban).to_be_visible(timeout=8000)
    expect(r.pg.locator(".recovery-banners [data-reset]")).to_be_visible(timeout=8000)
    r.settle(300)
    o = r.pg.evaluate(BOTH_JS)
    r.check(not o, f"both banners: {o}")
    r.check(dban.locator("[data-first-passkey]").count() == 1, "delete banner: does not say the ask set up a passkey that a cancel removes")
    r.audit("both-banners"); r.shot("account-07-both-banners", full=True)
    notme = dban.locator("details")
    r.check(notme.count() == 1, "delete banner: no 'Not you?' steps")
    if notme.count():
        notme.locator("summary").click(); r.settle(200)
        steps = notme.locator("ol li").all_inner_texts()
        r.check(len(steps) == 4 and "add a new passkey" in steps[2] and "remove the old one" in steps[2], f"delete banner: the steps: {steps}")
        r.audit("both-banners-steps"); r.shot("account-08-not-me-steps", full=True)
    dban.get_by_role("button", name="Cancel the delete").click()
    dlg = r.pg.locator("dialog[open]")
    expect(dlg).to_be_visible(timeout=8000)
    r.check(dlg.locator("[data-first-passkey]").count() == 1, "cancel dialog: does not say the passkey set up for the ask goes")
    dlg.get_by_role("button", name="Cancel the delete").click()
    expect(r.pg.locator(".delete-banners [data-delete-pending]")).to_have_count(0, timeout=8000)
    toast = r.pg.locator(".toasts").inner_text()
    r.check("The passkey added when the delete was asked for was removed; other sign-ins were ended. Change your Google or GitHub password." in toast,
            f"cancel toast: {toast!r}")

    # 2c. a first passkey set up elsewhere after this sign-in: the note on every page, and removing it from here
    r.mock("recovery", {"email": email, "first_passkey": True})
    r.go("/devices")
    fp = r.pg.locator(".recovery-banners [data-first-passkey-undo]")
    expect(fp).to_be_visible(timeout=8000)
    r.audit("first-passkey-note"); r.shot("account-09-first-passkey-note")
    fp.get_by_role("button", name="Remove that passkey").click()
    r.pg.locator("dialog[open]").get_by_role("button", name="Remove it").click()
    expect(r.pg.locator("[data-first-passkey-undo]")).to_have_count(0, timeout=8000)
    r.settle(600)  # the page redraws after the removal; the list sits in a folded "Recent changes"
    ev = r.pg.locator("[data-event=first_passkey_removed]")
    r.check(ev.count() == 1 and "removed the account's first passkey" in (ev.first.text_content() or ""),
            f"devices: the removal is not in Recent changes as a sentence: {r.pg.locator('[data-event]').all_text_contents()}")
    raw = [t for t in r.pg.locator("[data-event]").all_text_contents() if "_" in t or not t.strip()]
    r.check(not raw, f"devices: raw event names: {raw}")

    r.go("/help/lost-passkey")
    r.check(r.pg.locator("#not-back").count() == 1, "help: no section on what a reset does not give back")
    r.check(r.pg.locator("#synced").count() == 1 and r.pg.locator("#delete").count() == 1, "help: no steps for a synced passkey or for someone asking to delete")
    r.audit("help-lost"); r.shot("account-03-help-lost", full=True)

    # 3: no passkey, no platform authenticator: delete asks to set one up and never offers a sign-in instead
    r2 = run()
    email2 = f"bo-{vp}-{tag}@acct.test"
    sign_in(r2, email2, "Bo")
    r2.go("/account")
    r2.pg.fill("#delete-confirm", email2)
    r2.pg.get_by_role("button", name="Ask to delete my account").click()
    dlg = r2.pg.locator("dialog[open]")
    expect(dlg).to_be_visible(timeout=8000)
    expect(dlg.locator(".hc-step").first).to_be_visible(timeout=15000)
    r2.settle(1500)
    alt = dlg.locator(".hc-alt", has_text="Sign in again instead")
    r2.check(alt.count() == 1 and not alt.is_visible(), "delete dialog offers 'Sign in again instead', which a delete never takes")
    r2.shot("account-04-delete-dialog")
    dlg.get_by_role("button", name="Not now").click()
    expect(r2.pg.locator("dialog[open]")).to_have_count(0, timeout=8000)

    errs, fails = [], []
    for x in runs:
        errs += [e for e in x.errors if "challenges.cloudflare.com" not in e]; fails += x.failures
        x.close()
    return errs, fails


def stub_flow(b, base, vp):
    """4: download and delete on a stub mock (no passkey needed)."""
    r = Run(b, base, vp)
    email = f"cy-{vp}-{os.urandom(3).hex()}@acct.test"
    sign_in(r, email, "Cy")
    r.go("/account")
    with r.pg.expect_download() as d:
        r.pg.get_by_role("button", name="Download my data").click()
    r.check(d.value.suggested_filename.startswith("botlink-account"), f"export: file name {d.value.suggested_filename!r}")
    # step 1: ask. Nothing is deleted; every page shows it with a Cancel button
    r.pg.fill("#delete-confirm", email)
    r.pg.get_by_role("button", name="Ask to delete my account").click()
    r.pg.locator("dialog[open]").get_by_role("button", name="Ask to delete").click()
    expect(r.pg.locator("dialog[open]")).to_have_count(0, timeout=8000)
    expect(r.pg.locator("[data-delete-state=waiting]")).to_be_visible(timeout=8000)
    r.check(r.pg.get_by_role("button", name="Delete my account now").count() == 0, "account: a waiting delete can be finished")
    r.go("/rooms")
    banner = r.pg.locator(".delete-banners [data-delete-pending=waiting]")
    expect(banner).to_be_visible(timeout=8000)
    r.settle(300)
    o = r.pg.evaluate(DELETE_OVERLAP_JS)
    r.check(not o, f"rooms with the delete banner: {o}")
    r.audit("rooms-delete-banner"); r.shot("account-05-delete-banner")
    # cancelled from the banner, no passkey
    banner.get_by_role("button", name="Cancel the delete").click()
    r.pg.locator("dialog[open]").get_by_role("button", name="Cancel the delete").click()
    expect(r.pg.locator(".delete-banners [data-delete-pending]")).to_have_count(0, timeout=8000)
    # asked again; the wait ends; step 2: finish
    r.go("/account")
    r.pg.fill("#delete-confirm", email)
    r.pg.get_by_role("button", name="Ask to delete my account").click()
    r.pg.locator("dialog[open]").get_by_role("button", name="Ask to delete").click()
    expect(r.pg.locator("[data-delete-state=waiting]")).to_be_visible(timeout=8000)
    r.mock("account-delete", {"email": email, "ready": True})
    r.go("/account")
    expect(r.pg.locator(".delete-banners [data-delete-pending=ready]")).to_be_visible(timeout=8000)
    expect(r.pg.locator("[data-delete-state=ready]")).to_be_visible(timeout=8000)
    r.audit("account-delete-ready"); r.shot("account-06-delete-ready", full=True)
    r.pg.fill("#delete-confirm", email)
    r.pg.get_by_role("button", name="Delete my account now").click()
    r.pg.locator("dialog[open]").get_by_role("button", name="Delete").click()
    expect(r.pg.get_by_role("heading", name="Your account is deleted.")).to_be_visible(timeout=8000)
    r.audit("account-deleted")
    errs = [e for e in r.errors if "401" not in e]  # the deleted account's open requests get 401s, as on the real server
    fails = r.failures
    r.close()
    return errs, fails


def start_mock(port, hc):
    env = dict(os.environ, PORT=str(port), MOCK_HC=hc)
    log = tempfile.NamedTemporaryFile(prefix=f"mock-account-{port}-", suffix=".log", delete=False)
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
    ap.add_argument("--base", help="a MOCK_HC=real mock you started (the stub part then needs --stub-base)")
    ap.add_argument("--stub-base")
    ap.add_argument("--port", type=int, default=9273)
    ap.add_argument("--only", choices=list(VIEWPORTS))
    ap.add_argument("--shots", default=os.path.join(tempfile.gettempdir(), "botlink-account-shots"))
    a = ap.parse_args()
    shots = pathlib.Path(a.shots); shots.mkdir(parents=True, exist_ok=True)
    procs = []
    if a.base: base = a.base
    else: p1, base = start_mock(a.port, "real"); procs.append(p1)
    if a.stub_base: stub = a.stub_base
    elif a.base: stub = None
    else: p2, stub = start_mock(a.port + 1, "stub"); procs.append(p2)
    all_errs, all_fails = [], []
    try:
        with sync_playwright() as p:
            b = p.chromium.launch()
            for vp in [a.only] if a.only else list(VIEWPORTS):
                t = time.time()
                e, f = flow(b, base, vp, shots)
                if stub:
                    e2, f2 = stub_flow(b, stub, vp); e += e2; f += f2
                all_errs += e; all_fails += f
                print(f"{vp}: {len(e)} console errors, {len(f)} failures, {time.time() - t:.1f}s")
            b.close()
    finally:
        for proc in procs:
            proc.terminate(); proc.wait(5)
    for e in all_errs: print("ERROR", e)
    for f in all_fails: print("FAIL", f)
    ok = not all_errs and not all_fails
    print("PASS" if ok else "FAIL")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
