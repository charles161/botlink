"""Approving several waiting chats of one room together on "What needs you", on the fixture server.

When one room has two or more join requests waiting for this person, each of those cards gets a tick box beside its
code ("This code matches the one <chat> shows"), nothing ticked, and the room gets one bar: "Approve the N ticked
chats", at most five, one human check (approve_joins, bound to the room and exactly the ticked ids), the browser signs
the chain of member_add entries with the single approval's code and sends ONE request. The mock checks the human
check's set, every signature, the seq chain and each entry against its request field for field, all or nothing.

Covered: three waiting, tick two, approve (one check, one request, the third still waits); nothing ticked by default;
no control or shortcut ticks several; a sixth tick refused; a card that changes after its tick loses it and is not
sent; the re-read before signing catches a change (nothing signed or sent); batch_changed, room_full, a name clash and
human_check_failed (nothing approved, said plainly); one waiting chat (no tick box); two rooms (ticks never cross);
moves and person requests (no tick box); a card of tries (needs-tries.js) counts as one chat and ticks only its newest;
the single Approve with ticks present; a reload clears ticks; the room page;
the mock contract itself (400 for 0, 6 or repeated items, a check for one set refuses another, a used check).
Desktop 1440x900 and phone 390x844, light and dark: 0 console errors, no horizontal overflow, no forbidden words, no
text under 13px, tap targets of 44px. Screenshots: web/shots/<vp>[-dark]-31*-batch-*.png

    python3 web/test/test_batch.py                      # starts its own mock on :9981 and stops it after
    python3 web/test/test_batch.py --base http://localhost:8829
"""
import argparse, base64, json, os, pathlib, re, subprocess, sys, tempfile, time, urllib.request
from playwright.sync_api import sync_playwright, expect

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from test_e2e import Run, sign_in, approve_dialog, VIEWPORTS, SHOTS  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parents[2]
ROOM_URL = re.compile(r".*/rooms/([0-9a-f-]{36})$")
BATCH = re.compile(r"/app/v1/rooms/([0-9a-f-]{36})/join-requests/approve$")
CHANGED = "This request changed. Check it again."
OLD_LINE = "Each chat shows its own code. Approve only the one whose code your chat shows."
GROUP_LINE = "Each chat shows its own code. Tick or approve only the ones whose code a chat of yours shows."
SAME_PLACE = "These two run in the same place. Approve them one at a time."


def watch(r):
    r.reqs, r.bodies, r.resps = [], [], []
    r.pg.on("request", lambda q: (r.reqs.append((q.method, q.url.split("?")[0])), r.bodies.append((q.url.split("?")[0], q.post_data)) if q.method == "POST" else None))
    r.pg.on("response", lambda s: r.resps.append((s.request.method, s.url.split("?")[0], s.status)))
    return r


def allow(r, before, status, path):
    """Drop exactly the "Failed to load resource" lines of a refusal under test (status, a path ending) logged since before."""
    pat = re.compile(rf"status of {status} .*@ \S+{path}$")
    r.errors[before:] = [e for e in r.errors[before:] if not pat.search(e)]


def posts(r, pred):
    return [json.loads(b or "{}") for u, b in r.bodies if pred(u)]


def hc_posts(r, action="approve_joins"):
    return [b for b in posts(r, lambda u: u.endswith("/app/v1/human-check")) if b.get("action") == action]


def batch_posts(r):
    return [(BATCH.search(u).group(1), json.loads(b or "{}")) for u, b in r.bodies if BATCH.search(u)]


def single_posts(r):
    return [u for u, _ in r.bodies if re.search(r"/app/v1/join-requests/[0-9a-f-]{36}/approve$", u)]


def entry(wire):
    return json.loads(base64.urlsafe_b64decode(wire["entry"] + "=" * (-len(wire["entry"]) % 4)))


def new_room(r, name):
    r.go("/new"); r.pg.fill("#room-name", name); r.pg.click("button:has-text('Start the room')")
    r.pg.wait_for_url(ROOM_URL); r.settle(400)
    return ROOM_URL.match(r.pg.url).group(1)


def api(r, method, path, body=None):
    """The app API from the page (session cookie, CSRF token): {status, body}."""
    return r.pg.evaluate("""async ([m, p, b]) => {
      const me = await (await fetch('/app/v1/me')).json();
      const res = await fetch(p, { method: m, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf_token }, body: b === null ? undefined : JSON.stringify(b) });
      const t = await res.text(); let j = null; try { j = JSON.parse(t); } catch {}
      return { status: res.status, body: j };
    }""", [method, path, body])


def head_seq(r, room):
    return api(r, "GET", f"/app/v1/rooms/{room}/roster")["body"]["head_seq"]


def state(r, jid):
    return r.pg.request.get(f"{r.base}/__mock/join/{jid}").json()["status"]


def card(r, jid):
    return r.pg.locator(f"[data-need=join][data-request='{jid}']")


def box(r, jid):
    return r.pg.locator(f"input[type=checkbox][data-tick='{jid}']")


def group(r, room):
    return r.pg.locator(f"[data-batch-room='{room}']")


def go_btn(r, room):
    return group(r, room).locator("button.batch-go")


def bar_status(r, room):
    return group(r, room).locator(".batch-status")


