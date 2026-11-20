"""A room a chat asked for, against the REAL Go server and the REAL client CLI (docs/protocol/room-drafts.md).

A chat runs `create-room` (client/dist/cli.js, its own key store); the code comes from the chat's output, because the
page never shows it. A signed-in person opens the chat's link, types one wrong code (4 tries left; the retry needs no
second human check), then the right one, and confirms. Then: the page is on /rooms/<id> with the room fingerprint
shown as checked; the chat's `join --wait` prints "Joined #…" with the same room fingerprint; a second chat of the
same person joins through the room's invite and receives a message the first chat sends; the link shows the generic
not-found page; `invite-link` prints the URL the room page shows. Also: a purpose with a direction-changing character
is refused by the server (400 bad_request, the client quotes it), and a second person opening a link the first person
holds sees the generic not-found page.

    BOTLINK_ENV=dev BOTLINK_ADDR=127.0.0.1:8828 BOTLINK_DEV_LOGIN=1 BOTLINK_HUMAN_CHECK=stub \
      BOTLINK_APP_ORIGIN=http://localhost:8828 BOTLINK_WEB_DIR=web/public BOTLINK_METRICS_ADDR=off \
      BOTLINK_DATABASE_URL=postgres://botlink@127.0.0.1:55432/botlink_dev .dev/bin/botlink &
    python3 web/test/test_create_real.py [--base http://localhost:8828] [--only phone|desktop]
"""
import argparse, json, os, pathlib, re, sys, time
from playwright.sync_api import sync_playwright, expect
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from test_e2e import Run, VIEWPORTS, approve_dialog  # noqa: E402
from test_real_server import Chat, CLI  # noqa: E402
from test_create import HEADING, NOT_FOUND, ROOM_URL, watch, calls, allow, confirm_btn, status, type_code  # noqa: E402

RLO = chr(0x202E)
LINK = re.compile(r"Link for your human: (\S+/create/([0-9a-f-]{36}))")
CODE = re.compile(r"Code ([2-9A-Z]{3})-([2-9A-Z]{3}) · key ([0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4})")


def create_room(chat, room, name, purpose="Plan the launch week", job="Plans the launch week."):
    chat.app = "other"  # join --wait waits for this chat's own request: the same app
    chat.env["BOTLINK_APP"] = "other"  # every later command acts as this other-app chat, whatever app runs the test
    return chat.run("create-room", "--room", room, "--purpose", purpose, "--name", name, "--job", job, "--app", "other", "--app-name", "OpenCode", "--no-setup")


def sign_in(r, email, name):
    r.go("/login?return_to=/rooms")
    r.pg.fill("#dev-email", email); r.pg.fill("#dev-name", name)
    r.pg.click("button:has-text('Sign in (dev)')")
    r.pg.wait_for_url(re.compile(r"^[a-z]+://[^/]+/rooms(?:[?#].*)?$")); r.settle(400)


def local(base, url):
    """The chat prints the server's app origin; the browser uses the base it was given (the same server)."""
    return re.sub(r"^https?://[^/]+", base, url)


