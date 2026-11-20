"""Approving several waiting chats of one room together, against the REAL Go server and the REAL client CLI.

Three chats of one person ask to join one room with real `join` commands (client/dist/cli.js, each its own key store).
On "What needs you" the three cards have tick boxes and each card's code and key equal what that chat printed. Two are
ticked and approved: exactly one human check (approve_joins, the room, the two ids) and one approve request; the two
chats' `join --wait` print "Joined #…" (exit 0); the third still waits (exit 3) and its card stays; then the single
Approve lets it in. The room page shows all three with the room fingerprint checked; a message one sends the other
receives. Also:
- one of two ticked chats is rejected from a second browser session of the same person after the page read the list
  again (before the approve request): the server answers batch_changed, the page says "Nothing was approved. …", neither
  chat is a member, the rejected one's wait exits 4 and the other still waits;
- roster_conflict: a member leaves the room between the page's signing and its request; the page signs again and sends
  again with the same human check; the server's answer to that retry is asserted (it accepts it) and both chats join;
- --real: the real human check (Turnstile test keys, a Chromium virtual authenticator): a passkey is set up on a single
  approval, then a batch asks the passkey again (webauthn step "assert", never "skip") and the authenticator signs again.

    stub:  BOTLINK_ENV=dev BOTLINK_ADDR=127.0.0.1:9982 BOTLINK_DEV_LOGIN=1 BOTLINK_HUMAN_CHECK=stub \\
             BOTLINK_APP_ORIGIN=http://localhost:9982 BOTLINK_WEB_DIR=web/public BOTLINK_METRICS_ADDR=off \\
             BOTLINK_DATABASE_URL=postgres://botlink@127.0.0.1:<port>/<throwaway db> .dev/bin/botlink &
           python3 web/test/test_batch_real.py --base http://localhost:9982 [--only phone|desktop]
    real:  the same with BOTLINK_HUMAN_CHECK=real BOTLINK_TURNSTILE_SITE_KEY=1x00000000000000000000AA
             BOTLINK_TURNSTILE_SECRET=1x0000000000000000000000000000000AA on :9983 (needs challenges.cloudflare.com)
           python3 web/test/test_batch_real.py --base http://localhost:9983 --real
"""
import argparse, base64, json, os, pathlib, re, sys, tempfile, time, urllib.request
from playwright.sync_api import sync_playwright, expect
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from test_e2e import Run, VIEWPORTS, approve_dialog, SHOTS  # noqa: E402
from test_real_server import Chat, CLI  # noqa: E402
from test_create_real import sign_in  # noqa: E402
from test_batch import watch, allow, hc_posts, batch_posts, single_posts, card, box, group, go_btn, bar_status, tick, BATCH  # noqa: E402

ROOM_URL = re.compile(r".*/rooms/([0-9a-f-]{36})$")


def new_room(r, name):
    r.go("/new"); r.pg.fill("#room-name", name); r.pg.click("button:has-text('Start the room')")
    r.pg.wait_for_url(ROOM_URL); r.settle(400)
    expect(r.pg.locator(".fp-chip.ok")).to_be_visible(timeout=8000)
    return ROOM_URL.match(r.pg.url).group(1), r.pg.locator(".invite-url").inner_text().strip()


def ask(base, invite, tag, name):
    """A real chat asks to join from its own folder; returns (chat, request id, code, key)."""
    c = Chat(base, f"{tag}-{name}")
    c.cwd = tempfile.mkdtemp(prefix=f"bl-work-{name}-")  # each chat in its own folder: two in one place are never batched
    c.env.pop("CLAUDE_PID", None)  # else the client takes the folder of the app process that runs this test (session.ts)
    code, key = c.join(invite, name, job=f"Works on the {name} part of the launch.")
    return c, c.approve_url.rsplit("/", 1)[1], code, key


def still_waits(c):
    return c.run("join", "--wait", "--app", "claude-code", "--max-s", "3", timeout=60)


def home(r):
    r.go("/rooms"); r.pg.wait_for_selector(".needs-panel", timeout=8000); r.settle(600)


def statuses(r, room):
    return [s for m, u, s in r.resps if BATCH.search(u) and room in u]