def home(r):
    r.go("/rooms"); r.pg.wait_for_selector(".needs-panel, .room-grid", timeout=8000); r.settle(500)


def part_shot(r, loc, name):
    """An element screenshot with the fixed nav out of the way."""
    r.pg.evaluate("() => { const n = document.querySelector('.nav'); if (n) n.style.position = 'relative'; }")
    loc.screenshot(path=str(SHOTS / f"{r.vp}-{name}.png"))
    r.pg.evaluate("() => { const n = document.querySelector('.nav'); if (n) n.style.position = ''; }")


def tick(r, jid):
    b = box(r, jid)
    expect(b).to_be_enabled(timeout=5000)
    b.click()
    r.settle(150)


def mock_post(base, path, data):
    req = urllib.request.Request(base + "/__mock/" + path, data=json.dumps(data).encode(), headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=5) as res:
        return json.loads(res.read() or b"{}")


def flow(b, base, vp):
    fails, errs, runs = [], [], []
    seq = [0]

    def run(name, scheme="light"):
        seq[0] += 1
        x = watch(Run(b, base, vp, scheme=scheme)); runs.append(x)
        sign_in(x, f"{name.lower()}-{vp}-{seq[0]}-{int(time.time() * 1000) % 100000}@batch.test", name)
        return x

    def joins(r, room, names, **kw):
        # each chat in its own folder: two requests that run in the same place (app, computer, folder) look alike
        return {n: r.mock("join", {"room_id": room, "name": n, "app": kw.get("app", "claude-code"), "machine": kw.get("machine", "adams-macbook"), "folder": f"~/{n}", "job": f"Works on the {n} part."}) for n in names}

    try:
        # ── 1. three waiting, tick two, approve: one check, one request, the third still waits ──
        A = run("Adam")
        pg = A.pg
        acme = new_room(A, "acme")
        j = joins(A, acme, ["bugfix", "deployer", "designer"])
        home(A)
        expect(group(A, acme)).to_be_visible(timeout=5000)
        A.check(group(A, acme).locator("input[type=checkbox]").count() == 3, "main: three tick boxes")
        for n in j:
            expect(box(A, j[n]["id"])).to_be_enabled(timeout=5000)
            A.check(not box(A, j[n]["id"]).is_checked(), f"main: {n} ticked by default")
            lab = box(A, j[n]["id"]).evaluate("(b) => b.labels[0]?.textContent.trim()")
            A.check(lab == f"This code matches the one {n} shows", f"main: tick label for {n}: {lab!r}")
        # inside a batch group the twins line fits both ways of approving; the old one is gone there
        for n in j:
            tw = card(A, j[n]["id"]).locator(".need-twins").inner_text()
            A.check(GROUP_LINE in tw and OLD_LINE not in tw and "3 different requests for #acme are waiting" in tw, f"main: {n}'s twins line {tw!r}")
        # no control that ticks several at once, no shortcut that does
        ctl = pg.evaluate("""() => [...document.querySelectorAll('.needs-panel button, .needs-panel a, .needs-panel [role=button], .needs-panel input, .needs-panel label')]
          .map((e) => (e.textContent + ' ' + (e.getAttribute('aria-label') || '')).trim()).filter((t) => /\\b(all|every|select)\\b/i.test(t))""")
        A.check(not ctl, f"main: a control that reads like 'all': {ctl}")
        A.check(go_btn(A, acme).is_disabled(), "main: the bar's button is enabled at 0 ticks")
        A.check(go_btn(A, acme).inner_text().strip() == "Approve the ticked chats", f"main: button at 0: {go_btn(A, acme).inner_text()!r}")
        pg.locator("main").click(position={"x": 5, "y": 5})
        for k in ["Control+a", "Meta+a", "a", "Shift+a", "Enter", "Space", "Control+Enter"]:
            pg.keyboard.press(k)
        box(A, j["bugfix"]["id"]).focus(); pg.keyboard.press("Control+a"); pg.keyboard.press("Shift+End")
        r_ = pg.evaluate("() => document.querySelectorAll('input[data-tick]:checked').length")
        A.check(r_ == 0, f"main: keys ticked {r_} boxes")
        pg.evaluate("() => getSelection().removeAllRanges()")
        tick(A, j["bugfix"]["id"]); tick(A, j["deployer"]["id"])
        A.check(go_btn(A, acme).inner_text().strip() == "Approve the 2 ticked chats", f"main: button at 2: {go_btn(A, acme).inner_text()!r}")
        A.audit("batch-ticked"); A.shot("31-batch-ticked")
        part_shot(A, group(A, acme), "31a-batch-group")
        h0 = head_seq(A, acme)
        go_btn(A, acme).click()
        dlg = pg.locator("dialog[open]")
        expect(dlg).to_be_visible()
        expect(dlg.get_by_role("button", name="Approve 2 chats")).to_be_enabled(timeout=5000)
        txt = dlg.inner_text()
        A.check("These 2 chats become your chats in #acme." in txt, f"main dialog: what happens: {txt!r}")
        A.check("bugfix" in txt and "deployer" in txt and "designer" not in txt, f"main dialog: lists the ticked chats only: {txt!r}")
        A.check(dlg.locator(".batch-list li").count() == 2, "main dialog: two rows")
        A.check("Claude Code" in txt and "adams-macbook" in txt, f"main dialog: app and computer: {txt!r}")
        A.audit("batch-dialog"); A.shot("31b-batch-dialog")
        approve_dialog(A, "Approve 2 chats")
        hcs = hc_posts(A)
        A.check(len(hcs) == 1, f"main: {len(hcs)} approve_joins human checks")
        if hcs:
            A.check(hcs[0].get("target_id") == acme and sorted(hcs[0].get("targets") or []) == sorted([j["bugfix"]["id"], j["deployer"]["id"]]), f"main: check body {hcs[0]}")
        bps = batch_posts(A)
        A.check(len(bps) == 1 and not single_posts(A), f"main: {len(bps)} batch requests, {len(single_posts(A))} single")
        if bps:
            room, body = bps[0]
            A.check(room == acme and sorted(body.keys()) == ["human_check", "items"], f"main: batch path/body keys {room} {sorted(body)}")
            items = body["items"]
            A.check([i["id"] for i in items] == [j["bugfix"]["id"], j["deployer"]["id"]], f"main: item ids {[i['id'] for i in items]}")
            es = [entry(i["roster_entry"]) for i in items]
            A.check([e["seq"] for e in es] == [h0 + 1, h0 + 2] and all(e["op"] == "member_add" for e in es), f"main: chain {[(e['seq'], e['op']) for e in es]}")
            A.check([e["member"] for e in es] == [j["bugfix"]["member_id"], j["deployer"]["member_id"]], "main: members in order")
            A.check(hcs and body["human_check"].get("id") is not None, "main: the human check is in the body")
        st = [s for m, u, s in A.resps if BATCH.search(u)]
        A.check(st == [200], f"main: batch answers {st}")
        A.check(state(A, j["bugfix"]["id"]) == "approved" and state(A, j["deployer"]["id"]) == "approved" and state(A, j["designer"]["id"]) == "pending", "main: two approved, the third waits")
        expect(card(A, j["bugfix"]["id"])).to_have_count(0, timeout=5000)
        expect(card(A, j["designer"]["id"])).to_be_visible()
        A.check(box(A, j["designer"]["id"]).count() == 0, "main: one chat left waiting still has a tick box")
        A.check(head_seq(A, acme) == h0 + 2, "main: roster grew by two")
        if bps:  # a repeat after success: the used check is refused; a new check for the same set finds both decided
            before = len(A.errors)
            again = api(A, "POST", f"/app/v1/rooms/{acme}/join-requests/approve", bps[0][1])
            A.check(again["status"] == 403 and again["body"]["error"]["code"] == "human_check_failed", f"repeat: used check {again['status']}")
            fresh = api(A, "POST", "/app/v1/human-check", {"action": "approve_joins", "target_id": acme, "targets": [i["id"] for i in bps[0][1]["items"]]})["body"]
            again = api(A, "POST", f"/app/v1/rooms/{acme}/join-requests/approve", {**bps[0][1], "human_check": {"id": fresh["id"], "stub": True}})
            A.check(again["status"] == 409 and {x["reason"] for x in again["body"]["error"]["details"]["items"]} == {"already_decided"}, f"repeat: new check {again}")
            A.check(head_seq(A, acme) == h0 + 2, "repeat: roster grew again")
            allow(A, before, 403, "/join-requests/approve"); allow(A, before, 409, "/join-requests/approve")
        A.check(api(A, "GET", f"/app/v1/rooms/{acme}")["body"] is not None, "main: room readable")

        # ── 2. a sixth tick is refused; 3. a card that changes after its tick loses it ──
        B = run("Bea")
        r6 = new_room(B, "six")
        j6 = joins(B, r6, ["anvil", "birch", "cedar", "dune", "ember", "fjord"])
        home(B)
        for n in ["anvil", "birch", "cedar", "dune", "ember"]: tick(B, j6[n]["id"])
        expect(box(B, j6["fjord"]["id"])).to_be_enabled()
        box(B, j6["fjord"]["id"]).click(); B.settle(200)
        B.check(not box(B, j6["fjord"]["id"]).is_checked(), "sixth tick: box checked")
        B.check(B.pg.locator("input[data-tick]:checked").count() == 5, "sixth tick: count != 5")
        expect(group(B, r6)).to_contain_text("Five at a time.")
        B.check(go_btn(B, r6).inner_text().strip() == "Approve the 5 ticked chats", f"sixth: button {go_btn(B, r6).inner_text()!r}")
        B.audit("batch-five")
        # anvil changes after its tick (another computer): its tick goes, visibly, and it is not sent
        B.mock("join-edit", {"id": j6["anvil"]["id"], "machine": "strangers-pc"})
        expect(card(B, j6["anvil"]["id"])).to_contain_text("strangers-pc", timeout=5000)
        B.settle(400)
        B.check(not box(B, j6["anvil"]["id"]).is_checked(), "changed: anvil still ticked")
        expect(card(B, j6["anvil"]["id"])).to_contain_text(CHANGED)
        B.check(B.pg.locator("input[data-tick]:checked").count() == 4, "changed: the others lost their ticks")
        B.audit("batch-changed"); part_shot(B, card(B, j6["anvil"]["id"]), "31c-batch-card-changed")
        go_btn(B, r6).click()
        approve_dialog(B, "Approve 4 chats")
        bp = batch_posts(B)
        B.check(len(bp) == 1 and j6["anvil"]["id"] not in [i["id"] for i in bp[0][1]["items"]], f"changed: anvil sent {bp}")
        B.check(state(B, j6["anvil"]["id"]) == "pending" and state(B, j6["fjord"]["id"]) == "pending", "changed: anvil/fjord not pending")
        B.check(all(state(B, j6[n]["id"]) == "approved" for n in ["birch", "cedar", "dune", "ember"]), "changed: birch..ember not approved")

        # ── 4. the re-read before signing catches a change: nothing signed, nothing sent ──
        C = run("Cleo")
        rr = new_room(C, "reread")
        jr = joins(C, rr, ["alpha", "bravo", "charlie"])
        home(C)
        tick(C, jr["alpha"]["id"]); tick(C, jr["bravo"]["id"])
        go_btn(C, rr).click()
        dlg = C.pg.locator("dialog[open]")
        expect(dlg.get_by_role("button", name="Approve 2 chats")).to_be_enabled(timeout=5000)
        C.mock("join-edit", {"id": jr["bravo"]["id"], "folder": "~/elsewhere"})
        n_roster = sum(1 for m, u in C.reqs if u.endswith("/roster"))
        dlg.get_by_role("button", name="Approve 2 chats").click()
        expect(C.pg.locator("dialog[open]")).to_have_count(0, timeout=8000)
        C.settle(500)
        C.check(not batch_posts(C), "re-read: a batch request was sent")
        C.check(sum(1 for m, u in C.reqs if u.endswith("/roster")) == n_roster, "re-read: the roster was read for signing")
        expect(bar_status(C, rr)).to_contain_text("Nothing was signed or sent.")
        expect(bar_status(C, rr)).to_contain_text("bravo")
        expect(card(C, jr["bravo"]["id"])).to_contain_text(CHANGED)
        C.check(C.pg.locator("input[data-tick]:checked").count() == 0, "re-read: ticks kept")
        C.check(all(state(C, jr[n]["id"]) == "pending" for n in jr), "re-read: something approved")

        # ── 5. batch_changed: one was decided after the re-read; nothing approved, which and why ──
        before = len(C.errors)
        tick(C, jr["alpha"]["id"]); tick(C, jr["charlie"]["id"])

        def decide_then_send(route):
            mock_post(base, "join-edit", {"id": jr["charlie"]["id"], "status": "rejected"})
            route.continue_()
        C.pg.route(f"**/app/v1/rooms/{rr}/join-requests/approve", decide_then_send)
        go_btn(C, rr).click()
        approve_dialog(C, "Approve 2 chats")
        C.pg.unroute(f"**/app/v1/rooms/{rr}/join-requests/approve")
        st = [s for m, u, s in C.resps if BATCH.search(u)]
        C.check(st == [409], f"batch_changed: answers {st}")
        expect(bar_status(C, rr)).to_contain_text("Nothing was approved.")
        expect(bar_status(C, rr)).to_contain_text("charlie was already decided")
        C.check(state(C, jr["alpha"]["id"]) == "pending", "batch_changed: alpha approved")
        C.check(C.pg.locator("input[data-tick]:checked").count() == 0, "batch_changed: ticks kept")
        C.audit("batch-changed-answer"); part_shot(C, group(C, rr), "31d-batch-changed")
        allow(C, before, 409, "/join-requests/approve")

        # ── 6. room_full ──
        D = run("Dina")
        rf = new_room(D, "full")
        D.mock("members-add", {"room_id": rf, "count": 19})
        jf = joins(D, rf, ["late-one", "late-two"])
        home(D)
        before = len(D.errors)
        tick(D, jf["late-one"]["id"]); tick(D, jf["late-two"]["id"])
        go_btn(D, rf).click(); approve_dialog(D, "Approve 2 chats")
        expect(bar_status(D, rf)).to_contain_text("Nothing was approved. #full is full (20 members), so late-two can't come in.")
        D.check(state(D, jf["late-one"]["id"]) == "pending", "room_full: late-one approved")
        allow(D, before, 409, "/join-requests/approve")

        # ── 7. a name clash ──
        nm = new_room(D, "names")
        D.mock("members-add", {"room_id": nm, "count": 1, "name": "twin"})
        jn = joins(D, nm, ["twin", "solo"])
        home(D)
        before = len(D.errors)
        tick(D, jn["twin"]["id"]); tick(D, jn["solo"]["id"])
        go_btn(D, nm).click(); approve_dialog(D, "Approve 2 chats")
        expect(bar_status(D, nm)).to_contain_text("Nothing was approved. Another member of #names is already called twin.")
        D.check(state(D, jn["solo"]["id"]) == "pending", "name clash: solo approved")
        allow(D, before, 409, "/join-requests/approve")

        # ── 8. human_check_failed: the request carries another set than the check ──
        E_ = run("Eve")
        rh = new_room(E_, "check")
        jh = joins(E_, rh, ["one", "two"])
        home(E_)
        before = len(E_.errors)
        tick(E_, jh["one"]["id"]); tick(E_, jh["two"]["id"])

        def drop_one(route):
            body = json.loads(route.request.post_data)
            body["items"] = body["items"][:1]
            route.continue_(post_data=json.dumps(body))
        E_.pg.route(f"**/app/v1/rooms/{rh}/join-requests/approve", drop_one)
        go_btn(E_, rh).click()
        dlg = E_.pg.locator("dialog[open]")
        expect(dlg.get_by_role("button", name="Approve 2 chats")).to_be_enabled(timeout=5000)
        dlg.get_by_role("button", name="Approve 2 chats").click()
        expect(dlg.locator(".hc-status")).to_contain_text("The passkey step didn't count, so nothing was approved.", timeout=5000)
        E_.check([s for m, u, s in E_.resps if BATCH.search(u)] == [403], "hc failed: not a 403")
        E_.check(state(E_, jh["one"]["id"]) == "pending" and state(E_, jh["two"]["id"]) == "pending", "hc failed: something approved")
        E_.pg.unroute(f"**/app/v1/rooms/{rh}/join-requests/approve")
        dlg.get_by_role("button", name="Not now").click()
        allow(E_, before, 403, "/join-requests/approve")

        # ── 8b. a double submit: every ticked chat already decided; refreshed, said plainly, no error tone ──
        rd = new_room(E_, "double")
        jd = joins(E_, rd, ["dd-one", "dd-two", "dd-three"])
        home(E_)
        before = len(E_.errors)
        tick(E_, jd["dd-one"]["id"]); tick(E_, jd["dd-two"]["id"])

        def other_tab_first(route):
            for n in ("dd-one", "dd-two"): mock_post(base, "join-edit", {"id": jd[n]["id"], "status": "approved"})
            route.continue_()
        E_.pg.route(f"**/app/v1/rooms/{rd}/join-requests/approve", other_tab_first)
        go_btn(E_, rd).click(); approve_dialog(E_, "Approve 2 chats")
        E_.pg.unroute(f"**/app/v1/rooms/{rd}/join-requests/approve")
        E_.check([s for m, u, s in E_.resps if BATCH.search(u) and rd in u] == [409], "double: not a 409")
        expect(E_.pg.locator(".toast.toast-info")).to_contain_text("dd-one and dd-two were already decided. Nothing else to do.")
        E_.check(E_.pg.locator(".toast-error").count() == 0, "double: an error toast")
        expect(card(E_, jd["dd-one"]["id"])).to_have_count(0, timeout=5000)
        E_.check(group(E_, rd).count() == 0 and card(E_, jd["dd-three"]["id"]).is_visible(), "double: the list was not refreshed")
        allow(E_, before, 409, "/join-requests/approve")

        # ── 8c. the hourly approval limit: refused as a whole, with the minutes ──
        rl = new_room(E_, "limit")
        E_.mock("approvals-used", {"room_id": rl, "count": 59})
        jl = joins(E_, rl, ["lim-one", "lim-two"])
        home(E_)
        before = len(E_.errors)
        tick(E_, jl["lim-one"]["id"]); tick(E_, jl["lim-two"]["id"])
        go_btn(E_, rl).click(); approve_dialog(E_, "Approve 2 chats")
        expect(bar_status(E_, rl)).to_contain_text("Too many approvals this hour. Try again in 50 minutes.")
        E_.check(state(E_, jl["lim-one"]["id"]) == "pending", "limit: approved one of two")
        allow(E_, before, 429, "/join-requests/approve")

        # ── 9. one waiting chat: no tick box; 10. two rooms: ticks never cross ──
        F = run("Finn")
        r1 = new_room(F, "uno")
        j1 = joins(F, r1, ["lonely"])
        r2 = new_room(F, "dos")
        j2 = joins(F, r2, ["d-one", "d-two"])
        r3 = new_room(F, "tres")
        j3 = joins(F, r3, ["t-one", "t-two"])
        home(F)
        expect(card(F, j1["lonely"]["id"])).to_be_visible(timeout=5000)
        F.check(box(F, j1["lonely"]["id"]).count() == 0 and group(F, r1).count() == 0, "one waiting: tick box or bar shown")
        # one waiting join beside a move: no batch group, so the old twins line stays word for word
        F.mock("members-add", {"room_id": r1, "count": 1, "name": "roamer"})
        mv1 = F.mock("join", {"room_id": r1, "name": "roamer", "kind": "claim", "app": "codex", "machine": "laptop-2"})
        expect(card(F, mv1["id"])).to_be_visible(timeout=5000)
        for jid in (j1["lonely"]["id"], mv1["id"]):
            tw = card(F, jid).locator(".need-twins").inner_text()
            F.check(OLD_LINE in tw and GROUP_LINE not in tw, f"outside a group: twins line {tw!r}")
        F.check(group(F, r1).count() == 0, "one join and a move: a batch group")
        tick(F, j2["d-one"]["id"]); tick(F, j3["t-one"]["id"]); tick(F, j3["t-two"]["id"])
        F.check(go_btn(F, r2).inner_text().strip() == "Approve the 1 ticked chat", f"two rooms: dos button {go_btn(F, r2).inner_text()!r}")
        F.check(go_btn(F, r3).inner_text().strip() == "Approve the 2 ticked chats", "two rooms: tres button")
        go_btn(F, r2).click(); approve_dialog(F, "Approve 1 chat")
        bp = batch_posts(F); hc = hc_posts(F)
        F.check(len(bp) == 1 and bp[0][0] == r2 and [i["id"] for i in bp[0][1]["items"]] == [j2["d-one"]["id"]], f"two rooms: {bp}")
        F.check(len(hc) == 1 and hc[0]["target_id"] == r2 and hc[0]["targets"] == [j2["d-one"]["id"]], f"two rooms: check {hc}")
        F.check(state(F, j3["t-one"]["id"]) == "pending", "two rooms: tres approved")
        F.check(box(F, j3["t-one"]["id"]).is_checked() and box(F, j3["t-two"]["id"]).is_checked(), "two rooms: tres ticks lost")
        # the single approval still works with ticks present
        card(F, j1["lonely"]["id"]).get_by_role("button", name="Approve", exact=True).click()
        approve_dialog(F)
        F.check(state(F, j1["lonely"]["id"]) == "approved", "single with ticks: not approved")
        F.check(box(F, j3["t-one"]["id"]).is_checked() and box(F, j3["t-two"]["id"]).is_checked(), "single with ticks: ticks lost")
        F.check(len(hc_posts(F, "approve_join")) == 1, "single with ticks: approve_join check missing")
        # a reload clears ticks
        F.pg.reload(); F.pg.wait_for_selector("#main > *"); F.settle(600)
        expect(box(F, j3["t-one"]["id"])).to_be_enabled(timeout=5000)
        F.check(F.pg.locator("input[data-tick]:checked").count() == 0, "reload: ticks survived")
        # the approve link of a card that sits in a batch group on the list: the old line, no tick box
        F.go(f"/approve/{j3['t-one']['id']}"); F.settle(600)
        expect(card(F, j3["t-one"]["id"])).to_be_visible(timeout=5000)
        tw = card(F, j3["t-one"]["id"]).locator(".need-twins").inner_text()
        F.check(OLD_LINE in tw and GROUP_LINE not in tw, f"approve link: twins line {tw!r}")
        F.check(box(F, j3["t-one"]["id"]).count() == 0, "approve link: a tick box")
        # the room's own page has the same boxes and bar
        F.go(f"/rooms/{r3}"); F.settle(600)
        expect(group(F, r3)).to_be_visible(timeout=5000)
        F.check(group(F, r3).locator("input[data-tick]").count() == 2, "room page: tick boxes")
        F.audit("batch-room-page")

        # ── 11. moves and person requests: no tick box ──
        G = run("Gus")
        rg = new_room(G, "mixed")
        G.mock("members-add", {"room_id": rg, "count": 1, "name": "mover"})
        mv = G.mock("join", {"room_id": rg, "name": "mover", "kind": "claim", "app": "codex", "machine": "laptop-2"})
        jg = joins(G, rg, ["g-one", "g-two"])
        pr = G.mock("person-request", {"room_id": rg, "email": f"pat-{vp}@batch.test", "name": "Pat"})
        home(G)
        expect(card(G, mv["id"])).to_be_visible(timeout=5000)
        G.check(box(G, mv["id"]).count() == 0 and card(G, mv["id"]).locator("input[type=checkbox]").count() == 0, "move: tick box")
        G.check(G.pg.locator("[data-need=person] input[type=checkbox]").count() == 0, "person request: tick box")
        G.check(G.pg.locator("[data-need=person]").count() == 1, "person request: not shown")
        G.check(group(G, rg).locator("input[data-tick]").count() == 2, "mixed: the two joins have boxes")
        G.check(group(G, rg).locator("[data-need=person], .need-move").count() == 0, "mixed: a move or person card inside the batch group")
        tw = card(G, mv["id"]).locator(".need-twins").inner_text()
        G.check(OLD_LINE in tw, f"mixed: the move card outside the group keeps the old line {tw!r}")
        for n in jg:
            tw = card(G, jg[n]["id"]).locator(".need-twins").inner_text()
            G.check(GROUP_LINE in tw and OLD_LINE not in tw, f"mixed: {n} in the group {tw!r}")

        # ── 11b. two requests that run in the same place are never ticked into one batch (here both name no computer,
        #         so they are two cards, not one card of tries: needs-tries.js) ──
        L = run("Lou")
        rl2 = new_room(L, "alike")
        jl2 = {n: L.mock("join", {"room_id": rl2, "name": n, "machine": m, "folder": f, "job": f"Works on {n}."})
               for n, m, f in (("bugfix", None, "~/acme"), ("deployer", None, "~/acme"), ("writer", "adams-macbook", "~/docs"))}
        home(L)
        tick(L, jl2["bugfix"]["id"])
        expect(box(L, jl2["deployer"]["id"])).to_be_enabled()
        box(L, jl2["deployer"]["id"]).click(); L.settle(200)
        L.check(not box(L, jl2["deployer"]["id"]).is_checked(), "same place: deployer ticked beside bugfix")
        expect(card(L, jl2["deployer"]["id"])).to_contain_text(SAME_PLACE)
        tick(L, jl2["writer"]["id"])
        L.check(box(L, jl2["writer"]["id"]).is_checked(), "same place: writer (another folder) refused")
        L.audit("batch-same-place"); part_shot(L, card(L, jl2["deployer"]["id"]), "31e-batch-same-place")
        box(L, jl2["bugfix"]["id"]).click(); L.settle(150)
        tick(L, jl2["deployer"]["id"])
        L.check(box(L, jl2["deployer"]["id"]).is_checked(), "same place: deployer refused after bugfix was unticked")
        go_btn(L, rl2).click(); approve_dialog(L, "Approve 2 chats")
        bp = batch_posts(L)
        L.check(len(bp) == 1 and sorted(i["id"] for i in bp[0][1]["items"]) == sorted([jl2["deployer"]["id"], jl2["writer"]["id"]]), f"same place: batch {bp}")
        # the single Approve of a lookalike is unchanged
        card(L, jl2["bugfix"]["id"]).get_by_role("button", name="Approve", exact=True).click(); approve_dialog(L)
        L.check(state(L, jl2["bugfix"]["id"]) == "approved", "same place: single approval of bugfix")

        # ── 11c. the same computer, folder and app: one card of tries; only the request it shows (the newest) has a tick
        #         box, so two tries never go into one batch; the older one is approved on its own afterwards ──
        rl3 = new_room(L, "alike-2")
        jl3 = {n: L.mock("join", {"room_id": rl3, "name": n, "machine": "adams-macbook", "folder": f, "job": f"Works on {n}.", "age_s": age})
               for n, f, age in (("bugfix", "~/acme", 120), ("deployer", "~/acme", 60), ("writer", "~/docs", 30))}
        home(L)
        L.check(card(L, jl3["deployer"]["id"]).get_attribute("data-tries") == "2", "tries: bugfix and deployer aren't one card")
        L.check(box(L, jl3["bugfix"]["id"]).count() == 0 and card(L, jl3["bugfix"]["id"]).count() == 0, "tries: the older try has its own card or tick box")
        tick(L, jl3["deployer"]["id"]); tick(L, jl3["writer"]["id"])
        L.audit("batch-tries"); part_shot(L, card(L, jl3["deployer"]["id"]), "31f-batch-tries")
        go_btn(L, rl3).click(); approve_dialog(L, "Approve 2 chats")
        bp = batch_posts(L)
        L.check(len(bp) == 2 and sorted(i["id"] for i in bp[1][1]["items"]) == sorted([jl3["deployer"]["id"], jl3["writer"]["id"]]), f"tries: batch {bp[1:]}")
        L.check(state(L, jl3["bugfix"]["id"]) == "pending", "tries: the older try went with the batch")
        card(L, jl3["bugfix"]["id"]).get_by_role("button", name="Approve", exact=True).click(); approve_dialog(L)
        L.check(state(L, jl3["bugfix"]["id"]) == "approved", "tries: single approval of the older try")

        # ── 12. the mock's contract ──
        H = run("Hal")
        rc = new_room(H, "contract")
        jc = joins(H, rc, ["k1", "k2", "k3"])
        H.go("/rooms"); H.settle(300)
        before = len(H.errors)
        ids = [jc[n]["id"] for n in ["k1", "k2", "k3"]]
        url = f"/app/v1/rooms/{rc}/join-requests/approve"
        hc_ = lambda targets, target=rc: api(H, "POST", "/app/v1/human-check", {"action": "approve_joins", "target_id": target, "targets": targets})
        fake = {"seq": 1, "entry": "e30", "sig": "00", "signer": "00"}
        H.check(hc_([])["status"] == 400 and hc_(ids + ids[:1])["status"] == 400 and hc_([ids[0]] * 6)["status"] == 400, "contract: bad target sets accepted by the human check")
        chk = hc_(ids[:2])["body"]
        H.check(api(H, "POST", url, {"human_check": {"id": chk["id"], "stub": True}, "items": []})["status"] == 400, "contract: 0 items")
        H.check(api(H, "POST", url, {"human_check": {"id": chk["id"], "stub": True}, "items": [{"id": ids[0], "roster_entry": fake}] * 2})["status"] == 400, "contract: repeated items")
        H.check(api(H, "POST", url, {"human_check": {"id": chk["id"], "stub": True}, "items": [{"id": i, "roster_entry": fake} for i in (ids * 2)]})["status"] == 400, "contract: 6 items")
        other = api(H, "POST", url, {"human_check": {"id": chk["id"], "stub": True}, "items": [{"id": ids[0], "roster_entry": fake}]})
        H.check(other["status"] == 403 and other["body"]["error"]["code"] == "human_check_failed", f"contract: a check for {{k1,k2}} used for {{k1}}: {other}")
        single = hc_(None)
        H.check(single["status"] == 400, f"contract: approve_joins without targets: {single['status']}")
        wrong_room = hc_(ids[:1], target=acme)["body"]
        wr = api(H, "POST", url, {"human_check": {"id": wrong_room["id"], "stub": True}, "items": [{"id": ids[0], "roster_entry": fake}]})
        H.check(wr["status"] == 403, f"contract: a check for another room: {wr['status']}")
        one = api(H, "POST", "/app/v1/human-check", {"action": "approve_join", "target_id": ids[0]})["body"]
        sj = api(H, "POST", url, {"human_check": {"id": one["id"], "stub": True}, "items": [{"id": ids[0], "roster_entry": fake}]})
        H.check(sj["status"] == 403, f"contract: a single approval's check on the batch: {sj['status']}")
        bad = api(H, "POST", url, {"human_check": {"id": hc_(ids[:1])["body"]["id"], "stub": True}, "items": [{"id": ids[0], "roster_entry": fake}]})
        H.check(bad["status"] == 400 and bad["body"]["error"]["code"] == "roster_invalid", f"contract: a bad entry: {bad}")
        H.check(state(H, ids[0]) == "pending", "contract: approved by a bad request")
        # server differences (fix-batch approve_batch.go): no roster_entry, another room or a move of the caller's (400
        # with details.id), someone else's (batch_changed not_found), a repeat after success, targets on another action
        H.check(api(H, "POST", url, {"human_check": {"id": hc_(ids[:1])["body"]["id"], "stub": True}, "items": [{"id": ids[0]}]})["status"] == 400, "contract: an item without roster_entry")
        H.check(api(H, "POST", url, {"human_check": {"id": hc_(ids[:1])["body"]["id"], "stub": True}, "items": [{"id": ids[0], "roster_entry": {"seq": 1, "entry": "", "sig": "", "signer": ""}}]})["status"] == 400, "contract: an empty roster_entry")
        rc2 = new_room(H, "contract-two")
        other_room = H.mock("join", {"room_id": rc2, "name": "elsewhere"})
        H.mock("members-add", {"room_id": rc, "count": 1, "name": "k-mover"})
        claim = H.mock("join", {"room_id": rc, "name": "k-mover", "kind": "claim"})
        theirs = H.mock("join", {"room_id": acme, "name": "not-hal"})
        for jid, want in ((other_room["id"], "other room"), (claim["id"], "a move")):
            x = api(H, "POST", url, {"human_check": {"id": hc_([ids[0], jid])["body"]["id"], "stub": True}, "items": [{"id": i, "roster_entry": fake} for i in (ids[0], jid)]})
            H.check(x["status"] == 400 and x["body"]["error"]["code"] == "bad_request" and x["body"]["error"].get("details", {}).get("id") == jid, f"contract: {want}: {x}")
        x = api(H, "POST", url, {"human_check": {"id": hc_([ids[0], theirs["id"]])["body"]["id"], "stub": True}, "items": [{"id": i, "roster_entry": fake} for i in (ids[0], theirs["id"])]})
        H.check(x["status"] == 409 and x["body"]["error"]["code"] == "batch_changed" and x["body"]["error"]["details"]["items"] == [{"id": theirs["id"], "reason": "not_found"}], f"contract: someone else's request: {x}")
        H.check(api(H, "POST", "/app/v1/human-check", {"action": "approve_join", "target_id": ids[0], "targets": ids[:1]})["status"] == 400, "contract: targets on approve_join")
        H.check(hc_(list(reversed(ids[:2])))["status"] == 200, "contract: the order of targets")
        allow(H, before, 400, "/join-requests/approve"); allow(H, before, 409, "/join-requests/approve"); allow(H, before, 403, "/join-requests/approve"); allow(H, before, 400, "/human-check")
    except Exception as ex:
        fails.append(f"[{vp}] {type(ex).__name__}: {' | '.join(str(ex).splitlines()[:4])[:600]}")
    for x in runs:
        errs += x.errors; fails += x.failures
        x.close()
    return errs, fails


