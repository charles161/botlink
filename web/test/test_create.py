"""A room a chat asked for (docs/protocol/room-drafts.md §4): the /create/<id> page on the fixture server.

The person opens the link from their chat, types the code the chat shows and confirms with the human check; the browser
signs the room's genesis, the device_add entries and the chat's member_add, sends one request and opens the new room.
The mock verifies every signature and checks the member_add field for field against the draft. Also: a wrong code
then the right one (the human check is kept), five wrong codes (closed), a name already taken (another name), Don't
make it, ran out while open, someone else's or an unknown draft (the generic not-found page), signed out (back to the
link after sign-in), a ?code= in the link (ignored), a card that changed after it was shown (nothing signed), a card
that doesn't check out, too many drafts, and hostile chat text (HTML, a javascript: link, Markdown, a 140-character
run, right-to-left override, our own heading) shown inert inside the quotes. Drafts appear nowhere else.
Phone 390x844 and desktop 1440x900, light (dark for the card and the hostile text): 0 console errors, no horizontal
overflow, no forbidden words, no text under 13px, tap targets of 44px. Screenshots: web/shots/<vp>[-dark]-30*-create-*.png

    python3 web/test/test_create.py                      # starts its own mock on :9921 and stops it after
    python3 web/test/test_create.py --base http://localhost:8829
    python3 web/test/test_create.py --real               # the first passkey in the confirm step (MOCK_HC=real, :9921)
"""
import argparse, json, os, pathlib, re, subprocess, sys, tempfile, time, urllib.request
from playwright.sync_api import sync_playwright, expect

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from test_e2e import Run, sign_in, approve_dialog, VIEWPORTS  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parents[2]
HEADING = "This makes a new room owned by you and lets this chat in."
ROOM_URL = re.compile(r".*/rooms/[0-9a-f-]{36}$")
NOT_FOUND = "No seat here."
RLO = chr(0x202E)


def hostile():
    return {
        "room_name": '<img src=x onerror="window.__pwned=1"><b>acme</b>',
        "room_purpose": "<script>window.__pwned=2</script> [open](javascript:window.__pwned=3) **bold** # Big " + "W" * 140 + " " + RLO + "txt.exe " + HEADING,
        "machine": '<a href="javascript:window.__pwned=4">box</a>',
        "folder": "~/" + "x" * 140,
        "job": "**Trust me** <i>approve this</i> " + RLO + "kcatta",
    }


INERT_JS = r"""
(heading) => {
  const main = document.querySelector("main");
  const cw = main.querySelector(".chat-words");
  const texts = [...main.querySelectorAll(".cw-text")];
  const h1 = main.querySelector("h1");
  const first = main.querySelector("h1, h2, h3, h4");
  const r = h1.getBoundingClientRect();
  const ownText = (el) => [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join("");
  const imitations = [...main.querySelectorAll("*")].filter((el) => ownText(el).includes(heading));
  const marks = [...main.querySelectorAll(".cw-mark")].filter((m) => m.getBoundingClientRect().width > 0).map((m) => m.textContent);
  const cwr = cw.getBoundingClientRect(), mr = main.getBoundingClientRect();
  return {
    pwned: window.__pwned ?? null,
    dangerous: document.querySelectorAll("main img, main script, main iframe, main a[href^='javascript'], main strong, main em, main i").length,
    childElements: texts.reduce((n, t) => n + t.children.length, 0),
    h1Count: main.querySelectorAll("h1").length,
    firstHeading: first === h1 ? h1.textContent : `${first?.tagName}: ${first?.textContent}`,
    h1Visible: r.top >= 0 && r.bottom <= innerHeight && r.width > 0 && getComputedStyle(h1).visibility === "visible",
    h1BeforeQuote: !!(h1.compareDocumentPosition(cw) & Node.DOCUMENT_POSITION_FOLLOWING),
    imitations: imitations.map((el) => (el === h1 ? "h1" : el.closest(".chat-words") ? "quoted" : `${el.tagName}.${el.className}`)),
    marks,
    purpose: main.querySelector(".cw-text[data-field=room_purpose]")?.textContent || "",
    name: main.querySelector(".cw-text[data-field=room_name]")?.textContent || "",
    facts: main.querySelector(".rq-facts")?.textContent || "",
    quoteInside: cwr.left >= mr.left - 0.5 && cwr.right <= mr.right + 0.5,
    wrapped: texts.every((t) => t.scrollWidth <= t.clientWidth + 1),
  };
}
"""


