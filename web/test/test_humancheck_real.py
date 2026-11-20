"""Real human check (SPEC §4.1): Turnstile (Cloudflare's always-pass test site key) + WebAuthn user
verification with a virtual platform authenticator (Chromium CDP). First approval registers a
credential; every later join approval asks the device again (security review 12 Nov 2026: no skip window for joins);
a browser with no platform authenticator approves with a roaming authenticator (a security key without a PIN: user
presence only, launch plan #4). For a join there is no "sign in again instead" way out.

    MOCK_HC=real PORT=8827 node web/test/fixtures/mock-server.mjs &
    python3 web/test/test_humancheck_real.py [--base http://localhost:8827]
Needs network access to challenges.cloudflare.com.
"""
import argparse, pathlib, re, sys
from playwright.sync_api import sync_playwright, expect

SHOTS = pathlib.Path(__file__).resolve().parents[2] / "web" / "shots"


def setup(browser, base, vp, authenticator="platform"):
    ctx = browser.new_context(viewport=vp)
    pg = ctx.new_page()
    errs = []
    pg.on("console", lambda m: errs.append(f"{m.text} @ {m.location.get('url', '')}") if m.type == "error" else None)
    pg.on("pageerror", lambda e: errs.append(str(e)))
    if authenticator:
        cdp = ctx.new_cdp_session(pg)
        cdp.send("WebAuthn.enable")
        if authenticator == "platform":
            opts = {"protocol": "ctap2", "transport": "internal", "hasResidentKey": True, "hasUserVerification": True, "isUserVerified": True, "automaticPresenceSimulation": True}
        else:  # a USB security key with no PIN: user presence only
            opts = {"protocol": "ctap2", "transport": "usb", "hasResidentKey": False, "hasUserVerification": False, "automaticPresenceSimulation": True}
        cdp.send("WebAuthn.addVirtualAuthenticator", {"options": opts})
    return ctx, pg, errs


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--base", default="http://localhost:8827"); a = ap.parse_args()
    B = a.base
    fails = []
    with sync_playwright() as p:
        b = p.chromium.launch()
        ctx, pg, errs = setup(b, B, {"width": 390, "height": 844})
        pg.request.post(B + "/__mock/reset")
        pg.goto(B + "/login?return_to=/new"); pg.fill("#dev-email", "adam@acme.dev"); pg.click("button:has-text('Sign in (dev)')")
        pg.wait_for_url("**/new"); pg.fill("#room-name", "acme"); pg.click("button:has-text('Start the room')")
        pg.wait_for_url(re.compile(r".*/rooms/[0-9a-f-]{36}$")); pg.wait_for_timeout(800)
        for i, name in enumerate(["bugfix", "deployer"]):
            pg.request.post(B + "/__mock/join", data={"room": "acme", "name": name})
            card = pg.locator("[data-need=join]", has_text=name)
            expect(card).to_be_visible(timeout=5000)
            card.get_by_role("button", name="Approve").click()
            dlg = pg.locator("dialog[open]")
            expect(dlg).to_be_visible()
            if i == 0:
                expect(dlg.get_by_text("Set up Face ID or fingerprint")).to_be_visible(timeout=5000)
            else:
                expect(dlg.get_by_text("Asked each time a chat comes in.")).to_be_visible(timeout=5000)
            go = dlg.get_by_role("button", name=re.compile("Unlock & approve|Approve"))
            expect(go).to_be_enabled(timeout=20000)  # Turnstile test key passes on its own
            pg.screenshot(path=str(SHOTS / f"phone-real-hc-{i + 1}.png"))
            go.click()
            expect(pg.locator("dialog[open]")).to_have_count(0, timeout=15000)
            expect(pg.locator(".roster-item", has_text=name)).to_be_visible(timeout=5000)
            print(f"approved {name} with real check ({'register' if i == 0 else 'assert again'})")
        fails += [f"console: {e}" for e in errs if "challenges.cloudflare.com" not in e]
        ctx.close()

        # No platform authenticator (a Linux desktop): a security key / phone approves a join.
        ctx, pg, errs = setup(b, B, {"width": 1440, "height": 900}, authenticator="key")
        pg.add_init_script("window.PublicKeyCredential && (PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable = async () => false)")
        pg.goto(B + "/login?return_to=/new"); pg.fill("#dev-email", "nobio@acme.dev"); pg.click("button:has-text('Sign in (dev)')")
        pg.wait_for_url("**/new"); pg.fill("#room-name", "plain"); pg.click("button:has-text('Start the room')")
        pg.wait_for_url(re.compile(r".*/rooms/[0-9a-f-]{36}$")); pg.wait_for_timeout(800)
        pg.request.post(B + "/__mock/join", data={"room": "plain", "name": "helper"})
        pg.locator("[data-need=join]").get_by_role("button", name="Approve").click()
        dlg = pg.locator("dialog[open]")
        expect(dlg.get_by_text("Use your phone or a security key")).to_be_visible(timeout=5000)
        expect(dlg.get_by_role("button", name="Sign in again instead")).to_be_hidden()
        go = dlg.get_by_role("button", name="Use phone or key")
        expect(go).to_be_enabled(timeout=20000)
        pg.wait_for_timeout(500)
        pg.screenshot(path=str(SHOTS / "desktop-real-hc-no-biometrics.png"))
        go.click()
        expect(pg.locator("dialog[open]")).to_have_count(0, timeout=15000)
        expect(pg.locator(".roster-item", has_text="helper")).to_be_visible(timeout=5000)
        print("no-biometrics: approved with a security key (no PIN)")
        # nothing at hand: a join still needs a phone or a key (signing in again doesn't count for joins)
        ctx2, pg2, errs2 = setup(b, B, {"width": 1440, "height": 900}, authenticator=None)
        pg2.add_init_script("window.PublicKeyCredential && (PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable = async () => false)")
        pg2.goto(B + "/login?return_to=/new"); pg2.fill("#dev-email", "nokey@acme.dev"); pg2.click("button:has-text('Sign in (dev)')")
        pg2.wait_for_url("**/new"); pg2.fill("#room-name", "bare"); pg2.click("button:has-text('Start the room')")
        pg2.wait_for_url(re.compile(r".*/rooms/[0-9a-f-]{36}$")); pg2.wait_for_timeout(800)
        pg2.request.post(B + "/__mock/join", data={"room": "bare", "name": "helper"})
        pg2.locator("[data-need=join]").get_by_role("button", name="Approve").click()
        dlg2 = pg2.locator("dialog[open]")
        expect(dlg2.get_by_text("Use your phone or a security key")).to_be_visible(timeout=5000)
        expect(dlg2.get_by_role("button", name="Sign in again instead")).to_be_hidden()
        print("no authenticator at all: a join needs a phone or a key; no sign-in way out")
        fails += [f"console: {e}" for e in errs + errs2 if "challenges.cloudflare.com" not in e]
        ctx2.close()
        ctx.close(); b.close()
    for f in fails: print("FAIL", f)
    print("OK" if not fails else "NOT OK")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
