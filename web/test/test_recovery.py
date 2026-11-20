"""Lost passkey / lost laptop on the dashboard (prod-readiness blocker 5), on the fixture server, with screenshots.

Two browsers of one person (A: the old one that owns a room, B: a new one). B asks for a passkey reset; A sees the
banner and cancels it; B asks again, the wait ends, B sets up the new passkey and A is signed out. B (approved for the
room by A) removes A: the signed member list drops A's key and A, signing in again, is told it was removed and starts
over. A third browser removes itself. The help page opens signed in and signed out, and is linked from Your browsers
and the passkey prompt. Phone 390x844 and desktop 1440x900: 0 console errors, no horizontal overflow, no forbidden
words, no text under 13px, tap targets of 44px.

    python3 web/test/test_recovery.py                      # starts its own mock on :9221 and stops it after
    python3 web/test/test_recovery.py --base http://localhost:8829
"""
import argparse, os, traceback, pathlib, re, subprocess, sys, tempfile, time, urllib.request
from playwright.sync_api import sync_playwright, expect

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import test_e2e  # noqa: E402
from test_e2e import Run, sign_in, approve_dialog, VIEWPORTS  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parents[2]


def dialog(r):
    d = r.pg.locator("dialog[open]")
    expect(d).to_be_visible(timeout=8000)
    return d


def confirm(r, label):
    dialog(r).get_by_role("button", name=label).click()
    expect(r.pg.locator("dialog[open]")).to_have_count(0, timeout=8000)
    r.settle(600)


def sign_in_again(r, email):
    """A signed-in browser signs in again (the reauth page keeps the dev form even with a session)."""
    r.go("/login?reauth=1&return_to=/rooms")
    r.pg.fill("#dev-email", email); r.pg.fill("#dev-name", "Adam")
    r.pg.click("button:has-text('Sign in (dev)')")
    r.pg.wait_for_url(test_e2e.ROOMS_URL); r.settle(400)


OVERLAP_JS = r"""
() => [...document.querySelectorAll("li.device")].flatMap((li) => {
  const btns = [...li.querySelectorAll(".device-actions button")].map((b) => b.getBoundingClientRect());
  const main = li.querySelector(".device-main");
  if (!btns.length || !main) return [];
  const lines = [];
  const walk = document.createTreeWalker(main, NodeFilter.SHOW_TEXT);
  while (walk.nextNode()) {
    const n = walk.currentNode;
    if (!n.textContent.trim() || n.parentElement.closest("details:not([open]) > :not(summary)")) continue;  // folded text isn't shown
    const rg = document.createRange(); rg.selectNodeContents(n);
    lines.push(...[...rg.getClientRects()].filter((r) => r.width > 0 && r.height > 0));
  }
  const hit = (x, y) => x.left < y.right - 1 && y.left < x.right - 1 && x.top < y.bottom - 1 && y.top < x.bottom - 1;
  return btns.some((b) => lines.some((l) => hit(b, l))) ? [`device row "${li.querySelector("strong")?.textContent}": its buttons cover its text`] : [];
})
"""


def no_overlap(r, name):
    for p in r.pg.evaluate(OVERLAP_JS): r.failures.append(f"[{r.vp}] {name}: {p}")


def banner(r):
    return r.pg.locator(".recovery-banners")