def watch(r):
    r.reqs, r.bodies = [], []
    r.pg.on("request", lambda q: (r.reqs.append((q.method, q.url.split("?")[0])), r.bodies.append((q.url.split("?")[0], q.post_data)) if q.method == "POST" else None))
    return r


def allow(r, before, status, path):
    """Drop exactly the "Failed to load resource" lines of a refusal under test (status, a path ending) logged since before."""
    pat = re.compile(rf"status of {status} .*@ \S+{path}$")
    r.errors[before:] = [e for e in r.errors[before:] if not pat.search(e)]


def calls(r, suffix):
    return sum(1 for m, u in r.reqs if m == "POST" and u.endswith(suffix))


def draft_state(r, did):
    return r.pg.request.get(f"{r.base}/__mock/draft/{did}").json()


def me(r):
    return r.pg.evaluate("() => fetch('/app/v1/me').then((x) => x.json())")


def open_draft(r, did, query=""):
    r.go(f"/create/{did}{query}")
    r.pg.wait_for_selector("[data-draft], [data-draft-state], .center-page", timeout=8000)
    r.settle(300)


def confirm_btn(r):
    return r.pg.get_by_role("button", name="Confirm", exact=True)


def status(r):
    return r.pg.locator("#create-status")


def new_room(r, name):
    r.go("/new"); r.pg.fill("#room-name", name); r.pg.click("button:has-text('Start the room')")
    r.pg.wait_for_url(ROOM_URL); r.settle(400)


def type_code(r, code):
    r.pg.fill("#draft-code", code)


