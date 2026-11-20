"""Passkeys on "Your browsers" against the REAL Go server with the real human check (security follow-up, 12 Nov 2026).

Turnstile runs with Cloudflare's always-pass test keys (needs network to challenges.cloudflare.com); WebAuthn with
Chromium virtual authenticators. Checks: the first passkey is set up from a fresh sign-in; a second one asks the first
one before it is made; a passkey is removed with the other one; the last one can't be removed.

    BOTLINK_ENV=dev BOTLINK_ADDR=127.0.0.1:8862 BOTLINK_DEV_LOGIN=1 BOTLINK_HUMAN_CHECK=real \
      BOTLINK_TURNSTILE_SITE_KEY=1x00000000000000000000AA BOTLINK_TURNSTILE_SECRET=1x0000000000000000000000000000000AA \
      BOTLINK_APP_ORIGIN=http://localhost:8862 BOTLINK_WEB_DIR=web/public BOTLINK_METRICS_ADDR=off \
      BOTLINK_DATABASE_URL=postgres://botlink@127.0.0.1:<port>/<throwaway db> .dev/bin/botlink &
    python3 web/test/test_passkeys_real.py --base http://localhost:8862
"""
import argparse, re, sys, uuid
from playwright.sync_api import sync_playwright, expect


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--base", default="http://localhost:8862"); a = ap.parse_args()
    B = a.base
    fails, errs = [], []
    with sync_playwright() as p:
        b = p.chromium.launch()
        ctx = b.new_context(viewport={"width": 1280, "height": 900})
        # record what each passkey request allows, so the test can check the remove step never offers the passkey
        # being removed (the server refuses it, so offering it made this test pass or fail by which key answered)
        ctx.add_init_script("""(() => { const get = navigator.credentials.get.bind(navigator.credentials); window.__gets = [];
          navigator.credentials.get = (o) => { window.__gets.push((o && o.publicKey && o.publicKey.allowCredentials || []).length); return get(o); }; })()""")
        pg = ctx.new_page()
        pg.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
        cdp = ctx.new_cdp_session(pg)
        cdp.send("WebAuthn.enable")
        plat = cdp.send("WebAuthn.addVirtualAuthenticator", {"options": {"protocol": "ctap2", "transport": "internal", "hasResidentKey": True,
                                                                           "hasUserVerification": True, "isUserVerified": True, "automaticPresenceSimulation": True}})["authenticatorId"]
        pg.goto(B + "/login?return_to=/devices"); pg.fill("#dev-email", f"keys-{uuid.uuid4().hex[:8]}@acme.dev"); pg.fill("#dev-name", "Keys")
        pg.click("button:has-text('Sign in (dev)')"); pg.wait_for_url("**/devices"); pg.wait_for_timeout(800)
        sec = pg.locator("section.passkeys")
        expect(sec.get_by_text("No passkey yet")).to_be_visible(timeout=8000)

        def add(label):
            sec.get_by_role("button", name="Add a passkey").click()
            dlg = pg.locator("dialog[open]")
            go = dlg.get_by_role("button", name=re.compile("Set up|Confirm & add|Add|Unlock"))
            expect(go).to_be_enabled(timeout=30000)  # Turnstile test key passes on its own
            go.click()
            expect(pg.locator("dialog[open]")).to_have_count(0, timeout=20000)
            expect(sec.get_by_text(label)).to_be_visible(timeout=8000)

        # 1. first passkey from a fresh sign-in (platform authenticator)
        add("Passkey 1")
        if not sec.get_by_role("button", name="Remove").first.is_disabled():
            fails.append("the only passkey can be removed")
        # 2. a second passkey on a security key: the first one answers before the new one is made
        cdp.send("WebAuthn.addVirtualAuthenticator", {"options": {"protocol": "ctap2", "transport": "usb", "hasResidentKey": False,
                                                                   "hasUserVerification": False, "automaticPresenceSimulation": True}})
        add("Passkey 2")
        creds = cdp.send("WebAuthn.getCredentials", {"authenticatorId": plat})["credentials"]
        if len(creds) != 1 or creds[0]["signCount"] < 1:
            fails.append(f"the first passkey did not answer before the second was added: {creds}")
        # 3. remove passkey 2 (the security key); the platform passkey vouches
        sec.locator("li", has_text="Passkey 2").get_by_role("button", name="Remove").click()
        dlg = pg.locator("dialog[open]")
        go = dlg.get_by_role("button", name=re.compile("Unlock|Remove|Approve"))
        expect(go).to_be_enabled(timeout=30000)
        n_before = len(pg.evaluate("window.__gets"))
        go.click()
        pg.wait_for_function("(n) => window.__gets.length > n", arg=n_before, timeout=20000)
        allowed = pg.evaluate("window.__gets")[-1]
        if allowed != 1:
            fails.append(f"removing Passkey 2 offered {allowed} passkeys to answer; only the other one (1) may")
        expect(pg.locator("dialog[open]")).to_have_count(0, timeout=20000)
        expect(sec.get_by_text("Passkey 2")).to_have_count(0, timeout=8000)
        if not sec.get_by_role("button", name="Remove").first.is_disabled():
            fails.append("after removing one, the last passkey can be removed")
        pg.screenshot(path="web/shots/desktop-28-passkeys.png")
        ctx.close(); b.close()
    fails += [f"console: {e}" for e in errs if "challenges.cloudflare.com" not in e]
    for f in fails:
        print("FAIL", f)
    print("OK" if not fails else "NOT OK")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