def session_post(ctx, base, path):
    """POST as another browser session of the same person (its cookie and CSRF token), outside Playwright."""
    cookie = "; ".join(f"{c['name']}={c['value']}" for c in ctx.cookies(base))
    me = json.loads(urllib.request.urlopen(urllib.request.Request(base + "/app/v1/me", headers={"Cookie": cookie}), timeout=10).read())
    req = urllib.request.Request(base + path, data=b"{}", method="POST", headers={"Cookie": cookie, "X-CSRF-Token": me["csrf_token"], "Origin": base, "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as res:
        return res.status


def flow(b, base, vp):
    tag = f"{vp[:1]}{os.urandom(2).hex()}"
    runs, fails = [], []
    email = f"adam-{tag}@batch.test"

    def run():
        x = watch(Run(b, base, vp)); runs.append(x)
        sign_in(x, email, "Adam")
        return x

    try:
        A = run(); pg = A.pg
        # ── three chats ask; two approved together; the third waits, then comes in on its own ──
        room = f"crew-{tag}"
        rid, invite = new_room(A, room)
        chats = {n: ask(base, invite, tag, n) for n in ("builder", "checker", "scribe")}
        home(A)
        expect(group(A, rid)).to_be_visible(timeout=10000)
        A.check(group(A, rid).locator("input[data-tick]").count() == 3, "three tick boxes")
        for n, (c, jid, code, key) in chats.items():
            k = card(A, jid)
            expect(k).to_be_visible()
            A.check(k.locator(".match-code").get_attribute("aria-label") == "Code " + " ".join(code), f"{n}: card code != the chat's code {code}")
            expect(k.locator(".code-row .fp")).to_have_text(key)  # the browser's fingerprint of the request's keys == the chat's
            expect(box(A, jid)).to_be_enabled(timeout=8000)
            A.check(not box(A, jid).is_checked(), f"{n}: ticked by default")
        ids = [chats["builder"][1], chats["checker"][1]]
        for jid in ids: tick(A, jid)
        A.audit("real-batch-ticked"); A.shot("real-31-batch-ticked")
        go_btn(A, rid).click()
        expect(pg.locator("dialog[open]")).to_contain_text(f"These 2 chats become your chats in #{room}.")
        approve_dialog(A, "Approve 2 chats")
        hcs, bps = hc_posts(A), batch_posts(A)
        A.check(len(hcs) == 1 and hcs[0].get("target_id") == rid and sorted(hcs[0].get("targets") or []) == sorted(ids), f"human checks {hcs}")
        A.check(len(bps) == 1 and bps[0][0] == rid and [i["id"] for i in bps[0][1]["items"]] == ids and not single_posts(A), f"approve requests {[(x[0], [i['id'] for i in x[1]['items']]) for x in bps]}")
        A.check(statuses(A, rid) == [200], f"batch answers {statuses(A, rid)}")
        for n in ("builder", "checker"):
            rc, out = chats[n][0].wait()
            A.check(rc == 0 and f"Joined #{room} as {n}" in out, f"{n} join --wait rc={rc}: {out[-600:]}")
        rc, out = still_waits(chats["scribe"][0])
        A.check(rc == 3, f"scribe should still wait (exit 3), rc={rc}: {out[-400:]}")
        expect(card(A, chats["scribe"][1])).to_be_visible(timeout=8000)
        A.check(box(A, chats["scribe"][1]).count() == 0, "one chat left: still a tick box")
        card(A, chats["scribe"][1]).get_by_role("button", name="Approve", exact=True).click()
        approve_dialog(A)
        rc, out = chats["scribe"][0].wait()
        A.check(rc == 0 and f"Joined #{room} as scribe" in out, f"scribe join --wait rc={rc}: {out[-600:]}")
        A.check(len(hc_posts(A, "approve_join")) == 1 and len(single_posts(A)) == 1, "scribe: not one single approval")
        pg.goto(f"{base}/rooms/{rid}"); A.settle(900)
        expect(pg.locator(".fp-chip.ok")).to_be_visible(timeout=8000)
        room_fp = pg.locator(".fp-chip code").text_content().strip()
        for n in chats: expect(pg.locator(".roster-item", has_text=n)).to_be_visible(timeout=8000)
        A.check(room_fp in out, f"scribe's room fingerprint != the page's {room_fp}")
        A.shot("real-31-batch-room")
        text = f"hello from builder {tag}"
        rc, sent = chats["builder"][0].run("send", "--as", "builder", "--to", "checker", "--intent", "fyi", "--text", text)
        A.check(rc == 0, f"send rc={rc}: {sent[-400:]}")
        got = ""
        for _ in range(10):
            rc, got = chats["checker"][0].run("inbox", "--as", "checker")
            if text in got: break
            time.sleep(1)
        A.check(text in got, f"checker's inbox lacks the message: {got[-500:]}")

        # ── one of two ticked chats is rejected from a second browser session before the request ──
        room2 = f"split-{tag}"
        rid2, invite2 = new_room(A, room2)
        east, west = ask(base, invite2, tag, "east"), ask(base, invite2, tag, "west")
        B = run()  # the same person, another browser
        home(A)
        tick(A, east[1]); tick(A, west[1])
        before = len(A.errors)
        A.pg.route(f"**/app/v1/rooms/{rid2}/join-requests/approve", lambda route: (session_post(B.ctx, base, f"/app/v1/join-requests/{west[1]}/reject"), route.continue_()))
        go_btn(A, rid2).click(); approve_dialog(A, "Approve 2 chats")
        A.pg.unroute(f"**/app/v1/rooms/{rid2}/join-requests/approve")
        A.check(statuses(A, rid2) == [409], f"rejected in between: answers {statuses(A, rid2)}")
        # one chat is left waiting, so the bar is gone: the page says it in a toast
        expect(pg.locator(".toast", has_text="Nothing was approved. west was already decided.")).to_be_visible(timeout=8000)
        allow(A, before, 409, "/join-requests/approve")
        rc, out = west[0].wait()
        A.check(rc == 4, f"west (rejected) should exit 4, rc={rc}: {out[-400:]}")
        rc, out = still_waits(east[0])
        A.check(rc == 3, f"east should still wait (exit 3), rc={rc}: {out[-400:]}")
        pg.goto(f"{base}/rooms/{rid2}"); A.settle(900)
        A.check(pg.locator(".roster-item", has_text="east").count() == 0 and pg.locator(".roster-item", has_text="west").count() == 0, "rejected in between: one of them is a member")
        expect(card(A, east[1])).to_be_visible(timeout=8000)

        # ── roster_conflict: a member leaves between signing and the request; the retry uses the same check ──
        room3 = f"churn-{tag}"
        rid3, invite3 = new_room(A, room3)
        stayer = ask(base, invite3, tag, "stayer")
        pg.goto(f"{base}/rooms/{rid3}"); A.settle(600)
        card(A, stayer[1]).get_by_role("button", name="Approve", exact=True).click(); approve_dialog(A)
        rc, out = stayer[0].wait()
        A.check(rc == 0, f"stayer join rc={rc}: {out[-300:]}")
        north, south = ask(base, invite3, tag, "north"), ask(base, invite3, tag, "south")
        home(A)
        tick(A, north[1]); tick(A, south[1])
        seen = []

        def leave_first(route):
            seen.append(json.loads(route.request.post_data))
            if len(seen) == 1:
                rc, out = stayer[0].run("leave", "stayer")
                seen.append(("leave", rc, out[-200:]))
            route.continue_()
        before = len(A.errors)
        A.pg.route(f"**/app/v1/rooms/{rid3}/join-requests/approve", leave_first)
        go_btn(A, rid3).click(); approve_dialog(A, "Approve 2 chats")
        A.pg.unroute(f"**/app/v1/rooms/{rid3}/join-requests/approve")
        bodies = [x for x in seen if isinstance(x, dict)]
        left = [x for x in seen if isinstance(x, tuple)]
        A.check(left and left[0][1] == 0, f"roster_conflict: the leave failed {left}")
        st = statuses(A, rid3)
        A.roster_conflict = {"statuses": st, "same_check": len(bodies) >= 2 and bodies[0]["human_check"] == bodies[1]["human_check"],
                             "seqs": [[json.loads(base64.urlsafe_b64decode(i["roster_entry"]["entry"] + "==").decode())["seq"] for i in x["items"]] for x in bodies]}
        print(f"[{vp}] roster_conflict: {A.roster_conflict}")
        A.check(st == [409, 200] and A.roster_conflict["same_check"], f"roster_conflict: answers {st}, the same check on the retry: {A.roster_conflict}")
        A.check(len([h for h in hc_posts(A) if h.get("target_id") == rid3]) == 1, "roster_conflict: a second human check")
        allow(A, before, 409, "/join-requests/approve")
        for n, c in (("north", north[0]), ("south", south[0])):
            rc, out = c.wait()
            A.check(rc == 0 and f"Joined #{room3} as {n}" in out, f"{n} after the retry: rc={rc} {out[-400:]}")

        # ── two real chats in one folder on one computer with one app: never in one batch ──
        room4 = f"twins-{tag}"
        rid4, invite4 = new_room(A, room4)
        one = ask(base, invite4, tag, "first-twin")
        c2 = Chat(base, f"{tag}-second-twin"); c2.cwd = one[0].cwd; c2.env.pop("CLAUDE_PID", None)
        c2.join(invite4, "second-twin", job="Works on the same thing, from the same folder.")
        two = (c2, c2.approve_url.rsplit("/", 1)[1])
        home(A)
        tick(A, one[1])
        expect(box(A, two[1])).to_be_enabled(timeout=8000)
        box(A, two[1]).click(); A.settle(200)
        A.check(not box(A, two[1]).is_checked(), "same place (real): the second chat in one folder was ticked")
        expect(card(A, two[1])).to_contain_text("These two run in the same place. Approve them one at a time.")
    except Exception as ex:
        fails.append(f"[{vp}] {type(ex).__name__}: {' | '.join(str(ex).splitlines()[:4])[:700]}")
    errs = []
    for x in runs:
        errs += x.errors; fails += x.failures
        try: x.close()
        except Exception: pass
    return errs, fails


def real_pass(b, base):
    """The real human check: a passkey on each batch (approve_joins), never skipped within the hour."""
    tag = f"k{os.urandom(2).hex()}"
    fails = []
    r = watch(Run(b, base, "desktop"))
    cdp = r.ctx.new_cdp_session(r.pg)
    cdp.send("WebAuthn.enable")
    auth = cdp.send("WebAuthn.addVirtualAuthenticator", {"options": {"protocol": "ctap2", "transport": "internal", "hasResidentKey": True,
                                                                       "hasUserVerification": True, "isUserVerified": True, "automaticPresenceSimulation": True}})["authenticatorId"]
    hcs = []
    def on_hc(s):  # read the body while it is there
        if s.url.endswith("/app/v1/human-check") and s.request.method == "POST":
            try: hcs.append((json.loads(s.request.post_data or "{}").get("action"), s.json()["webauthn"]["step"]))
            except Exception as ex: hcs.append(("?", f"unreadable: {ex}"))
    r.pg.on("response", on_hc)
    steps = lambda: hcs

    def approve(label):
        dlg = r.pg.locator("dialog[open]")
        go = dlg.get_by_role("button", name=re.compile(label))
        expect(go).to_be_enabled(timeout=30000)  # the Turnstile test key passes on its own
        go.click()
        expect(r.pg.locator("dialog[open]")).to_have_count(0, timeout=20000)
        r.settle(600)
    try:
        sign_in(r, f"kim-{tag}@batch.test", "Kim")
        room = f"keys-{tag}"
        rid, invite = new_room(r, room)
        first = ask(base, invite, tag, "first")
        r.pg.goto(f"{base}/rooms/{rid}"); r.settle(600)
        card(r, first[1]).get_by_role("button", name="Approve", exact=True).click()
        approve(r"Set up|Approve|Unlock")
        rc, out = first[0].wait()
        r.check(rc == 0, f"first (passkey set up): rc={rc} {out[-300:]}")
        c0 = cdp.send("WebAuthn.getCredentials", {"authenticatorId": auth})["credentials"]
        r.check(len(c0) == 1, f"no passkey after the first approval: {c0}")
        a, z = ask(base, invite, tag, "alpha"), ask(base, invite, tag, "zulu")
        home(r)
        tick(r, a[1]); tick(r, z[1])
        go_btn(r, rid).click()
        dlg = r.pg.locator("dialog[open]")
        expect(dlg).to_contain_text("Face ID, fingerprint or Windows Hello, to let these chats in. Asked each time.", timeout=15000)
        r.audit("real-batch-passkey"); r.shot("real-31b-batch-passkey")
        approve(r"Unlock")
        print(f"[real] human checks (action, webauthn step): {steps()}")
        r.check(steps() and steps()[-1] == ("approve_joins", "assert"), f"approve_joins within the hour of a passkey: {steps()}, want assert")
        c1 = cdp.send("WebAuthn.getCredentials", {"authenticatorId": auth})["credentials"]
        r.check(c1 and c0 and c1[0]["signCount"] > c0[0]["signCount"], f"the passkey did not sign for the batch: {c0} -> {c1}")
        r.check(statuses(r, rid) == [200], f"batch answers {statuses(r, rid)}")
        for n, c in (("alpha", a[0]), ("zulu", z[0])):
            rc, out = c.wait()
            r.check(rc == 0 and f"Joined #{room} as {n}" in out, f"{n}: rc={rc} {out[-300:]}")
    except Exception as ex:
        fails.append(f"[real] {type(ex).__name__}: {' | '.join(str(ex).splitlines()[:4])[:700]}")
    errs = [e for e in r.errors if "challenges.cloudflare.com" not in e]
    fails += r.failures
    r.close()
    return errs, fails


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://localhost:9982")
    ap.add_argument("--only", choices=list(VIEWPORTS))
    ap.add_argument("--real", action="store_true", help="the passkey pass, on a server with BOTLINK_HUMAN_CHECK=real")
    a = ap.parse_args()
    assert CLI.exists(), f"{CLI} missing (cd client && npm ci && npm run build)"
    E, F = [], []
    with sync_playwright() as p:
        b = p.chromium.launch()
        if a.real:
            e, f = real_pass(b, a.base)
            print(f"real human check: {len(e)} console errors, {len(f)} failures")
            E += e; F += f
        else:
            for vp in [a.only] if a.only else list(VIEWPORTS):
                t = time.time()
                e, f = flow(b, a.base, vp)
                print(f"{vp}: batch on the real server {time.time() - t:.0f}s, {len(e)} console errors, {len(f)} failures")
                E += e; F += f
        b.close()
    for e in E: print("ERROR", e)
    for f in F: print("FAIL ", f)
    ok = not E and not F
    print("OK" if ok else "NOT OK")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
