"""The dashboard tells the person a chat is asking to join (prod-readiness blocker 10), on the fixture server.

A request arriving while the person is on another page shows at once as a card (who, which name, which room, the code,
a link to the approval page) and the tab title counts the requests that wait. Two requests for one room are two cards
that say so. A request the chat withdraws, or that runs out, leaves: the approval page says why, the banner says why,
and the count drops. Browser notifications: asked for only from a click, a refusal is said plainly, a browser without
them is told so, and a tab in the background gets exactly one notification per request, never one per event or reload.
Notification and the tab's visibility are stubbed in the page. Phone 390x844 and desktop 1440x900: 0 console errors,
no horizontal overflow, no forbidden words, no text under 13px, tap targets of 44px.

    python3 web/test/test_notify.py                      # starts its own mock on :9291 and stops it after
    python3 web/test/test_notify.py --base http://localhost:8829
"""
import argparse, json, os, pathlib, re, subprocess, sys, tempfile, time, urllib.request
from playwright.sync_api import sync_playwright, expect

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from test_e2e import Run, sign_in, VIEWPORTS  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parents[2]

# Notification and document.visibilityState, stubbed. State lives in sessionStorage so it survives a reload of the tab.
STUB = r"""
(() => {
  let S; try { S = sessionStorage; S.getItem("x"); } catch { return; }
  const cfg = %s;
  if (S.getItem("__perm") === null) S.setItem("__perm", cfg.perm);
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => S.getItem("__vis") || "visible" });
  Object.defineProperty(document, "hidden", { configurable: true, get: () => (S.getItem("__vis") || "visible") === "hidden" });
  window.__setVis = (v) => { S.setItem("__vis", v); document.dispatchEvent(new Event("visibilitychange")); };
  window.__notes = () => JSON.parse(S.getItem("__notes") || "[]");
  window.__asks = () => Number(S.getItem("__asks") || 0);
  if (cfg.none) { delete window.Notification; return; }
  class N {
    constructor(title, o = {}) { const l = window.__notes(); l.push({ title, body: o.body || "", tag: o.tag || "" }); S.setItem("__notes", JSON.stringify(l)); window.__last = this; }
    close() {}
    static get permission() { return S.getItem("__perm"); }
    static requestPermission() { S.setItem("__asks", String(window.__asks() + 1)); S.setItem("__perm", cfg.answer); return Promise.resolve(cfg.answer); }
  }
  window.Notification = N;
})();
"""


def stubbed(b, base, vp, **cfg):
    r = Run(b, base, vp)
    r.pg.add_init_script(STUB % json.dumps({"perm": "default", "answer": "granted", "none": False, **cfg}))
    return r


def banner(r):
    return r.pg.locator(".notify-banners")


def title(r):
    return r.pg.evaluate("() => document.title")


def wait_title(r, pattern, ms=8000):
    end = time.time() + ms / 1000
    while time.time() < end:
        if re.search(pattern, title(r)): return True
        r.settle(150)
    r.check(False, f"tab title {title(r)!r} should match {pattern!r}")
    return False


def control(r):
    return r.pg.locator("[data-notify-control]")


