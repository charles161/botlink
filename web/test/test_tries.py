"""Join requests from one place shown as ONE card, on the fixture server (P0 rejoin, 21 Nov 2026).

A confused chat re-ran `join` four times from one computer and folder under four names; the room owner saw four full
cards, one per request ("i dont like the ui ux when there are multiple requests"). Now pending JOIN requests of one
room from the same computer + folder + app show as one card: "<App> on <computer> wants in · N tries", the newest
request's name and code as a single card shows them, the older ones under a collapsed "Older tries" (name, code, when
asked, and their own Approve), Approve (the newest only, the same human check as a single request) and "Reject all".

Covered: the four-request case (room page and Your rooms); a new try arriving over SSE updates the card in place
(same key, Details stay open, no entrance animation); approving the newest approves exactly it (one human check bound
to it, one request) and the count drops; approving an older one from Details shows ITS code; "Reject all" with one
reject failing says so and leaves that one waiting; the place strings are attacker-writable: a request with copied
strings and its own code inside the group is not approved by Approve, both codes are on the card, the card counts
the different codes, and the dialog always shows the code of the request being approved; different computers,
folders, apps never merge, requests missing the computer or folder never merge; moves and person requests stay
apart; the batch (needs-batch.js) counts a group as one chat and ticks only the request the card shows; a single
request looks exactly as before (pixel comparison with the screenshots taken before the change); keyboard, labels,
reduced motion; 390x844 and 1440x900, light and dark: 0 console errors, no overflow, no small text, 44px targets.

Screenshots: web/shots/rejoin-group/<label>/<vp>[-dark]-*.png (--label before on the old code, after on the new).

    python3 web/test/test_tries.py                       # its own mock on 127.0.0.1:56947, stopped after
    python3 web/test/test_tries.py --port 56911 --label before
"""
import argparse, json, pathlib, re, sys, time

from playwright.sync_api import sync_playwright, expect

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from test_e2e import Run, sign_in, approve_dialog, VIEWPORTS, SHOTS  # noqa: E402
from test_batch import watch, new_room, state, start_mock, allow, posts, batch_posts, single_posts, box  # noqa: E402

OUT = SHOTS / "rejoin-group"
PLACE = {"app": "other", "app_name": "OpenCode", "machine": "Charless-MacBook-Air.local", "folder": "~/Documents/Default Project"}
FOUR = [("opencode", 600), ("opencode-2", 420), ("opencode-mj", 240), ("sec-research", 60)]
JOB = "coding agent working in Default Project"
CHECKS = [0]


def ck(r, cond, msg):
    CHECKS[0] += 1
    r.check(cond, msg)


def gc(code):
    return f"{code[:3]}-{code[3:]}" if len(code) == 6 else code


def aria(code):
    return "Code " + " ".join(code)


def join(r, room, name, age=0, **kw):
    body = {"room_id": room, "name": name, "job": kw.pop("job", JOB), "age_s": age, **PLACE, **kw}
    return r.mock("join", body)


def cards(r):
    return r.pg.locator("[data-need=join]")


def tries_card(r):
    return r.pg.locator("[data-need=join][data-tries]")


def older_row(r, jid):
    return r.pg.locator(f"[data-older-request='{jid}']")


def open_older(r, g):
    """Open the card's Older tries (it stays open across redraws once opened)."""
    d = g.locator("details.tries-more")
    if not d.evaluate("(d) => d.open"):
        d.locator("summary").click(); r.settle(150)


def room_page(r, room):
    r.go(f"/rooms/{room}")
    r.pg.wait_for_selector("[data-need]", timeout=8000)
    r.settle(700)


def shot_dir(label):
    d = OUT / label
    d.mkdir(parents=True, exist_ok=True)
    return d


def view_shot(r, label, name, loc=None):
    """The viewport with loc at the top (under the nav), like the incident screenshots."""
    if loc is not None:
        loc.evaluate("(el) => { const y = el.getBoundingClientRect().top + scrollY - 90; scrollTo(0, Math.max(0, y)); }")
        r.settle(250)
    r.pg.screenshot(path=str(shot_dir(label) / f"{name}.png"))


UNCAP = "html.shot-whole .panel, html.shot-whole .scroll-body, html.shot-whole .scroll-area { max-height: none !important; overflow: visible !important; }"