def flow(b, base, vp):
    fails, errs, runs = [], [], []

    def run(email, name, scheme="light"):
        x = watch(Run(b, base, vp, scheme=scheme)); runs.append(x)
        if email: sign_in(x, email, name)
        return x

    try:
        A = run(f"adam-{vp}@create.test", "Adam")
        acct = me(A)["account"]["id"]

        # 1. the card, ?code= ignored, then the full confirm: one request, signatures verified by the mock
        d = A.mock("draft", {"room_name": "launch", "room_purpose": "Plan the launch week", "name": "planner", "app": "codex", "machine": "adams-mini", "folder": "~/launch", "job": "Plans the launch week."})
        open_draft(A, d["id"], f"?code={d['match_code']}")
        pg = A.pg
        expect(pg.locator(f"[data-draft='{d['id']}']")).to_be_visible()
        expect(pg.locator("#draft-code")).to_have_value("")
        i = pg.evaluate(INERT_JS, HEADING)
        A.check(i["firstHeading"] == HEADING and i["h1Visible"] and i["h1Count"] == 1, f"card: our heading first and visible: {i}")
        A.check(i["name"] == "launch" and i["purpose"] == "Plan the launch week" and i["marks"] == ["“", "”", "“", "”"], f"card: quoted name and purpose: {i}")
        A.check(pg.locator(".chat-words .cw-by").inner_text().startswith("A chat wrote"), "card: the line saying a chat wrote them")
        for x in ["planner", "Codex", "adams-mini", "~/launch", "Plans the launch week."]:
            A.check(x in i["facts"], f"card: fact {x!r} missing: {i['facts']!r}")
        expect(pg.locator("[data-fp]")).to_have_text(d["fingerprint"])  # computed by the browser from the card's keys
        A.audit("create-card"); A.shot("30-create-card")
        confirm_btn(A).click()
        expect(status(A)).to_have_text("Type the code your chat shows.")
        A.check(pg.locator("dialog[open]").count() == 0 and calls(A, "/confirm") == 0, "empty code: no dialog, no request")
        type_code(A, "abc"); confirm_btn(A).click()
        expect(status(A)).to_have_text("The code has six characters, like K7Q-2MX.")
        c = d["match_code"].lower()
        type_code(A, f"{c[:3]}-{c[3:]}")
        confirm_btn(A).click()
        expect(pg.locator("dialog[open]")).to_be_visible()
        A.settle(300); A.audit("create-human-check"); A.shot("30a-create-human-check")
        approve_dialog(A, "Confirm")
        pg.wait_for_url(ROOM_URL, timeout=8000)
        room_id = pg.url.rstrip("/").split("/")[-1]
        hc = [json.loads(b) for u, b in A.bodies if u.endswith("/app/v1/human-check")][-1]
        A.check(hc == {"action": "confirm_room", "target_id": d["id"]}, f"human check asked for {hc}, want confirm_room for the draft")
        body = [json.loads(b) for u, b in A.bodies if u.endswith(f"/room-drafts/{d['id']}/confirm")][-1]
        A.check(sorted(body) == ["code", "human_check", "room", "roster_entry"] and sorted(body["room"]) == ["entries", "genesis", "id", "name", "purpose"] and body["code"] == d["match_code"], f"confirm body: {sorted(body)} {body.get('code')}")
        A.check(body["roster_entry"]["seq"] == len(body["room"]["entries"]) + 1, "member_add is not at the seq after the room's entries")
        st = draft_state(A, d["id"])
        A.check(st["status"] == "confirmed" and st["room_id"] == room_id, f"confirm: draft not confirmed into this room: {st['status']} {st.get('room_id')}")
        A.check(calls(A, f"/room-drafts/{d['id']}/confirm") == 1 and st["confirm_calls"] == 1, f"confirm: {st['confirm_calls']} requests, want one")
        ma, g = st["member_add"], st["genesis"]
        want = {"op": "member_add", "member": d["member_id"], "account": acct, "name": "planner", "app": "codex", "ed": st["ed25519_pk"], "x": st["x25519_pk"], "room": room_id, "seq": st["device_adds"] + 1}
        A.check(all(ma.get(k) == v for k, v in want.items()), f"member_add vs card: {ma} want {want}")
        A.check(g["op"] == "genesis" and g["name"] == "launch" and g["owner"] == acct and g["room"] == room_id, f"genesis: {g}")
        expect(pg.locator(".roster-item", has_text="planner")).to_be_visible(timeout=5000)
        expect(pg.locator(".fp-chip.ok")).to_be_visible(timeout=5000)  # the room page verified the chain in the browser
        open_draft(A, d["id"])  # a confirmed draft's link: the generic not-found page
        A.check(NOT_FOUND in pg.locator("main").inner_text(), "confirmed draft: not the generic not-found page")
        allow(A, 0, 404, f"/room-drafts/{d['id']}/claim")

        # 2. a wrong code, then the right one: the human check is kept for the retry
        d = A.mock("draft", {"room_name": "retry", "name": "retrier"})
        open_draft(A, d["id"]); n0 = calls(A, "/app/v1/human-check")
        wrong = "ZZZ999" if d["match_code"] != "ZZZ999" else "YYY888"
        type_code(A, wrong); confirm_btn(A).click(); approve_dialog(A, "Confirm")
        expect(status(A)).to_have_text("That code doesn't match the one your chat shows. 4 tries left.")
        A.check(pg.locator("#draft-code").get_attribute("aria-invalid") == "true", "wrong code: field not marked")
        A.audit("create-wrong-code"); A.shot("30c-create-wrong-code")
        type_code(A, d["match_code"]); confirm_btn(A).click()
        pg.wait_for_url(ROOM_URL, timeout=8000)
        A.check(calls(A, "/app/v1/human-check") - n0 == 1, f"wrong then right: {calls(A, '/app/v1/human-check') - n0} human checks, want one")
        A.check(draft_state(A, d["id"])["confirm_calls"] == 2, "wrong then right: two confirm requests")
        allow(A, 0, 403, f"/room-drafts/{d['id']}/confirm")

        # 3. five wrong codes: closed
        d = A.mock("draft", {"room_name": "closed", "name": "closer"})
        open_draft(A, d["id"]); n0 = calls(A, "/app/v1/human-check")
        wrong = "ZZZ999" if d["match_code"] != "ZZZ999" else "YYY888"
        for k in range(5):
            type_code(A, wrong); confirm_btn(A).click()
            if k == 0: approve_dialog(A, "Confirm")
            if k < 4: expect(status(A)).to_have_text(f"That code doesn't match the one your chat shows. {4 - k} {'tries' if 4 - k > 1 else 'try'} left.")
        expect(pg.locator("[data-draft-state=closed]")).to_be_visible()
        A.check(pg.locator("main h1").inner_text() == "Closed after five wrong codes", "closed: heading")
        st = draft_state(A, d["id"])
        A.check(st["status"] == "closed" and st["wrong_codes"] == 5 and calls(A, "/app/v1/human-check") - n0 == 1, f"closed: {st['status']} {st['wrong_codes']}")
        A.audit("create-closed"); A.shot("30d-create-closed")
        open_draft(A, d["id"])
        A.check(NOT_FOUND in pg.locator("main").inner_text(), "closed draft: not the generic not-found page")
        allow(A, 0, 403, f"/room-drafts/{d['id']}/confirm"); allow(A, 0, 404, f"/room-drafts/{d['id']}/claim")

        # 4. name already taken: when claimed (the card says so) and when it is taken while the page is open
        new_room(A, "acme")
        d = A.mock("draft", {"room_name": "acme", "room_purpose": "Second try", "name": "second"})
        open_draft(A, d["id"])
        expect(pg.locator("#draft-room-name")).to_be_visible()
        expect(pg.locator("#draft-room-name-help")).to_have_text("You already own a room called #acme. Pick another name for this one.")
        A.audit("create-name-taken"); A.shot("30e-create-name-taken")
        type_code(A, d["match_code"]); confirm_btn(A).click()
        expect(status(A)).to_have_text("Give the room a name.")
        pg.fill("#draft-room-name", "Acme Two"); confirm_btn(A).click(); approve_dialog(A, "Confirm")
        pg.wait_for_url(ROOM_URL, timeout=8000)
        st = draft_state(A, d["id"])
        A.check(st["genesis"]["name"] == "acme-two", f"renamed: genesis name {st['genesis']['name']}")
        A.check(pg.locator("h1").inner_text().strip().lstrip("#") == "acme-two", "renamed: room page title")
        d = A.mock("draft", {"room_name": "later", "name": "laterbot"})
        open_draft(A, d["id"])
        A.check(pg.locator("#draft-room-name").count() == 0, "not taken yet: no rename field")
        # another tab of the same person makes a room with that name while this page is open
        tab = A.ctx.new_page(); tab.goto(base + "/new"); tab.wait_for_selector("#room-name"); tab.fill("#room-name", "later"); tab.click("button:has-text('Start the room')"); tab.wait_for_url(ROOM_URL); tab.close()
        n0 = calls(A, "/app/v1/human-check")
        type_code(A, d["match_code"]); confirm_btn(A).click(); approve_dialog(A, "Confirm")
        expect(pg.locator("#draft-room-name-help")).to_have_text("You already own a room called #later. Pick another name for this one.")
        pg.fill("#draft-room-name", "later-two"); confirm_btn(A).click()
        pg.wait_for_url(ROOM_URL, timeout=8000)
        A.check(calls(A, "/app/v1/human-check") - n0 == 1, "taken while open: the human check is kept for the new name")
        A.check(draft_state(A, d["id"])["genesis"]["name"] == "later-two", "taken while open: new name signed")
        allow(A, 0, 409, f"/room-drafts/{d['id']}/confirm")

        # 5. Don't make it
        d = A.mock("draft", {"room_name": "nope", "name": "nobot"})
        open_draft(A, d["id"])
        pg.get_by_role("button", name="Don't make it").click()
        expect(pg.locator("[data-draft-state=rejected]")).to_be_visible()
        A.check(draft_state(A, d["id"])["status"] == "rejected", "reject: draft not rejected")
        A.check("nobot is told you said no." in pg.locator("main").inner_text(), "reject: message")
        A.audit("create-rejected"); A.shot("30h-create-rejected")

        # 6. ran out while the page was open; already ran out; someone else's; unknown
        d = A.mock("draft", {"room_name": "short", "name": "shortbot", "expires_in_s": 4})
        open_draft(A, d["id"])
        expect(pg.locator("[data-draft-state=expired]")).to_be_visible(timeout=9000)
        A.check(pg.locator("main h1").inner_text() == "This request ran out" and confirm_btn(A).count() == 0, "expired: heading, no Confirm")
        A.audit("create-expired"); A.shot("30f-create-expired")
        for label, body in [("ran out", {"expires_in_s": -5}), ("someone else's", {"claimed_by_email": f"eve-{vp}@create.test"})]:
            d = A.mock("draft", {"room_name": "other", **body})
            open_draft(A, d["id"])
            A.check(NOT_FOUND in pg.locator("main").inner_text() and pg.locator("[data-draft]").count() == 0, f"{label}: not the generic not-found page")
            allow(A, 0, 404, f"/room-drafts/{d['id']}/claim")
        open_draft(A, "01a1b2c3-0000-7000-8000-000000000000")
        A.check(NOT_FOUND in pg.locator("main").inner_text(), "unknown draft: not the generic not-found page")
        allow(A, 0, 404, "/room-drafts/01a1b2c3-0000-7000-8000-000000000000/claim")

        # 7. the card changed after it was shown: nothing is signed or sent
        d = A.mock("draft", {"room_name": "swap", "name": "swapbot"})
        open_draft(A, d["id"])
        A.mock("draft-edit", {"id": d["id"], "ed25519_pk": os.urandom(32).hex()})
        n0 = calls(A, "/app/v1/human-check")
        type_code(A, d["match_code"]); confirm_btn(A).click()
        expect(status(A)).to_have_text("This request changed after you opened it, so nothing was signed. Reload the page and check it again.")
        A.check(pg.locator("dialog[open]").count() == 0 and calls(A, "/app/v1/human-check") == n0 and draft_state(A, d["id"])["confirm_calls"] == 0, "changed card: something was signed or sent")
        expect(confirm_btn(A)).to_be_disabled()

        # 8. a card that doesn't check out against itself
        d = A.mock("draft", {"room_name": "bad", "name": "badbot", "app": "evil", "unchecked": True})  # the real server refuses this app at create
        open_draft(A, d["id"])
        expect(pg.locator(".need-blocker")).to_have_text("This request doesn't check out, so it can't be confirmed. Don't make it, and ask your chat to start again.")
        expect(confirm_btn(A)).to_be_disabled()

        # 9. hostile chat text renders inert inside the quotes. A render test: the real server refuses such a draft at create
        # (room name format, wire.OneLineTextOK for the purpose; test_create_real.py), so it is seeded unchecked here.
        for bad in [{"room_purpose": "Ship " + RLO + "txt.exe"}, {"room_purpose": "line\nbreak"}, {"room_purpose": "zero" + chr(0x200B) + "width"}, {"room_name": "<b>x</b>"}]:
            res = A.pg.request.post(base + "/__mock/draft", data=bad)
            A.check(res.status == 400, f"the mock made a draft the server refuses: {bad} -> {res.status}")
        d = A.mock("draft", {"name": "mallory", "unchecked": True, **hostile()})
        open_draft(A, d["id"])
        i = pg.evaluate(INERT_JS, HEADING)
        A.check(i["pwned"] is None and i["dangerous"] == 0 and i["childElements"] == 0, f"hostile: elements made from chat text: {i}")
        A.check(i["firstHeading"] == HEADING and i["h1Visible"] and i["h1Count"] == 1 and i["h1BeforeQuote"], f"hostile: our heading not first and visible: {i}")
        A.check(sorted(i["imitations"]) == ["h1", "quoted"], f"hostile: the imitation of our heading is outside the quote: {i['imitations']}")
        A.check(i["name"] == hostile()["room_name"], f"hostile: name not shown as written: {i['name']!r}")
        A.check("[U+202E]txt.exe" in i["purpose"] and RLO not in i["purpose"] and "W" * 140 in i["purpose"], f"hostile: purpose: {i['purpose']!r}")
        A.check("[U+202E]kcatta" in i["facts"] and RLO not in i["facts"], "hostile: job not shown harmless")
        A.check(i["marks"] == ["“", "”", "“", "”"] and i["quoteInside"] and i["wrapped"], f"hostile: quotes, wrapping: {i}")
        expect(pg.locator("#draft-room-name-help")).to_have_text("Room names use lowercase letters, numbers and dashes. Pick a name for this one.")
        A.audit("create-hostile"); A.shot("30b-create-hostile"); A.shot("30b-create-hostile-full", full=True)

        # 10. drafts appear nowhere else: not in What needs you, not in the rooms list, no count
        D = run(f"dora-{vp}@create.test", "Dora")
        d = D.mock("draft", {"room_name": "hidden", "name": "hiddenbot"})
        open_draft(D, d["id"])
        D.go("/rooms"); D.settle(600)
        txt = D.pg.locator("main").inner_text()
        api = D.pg.evaluate("() => Promise.all([fetch('/app/v1/needs-you').then((x) => x.json()), fetch('/app/v1/rooms').then((x) => x.json())])")
        D.check("hidden" not in txt and "hiddenbot" not in txt and D.pg.locator(".count-dot").count() == 0, "a draft shows on the rooms page")
        D.check(not api[0]["join_requests"] and not api[0]["attention"] and not api[1]["rooms"], f"a draft is in needs-you or rooms: {api}")

        # 11. too many drafts held by one person
        C = run(f"cara-{vp}@create.test", "Cara")
        for k in range(3): C.mock("draft", {"room_name": f"held-{k}", "claimed_by_email": f"cara-{vp}@create.test"})
        d = C.mock("draft", {"room_name": "fourth"})
        open_draft(C, d["id"])
        expect(C.pg.locator("[data-draft-state=too-many]")).to_be_visible()
        C.audit("create-too-many"); C.shot("30g-create-too-many")
        allow(C, 0, 429, f"/room-drafts/{d['id']}/claim")

        # 12. signed out: sign in, then back to the same link
        S = run(None, None)
        d = S.mock("draft", {"room_name": "signin", "name": "signinbot"})
        S.pg.goto(f"{base}/create/{d['id']}")
        S.pg.wait_for_url(re.compile(r".*/login\?return_to=%2Fcreate%2F" + d["id"]))
        S.pg.fill("#dev-email", f"sam-{vp}@create.test"); S.pg.fill("#dev-name", "Sam")
        S.pg.click("button:has-text('Sign in (dev)')")
        S.pg.wait_for_url(f"**/create/{d['id']}")
        expect(S.pg.locator("main h1")).to_have_text(HEADING)
        allow(S, 0, 401, r"/app/v1/me(\?\S*)?")
    except Exception as ex:
        fails.append(f"[{vp}] {type(ex).__name__}: {' | '.join(str(ex).splitlines()[:4])[:600]}")
        for k, x in enumerate(runs):  # where each tab was when it failed
            try:
                p = pathlib.Path(tempfile.gettempdir()) / f"create-fail-{vp}-{k}.png"; x.pg.screenshot(path=str(p)); fails.append(f"[{vp}] tab {k} at {x.pg.url}: {p}")
            except Exception: pass
    for x in runs:
        errs += x.errors; fails += x.failures
        try: x.close()
        except Exception: pass
    return errs, fails