def flow(b, base, vp):
    tag = f"{vp[:1]}{os.urandom(2).hex()}"
    room = f"launch-{tag}"
    runs, fails = [], []

    def run(email, name):
        x = watch(Run(b, base, vp)); runs.append(x)
        sign_in(x, email, name)
        return x

    try:
        A = run(f"adam-{tag}@create.test", "Adam"); pg = A.pg

        # the chat asks; the code and the key come from its output (the page never shows the code)
        planner = Chat(base, f"{tag}-planner")
        rc, out = create_room(planner, room, "planner")
        link, code = LINK.search(out), CODE.search(out)
        assert rc == 0 and link and code, f"create-room rc={rc}: {out}"
        url, did, key = local(base, link.group(1)), link.group(2), code.group(3)
        right = code.group(1) + code.group(2)
        pg.goto(url); pg.wait_for_selector(f"[data-draft='{did}']", timeout=8000); A.settle(300)
        expect(pg.locator("main h1")).to_have_text(HEADING)
        expect(pg.locator("[data-fp]")).to_have_text(key)  # the browser's fingerprint of the card's keys == the chat's
        A.check(pg.locator(".cw-text[data-field=room_name]").text_content() == room, "card: room name")
        facts = pg.locator(".rq-facts").inner_text()
        A.check("planner" in facts and "OpenCode" in facts, f"card: facts {facts!r}")
        A.audit("real-create-card"); A.shot("real-30-create-card")

        # one wrong code: 4 tries left; the retry with the right code needs no second human check
        n0 = calls(A, "/app/v1/human-check")
        wrong = "ZZZ999" if right != "ZZZ999" else "YYY888"
        type_code(A, wrong); confirm_btn(A).click(); approve_dialog(A, "Confirm")
        expect(status(A)).to_have_text("That code doesn't match the one your chat shows. 4 tries left.")
        type_code(A, f"{right[:3].lower()}-{right[3:].lower()}"); confirm_btn(A).click()
        pg.wait_for_url(ROOM_URL, timeout=10000)
        A.check(calls(A, "/app/v1/human-check") - n0 == 1, f"{calls(A, '/app/v1/human-check') - n0} human checks for a wrong then a right code, want one")
        A.check(calls(A, f"/room-drafts/{did}/confirm") == 2, "wrong then right: two confirm requests")
        hc = [json.loads(x) for u, x in A.bodies if u.endswith("/app/v1/human-check")][-1]
        A.check(hc == {"action": "confirm_room", "target_id": did}, f"human check {hc}")
        allow(A, 0, 403, f"/room-drafts/{did}/confirm")
        expect(pg.locator(".fp-chip.ok")).to_be_visible(timeout=8000)  # the browser verified the new room's roster
        room_fp = pg.locator(".fp-chip code").text_content().strip()
        expect(pg.locator(".roster-item", has_text="planner")).to_be_visible(timeout=8000)
        invite = pg.locator(".invite-url").inner_text().strip()
        A.shot("real-30-create-room")

        # the chat's wait: approved, the approval self-check, the same room fingerprint
        rc, out = planner.wait()
        A.check(rc == 0 and f"Joined #{room}" in out and room_fp in out, f"join --wait rc={rc} (room fp {room_fp}): {out[-800:]}")

        # a second chat of the same person comes in through the room's invite and receives the first chat's message
        helper = Chat(base, f"{tag}-helper")
        helper.env["BOTLINK_APP"] = "claude-code"  # its inbox acts as this Claude Code chat wherever the test runs
        helper.join(invite, "helper", job="Helps plan.")
        card = pg.locator("[data-need=join]", has_text="helper")
        expect(card).to_be_visible(timeout=8000)
        card.get_by_role("button", name="Approve").click(); approve_dialog(A)
        rc, out = helper.wait()
        A.check(rc == 0, f"helper join: rc={rc} {out[-400:]}")
        text = f"hello from planner {tag}"
        rc, out = planner.run("send", "--as", "planner", "--to", "helper", "--intent", "fyi", "--text", text)
        A.check(rc == 0, f"send: rc={rc} {out[-400:]}")
        sent = out
        got = ""
        for _ in range(10):
            rc, got = helper.run("inbox", "--as", "helper")
            if text in got: break
            time.sleep(1)
        A.check(text in got, f"helper's inbox lacks the message: {got[-600:]} (send said: {sent[-400:]})")

        # the link after the confirm: the generic not-found page
        pg.goto(url); A.settle(900)
        A.check(NOT_FOUND in pg.locator("main").inner_text() and pg.locator("[data-draft]").count() == 0, "confirmed draft's link: not the generic not-found page")
        allow(A, 0, 404, f"/room-drafts/{did}/claim")

        # invite-link prints the room page's invite URL
        rc, out = planner.run("invite-link", "--as", "planner")
        A.check(rc == 0 and invite in out, f"invite-link rc={rc}: want {invite!r} in {out[-500:]}")

        # a purpose with a direction-changing character: the server refuses the draft (400), the client quotes it
        bidi = Chat(base, f"{tag}-bidi")
        rc, out = create_room(bidi, f"bidi-{tag}", "bidibot", purpose="Ship " + RLO + "exe.txt")
        A.check(rc != 0 and "bad_request" in out and "room_purpose must be one line of visible text" in out and not LINK.search(out), f"bidi purpose: rc={rc} {out[-500:]}")

        # a second person opening a link the first person already holds: the generic not-found page
        other = Chat(base, f"{tag}-other")
        rc, out = create_room(other, f"held-{tag}", "heldbot")
        m = LINK.search(out)
        assert rc == 0 and m, f"create-room rc={rc}: {out}"
        held = local(base, m.group(1))
        pg.goto(held); pg.wait_for_selector(f"[data-draft='{m.group(2)}']", timeout=8000)  # Adam holds it now
        B = run(f"bea-{tag}@create.test", "Bea")
        B.pg.goto(held); B.settle(900)
        B.check(NOT_FOUND in B.pg.locator("main").inner_text() and B.pg.locator("[data-draft]").count() == 0, "someone else's draft: not the generic not-found page")
        allow(B, 0, 404, f"/room-drafts/{m.group(2)}/claim")
        B.audit("real-create-not-yours")
    except Exception as ex:
        fails.append(f"[{vp}] {type(ex).__name__}: {' | '.join(str(ex).splitlines()[:4])[:700]}")
    errs = []
    for x in runs:
        errs += x.errors; fails += x.failures
        try: x.close()
        except Exception: pass
    return errs, fails


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://localhost:8828")
    ap.add_argument("--only", choices=list(VIEWPORTS))
    a = ap.parse_args()
    assert CLI.exists(), f"{CLI} missing (client/ builds it)"
    E, F = [], []
    with sync_playwright() as p:
        b = p.chromium.launch()
        for vp in [a.only] if a.only else list(VIEWPORTS):
            t = time.time()
            e, f = flow(b, a.base, vp)
            print(f"{vp}: create on the real server {time.time() - t:.0f}s, {len(e)} console errors, {len(f)} failures")
            E += e; F += f
        b.close()
    for e in E: print("ERROR", e)
    for f in F: print("FAIL ", f)
    ok = not E and not F
    print("OK" if ok else "NOT OK")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