def flow(b, base, vp, shots):
    fails, errs, runs = [], [], []
    email = f"adam-{vp}@recover.test"

    def run():
        x = Run(b, base, vp); runs.append(x); return x

    # A browser whose sign-in this flow ended on purpose gets 401s until it signs in again: the browser logs those
    # network answers as console errors. Only those are allowed, and only for that browser and while it is signed out.
    ended = []  # (run, first error index, last error index or None)

    def signed_out(r):
        ended.append([r, len(r.errors), None])

    def signed_in(r):
        for e in ended:
            if e[0] is r and e[2] is None: e[2] = len(r.errors)

    def shot(r, name):
        r.pg.screenshot(path=str(shots / f"recovery-{vp}-{name}.png"))

    try:
        # A: the old browser, owner of #keys
        A = run()
        sign_in(A, email, "Adam")
        A.go("/new"); A.pg.fill("#room-name", "keys"); A.pg.click("button:has-text('Start the room')")
        A.pg.wait_for_url(re.compile(r".*/rooms/[0-9a-f-]{36}$")); A.settle(700)
        # B: a new browser of the same person; A approves it for #keys
        B = run()
        sign_in(B, email, "Adam")
        # before B is approved, A is the only browser that can change #keys: removing it would freeze #keys for good.
        # From B it can't be avoided; from A itself, approving another browser first avoids it. Both dialogs say so,
        # and need the tick.
        B.go("/devices")
        B.pg.locator("li.device", has_not=B.pg.locator(".badge-this")).first.get_by_role("button", name="Remove").click()
        expect(dialog(B).locator("[data-freeze='1']")).to_contain_text("only browser that can approve or remove members")
        expect(dialog(B)).to_contain_text("can't be avoided from here")
        B.audit("devices-remove-freeze"); shot(B, "devices-remove-freeze")
        dialog(B).get_by_role("button", name="Remove").click()
        expect(dialog(B)).to_contain_text("Tick “I understand”")
        dialog(B).get_by_role("button", name="Not now").click()
        A.go("/devices")
        A.pg.locator("li.device.is-this").get_by_role("button", name="Remove this browser").click()
        expect(dialog(A).locator("[data-freeze='1']")).to_contain_text("approve it from this one")
        dialog(A).get_by_role("button", name="Not now").click()
        A.go("/rooms")
        expect(A.pg.locator("[data-need=new_device]")).to_be_visible(timeout=8000)
        A.pg.locator("[data-need=new_device]").get_by_role("button", name="Approve").click()
        approve_dialog(A)
        A.go("/rooms"); A.mock("passkey-here", {})  # the account's passkey, made in A

        # the help page: linked from Your browsers, open when signed out too
        B.go("/devices")
        expect(B.pg.get_by_role("link", name="What to do when a device is lost")).to_be_visible()
        B.pg.get_by_role("link", name="What to do when a device is lost").click()
        B.pg.wait_for_url("**/help/lost-passkey"); B.settle(500)
        expect(B.pg.get_by_role("heading", name="Lost your passkey or your laptop?")).to_be_visible()
        B.check("3 days" in B.pg.inner_text("#main"), "help: the wait comes from the server (3 days)")
        B.check("don't clear its cookies" in B.pg.inner_text("#main"), "help: says the reset belongs to the browser that asked")
        B.audit("help"); shot(B, "help")
        S = run()
        S.go("/help/lost-passkey")
        expect(S.pg.get_by_role("heading", name="Lost your passkey or your laptop?")).to_be_visible()
        S.audit("help-signed-out")

        # 1. B asks for a reset (fresh sign-in)
        B.go("/devices")
        B.pg.get_by_role("button", name="Reset my passkeys").click()
        confirm(B, "Ask for a reset")
        expect(banner(B).locator("[data-reset=waiting]")).to_contain_text("You asked to reset your passkeys.")
        B.audit("devices-reset-asked"); no_overlap(B, "devices-reset-asked"); shot(B, "devices-reset-asked")
        # 2. A, signed in long before, sees it on every page and cancels it with a click
        for path in ("/rooms", "/devices", "/account"):
            A.go(path)
            expect(banner(A)).to_contain_text("A passkey reset was asked for your account.", timeout=8000)
        A.go("/rooms")
        A.audit("rooms-reset-banner"); shot(A, "rooms-reset-banner")
        banner(A).get_by_role("button", name="Cancel the reset").click()
        confirm(A, "Cancel the reset")
        expect(banner(A)).to_have_count(0)
        B.go("/rooms")
        expect(banner(B)).to_have_count(0)
        # 3. B asks again; a stale sign-in is sent to sign in again first
        A.mock("recovery", {"email": email, "stale": True})
        B.go("/devices")
        B.pg.get_by_role("button", name="Reset my passkeys").click()
        expect(dialog(B)).to_contain_text("Sign in again first")
        dialog(B).get_by_role("button", name="Cancel", exact=True).click()
        sign_in_again(B, email)
        B.go("/devices")
        B.pg.get_by_role("button", name="Reset my passkeys").click()
        confirm(B, "Ask for a reset")
        # 4. the wait ends: B sets up the new passkey; A is signed out
        A.mock("recovery", {"email": email, "ready": True})
        B.go("/rooms")
        expect(banner(B).locator("[data-reset=ready]")).to_be_visible(timeout=8000)
        B.audit("rooms-reset-ready"); shot(B, "rooms-reset-ready")
        banner(B).get_by_role("button", name="Set up new passkey").click()
        expect(dialog(B)).to_contain_text("Your old passkeys stop working")
        signed_out(A)  # from the moment B finishes (A's open page hears about it at once)
        confirm(B, "Set up")
        expect(banner(B)).to_have_count(0)
        A.pg.goto(base + "/rooms"); A.pg.wait_for_url("**/login**", timeout=8000)

        # 5. B removes A: B signs the device_remove for #keys, so #keys no longer lists A's key, and the passkey made in A
        # (ticked for it) goes in the same step; the one made in B stays (not ticked)
        sign_in(A, email, "Adam"); signed_in(A)
        A.go("/rooms"); A.settle(800); A.mock("passkey-here", {})
        B.go("/devices"); B.settle(800); B.mock("passkey-here", {}); B.mock("passkey-here", {"unknown": True})
        B.go("/devices")
        other = B.pg.locator("li.device", has_not=B.pg.locator(".badge-this")).first
        other.get_by_role("button", name="Remove").click()
        expect(dialog(B)).to_contain_text("A passkey kept on that computer keeps working until you remove it")
        boxes = dialog(B).locator("input[data-passkey=tick]")
        expect(boxes).to_have_count(2)
        B.check(boxes.nth(0).is_checked() and not boxes.nth(1).is_checked(), "removal: only the passkey made in that browser is ticked")
        expect(dialog(B)).to_contain_text("bot-link can't tell where these live")
        expect(dialog(B).locator("input[data-passkey=choose]")).to_have_count(2)
        B.check(dialog(B).locator("input[data-passkey=choose]:checked").count() == 0, "removal: an unknown passkey has a default")
        expect(dialog(B).locator("[data-answering]")).to_contain_text("doesn't lock out whoever has that computer")
        B.audit("devices-remove-dialog"); shot(B, "devices-remove-dialog")
        # no choice for the unknown passkey: it doesn't go ahead
        dialog(B).get_by_role("button", name="Remove").click()
        expect(dialog(B)).to_contain_text("Choose keep or remove for Passkey 3 first")
        signed_out(A)
        dialog(B).get_by_role("radio", name="Keep").click()
        confirm(B, "Try again")
        expect(B.pg.locator(".toast")).to_contain_text("and 1 passkey", timeout=5000)
        expect(B.pg.locator(".toast")).to_contain_text("you kept still work")
        expect(B.pg.locator("li.device.is-revoked")).to_contain_text("Removed", timeout=8000)
        B.check(B.pg.locator("li.device.is-revoked", has_text="still listed").count() == 0, "removal: #keys still lists the removed browser")
        B.check(B.pg.get_by_role("button", name="Finish removing").count() == 0, "removal: nothing should be left to finish")
        B.audit("devices-removed"); no_overlap(B, "devices-removed"); shot(B, "devices-removed")
        # A was signed out; signing in again, it is told it was removed and starts over
        A.pg.goto(base + "/rooms"); A.pg.wait_for_url("**/login**", timeout=8000)
        sign_in(A, email, "Adam"); signed_in(A)
        expect(banner(A).locator("[data-removed]")).to_be_visible(timeout=8000)
        A.audit("rooms-removed-browser"); shot(A, "rooms-removed-browser")
        banner(A).get_by_role("button", name="Start over in this browser").click()
        A.pg.wait_for_selector("#main > *"); A.settle(900)
        expect(banner(A)).to_have_count(0)

        # 6. a third browser removes itself
        C = run()
        sign_in(C, email, "Adam")
        C.go("/devices")
        C.pg.locator("li.device.is-this").get_by_role("button", name="Remove this browser").click()
        expect(dialog(C)).to_contain_text("signs out here")
        dialog(C).get_by_role("radio", name="Keep").click()  # the passkey of unknown place: chosen before going ahead
        signed_out(C)
        confirm(C, "Remove")
        C.pg.wait_for_url("**/login**", timeout=8000)

        # 7. resets turned off on the server: Your browsers and the help page say so, and offer no reset
        B.mock("recovery", {"email": email, "off": True})
        B.go("/devices")
        expect(B.pg.locator("#reset")).to_contain_text("Passkey resets are turned off on this server")
        B.check(B.pg.get_by_role("button", name="Reset my passkeys").count() == 0, "off: a reset button is still offered")
        B.go("/help/lost-passkey")
        expect(B.pg.locator("#main")).to_contain_text("Passkey resets are turned off on this server")
        B.mock("recovery", {"email": email, "off": False})

        # 8. the passkey prompt links to the help page when it asks for a passkey (assert step: real check only), and
        # the module is there for every page that opens the dialog
        B.go("/devices")
        B.check(B.pg.evaluate("() => import('/assets/js/humancheck.js').then((m) => typeof m.humanCheck === 'function')"), "humancheck module")
    except Exception as ex:
        line = ",".join(str(f.lineno) for f in traceback.extract_tb(ex.__traceback__) if f.filename.endswith("test_recovery.py"))
        fails.append(f"[{vp}] line {line}: {type(ex).__name__}: {str(ex).splitlines()[0][:400]}")
    for x in runs:
        allowed = set()
        for r, a, z in ended:
            if r is x:
                allowed |= {i for i in range(a, len(x.errors) if z is None else z) if "status of 401" in x.errors[i]}
        errs += [e for i, e in enumerate(x.errors) if i not in allowed]; fails += x.failures
        x.close()
    return errs, fails