def flow(b, base, vp, shots):
    fails, errs, runs = [], [], []
    email = f"nora-{vp}@notify.test"

    def run(**cfg):
        x = stubbed(b, base, vp, **cfg); runs.append(x); return x

    def shot(r, name):
        r.pg.screenshot(path=str(shots / f"notify-{vp}-{name}.png"))

    try:
        A = run(answer="denied")
        sign_in(A, email, "Nora")
        A.go("/new"); A.pg.fill("#room-name", "acme"); A.pg.click("button:has-text('Start the room')")
        A.pg.wait_for_url(re.compile(r".*/rooms/[0-9a-f-]{36}$")); A.settle(600)
        room = A.pg.url.rstrip("/").split("/")[-1]  # the mock finds rooms by name too; each viewport has its own #acme
        A.check(not title(A).startswith("("), f"no count while nothing waits: {title(A)!r}")

        # 1. a request arrives while the person is on another page: a card at once, and the count in the tab title
        A.go("/devices")
        x = A.mock("join", {"room_id": room, "name": "x", "app": "claude-code", "machine": "studio", "match_code": "K7QAMX"})
        card_x = banner(A).locator(f"[data-notify='{x['id']}']")
        expect(card_x).to_be_visible(timeout=8000)
        expect(card_x).to_contain_text("#acme")
        expect(card_x).to_contain_text("x")
        expect(card_x).to_contain_text("studio")
        expect(card_x).to_contain_text("K7Q-AMX")
        A.check(card_x.get_by_role("link", name="Open the request").get_attribute("href") == f"/approve/{x['id']}", "card links to its approval page")
        wait_title(A, r"^\(1\) ")
        A.audit("devices-one-request"); shot(A, "devices-one-request")

        # 2. a second request for the same room from the same computer, under another name: two cards, said plainly
        y = A.mock("join", {"room_id": room, "name": "y", "app": "claude-code", "machine": "studio", "match_code": "P4WBNZ"})
        expect(banner(A).locator("[data-notify]")).to_have_count(2, timeout=8000)
        expect(banner(A).locator("[data-notify-twins]")).to_contain_text("2 different requests for #acme")
        expect(banner(A).locator(f"[data-notify='{y['id']}']")).to_contain_text("P4W-BNZ")
        wait_title(A, r"^\(2\) ")
        A.audit("devices-two-requests"); shot(A, "devices-two-requests")
        # on the rooms page the cards are already on the page: no second copy in the banner, still marked as two
        A.go("/rooms")
        expect(A.pg.locator("#main [data-need=join]")).to_have_count(2, timeout=8000)
        A.check(banner(A).locator("[data-notify]").count() == 0, "rooms page: the banner doesn't repeat cards the page shows")
        expect(A.pg.locator("#main .need-twins").first).to_contain_text("different requests")
        wait_title(A, r"^\(2\) ")

        # 3. the approval page of x: y still shows in the banner (the founder's case: the other request is in view)
        A.go(f"/approve/{x['id']}")
        expect(A.pg.locator("#main [data-need=join]")).to_have_count(1)
        expect(banner(A).locator(f"[data-notify='{y['id']}']")).to_be_visible(timeout=8000)
        A.check(banner(A).locator(f"[data-notify='{x['id']}']").count() == 0, "approve page: its own request isn't repeated in the banner")
        expect(A.pg.locator("#main .need-twins")).to_contain_text("y")
        A.audit("approve-with-twin"); shot(A, "approve-with-twin")

        # 4. the chat withdraws x: the page says so instead of keeping a card that can't be approved
        A.mock("join-end", {"id": x["id"], "ended": "withdrawn"})
        expect(A.pg.locator("#main [data-gone=withdrawn]")).to_contain_text("Withdrawn by the chat", timeout=8000)
        expect(A.pg.locator("#main [data-need=join]")).to_have_count(0)
        wait_title(A, r"^\(1\) ")
        A.audit("approve-withdrawn"); shot(A, "approve-withdrawn")
        # opened again later, the link says the same (not a not-found page)
        A.go(f"/approve/{x['id']}")
        expect(A.pg.locator("#main [data-gone=withdrawn]")).to_be_visible()

        # 5. y runs out with no event from the server: it leaves the banner, the banner says why, the count clears
        A.go("/devices")
        expect(banner(A).locator(f"[data-notify='{y['id']}']")).to_be_visible(timeout=8000)
        A.mock("join-end", {"id": y["id"], "ended": "expired", "in_s": 2})
        expect(banner(A).locator(f"[data-notify='{y['id']}']")).to_have_count(0, timeout=8000)
        expect(banner(A).locator(f"[data-notify-gone='{y['id']}']")).to_contain_text("expired")
        wait_title(A, r"^(?!\()")
        A.audit("devices-expired"); shot(A, "devices-expired")

        # 5b. a server whose requests last 2 minutes (staging): the approval page says the real time, never "15 minutes"
        z = A.mock("join", {"room_id": room, "name": "z", "app": "claude-code", "machine": "studio", "match_code": "Q2RZZT", "expires_in_s": 120})
        A.go(f"/approve/{z['id']}")
        expect(A.pg.locator("#main [data-need=join]")).to_contain_text("2 min left", timeout=8000)
        A.check("15 min" not in A.pg.locator("#main").inner_text(), "approve page: no 15-minute lifetime for a 2-minute request")
        A.mock("join-end", {"id": z["id"], "ended": "expired", "in_s": 0})
        expect(A.pg.locator("#main [data-gone=expired]")).to_contain_text("ran out at", timeout=8000)
        A.check("15 min" not in A.pg.locator("#main").inner_text(), f"expired page: no 15-minute lifetime: {A.pg.locator('#main').inner_text()!r}")
        wait_title(A, r"^(?!\()")

        # 6. permission: never asked on load; asked from the click; a refusal is said plainly
        A.go("/rooms")
        expect(control(A)).to_be_visible()
        expect(control(A)).to_contain_text("while a bot-link tab is open")
        A.check(A.pg.evaluate("() => window.__asks()") == 0, "permission asked without a click")
        control(A).get_by_role("button", name="Tell me when a chat asks to join").click()
        expect(control(A)).to_have_attribute("data-state", "denied", timeout=8000)
        expect(control(A)).to_contain_text("blocked")
        A.check(A.pg.evaluate("() => window.__asks()") == 1, "permission asked once, from the click")
        A.audit("rooms-control-denied"); shot(A, "rooms-control-denied")

        # 7. granted, tab in the background: exactly one notification per request
        G = run(answer="granted")
        sign_in(G, email, "Nora")
        expect(control(G)).to_have_attribute("data-state", "off")
        G.check(G.pg.evaluate("() => window.__asks()") == 0, "granted run: permission asked without a click")
        control(G).get_by_role("button", name="Tell me when a chat asks to join").click()
        expect(control(G)).to_have_attribute("data-state", "on", timeout=8000)
        G.go("/devices")
        G.pg.evaluate("() => window.__setVis('hidden')")
        z = G.mock("join", {"room_id": room, "name": "z", "app": "codex", "machine": "box-2", "match_code": "ZZ7QRT"})
        G.pg.wait_for_function("() => window.__notes().length >= 1", timeout=8000)
        n = G.pg.evaluate("() => window.__notes()")
        G.check(len(n) == 1 and "#acme" in n[0]["title"] and "z" in n[0]["body"], f"one notification naming the room and the chat: {n}")
        G.check(all("ZZ7" not in (m["title"] + m["body"]) for m in n), "the notification carries no code")
        for _ in range(3):  # more events (any change rings the stream) and a reload of the tab: no repeats
            G.mock("activity", {"room": "acme", "items": [{"from": "x", "to": None}]}); G.settle(400)
        G.pg.reload(); G.pg.wait_for_selector("#main > *"); G.settle(1200)
        G.check(len(G.pg.evaluate("() => window.__notes()")) == 1, f"repeats: {G.pg.evaluate('() => window.__notes()')}")
        w = G.mock("join", {"room_id": room, "name": "w", "app": "cursor", "machine": "box-3"})
        G.pg.wait_for_function("() => window.__notes().length >= 2", timeout=8000)
        n = G.pg.evaluate("() => window.__notes()")
        G.check(len(n) == 2 and n[0]["tag"] != n[1]["tag"], f"one more for the new request: {n}")
        # clicking the notification opens the request
        G.pg.evaluate("() => window.__setVis('visible')")
        G.pg.evaluate("() => window.__last.onclick(new Event('click'))")
        G.pg.wait_for_url(f"**/approve/{w['id']}", timeout=8000)
        expect(G.pg.locator("#main [data-need=join]")).to_have_count(1)
        # the choice is remembered in this browser
        G.go("/rooms")
        expect(control(G)).to_have_attribute("data-state", "on")
        A.mock("join-end", {"id": z["id"], "ended": "withdrawn"}); A.mock("join-end", {"id": w["id"], "ended": "withdrawn"})

        # 8. a browser without notifications is told so, and the tab title is the fallback
        U = run(none=True)
        sign_in(U, email, "Nora")
        expect(control(U)).to_have_attribute("data-state", "unsupported")
        expect(control(U)).to_contain_text("tab title")
        U.audit("rooms-control-unsupported")
    except Exception as ex:
        fails.append(f"[{vp}] {type(ex).__name__}: {' | '.join(str(ex).splitlines()[:4])[:600]}")
    for x in runs:
        errs += x.errors; fails += x.failures
        x.close()
    return errs, fails


def start_mock(port):
    env = dict(os.environ, PORT=str(port))
    log = tempfile.NamedTemporaryFile(prefix=f"mock-notify-{port}-", suffix=".log", delete=False)
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
    ap.add_argument("--port", type=int, default=9291)
    ap.add_argument("--only", choices=list(VIEWPORTS))
    ap.add_argument("--shots", default=os.path.join(tempfile.gettempdir(), "botlink-notify-shots"))
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