def el_shot(r, label, name, loc, whole=True):
    """An element screenshot with the fixed nav out of the way; whole: lift the scroll caps so a tall card isn't cut."""
    r.pg.evaluate("([css, whole]) => { const n = document.querySelector('.nav'); if (n) n.style.position = 'relative'; if (whole) { const s = document.createElement('style'); s.id = 'shot-whole'; s.textContent = css; document.head.append(s); document.documentElement.classList.add('shot-whole'); } }", [UNCAP, whole])
    path = shot_dir(label) / f"{name}.png"
    if whole:
        bb = loc.evaluate("(el) => { const b = el.getBoundingClientRect(); return { x: b.left + scrollX, y: b.top + scrollY, width: b.width, height: b.height }; }")
        r.pg.screenshot(path=str(path), full_page=True, clip=bb, animations="disabled")
    else:
        loc.screenshot(path=str(path), animations="disabled")
    r.pg.evaluate("() => { const n = document.querySelector('.nav'); if (n) n.style.position = ''; document.getElementById('shot-whole')?.remove(); document.documentElement.classList.remove('shot-whole'); }")
    return path


def same_pixels(a, b):
    from PIL import Image, ImageChops
    ia, ib = Image.open(a).convert("RGBA"), Image.open(b).convert("RGBA")
    if ia.size != ib.size:
        return False, f"size {ia.size} vs {ib.size}"
    box_ = ImageChops.difference(ia, ib).getbbox()
    return box_ is None, f"differs in {box_}"


def dialog_text(r):
    dlg = r.pg.locator("dialog[open]")
    expect(dlg).to_be_visible(timeout=5000)
    r.settle(300)
    return dlg.inner_text()


def not_now(r):
    r.pg.locator("dialog[open]").get_by_role("button", name="Not now").click()
    expect(r.pg.locator("dialog[open]")).to_have_count(0, timeout=5000)


def hc_single(r):
    return [b for b in posts(r, lambda u: u.endswith("/app/v1/human-check")) if b.get("action") == "approve_join"]


def four_case(r, label, prefix):
    """The incident: four tries from one place. Returns {name: mock response}, the room id."""
    room = new_room(r, "neon")
    j = {n: join(r, room, n, age) for n, age in FOUR}
    room_page(r, room)
    panel = r.pg.locator(".needs-panel")
    view_shot(r, label, f"{prefix}four-room", panel)
    el_shot(r, label, f"{prefix}four-panel", panel)
    return j, room


def single_case(r, label, prefix):
    room = new_room(r, "solo")
    join(r, room, "bugfix", 0, app="claude-code", app_name=None, machine="adams-macbook", folder="~/acme", match_code="K7Q2MX",
         job="Fixed the checkout double-charge bug (commit a1b2c3). Knows the payment flow.")
    room_page(r, room)
    c = cards(r).first
    view_shot(r, label, f"{prefix}single-room", r.pg.locator(".needs-panel"))
    path = el_shot(r, label, f"{prefix}single-card", c, whole=False)  # as the baseline of the old code was taken
    return room, c, path


def check_single(r, c, path, label, prefix):
    ck(r, cards(r).count() == 1 and tries_card(r).count() == 0, "single: one plain card, no tries card")
    ck(r, c.locator(".need-title").inner_text() == "bugfix would like to come in", f"single: title {c.locator('.need-title').inner_text()!r}")
    ck(r, c.get_by_role("button", name="Reject", exact=True).count() == 1 and c.get_by_role("button", name="Reject all").count() == 0, "single: Reject (not Reject all)")
    ck(r, c.locator(".tries-more, [data-older-request]").count() == 0, "single: an Older tries list on a single request")
    base = OUT / "before" / path.name
    if label != "before":
        if base.exists():
            ok, why = same_pixels(base, path)
            ck(r, ok, f"single: the card's pixels changed against {base.relative_to(SHOTS.parent.parent)} ({why})")
        else:
            ck(r, False, f"single: no before screenshot {base} to compare with")


