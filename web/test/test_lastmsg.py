"""The rooms home says when the last message passed in each room (lane LASTMSG), on the fixture server.

Each room card reads "Last message 5 min ago" (the exact time as its tooltip) or "No messages yet". Rooms with the
newest message come first; rooms with none come after them, newest room first. The text is recomputed from the time
already loaded on a slow timer, with no new request. Light and dark on desktop, light on a phone: 0 console errors, no
horizontal overflow, no forbidden words, no text under 13px, tap targets of 44px. Screenshots go to web/shots/.

    python3 web/test/test_lastmsg.py                     # starts its own mock on :9961 and stops it after
    python3 web/test/test_lastmsg.py --base http://localhost:8829
"""
import argparse, datetime, os, pathlib, re, subprocess, sys, tempfile, time, urllib.request
from playwright.sync_api import sync_playwright, expect

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from test_e2e import Run, sign_in, SHOTS  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parents[2]
# created in this order; messages per room in minutes before now (None: no message)
ROOMS = [("talk", 5), ("old-quiet", None), ("busy", 0), ("new-quiet", None), ("standup", 30 * 60)]
ORDER = ["busy", "talk", "standup", "new-quiet", "old-quiet"]
TEXT = {"busy": "Last message just now", "talk": "Last message 5 min ago", "standup": "Last message yesterday",
        "new-quiet": "No messages yet", "old-quiet": "No messages yet"}
WORDS = re.compile(r"\b(active|online|seen|read|last seen)\b|—", re.I)
RUNS = [("desktop", "light"), ("desktop", "dark"), ("phone", "light")]


def iso(minutes_ago):
    t = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(minutes=minutes_ago)
    return t.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def card(r, name):
    return r.pg.locator(".room-card-wrap").filter(has=r.pg.locator(".rc-name", has_text=re.compile(rf"^#{re.escape(name)}-")))


def flow(b, base, vp, scheme):
    r = Run(b, base, vp, scheme=scheme)
    tag = f"{vp}-{scheme}"
    try:
        sign_in(r, f"lena-{tag}@lastmsg.test", "Lena")
        for name, _ in ROOMS:
            r.go("/new"); r.pg.fill("#room-name", f"{name}-{tag}"); r.pg.fill("#room-purpose", f"Room {name}")
            r.pg.click("button:has-text('Start the room')")
            r.pg.wait_for_url(re.compile(r".*/rooms/[0-9a-f-]{36}$")); r.settle(300)
        for name, ago in ROOMS:
            if ago is not None:
                r.mock("activity", {"room": f"{name}-{tag}", "items": [{"from": "builder", "to": "shipper", "at": iso(ago)}]})
        r.pg.clock.install()
        lists = []
        r.pg.on("request", lambda q: lists.append(q.url) if q.method == "GET" and q.url.endswith("/app/v1/rooms") else None)
        r.go("/rooms")
        expect(r.pg.locator(".room-card")).to_have_count(len(ROOMS), timeout=5000)
        r.settle(300)
        got = [re.sub(rf"-{tag}$", "", t.lstrip("#")) for t in r.pg.locator(".rc-name").all_inner_texts()]
        r.check(got == ORDER, f"order {got}, want {ORDER}")
        for name, want in TEXT.items():
            line = card(r, name).locator(".rc-last")
            text = line.inner_text().strip()
            r.check(text == want, f"{name}: line {text!r}, want {want!r}")
            r.check(not WORDS.search(text), f"{name}: line {text!r} uses a word it must not")
            label = card(r, name).locator("a.room-card").get_attribute("aria-label") or ""
            r.check(want.lower() in label.lower(), f"{name}: the card's label {label!r} should say {want.lower()!r}")
            if want.startswith("Last message"):
                when = line.get_attribute("datetime")
                title = line.get_attribute("title") or ""
                r.check(line.evaluate("(e) => e.tagName") == "TIME" and bool(when), f"{name}: the line should be a <time> with its datetime")
                exact = r.pg.evaluate("(iso) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })", when or "")
                r.check(title == exact, f"{name}: tooltip {title!r}, want the exact time {exact!r}")
            else:
                r.check(line.get_attribute("title") is None and line.evaluate("(e) => e.tagName") != "TIME", f"{name}: no time and no tooltip when the room has no message")
        r.audit(f"rooms-last-message-{tag}")
        name = f"22c-rooms-last-message" if scheme == "light" else "dark-22c-rooms-last-message"
        r.shot(name, full=True)
        # two minutes later, from the times already loaded: the words move, no new request for the list
        n = len(lists)
        r.pg.clock.fast_forward("02:00"); r.settle(300)
        for name, want in [("talk", "Last message 7 min ago"), ("busy", "Last message 2 min ago"), ("new-quiet", "No messages yet")]:
            text = card(r, name).locator(".rc-last").inner_text().strip()
            r.check(text == want, f"after two minutes {name}: {text!r}, want {want!r}")
        r.check(len(lists) == n, f"the slow timer made {len(lists) - n} new request(s) for the rooms list; it must only recompute the words")
    except Exception as ex:
        r.failures.append(f"[{tag}] {type(ex).__name__}: {' | '.join(str(ex).splitlines()[:4])[:600]}")
    errs, fails = r.errors, r.failures
    r.close()
    return errs, fails


def start_mock(port):
    env = dict(os.environ, PORT=str(port))
    log = tempfile.NamedTemporaryFile(prefix=f"mock-lastmsg-{port}-", suffix=".log", delete=False)
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
    ap.add_argument("--port", type=int, default=9961)
    a = ap.parse_args()
    SHOTS.mkdir(exist_ok=True)
    proc, base = (None, a.base) if a.base else start_mock(a.port)
    all_errs, all_fails = [], []
    try:
        with sync_playwright() as p:
            b = p.chromium.launch()
            for vp, scheme in RUNS:
                t = time.time()
                e, f = flow(b, base, vp, scheme)
                all_errs += e; all_fails += f
                print(f"{vp} {scheme}: {len(e)} console errors, {len(f)} failures, {time.time() - t:.1f}s")
            b.close()
    finally:
        if proc:
            proc.terminate(); proc.wait(5)
    for e in all_errs: print("ERROR", e)
    for f in all_fails: print("FAIL", f)
    ok = not all_errs and not all_fails
    print("PASS" if ok else "FAIL")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