def start_mock(port):
    env = dict(os.environ, PORT=str(port))
    log = tempfile.NamedTemporaryFile(prefix=f"mock-recovery-{port}-", suffix=".log", delete=False)
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
    ap.add_argument("--port", type=int, default=9221)
    ap.add_argument("--only", choices=list(VIEWPORTS))
    ap.add_argument("--shots", default=os.path.join(tempfile.gettempdir(), "botlink-recovery-shots"))
    a = ap.parse_args()
    shots = pathlib.Path(a.shots); shots.mkdir(parents=True, exist_ok=True)
    proc, base = (None, a.base) if a.base else start_mock(a.port)
    all_errs, all_fails = [], []
    try:
        with sync_playwright() as p:
            b = p.chromium.launch()
            for vp in [a.only] if a.only else list(VIEWPORTS):
                t = time.time()
                e, f = flow(b, base, vp, shots)
                all_errs += e; all_fails += f
                print(f"{vp}: {len(e)} console errors, {len(f)} failures, {time.time() - t:.1f}s")
            b.close()
    finally:
        if proc:
            proc.terminate(); proc.wait(5)
    for e in all_errs: print("ERROR", e)
    for f in all_fails: print("FAIL", f)
    print(f"screenshots: {shots}")
    ok = not all_errs and not all_fails
    print("PASS" if ok else "FAIL")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