def flow(b, base, vp, label):
    fails, errs, runs = [], [], []
    seq = [0]

    def run(name, scheme="light"):
        seq[0] += 1
        x = watch(Run(b, base, vp, scheme=scheme)); runs.append(x)
        sign_in(x, f"{name.lower()}-{vp}-{scheme}-{seq[0]}-{int(time.time() * 1000) % 100000}@tries.test", name)
        return x

    try:
        # ── 0. a single request looks exactly as before (first: its screenshot is the baseline of the old code) ──
        Z = run("Zed")
        _, c, path = single_case(Z, label, f"{vp}-")
        check_single(Z, c, path, label, f"{vp}-")
        Z.audit("tries-single")

        # ── 1. the four-request case ──
        A = run("Charles")
        pg = A.pg
        j, neon = four_case(A, label, f"{vp}-")
        newest = j["sec-research"]
        ck(A, cards(A).count() == 1, f"four: {cards(A).count()} cards for four tries from one place (want 1)")
        g = tries_card(A)
        ck(A, g.count() == 1, "four: no tries card")
        if g.count() == 1:
            title = g.locator(".need-title").inner_text().replace("\n", " ")
            ck(A, title == "OpenCode on Charless-MacBook-Air.local wants in · 4 tries", f"four: title {title!r}")
            ck(A, g.get_attribute("data-request") == newest["id"] and g.get_attribute("data-tries") == "4", "four: the card is not the newest's")
            ck(A, g.locator(".code-row .match-code").first.get_attribute("aria-label") == aria(newest["match_code"]), "four: the code shown is not the newest's")
            facts = g.locator(".rq-facts").first.inner_text()
            ck(A, all(x in facts for x in ["sec-research", "OpenCode", "Charless-MacBook-Air.local", "~/Documents/Default Project"]), f"four: facts {facts!r}")
            ck(A, "Approve only if sec-research shows the same code." in g.inner_text(), "four: the match hint names the newest")
            line = g.locator(".need-twins").inner_text()
            ck(A, "4 different codes" in line, f"four: the card doesn't count the codes ({line!r})")
            ck(A, "—" not in g.inner_text(), "four: an em dash on the card")
            ck(A, g.get_by_role("button", name="Approve", exact=True).count() == 1, "four: one Approve")
            ck(A, g.get_by_role("button", name="Reject all").count() == 1 and g.get_by_role("button", name="Reject", exact=True).count() == 0, "four: Reject all instead of Reject")
            ck(A, pg.locator(".batch-group").count() == 0 and pg.locator("input[type=checkbox][data-tick]").count() == 0, "four: one place is not a batch")
            # like a single request (test_e2e.py), the whole card with its Approve fits in the list's scroll area
            fits = g.evaluate("(c) => { const b = c.closest('.scroll-body'); return c.getBoundingClientRect().height <= b.getBoundingClientRect().height + 1; }")
            ck(A, fits, "four: the card doesn't fit in the capped panel")
            more = g.locator("details.tries-more")
            ck(A, more.count() == 1 and not more.evaluate("(d) => d.open"), "four: Older tries missing or open by default")
            ck(A, g.get_attribute("aria-labelledby") == g.locator(".need-title").get_attribute("id"), "four: the card is not labelled by its title")
            # keyboard: the summary opens with Enter
            more.locator("summary").focus(); pg.keyboard.press("Enter"); A.settle(200)
            ck(A, more.evaluate("(d) => d.open"), "four: Enter on Older tries didn't open it")
            rows = g.locator("[data-older-request]")
            names = [rows.nth(i).locator(".tries-name").inner_text() for i in range(rows.count())]
            ck(A, names == ["opencode-mj", "opencode-2", "opencode"], f"four: older rows {names}")
            for n in ["opencode-mj", "opencode-2", "opencode"]:
                row = older_row(A, j[n]["id"])
                ck(A, row.locator(".match-code").get_attribute("aria-label") == aria(j[n]["match_code"]), f"four: {n}'s row shows another code")
                ck(A, "min ago" in row.inner_text(), f"four: {n}'s row doesn't say when it asked")
                ck(A, row.get_by_role("button", name=f"Approve {n}, code {gc(j[n]['match_code'])}").count() == 1, f"four: {n}'s row has no labelled Approve")
            A.audit("tries-four")
            el_shot(A, label, f"{vp}-four-card-details", g)
            more.locator("summary").click(); A.settle(150)
        # Your rooms: the same one card, with the room named
        A.go("/rooms"); pg.wait_for_selector(".needs-panel", timeout=8000); A.settle(600)
        ck(A, cards(A).count() == 1 and tries_card(A).count() == 1, f"rooms: {cards(A).count()} cards for four tries")
        if tries_card(A).count():
            ck(A, "#neon" in tries_card(A).locator(".need-room").inner_text(), "rooms: the tries card doesn't name the room")
        A.audit("tries-four-rooms"); view_shot(A, label, f"{vp}-four-your-rooms", pg.locator(".needs-panel"))

        # ── 2. a new try arrives over SSE: the card updates in place ──
        room_page(A, neon)
        g = tries_card(A)
        if g.count() == 1:
            open_older(A, g)
            key0 = g.get_attribute("data-need-key")
            j5 = join(A, neon, "opencode-3", 0)
            expect(g.locator(".need-title")).to_contain_text("5 tries", timeout=5000)
            ck(A, g.evaluate("(c) => c.getAnimations().length") == 0, "live: the updated card played its entrance animation again")
            ck(A, cards(A).count() == 1, "live: a second card for the new try")
            ck(A, g.get_attribute("data-need-key") == key0, "live: the card's key changed")
            ck(A, g.locator("details.tries-more").evaluate("(d) => d.open"), "live: Older tries closed on the update")
            ck(A, g.get_attribute("data-request") == j5["id"] and g.locator(".code-row .match-code").first.get_attribute("aria-label") == aria(j5["match_code"]), "live: the card doesn't show the new newest")
            ck(A, g.locator("[data-older-request]").count() == 4, "live: older rows")
            ck(A, pg.locator(".needs-panel .new-pill").is_hidden(), "live: the update counted as a new item")

            # ── 3. Approve acts on the newest only ──
            A.reqs.clear(); A.bodies.clear()
            g.get_by_role("button", name="Approve", exact=True).click()
            t = dialog_text(A)
            ck(A, gc(j5["match_code"]) in t and "opencode-3" in t, f"approve: the dialog doesn't show the newest's code ({t[:200]!r})")
            ck(A, not any(gc(j[n]["match_code"]) in t for n in j), "approve: the dialog shows another try's code")
            approve_dialog(A)
            ck(A, state(A, j5["id"]) == "approved", "approve: the newest isn't approved")
            ck(A, all(state(A, j[n]["id"]) == "pending" for n in j), "approve: an older try was approved too")
            sp = single_posts(A)
            ck(A, len(sp) == 1 and j5["id"] in sp[0], f"approve: approve requests {sp}")
            hc = hc_single(A)
            ck(A, len(hc) == 1 and hc[0].get("target_id") == j5["id"], f"approve: human checks {hc}")
            expect(g.locator(".need-title")).to_contain_text("4 tries", timeout=5000)
            ck(A, g.get_attribute("data-request") == newest["id"], "approve: the card doesn't show the next newest")

            # ── 4. an older one approved from Details: its own code in the dialog ──
            o = j["opencode-2"]
            open_older(A, g)
            A.reqs.clear(); A.bodies.clear()
            older_row(A, o["id"]).get_by_role("button", name=re.compile(r"^Approve opencode-2,")).click()
            t = dialog_text(A)
            ck(A, gc(o["match_code"]) in t and "opencode-2" in t and gc(newest["match_code"]) not in t, f"older: the dialog's code ({t[:200]!r})")
            approve_dialog(A)
            ck(A, state(A, o["id"]) == "approved" and state(A, newest["id"]) == "pending", "older: the wrong request was approved")
            sp = single_posts(A)
            ck(A, len(sp) == 1 and o["id"] in sp[0], f"older: approve requests {sp}")
            expect(g.locator(".need-title")).to_contain_text("3 tries", timeout=5000)

            # ── 5. Reject all, one reject failing ──
            A.mock("reject-fails", {"id": j["opencode"]["id"]})
            before = len(A.errors)
            g.get_by_role("button", name="Reject all").click()
            toast = pg.locator(".toast").last
            expect(toast).to_contain_text("opencode", timeout=5000)
            tt = toast.inner_text()
            ck(A, "2 of 3" in tt and "still waiting" in tt, f"reject all: partial failure not said plainly ({tt!r})")
            A.settle(500)
            ck(A, state(A, newest["id"]) == "rejected" and state(A, j["opencode-mj"]["id"]) == "rejected", "reject all: the others weren't rejected")
            ck(A, state(A, j["opencode"]["id"]) == "pending", "reject all: the failed one isn't waiting")
            expect(cards(A)).to_have_count(1, timeout=5000)
            ck(A, tries_card(A).count() == 0 and cards(A).first.locator(".need-title").inner_text() == "opencode would like to come in", "reject all: the one left isn't a plain card")
            allow(A, before, 503, "/reject")
            A.mock("reject-fails", {"id": j["opencode"]["id"], "fail": False})
            A.audit("tries-after-reject-all")
            cards(A).first.get_by_role("button", name="Reject", exact=True).click()
            expect(cards(A)).to_have_count(0, timeout=5000)

            # a clean Reject all: everything gone, said once
            r1, r2 = join(A, neon, "again-1", 30), join(A, neon, "again-2", 0)
            expect(tries_card(A)).to_have_count(1, timeout=5000)
            tries_card(A).get_by_role("button", name="Reject all").click()
            expect(pg.locator(".toast").last).to_contain_text("Rejected both tries", timeout=5000)
            ck(A, state(A, r1["id"]) == "rejected" and state(A, r2["id"]) == "rejected", "reject all: not all rejected")

        # ── 6. copied place strings: Approve never approves the copy; both codes in view; the dialog's code is the approved one ──
        S = run("Sam")
        sp_room = new_room(S, "spoof")
        mine = join(S, sp_room, "my-chat", 30, match_code="NZXQCU")
        copy = join(S, sp_room, "my-chat-x", 90, match_code="QJPS8X")  # another computer, the same strings, its own code
        room_page(S, sp_room)
        g = tries_card(S)
        ck(S, cards(S).count() == 1 and g.count() == 1, "spoof: the copy isn't in the group (the test needs it there)")
        if g.count() == 1:
            ck(S, g.locator(".code-row .match-code").first.get_attribute("aria-label") == aria("NZXQCU"), "spoof: main code")
            ck(S, "2 different codes" in g.locator(".need-twins").inner_text(), "spoof: the card doesn't say two codes wait")
            open_older(S, g)
            ck(S, older_row(S, copy["id"]).locator(".match-code").get_attribute("aria-label") == aria("QJPS8X"), "spoof: the copy's code isn't on the card")
            S.reqs.clear(); S.bodies.clear()
            g.get_by_role("button", name="Approve", exact=True).click()
            t = dialog_text(S)
            ck(S, "NZX-QCU" in t and "QJP-S8X" not in t, f"spoof: dialog codes ({t[:200]!r})")
            approve_dialog(S)
            ck(S, state(S, mine["id"]) == "approved", "spoof: my chat isn't approved")
            ck(S, state(S, copy["id"]) == "pending", "spoof: Approve approved the copy too")
            sp = single_posts(S); hc = hc_single(S)
            ck(S, len(sp) == 1 and mine["id"] in sp[0] and len(hc) == 1 and hc[0].get("target_id") == mine["id"], f"spoof: requests {sp} {hc}")
            expect(cards(S)).to_have_count(1, timeout=5000)
            ck(S, cards(S).first.locator(".code-row .match-code").get_attribute("aria-label") == aria("QJPS8X"), "spoof: the copy left waiting doesn't show its own code")
            cards(S).first.get_by_role("button", name="Reject", exact=True).click()
            expect(cards(S)).to_have_count(0, timeout=5000)
        # the copy is the newest: the card shows ITS code, and Approve's dialog shows that code too
        mine2 = join(S, sp_room, "my-chat-2", 200, match_code="K7Q2MX")
        copy2 = join(S, sp_room, "my-chat-y", 10, match_code="ABC234")
        expect(tries_card(S)).to_have_count(1, timeout=5000)
        g = tries_card(S)
        ck(S, g.locator(".code-row .match-code").first.get_attribute("aria-label") == aria("ABC234"), "spoof newest: the card shows another code than the one it approves")
        g.get_by_role("button", name="Approve", exact=True).click()
        t = dialog_text(S)
        ck(S, "ABC-234" in t and "K7Q-2MX" not in t, f"spoof newest: dialog ({t[:200]!r})")
        not_now(S)
        open_older(S, g)
        older_row(S, mine2["id"]).get_by_role("button", name=re.compile(r"^Approve my-chat-2,")).click()
        t = dialog_text(S)
        ck(S, "K7Q-2MX" in t and "ABC-234" not in t, f"spoof newest: the older one's dialog ({t[:200]!r})")
        approve_dialog(S)
        ck(S, state(S, mine2["id"]) == "approved" and state(S, copy2["id"]) == "pending", "spoof newest: the wrong request approved")

        # ── 7. never merged: another computer, folder, app; missing computer or folder ──
        M = run("Mo")
        mr = new_room(M, "apart")
        P = {"app": "codex", "app_name": None, "machine": "m1", "folder": "~/a"}
        variants = [{}, {"machine": "m2"}, {"folder": "~/b"}, {"app": "cursor"}, {"app": "other", "app_name": "Kilo"},
                    {"machine": None}, {"machine": None}, {"folder": None}, {"folder": None}]
        for i, v in enumerate(variants):
            join(M, mr, f"c{i}", 100 - i, **{**P, **v})
        room_page(M, mr)
        ck(M, cards(M).count() == len(variants) and tries_card(M).count() == 0, f"apart: {cards(M).count()} cards, {tries_card(M).count()} tries cards")
        ck(M, M.pg.locator("[data-need=join]", has_text="unknown").count() == 4, "apart: missing computer or folder not shown as unknown")

        # ── 8. moves and person requests stay apart ──
        mv = new_room(M, "moves")
        alpha = join(M, mv, "alpha", 0, **P)
        room_page(M, mv)
        cards(M).first.get_by_role("button", name="Approve", exact=True).click(); approve_dialog(M)
        join(M, mv, "beta", 50, **P); join(M, mv, "gamma", 40, **P)
        M.mock("join", {"room_id": mv, "name": "alpha", "kind": "claim", **P})
        M.mock("person-request", {"room_id": mv, "email": f"pat-{vp}-{seq[0]}@tries.test", "name": "Pat"})
        room_page(M, mv)
        ck(M, cards(M).count() == 2 and tries_card(M).count() == 1, f"moves: {cards(M).count()} join cards (want the group + the move)")
        if tries_card(M).count():
            ck(M, tries_card(M).get_attribute("data-tries") == "2", "moves: the move was counted as a try")
            ck(M, tries_card(M).locator(".need-move, [data-need=person]").count() == 0, "moves: a move or person inside the tries card")
        ck(M, M.pg.locator(".need-move").count() == 1 and M.pg.locator("[data-need=person]").count() == 1, "moves: the move or the person card is missing")
        M.audit("tries-moves")

        # ── 9. the batch counts a group as one chat and ticks only the request the card shows ──
        X = run("Xia")
        xr = new_room(X, "mixed")
        t1, t2, t3 = join(X, xr, "t1", 300), join(X, xr, "t2", 200), join(X, xr, "t3", 100)
        w = join(X, xr, "writer", 50, app="cursor", app_name=None, machine="xias-pc", folder="~/docs")
        room_page(X, xr)
        grp = X.pg.locator(f"[data-batch-room='{xr}']")
        ck(X, grp.count() == 1, "batch: no batch group for a tries card and another chat")
        ticks = X.pg.locator("input[type=checkbox][data-tick]")
        ids = sorted(ticks.nth(i).get_attribute("data-tick") for i in range(ticks.count()))
        ck(X, ids == sorted([t3["id"], w["id"]]), f"batch: tick boxes for {ids}")
        if grp.count() == 1 and box(X, t3["id"]).count() == 1:
            ck(X, "2 chats are waiting" in grp.locator(".batch-intro").inner_text(), f"batch: intro {grp.locator('.batch-intro').inner_text()!r}")
            # a newer try from t3's place: t3's tick goes (it is under Older tries now) and the bar says why
            expect(box(X, t3["id"])).to_be_enabled(timeout=5000); box(X, t3["id"]).click(); X.settle(150)
            t4 = join(X, xr, "t4", 0)
            expect(box(X, t4["id"])).to_have_count(1, timeout=5000)
            X.settle(300)
            ck(X, box(X, t3["id"]).count() == 0 and not box(X, t4["id"]).is_checked(), "batch: a tick moved to the newer try or stayed on the older one")
            note = grp.locator(".batch-status")
            ck(X, note.is_visible() and "t3" in note.inner_text(), f"batch: the bar doesn't say why t3's tick went ({note.inner_text() if note.count() else None!r})")
            t1, t2, t3 = t2, t3, t4
            for jid in (t3["id"], w["id"]):
                expect(box(X, jid)).to_be_enabled(timeout=5000); box(X, jid).click(); X.settle(150)
            X.audit("tries-batch"); el_shot(X, label, f"{vp}-batch-with-tries", grp)
            grp.locator("button.batch-go").click(); approve_dialog(X, "Approve 2 chats")
            bp = batch_posts(X)
            ck(X, len(bp) == 1 and sorted(i["id"] for i in bp[0][1]["items"]) == sorted([t3["id"], w["id"]]), f"batch: sent {bp}")
            ck(X, state(X, t1["id"]) == "pending" and state(X, t2["id"]) == "pending", "batch: an older try went with the batch")

    except Exception as ex:
        fails.append(f"[{vp}] {type(ex).__name__}: {' | '.join(str(ex).splitlines()[:4])[:600]}")
    for x in runs:
        errs += x.errors; fails += x.failures
        x.close()
    return errs, fails


