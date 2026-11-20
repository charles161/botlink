"""The rooms home's "Last message …" line (lane LASTMSG) against the REAL Go server and the REAL client CLI.

A person starts #talk-… then #quiet-… (the newer room). Two real chats join #talk-… and one sends a real message to the
room. The rooms home then shows #talk-… first with "Last message just now" and #quiet-… after it with "No messages yet"
(a room with a message sorts before a newer room without one). Phone 390x844 and desktop 1440x900: 0 console errors,
the e2e audit (overflow, small text, tap targets, forbidden words).

    BOTLINK_ENV=dev BOTLINK_ADDR=127.0.0.1:9982 BOTLINK_DEV_LOGIN=1 BOTLINK_HUMAN_CHECK=stub \\
      BOTLINK_APP_ORIGIN=http://localhost:9982 BOTLINK_WEB_DIR=web/public BOTLINK_METRICS_ADDR=off \\
      BOTLINK_DATABASE_URL=postgres://botlink@127.0.0.1:<port>/<throwaway db> .dev/bin/botlink &
    python3 web/test/test_lastmsg_real.py --base http://localhost:9982 [--only phone|desktop]
"""
import argparse, os, pathlib, sys, time
from playwright.sync_api import sync_playwright, expect
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from test_e2e import Run, VIEWPORTS, approve_dialog  # noqa: E402
from test_real_server import Chat, CLI  # noqa: E402
from test_create_real import sign_in  # noqa: E402
from test_batch_real import new_room, ask  # noqa: E402


def flow(b, base, vp):
    tag = f"{vp[:1]}{os.urandom(2).hex()}"
    r = Run(b, base, vp)
    fails = []
    try:
        sign_in(r, f"lena-{tag}@lastmsg.test", "Lena")
        talk, quiet = f"talk-{tag}", f"quiet-{tag}"
        tid, invite = new_room(r, talk)
        new_room(r, quiet)
        a, z = ask(base, invite, tag, "speaker"), ask(base, invite, tag, "hearer")
        r.pg.goto(f"{base}/rooms/{tid}"); r.settle(700)
        for c, jid, _, _ in (a, z):
            k = r.pg.locator(f"[data-need=join][data-request='{jid}']")
            expect(k).to_be_visible(timeout=8000)
            k.get_by_role("button", name="Approve", exact=True).click(); approve_dialog(r)
            rc, out = c.wait()
            r.check(rc == 0, f"join rc={rc}: {out[-300:]}")
        rc, out = a[0].run("send", "--as", "speaker", "--to", "room", "--intent", "fyi", "--text", f"standup notes {tag}")
        r.check(rc == 0, f"send rc={rc}: {out[-400:]}")
        r.go("/rooms"); r.pg.wait_for_selector(".room-grid .rc-name", timeout=8000); r.settle(600)
        names = [n.strip() for n in r.pg.locator(".room-grid .rc-name").all_inner_texts()]
        r.check(names[:2] == [f"#{talk}", f"#{quiet}"], f"order {names}, want #{talk} then #{quiet}")
        line = lambda n: r.pg.locator(".room-card-wrap", has_text=f"#{n}").locator(".rc-last").inner_text().strip()
        r.check(line(talk) == "Last message just now", f"#{talk}: {line(talk)!r}")
        r.check(line(quiet) == "No messages yet", f"#{quiet}: {line(quiet)!r}")
        r.audit("real-rooms-last-message"); r.shot("real-22c-rooms-last-message")
    except Exception as ex:
        fails.append(f"[{vp}] {type(ex).__name__}: {' | '.join(str(ex).splitlines()[:4])[:700]}")
    errs, fails = r.errors, fails + r.failures
    r.close()
    return errs, fails


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://localhost:9982")
    ap.add_argument("--only", choices=list(VIEWPORTS))
    a = ap.parse_args()
    assert CLI.exists(), f"{CLI} missing (cd client && npm ci && npm run build)"
    E, F = [], []
    with sync_playwright() as p:
        b = p.chromium.launch()
        for vp in [a.only] if a.only else list(VIEWPORTS):
            t = time.time()
            e, f = flow(b, a.base, vp)
            print(f"{vp}: last message on the real server {time.time() - t:.0f}s, {len(e)} console errors, {len(f)} failures")
            E += e; F += f
        b.close()
    for e in E: print("ERROR", e)
    for f in F: print("FAIL ", f)
    ok = not E and not F
    print("OK" if ok else "NOT OK")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
