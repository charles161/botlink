"""Your account (views/account.js): download my data, and delete my account, against the REAL Go server.

The browser signs the leave (person_remove) in a room another person owns, so this runs on the real server, like
test_real_server.py: the roster the owner's browser verifies afterwards is the real one. No chats (the Go tests in
server/test/account_test.go cover chats, names, waits and rows).

    BOTLINK_ENV=dev BOTLINK_ADDR=127.0.0.1:9210 BOTLINK_DEV_LOGIN=1 BOTLINK_HUMAN_CHECK=stub BOTLINK_ACCOUNT_DELETE_DELAY=0 \
      BOTLINK_APP_ORIGIN=http://localhost:9210 BOTLINK_WEB_DIR=web/public BOTLINK_METRICS_ADDR=off \
      BOTLINK_DATABASE_URL=postgres://botlink@127.0.0.1:55711/botlink_dev .dev/bin/botlink &
    python3 web/test/test_account.py [--base http://localhost:9210] [--only phone|desktop]
"""
import argparse, json, os, pathlib, re, sys
from playwright.sync_api import sync_playwright, expect
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from test_e2e import Run, VIEWPORTS, ROOMS_URL, approve_dialog, sign_in  # noqa: E402


def start_room(r, name):
    r.go("/new")
    r.pg.fill("#room-name", name)
    r.pg.click("button:has-text('Start the room')")
    r.pg.wait_for_url(re.compile(r".*/rooms/[0-9a-f-]{36}$"))
    expect(r.pg.locator(".fp-chip.ok")).to_be_visible(timeout=8000)
    return r.pg.url