def dark(b, base, vp):
    """The card and the hostile text in dark mode."""
    r = watch(Run(b, base, vp, scheme="dark"))
    fails = []
    try:
        sign_in(r, f"dana-{vp}@create.test", "Dana")
        d = r.mock("draft", {"room_name": "launch", "room_purpose": "Plan the launch week", "name": "planner", "app": "codex", "machine": "adams-mini", "folder": "~/launch", "job": "Plans the launch week."})
        open_draft(r, d["id"]); expect(r.pg.locator("[data-fp]")).to_have_text(d["fingerprint"])
        r.audit("dark-create-card"); r.shot("dark-30-create-card")
        d = r.mock("draft", {"name": "mallory", "unchecked": True, **hostile()})  # seeded: the real server refuses it
        open_draft(r, d["id"])
        i = r.pg.evaluate(INERT_JS, HEADING)
        r.check(i["pwned"] is None and i["dangerous"] == 0 and i["childElements"] == 0 and i["h1Visible"], f"dark hostile: {i}")
        r.audit("dark-create-hostile"); r.shot("dark-30b-create-hostile")
    except Exception as ex:
        fails.append(f"[{vp} dark] {type(ex).__name__}: {' | '.join(str(ex).splitlines()[:4])[:600]}")
    errs, fails = r.errors, fails + r.failures
    r.close()
    return errs, fails