def dark(b, base, vp, label):
    """The four-request case and the single request in dark (screenshots, audit, the single card's pixels)."""
    fails = []
    r = watch(Run(b, base, vp, scheme="dark"))
    try:
        sign_in(r, f"dora-{vp}-{int(time.time() * 1000) % 100000}@tries.test", "Dora")
        j, room = four_case(r, label, f"{vp}-dark-")
        g = tries_card(r)
        ck(r, g.count() == 1, "dark four: no tries card")
        if g.count():
            open_older(r, g)
            r.audit("tries-four-dark")
            el_shot(r, label, f"{vp}-dark-four-card-details", g)
        _, c, path = single_case(r, label, f"{vp}-dark-")
        check_single(r, c, path, label, f"{vp}-dark-")
        r.audit("tries-single-dark")
    except Exception as ex:
        fails.append(f"[{vp} dark] {type(ex).__name__}: {' | '.join(str(ex).splitlines()[:4])[:600]}")
    errs, fails = r.errors, fails + r.failures
    r.close()
    return errs, fails


def reduced(b, base, label):
    """Reduced motion: the card appears and updates without movement."""
    fails = []
    r = watch(Run(b, base, "phone"))
    try:
        r.pg.emulate_media(reduced_motion="reduce")
        sign_in(r, f"rita-{int(time.time() * 1000) % 100000}@tries.test", "Rita")
        room = new_room(r, "calm")
        for n, age in FOUR[:2]:
            join(r, room, n, age)
        room_page(r, room)
        g = tries_card(r)
        ck(r, g.count() == 1, "reduced: no tries card")
        if g.count():
            dur = g.evaluate("(c) => getComputedStyle(c).animationDuration")
            ck(r, dur in ("1e-06s", "0.001ms", "0s") or float(dur.rstrip("ms").rstrip("s") or 0) < 0.01, f"reduced: the card animates ({dur})")
            join(r, room, "sec-research", 0)
            expect(g.locator(".need-title")).to_contain_text("3 tries", timeout=5000)
            r.audit("tries-reduced"); el_shot(r, label, "phone-reduced-motion-card", g)
    except Exception as ex:
        fails.append(f"[reduced] {type(ex).__name__}: {' | '.join(str(ex).splitlines()[:4])[:600]}")
    errs, fails = r.errors, fails + r.failures
    r.close()
    return errs, fails


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base")
    ap.add_argument("--port", type=int, default=56947)
    ap.add_argument("--only", choices=list(VIEWPORTS))
    ap.add_argument("--label", default="after", help="screenshot subfolder under web/shots/rejoin-group/ (before | after)")
    a = ap.parse_args()
    proc, base = (None, a.base) if a.base else start_mock(a.port)
    all_errs, all_fails = [], []
    try:
        with sync_playwright() as p:
            b = p.chromium.launch()
            for vp in [a.only] if a.only else list(VIEWPORTS):
                t = time.time()
                e, f = flow(b, base, vp, a.label)
                e2, f2 = dark(b, base, vp, a.label)
                all_errs += e + e2; all_fails += f + f2
                print(f"{vp}: {len(e + e2)} console errors, {len(f + f2)} failures, {time.time() - t:.1f}s")
            e3, f3 = reduced(b, base, a.label)
            all_errs += e3; all_fails += f3
            b.close()
    finally:
        if proc:
            proc.terminate(); proc.wait(5)
    for e in all_errs: print("ERROR", e)
    for f in all_fails: print("FAIL", f)
    ok = not all_errs and not all_fails
    print(f"{CHECKS[0]} checks, {len(all_fails)} failures, {len(all_errs)} console errors")
    print("PASS" if ok else "FAIL")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