def flow(browser, base, vp):
    tag = f"{vp[:1]}{os.urandom(2).hex()}"
    olive_email, dana_email = f"olive-{tag}@acme.dev", f"dana-{tag}@lumen.ai"
    olive = Run(browser, base, vp)
    sign_in(olive, olive_email, "Olive")
    share_url = start_room(olive, f"share-{tag}")

    # Dana joins Olive's room as a person (Olive's browser signs person_add) and starts a room of her own
    olive.pg.get_by_role("button", name="Invite a person").click()
    expect(olive.pg.locator(".pinv.is-fresh")).to_be_visible(timeout=8000)
    pinv = olive.pg.locator(".pinv.is-fresh .pinv-url").inner_text().rsplit("/", 1)[1]
    dana = Run(browser, base, vp)
    dana.go(f"/login?return_to=/p/{pinv}")
    dana.pg.fill("#dev-email", dana_email); dana.pg.fill("#dev-name", "Dana")
    dana.pg.click("button:has-text('Sign in (dev)')")
    dana.pg.wait_for_url(f"**/p/{pinv}")
    dana.pg.get_by_role("button", name="Ask to join").click()
    expect(dana.pg.get_by_role("heading", name="Asked.")).to_be_visible(timeout=8000)
    pr = olive.pg.locator("[data-need=person]")
    expect(pr).to_be_visible(timeout=8000)
    pr.get_by_role("button", name="Approve").click()
    approve_dialog(olive)
    expect(olive.pg.locator(".person-row", has_text="Dana")).to_be_visible(timeout=8000)
    dana.go(share_url.replace(base, ""))
    expect(dana.pg.locator(".fp-chip.ok")).to_be_visible(timeout=8000)
    start_room(dana, f"solo-{tag}")

    # the page, from the account menu
    dana.go("/rooms")
    dana.pg.locator(".me-btn").click()
    dana.pg.get_by_role("menuitem", name="Your account").click()
    dana.pg.wait_for_url("**/account")
    expect(dana.pg.get_by_role("heading", name="Delete your account")).to_be_visible(timeout=8000)
    page = dana.pg.locator("#main")
    dana.check(page.get_by_text(f"#share-{tag} (Olive's)").count() == 1, "the room Dana leaves is not listed")
    dana.check(page.get_by_text(f"#solo-{tag}").count() == 1, "the room Dana owns is not listed")
    dana.audit("account"); dana.shot("account", full=True)

    # download my data
    with dana.pg.expect_download() as dl:
        dana.pg.get_by_role("button", name="Download my data").click()
    d = dl.value
    dana.check(re.fullmatch(r"botlink-account-\d{4}-\d{2}-\d{2}\.json", d.suggested_filename) is not None, f"file name {d.suggested_filename}")
    text = pathlib.Path(d.path()).read_text()
    data = json.loads(text)
    dana.check(data.get("format") == "botlink-account-export" and data["account"]["email"] == dana_email, "export: wrong account")
    names = {x["name"] for x in data["rooms"]}
    dana.check({f"share-{tag}", f"solo-{tag}"} <= names, f"export rooms: {names}")
    dana.check(olive_email not in text, "export holds Olive's email address")
    dana.check(len(data["browsers"]) >= 1 and "messages" in data, "export sections missing")
    # lane FREE: the server runs with BOTLINK_PAYWALL at its default (off), so the export has no plan section
    dana.check("plan" not in data, "export has a plan section with the paywall off")
    expect(dana.pg.get_by_text("Saved botlink-account-")).to_be_visible()

    # step 1, ask: the button waits for the typed address; nothing is deleted
    ask = dana.pg.get_by_role("button", name="Ask to delete my account")
    expect(ask).to_be_disabled()
    dana.pg.fill("#delete-confirm", "someone@else.dev")
    expect(ask).to_be_disabled()
    dana.pg.fill("#delete-confirm", dana_email.upper())
    expect(ask).to_be_enabled()
    ask.click()
    approve_dialog(dana, "Ask to delete")
    # this server runs with no wait (BOTLINK_ACCOUNT_DELETE_DELAY=0, dev only): the ask is ready at once
    expect(dana.pg.locator("[data-delete-state=ready]")).to_be_visible(timeout=8000)
    # Dana's other browser sees it on every page and cancels it, no passkey
    other = Run(browser, base, vp)
    sign_in(other, dana_email, "Dana")
    banner = other.pg.locator(".delete-banners [data-delete-pending]")
    expect(banner).to_be_visible(timeout=8000)
    other.audit("rooms-delete-banner"); other.shot("account-delete-banner")
    banner.get_by_role("button", name="Cancel the delete").click()
    other.pg.locator("dialog[open]").get_by_role("button", name="Cancel the delete").click()
    expect(other.pg.locator(".delete-banners [data-delete-pending]")).to_have_count(0, timeout=8000)
    dana.go("/account")
    expect(dana.pg.locator("[data-delete-state]")).to_have_count(0, timeout=8000)
    # asked again, step 2: finish
    dana.pg.fill("#delete-confirm", dana_email)
    dana.pg.get_by_role("button", name="Ask to delete my account").click()
    approve_dialog(dana, "Ask to delete")
    expect(dana.pg.locator("[data-delete-state=ready]")).to_be_visible(timeout=8000)
    dana.pg.fill("#delete-confirm", dana_email)
    bd, bo = len(dana.errors), len(other.errors)
    dana.pg.get_by_role("button", name="Delete my account now").click()
    approve_dialog(dana, "Delete")
    expect(dana.pg.get_by_role("heading", name="Your account is deleted.")).to_be_visible(timeout=8000)
    dana.check(dana.pg.locator(".me-btn").count() == 0, "account menu still shown after delete")
    dana.audit("account-deleted"); dana.shot("account-deleted")

    # signed out everywhere: the dashboard sends her to sign in
    dana.go("/rooms")
    dana.pg.wait_for_url("**/login**")

    # Olive's browser still verifies her room's member list, and Dana is out of it
    olive.go(share_url.replace(base, ""))
    expect(olive.pg.locator(".fp-chip.ok")).to_be_visible(timeout=8000)
    expect(olive.pg.locator(".person-row", has_text="Dana")).to_have_count(0, timeout=8000)

    # the same address can sign up again: a new, empty account
    sign_in(dana, dana_email, "Dana")
    dana.check(dana.pg.get_by_text(f"#solo-{tag}").count() == 0 and dana.pg.get_by_text(f"#share-{tag}").count() == 0,
               "the new account sees the old rooms")
    # once deleted, the session is gone: the dashboard's own /me check answers 401 (live update and the next page
    # load), which the browser logs like any signed-out visit. Any other error still counts.
    # (the other browser was on Your rooms: its live refresh gets 401 too)
    gone = re.compile(r"status of 401 .* @ \S+/app/v1/(me|me/delete|rooms)(\?|$)")
    dana.errors = dana.errors[:bd] + [e for e in dana.errors[bd:] if not gone.search(e)]
    other.errors = other.errors[:bo] + [e for e in other.errors[bo:] if not gone.search(e)]
    errs, fails = olive.errors + dana.errors + other.errors, olive.failures + dana.failures + other.failures
    olive.close(); dana.close(); other.close()
    return errs, fails


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://localhost:9210")
    ap.add_argument("--only", choices=list(VIEWPORTS))
    a = ap.parse_args()
    E, F = [], []
    with sync_playwright() as p:
        b = p.chromium.launch()
        for vp in [a.only] if a.only else list(VIEWPORTS):
            e, f = flow(b, a.base, vp)
            print(f"{vp}: {len(e)} console errors, {len(f)} failures")
            E += e; F += f
        b.close()
    for e in E: print("ERROR", e)
    for f in F: print("FAIL ", f)
    print("OK" if not E and not F else "NOT OK")
    sys.exit(0 if not E and not F else 1)


if __name__ == "__main__":
    main()