def real_pass(b, base):
    """A brand-new account sets up its first passkey in the confirm step, as in an approval; the next confirm asks the
    passkey again (MOCK_HC=real: Turnstile's always-pass test key and a virtual platform authenticator)."""
    r = watch(Run(b, base, "phone"))
    cdp = r.ctx.new_cdp_session(r.pg)
    cdp.send("WebAuthn.enable")
    cdp.send("WebAuthn.addVirtualAuthenticator", {"options": {"protocol": "ctap2", "transport": "internal", "hasResidentKey": True, "hasUserVerification": True, "isUserVerified": True, "automaticPresenceSimulation": True}})
    fails = []
    try:
        sign_in(r, "nina@create.test", "Nina")
        r.check(me(r)["webauthn_registered"] is False, "a brand-new account already has a passkey")
        for k, (step, room) in enumerate([("Set up Face ID or fingerprint", "first"), ("to make this room. Asked each time.", "second")]):
            d = r.mock("draft", {"room_name": room, "name": f"{room}bot"})
            open_draft(r, d["id"]); type_code(r, d["match_code"]); confirm_btn(r).click()
            dlg = r.pg.locator("dialog[open]")
            expect(dlg.get_by_text(step)).to_be_visible(timeout=8000)
            go = dlg.get_by_role("button", name="Unlock & confirm")
            expect(go).to_be_enabled(timeout=20000)
            if k == 0: r.shot("30i-create-first-passkey")
            go.click()
            r.pg.wait_for_url(ROOM_URL, timeout=15000)
            r.check(draft_state(r, d["id"])["status"] == "confirmed", f"{room}: not confirmed")
        r.check(me(r)["webauthn_registered"] is True, "the first passkey was not set up in the confirm step")
    except Exception as ex:
        fails.append(f"[real] {type(ex).__name__}: {' | '.join(str(ex).splitlines()[:4])[:600]}")
    errs, fails = r.errors, fails + r.failures
    r.close()
    return errs, fails