def dark(b, base, vp):
    """The ticked list and the dialog in dark."""
    fails = []
    r = watch(Run(b, base, vp, scheme="dark"))
    try:
        sign_in(r, f"dora-{vp}-{int(time.time() * 1000) % 100000}@batch.test", "Dora")
        room = new_room(r, "night")
        j = {n: r.mock("join", {"room_id": room, "name": n, "app": a}) for n, a in [("scout", "codex"), ("writer", "cursor"), ("tester", "claude-code")]}
        home(r)
        tick(r, j["scout"]["id"]); tick(r, j["writer"]["id"])
        r.audit("batch-ticked-dark"); r.shot("dark-31-batch-ticked")
        go_btn(r, room).click()
        expect(r.pg.locator("dialog[open]").get_by_role("button", name="Approve 2 chats")).to_be_enabled(timeout=5000)
        r.audit("batch-dialog-dark"); r.shot("dark-31b-batch-dialog")
        r.pg.locator("dialog[open]").get_by_role("button", name="Not now").click()
    except Exception as ex:
        fails.append(f"[{vp} dark] {type(ex).__name__}: {' | '.join(str(ex).splitlines()[:4])[:600]}")
    errs, fails = r.errors, fails + r.failures
    r.close()
    return errs, fails


def start_mock(port):
    env = dict(os.environ, PORT=str(port), MOCK_HC="stub")
    log = tempfile.NamedTemporaryFile(prefix=f"mock-batch-{port}-", suffix=".log", delete=False)
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
    ap.add_argument("--port", type=int, default=9981)
    ap.add_argument("--only", choices=list(VIEWPORTS))
    a = ap.parse_args()
    proc, base = (None, a.base) if a.base else start_mock(a.port)
    all_errs, all_fails = [], []
    try:
        with sync_playwright() as p:
            b = p.chromium.launch()
            for vp in [a.only] if a.only else list(VIEWPORTS):
                t = time.time()
                e, f = flow(b, base, vp)
                e2, f2 = dark(b, base, vp)
                all_errs += e + e2; all_fails += f + f2
                print(f"{vp}: {len(e + e2)} console errors, {len(f + f2)} failures, {time.time() - t:.1f}s")
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