def start_mock(port, hc="stub"):
    env = dict(os.environ, PORT=str(port), MOCK_HC=hc)
    log = tempfile.NamedTemporaryFile(prefix=f"mock-create-{port}-", suffix=".log", delete=False)
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
    ap.add_argument("--port", type=int, default=9921)
    ap.add_argument("--only", choices=list(VIEWPORTS))
    ap.add_argument("--real", action="store_true", help="only the first-passkey pass, on a mock with MOCK_HC=real (needs challenges.cloudflare.com)")
    a = ap.parse_args()
    proc, base = (None, a.base) if a.base else start_mock(a.port, "real" if a.real else "stub")
    all_errs, all_fails = [], []
    try:
        with sync_playwright() as p:
            b = p.chromium.launch()
            for vp in [] if a.real else [a.only] if a.only else list(VIEWPORTS):
                t = time.time()
                e, f = flow(b, base, vp)
                e2, f2 = dark(b, base, vp)
                all_errs += e + e2; all_fails += f + f2
                print(f"{vp}: {len(e + e2)} console errors, {len(f + f2)} failures, {time.time() - t:.1f}s")
            if a.real:
                e, f = real_pass(b, base)
                all_errs += e; all_fails += f
                print(f"real human check: {len(e)} console errors, {len(f)} failures")
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
