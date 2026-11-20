"""An event address a person approves (docs/protocol/event-url-approval.md §2-4), on the fixture server.

A chat asks bot-link to call an address (the trigger of a routine) when a message waits for it. Its person sees a card
under "What needs you" and on /approve-url/<id>: our heading with the room, the host large (the URL parser's host, in
the server's host exactly, never decoded; an xn-- name is never offered), the full address as inert text, what is sent, the warning, Approve (passkey:
approve_event_url, the request id) and Don't. The request is read again before the passkey step and before sending.

Covered: the card on Your rooms and on its page; approve (one human check bound to the id, one approve request, the
card leaves, the line); reject; a change before the passkey step and between it and the send (nothing sent); blocked
at approval; the passkey step not counting; someone else's, unknown, ran out and decided (the generic not-found page);
signed out (back to the link after sign-in); hostile addresses (HTML, a javascript: look, right-to-left override, a
500-character query, an encoded (xn--) look-alike, number forms of an IP, a name before an @) rendered inert with our heading and warning first; no tick
box and a batch in the same room leaves the card alone; the member's approved addresses and Stop (confirm, one
request, the row leaves), not shown to another person of the room. Phone 390x844 and desktop 1440x900, light and dark:
0 console errors, no horizontal overflow, no forbidden words, no text under 13px, tap targets of 44px.
Screenshots: web/shots/<vp>[-dark]-40*-eventurl-*.png

    python3 web/test/test_eventurl.py                     # starts its own mock on :10121 and stops it after
    python3 web/test/test_eventurl.py --base http://localhost:8829
"""
import argparse, json, pathlib, re, sys, tempfile, time
from playwright.sync_api import sync_playwright, expect

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from test_e2e import Run, sign_in, approve_dialog, VIEWPORTS  # noqa: E402
from test_batch import watch, allow, posts, api, new_room, home, tick, group, go_btn, batch_posts  # noqa: E402
from test_create import start_mock  # noqa: E402

NOT_FOUND = "No seat here."
RLO = chr(0x202E)
HEADING = "{chat} asks bot-link to call an address when a message waits for it."
SENT = "bot-link will call this address each time a message waits for {chat}. It sends which room and which chat, who wrote, whether the message was to this chat alone or to the room, whether it needs an answer, and how many wait, with their ids and the time. It never sends the message text."
UNREACHABLE = "bot-link could not reach this address, so nothing was approved."
TOO_MANY = "{chat} already has six addresses. Stop one first."
WARNING = "bot-link could not check that this address is yours. Approve only if you made this address yourself, for example the trigger of a routine in your chat app."
CHANGED = "This request changed after you opened it. Nothing was approved."
BLOCKED = "bot-link may not call this address (it does not point to a public https address). Nothing was approved."
HC_FAILED = "The passkey step did not count, so nothing was approved."
COMPARE = "The host alone doesn't show it is yours. Compare the whole address with the one your app shows for your routine."
LASTS = "It stays for as long as {chat} keeps renewing it, until you stop it here."
APPROVED = "Approved. bot-link calls this address when a message waits for {chat}. If one waits now, it has just called it."
STOP_BODY = "bot-link stops calling this address. {chat} will not be woken through it any more. {chat} can ask you again."
REFUSED = "This request doesn't check out, so it can't be approved. Don't approve it, and ask your chat to ask again."
ENCODED = "This host is an encoded name (a part of it starts with xn--). What it would look like is not shown on purpose: it can look like another name. bot-link does not let you approve it."
GOOD_URL = "https://hooks.example.com/v1/routines/rt_8Hq2/fire?key=k_live_4b1c"
HOSTILE_URL = ("https://good.example@evil.example/<img src=x onerror=\"window.__pwned=1\">/javascript:window.__pwned=2?" + RLO + "q=<script>window.__pwned=3</script>"
               + "a" * 500 + "&h=" + HEADING.format(chat="planner") + " " + WARNING)
LOOKALIKES = ["https://xn--80ak6aa92e.com/hook", "https://xn--pypal-4ve.com/hook"]  # read as "apple.com" and "paypal.com" when decoded


CARD_JS = r"""
([id, heading, warning]) => {
  const c = document.querySelector(`[data-need=event_url][data-request="${id}"]`);
  if (!c) return null;
  const main = document.querySelector("main");
  const vis = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility === "visible"; };
  const ownText = (el) => [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join("");
  const title = c.querySelector(".need-title"), warn = c.querySelector(".eu-warn"), addr = c.querySelector(".eu-address");
  const heads = [...c.querySelectorAll("h1, h2, h3, h4")];
  const texts = [...c.querySelectorAll(".cw-text, .eu-host")];
  const cr = c.getBoundingClientRect(), mr = main.getBoundingClientRect();
  return {
    pwned: window.__pwned ?? null,
    dangerous: c.querySelectorAll("img, script, iframe, a, strong, em, i").length,
    childElements: texts.reduce((n, t) => n + t.querySelectorAll(":not(wbr)").length, 0),
    wbr: c.querySelectorAll(".cw-text[data-field=url] wbr").length,
    nonAscii: /[^\x00-\x7f\u201c\u201d\u2026\u00b7]/.test(c.querySelector(".eu-address")?.innerText || ""),
    hasApprove: !![...c.querySelectorAll("button")].find((b) => b.textContent.trim() === "Approve"),
    lasts: c.querySelector(".eu-lasts")?.textContent || "",
    checkboxes: c.querySelectorAll("input[type=checkbox]").length,
    title: title?.textContent || "",
    firstHeading: heads[0] === title,
    titleVisible: vis(title),
    warn: warn?.textContent || "",
    warnVisible: vis(warn),
    titleBeforeWarn: !!(title && warn && (title.compareDocumentPosition(warn) & Node.DOCUMENT_POSITION_FOLLOWING)),
    warnBeforeAddress: !!(warn && addr && (warn.compareDocumentPosition(addr) & Node.DOCUMENT_POSITION_FOLLOWING)),
    imitations: [...c.querySelectorAll("*")].filter((el) => ownText(el).includes(heading) || ownText(el).includes(warning)).map((el) => el === title ? "title" : el.closest(".eu-address") ? "quoted" : el.closest(".eu-warn") ? "warn" : `${el.tagName}.${el.className}`),
    room: c.querySelector(".need-room")?.textContent || "",
    host: c.querySelector(".eu-host")?.textContent || "",
    hostSize: parseFloat(getComputedStyle(c.querySelector(".eu-host") || c).fontSize),
    titleSize: parseFloat(getComputedStyle(title || c).fontSize),
    encoded: c.querySelector(".eu-encoded")?.textContent || "",
    userinfo: c.querySelector(".eu-userinfo")?.textContent || "",
    url: c.querySelector(".cw-text[data-field=url]")?.textContent || "",
    sent: c.querySelector(".eu-sent")?.textContent || "",
    blocker: c.querySelector(".need-blocker:not([hidden])")?.textContent || "",
    inside: cr.left >= mr.left - 0.5 && cr.right <= mr.right + 0.5,
    wrapped: texts.every((t) => t.scrollWidth <= t.clientWidth + 1),
    buttons: [...c.querySelectorAll("button")].map((b) => b.textContent.trim()),
    approveDisabled: !![...c.querySelectorAll("button")].find((b) => b.textContent.trim() === "Approve")?.disabled,
  };
}
"""


def card(r, rid):
    return r.pg.locator(f"[data-need=event_url][data-request='{rid}']")


def look(r, rid, chat):
    return r.pg.evaluate(CARD_JS, [rid, HEADING.format(chat=chat), WARNING])


def eu_state(r, rid):
    return r.pg.request.get(f"{r.base}/__mock/eu-request/{rid}").json()


def subs(r, member_id):
    return r.pg.request.get(f"{r.base}/__mock/eu-subs/{member_id}").json()["subs"]


def n_posts(r, suffix):
    return sum(1 for m, u in r.reqs if m == "POST" and u.endswith(suffix))


def hc_bodies(r):
    return [b for b in posts(r, lambda u: u.endswith("/app/v1/human-check")) if b.get("action") == "approve_event_url"]


def open_page(r, rid):
    r.go(f"/approve-url/{rid}")
    r.pg.wait_for_selector("[data-eu-page], .center-page", timeout=8000)
    r.settle(300)


def approve_btn(r, rid):
    return card(r, rid).get_by_role("button", name="Approve", exact=True)


def common_card(r, rid, chat, room, url, host):
    i = look(r, rid, chat)
    r.check(i is not None, f"card {rid} not drawn")
    if i is None: return i
    r.check(i["title"] == HEADING.format(chat=chat) and i["firstHeading"] and i["titleVisible"], f"card: our heading first and visible: {i['title']!r}")
    r.check(i["warn"] == f"{WARNING} {COMPARE}" and i["warnVisible"] and i["titleBeforeWarn"] and i["warnBeforeAddress"], f"card: the warning, after the heading, before the address: {i['warn']!r}")
    r.check(i["room"] == f"#{room}", f"card: room {i['room']!r}")
    r.check(i["host"] == host and i["hostSize"] >= i["titleSize"], f"card: the large host is not the server's host byte for byte: {i['host']!r} vs {host!r}, {i['hostSize']} vs {i['titleSize']}")
    r.check(i["url"] == url.replace(RLO, "[U+202E]"), f"card: full address as written: {i['url'][:80]!r}")
    r.check(i["sent"] == SENT.format(chat=chat), f"card: what is sent: {i['sent']!r}")
    r.check(i["checkboxes"] == 0, "card: a tick box on an address request")
    r.check(i["dangerous"] == 0 and i["childElements"] == 0 and i["pwned"] is None, f"card: elements made from the address: {i}")
    r.check(i["inside"] and i["wrapped"], f"card: pushed out of the page or not wrapped: {i}")
    return i


def offered(r, i):
    """The card offers Approve: the line on how long it lasts, an enabled Approve, no blocker."""
    r.check(i and i["hasApprove"] and not i["approveDisabled"] and i["lasts"] == LASTS.format(chat="planner") and not i["blocker"], f"card: Approve not offered as it should be: {i and (i['hasApprove'], i['approveDisabled'], i['lasts'], i['blocker'])}")


def flow(b, base, vp):
    fails, errs, runs = [], [], []

    def run(email, name, scheme="light"):
        x = watch(Run(b, base, vp, scheme=scheme)); runs.append(x)
        if email: sign_in(x, email, name)
        return x

    try:
        A = run(f"adam-{vp}@eu.test", "Adam")
        pg = A.pg
        acme = new_room(A, "acme")
        planner = A.mock("eu-member", {"room_id": acme, "name": "planner", "email": f"adam-{vp}@eu.test"})["member_id"]

        # 1. the card on Your rooms; approve: one human check bound to the id, one approve request, the card leaves
        q = A.mock("eu-request", {"member_id": planner, "url": GOOD_URL})
        home(A)
        expect(card(A, q["id"])).to_be_visible()
        i = common_card(A, q["id"], "planner", "acme", GOOD_URL, "hooks.example.com")
        offered(A, i)
        A.check(i and i["wbr"] >= 5, f"the full address has no wrap points: {i and i['wbr']}")
        A.check(q["approve_url"].endswith(f"/approve-url/{q['id']}"), f"approve_url: {q['approve_url']}")
        A.check(pg.locator(".nav .count-dot").inner_text().strip() == "1", "the waiting count leaves the address request out")
        A.audit("eventurl-card"); A.shot("40-eventurl-card")
        approve_btn(A, q["id"]).click()
        dlg = pg.locator("dialog[open]")
        expect(dlg).to_be_visible()
        A.check(dlg.get_by_text("hooks.example.com", exact=True).count() >= 1, "dialog: the host is not named")
        A.settle(200); A.audit("eventurl-human-check"); A.shot("40a-eventurl-human-check")
        approve_dialog(A, "Approve")
        expect(card(A, q["id"])).to_have_count(0, timeout=5000)
        expect(pg.locator(".toast", has_text=APPROVED.format(chat="planner"))).to_be_visible()
        A.check(hc_bodies(A) == [{"action": "approve_event_url", "target_id": q["id"]}], f"human check: {hc_bodies(A)}")
        A.check(n_posts(A, f"/event-urls/{q['id']}/approve") == 1, "approve: want exactly one request")
        body = posts(A, lambda u: u.endswith(f"/event-urls/{q['id']}/approve"))[0]
        A.check(sorted(body) == ["human_check"], f"approve body: {body}")
        st = eu_state(A, q["id"])
        A.check(st["status"] == "approved" and st["approve_calls"] == 1, f"approve: mock state {st['status']} {st['approve_calls']}")
        sl = subs(A, planner)
        A.check(len(sl) == 1 and sl[0]["url"] == GOOD_URL and sl[0]["approved_by"] == "person", f"approve: subscription {sl}")

        # 2. its page: the card alone; approve there; the done line
        q2 = A.mock("eu-request", {"member_id": planner, "url": "https://api.example.org/hooks/second", "name": "message.received"})
        open_page(A, q2["id"])
        expect(card(A, q2["id"])).to_be_visible()
        common_card(A, q2["id"], "planner", "acme", "https://api.example.org/hooks/second", "api.example.org")
        A.check(pg.locator("[data-need]").count() == 1, "page: more than the one card")
        A.audit("eventurl-page"); A.shot("40b-eventurl-page")
        approve_btn(A, q2["id"]).click(); approve_dialog(A, "Approve")
        expect(pg.locator("[data-eu-state=approved]")).to_be_visible()
        A.check(APPROVED.format(chat="planner") in pg.locator("main").inner_text(), "page: the approved line")
        A.audit("eventurl-approved"); A.shot("40c-eventurl-approved")
        open_page(A, q2["id"])   # decided: the generic page
        A.check(NOT_FOUND in pg.locator("main").inner_text() and card(A, q2["id"]).count() == 0, "decided: not the generic not-found page")

        # 3. changed after it was shown, before the passkey step: nothing asked, nothing sent
        for field, value in [("url", "https://hooks.example.com/v1/routines/rt_8Hq2/fire?key=k_live_OTHER"), ("member_name", "imposter"), ("room_name", "other"), ("name", "roster.changed")]:
            qc = A.mock("eu-request", {"member_id": planner, "url": f"https://change.example/{field}"})
            open_page(A, qc["id"])
            n0, a0 = len(hc_bodies(A)), n_posts(A, "/approve")
            A.mock("eu-request-edit", {"id": qc["id"], field: value})
            approve_btn(A, qc["id"]).click()
            expect(pg.locator(".eu-status")).to_have_text(CHANGED)
            A.check(pg.locator("dialog[open]").count() == 0 and len(hc_bodies(A)) == n0 and n_posts(A, "/approve") == a0, f"changed {field}: something was asked or sent")
            expect(approve_btn(A, qc["id"])).to_be_disabled()
            A.check(eu_state(A, qc["id"])["status"] == "waiting", f"changed {field}: not waiting")
        A.audit("eventurl-changed"); A.shot("40d-eventurl-changed")

        # 4. changed between the passkey step and the send: the dialog's approve sends nothing
        qc = A.mock("eu-request", {"member_id": planner, "url": "https://change.example/late"})
        open_page(A, qc["id"])
        approve_btn(A, qc["id"]).click()
        expect(pg.locator("dialog[open]")).to_be_visible()
        A.mock("eu-request-edit", {"id": qc["id"], "url": "https://change.example/swapped"})
        pg.locator("dialog[open]").get_by_role("button", name="Approve").click()
        expect(pg.locator("dialog[open]")).to_have_count(0, timeout=5000)
        expect(pg.locator(".eu-status")).to_have_text(CHANGED)
        A.check(eu_state(A, qc["id"])["approve_calls"] == 0, "changed during the passkey step: an approve was sent")

        # 5. Don't, on the list and on the page
        qr = A.mock("eu-request", {"member_id": planner, "url": "https://nope.example/a"})
        home(A)
        card(A, qr["id"]).get_by_role("button", name="Don't").click()
        expect(card(A, qr["id"])).to_have_count(0, timeout=5000)
        A.check(eu_state(A, qr["id"])["status"] == "rejected", "reject (list): not rejected")
        qr = A.mock("eu-request", {"member_id": planner, "url": "https://nope.example/b"})
        open_page(A, qr["id"])
        card(A, qr["id"]).get_by_role("button", name="Don't").click()
        expect(pg.locator("[data-eu-state=rejected]")).to_be_visible()
        A.check(eu_state(A, qr["id"])["status"] == "rejected" and len([1 for m, u in A.reqs if u.endswith(f"{qr['id']}/reject")]) == 1, "reject (page): not one reject")
        A.check(eu_state(A, qr["id"])["approve_calls"] == 0, "reject: an approve was sent")
        res = A.pg.request.post(base + "/__mock/eu-plain-subscribe", data={"member_id": planner, "url": "https://nope.example/b"})
        A.check(res.status == 409 and res.json()["error"]["code"] == "stopped_by_person" and res.json()["error"]["details"]["reason"] == "rejected" and res.json()["error"]["details"]["until"], f"a plain subscribe after a turn-down: {res.status} {res.text()}")

        # 6. blocked at approval: nothing approved, said plainly
        qb = A.mock("eu-request", {"member_id": planner, "url": "https://blocked.example/x", "blocked": True})
        open_page(A, qb["id"]); e0 = len(A.errors)
        approve_btn(A, qb["id"]).click(); approve_dialog(A, "Approve")
        expect(pg.locator(".eu-status")).to_have_text(BLOCKED)
        st = eu_state(A, qb["id"])
        A.check(st["status"] == "waiting" and st["approve_calls"] == 1 and not any(s["url"] == "https://blocked.example/x" for s in subs(A, planner)), f"blocked: {st}")
        A.audit("eventurl-blocked"); A.shot("40e-eventurl-blocked")
        allow(A, e0, 422, f"/event-urls/{qb['id']}/approve")

        # 6b. the name does not resolve at approval (422 event_verify_failed): nothing approved, the check spent
        qv = A.mock("eu-request", {"member_id": planner, "url": "https://nowhere.example/x", "unresolvable": True})
        open_page(A, qv["id"]); e0 = len(A.errors)
        approve_btn(A, qv["id"]).click(); approve_dialog(A, "Approve")
        expect(pg.locator(".eu-status")).to_have_text(UNREACHABLE)
        st = eu_state(A, qv["id"])
        A.check(st["status"] == "waiting" and st["approve_calls"] == 1 and st["spent_checks"] == 1, f"unresolvable: {st}")
        allow(A, e0, 422, f"/event-urls/{qv['id']}/approve")

        # 6c. six addresses already (409 too_many_subscriptions): nothing approved, the check NOT spent
        crowd = A.mock("eu-member", {"room_id": acme, "name": "crowded", "email": f"adam-{vp}@eu.test"})["member_id"]
        for k in range(6): A.mock("eu-sub", {"member_id": crowd, "url": f"https://full{k}.example/x"})
        qf = A.mock("eu-request", {"member_id": crowd, "url": "https://seventh.example/x"})
        open_page(A, qf["id"]); e0 = len(A.errors)
        approve_btn(A, qf["id"]).click(); approve_dialog(A, "Approve")
        expect(pg.locator(".eu-status")).to_have_text(TOO_MANY.format(chat="crowded"))
        st = eu_state(A, qf["id"])
        A.check(st["status"] == "waiting" and st["spent_checks"] == 0 and len(subs(A, crowd)) == 6, f"too many: {st}")
        allow(A, e0, 409, f"/event-urls/{qf['id']}/approve")

        # 7. the passkey step did not count
        qh = A.mock("eu-request", {"member_id": planner, "url": "https://hc.example/x", "hc_fail": True})
        open_page(A, qh["id"]); e0 = len(A.errors)
        approve_btn(A, qh["id"]).click()
        dlg = pg.locator("dialog[open]")
        dlg.get_by_role("button", name="Approve").click()
        expect(dlg.locator(".hc-status")).to_have_text(HC_FAILED)
        A.check(dlg.get_by_text("Sign in again instead").is_hidden(), "passkey every time: a sign-in-again way out is offered")
        dlg.get_by_role("button", name="Not now").click()
        A.check(eu_state(A, qh["id"])["status"] == "waiting", "hc failed: not waiting")
        allow(A, e0, 403, f"/event-urls/{qh['id']}/approve")

        # 8. someone else's, unknown, ran out, decided elsewhere while open: the generic page
        E = run(f"eve-{vp}@eu.test", "Eve")
        eroom = new_room(E, "eves")
        emem = E.mock("eu-member", {"room_id": eroom, "name": "evebot", "email": f"eve-{vp}@eu.test"})["member_id"]
        qe = E.mock("eu-request", {"member_id": emem, "url": "https://eve.example/x"})
        for label, rid in [("someone else's", qe["id"]), ("unknown", "01a1b2c3-0000-7000-8000-000000000000"),
                           ("ran out", A.mock("eu-request", {"member_id": planner, "url": "https://late.example/x", "expires_in_s": -5})["id"])]:
            open_page(A, rid)
            A.check(NOT_FOUND in pg.locator("main").inner_text() and pg.locator("[data-need=event_url]").count() == 0, f"{label}: not the generic not-found page")
        e0 = len(A.errors)
        hc = api(A, "POST", "/app/v1/human-check", {"action": "approve_event_url", "target_id": qe["id"]})["body"]  # a good check of A's, bound to Eve's request
        for verb in ("reject", "approve"):
            r404 = api(A, "POST", f"/app/v1/event-urls/{qe['id']}/{verb}", {"human_check": {"id": hc["id"], "stub": True}} if verb == "approve" else {})
            A.check(r404["status"] == 404, f"someone else's {verb}: {r404}")
        A.check(eu_state(A, qe["id"])["spent_checks"] == 1, "someone else's: the refused approval did not spend the check")
        A.check(eu_state(A, qe["id"])["status"] == "waiting", "someone else's: changed")
        allow(A, e0, 404, f"/event-urls/{qe['id']}/(reject|approve)")
        qd = A.mock("eu-request", {"member_id": planner, "url": "https://decided.example/x"})
        open_page(A, qd["id"])
        A.mock("eu-request-edit", {"id": qd["id"], "status": "rejected"})
        n0 = len(hc_bodies(A))
        approve_btn(A, qd["id"]).click()
        expect(pg.locator(".center-page")).to_be_visible(timeout=5000)
        A.check(NOT_FOUND in pg.locator("main").inner_text() and len(hc_bodies(A)) == n0, "decided while open: not the generic page, or a human check was asked")

        # 9. hostile addresses render inert; our heading and warning come first
        qx = A.mock("eu-request", {"member_id": planner, "url": HOSTILE_URL, "host": "evil.example", "unchecked": True})
        open_page(A, qx["id"])
        i = common_card(A, qx["id"], "planner", "acme", HOSTILE_URL, "evil.example")
        A.check(i and "[U+202E]" in i["url"] and RLO not in i["url"] and "a" * 500 in i["url"], f"hostile: the address as marks: {i and i['url'][:80]!r}")
        A.check(i and "before an @" in i["userinfo"] and i["userinfo"].endswith("it calls evil.example.") and "good.example" not in i["userinfo"], f"hostile: the name before @ is not called out: {i and i['userinfo']!r}")
        A.check(i and sorted(set(i["imitations"])) == ["quoted", "title", "warn"], f"hostile: our heading or warning imitated outside the quote: {i and i['imitations']}")
        A.audit("eventurl-hostile"); A.shot("40f-eventurl-hostile"); A.shot("40f-eventurl-hostile-full", full=True)
        # an encoded name: the server refuses it at the ask; seeded directly, the card shows it as it is, large, and offers no Approve
        for lk in LOOKALIKES:
            h_ = lk.split("/")[2]
            res = A.pg.request.post(base + "/__mock/eu-request", data={"member_id": planner, "url": lk})
            A.check(res.status == 422, f"the mock took an xn-- host at the ask: {res.status}")
            ql = A.mock("eu-request", {"member_id": planner, "url": lk, "host": h_, "unchecked": True})
            open_page(A, ql["id"])
            i = common_card(A, ql["id"], "planner", "acme", lk, h_)
            A.check(i and i["encoded"] == ENCODED and not i["hasApprove"] and not i["nonAscii"] and not i["blocker"], f"encoded {h_}: {i and (i['encoded'], i['hasApprove'], i['nonAscii'])}")
            if lk == LOOKALIKES[0]: A.audit("eventurl-lookalike"); A.shot("40g-eventurl-lookalike")
        res = A.pg.request.post(base + "/__mock/eu-request", data={"member_id": planner, "url": "https://good.example@evil.example/x"})
        A.check(res.status == 422, f"the mock took a name before an @ at the ask (events.PlainHost refuses it): {res.status}")
        # number forms of an IP, a trailing dot, percent-encoding: the server refuses them at the ask; seeded directly, refused here
        for u_, h_ in [("https://16843009/x", "1.1.1.1"), ("https://0x01010101/x", "1.1.1.1"), ("https://1.1.257/x", "1.1.1.1"), ("https://001.001.001.001/x", "1.1.1.1"),
                       ("https://1.1.1.1./x", "1.1.1.1"), ("https://%65vil.example/x", "evil.example")]:
            res = A.pg.request.post(base + "/__mock/eu-request", data={"member_id": planner, "url": u_})
            A.check(res.status == 422, f"the mock took {u_} at the ask: {res.status}")
            qn_ = A.mock("eu-request", {"member_id": planner, "url": u_, "host": h_, "unchecked": True})
            open_page(A, qn_["id"])
            i = look(A, qn_["id"], "planner")
            A.check(i and i["host"] == h_ and i["approveDisabled"] and i["blocker"] == REFUSED, f"{u_}: not refused: {i and (i['host'], i['approveDisabled'], i['blocker'])}")
        for label, url, host in [("javascript:", "javascript:window.__pwned=4//https://hooks.example.com/", "hooks.example.com"),
                                 ("host mismatch", "https://good.example@evil.example/", "good.example")]:
            qj = A.mock("eu-request", {"member_id": planner, "url": url, "host": host, "unchecked": True})
            open_page(A, qj["id"])
            i = look(A, qj["id"], "planner")
            A.check(i and i["approveDisabled"] and i["blocker"] and i["dangerous"] == 0 and i["pwned"] is None, f"{label}: approve not stopped: {i}")
        A.shot("40h-eventurl-refused")

        # 10. a batch in the same room leaves the address request alone
        j = [A.mock("join", {"room_id": acme, "name": n, "machine": f"box-{n}", "folder": f"~/{n}"}) for n in ("alpha", "beta")]
        qn = A.mock("eu-request", {"member_id": planner, "url": "https://batch.example/x"})
        home(A)
        A.check(group(A, acme).locator("[data-need=event_url]").count() == 0, "batch: an address card inside the batch group")
        A.check(card(A, qn["id"]).locator("input[type=checkbox]").count() == 0, "batch: a tick box on the address card")
        A.check(group(A, acme).locator(".batch-intro").inner_text().startswith("2 chats are waiting"), "batch: the bar counts the address request")
        for x in j: tick(A, x["id"])
        go_btn(A, acme).click(); approve_dialog(A, "Approve 2 chats")
        bp = batch_posts(A)
        A.check(len(bp) == 1 and sorted(it["id"] for it in bp[0][1]["items"]) == sorted(x["id"] for x in j), f"batch: items {bp}")
        expect(card(A, qn["id"])).to_be_visible()
        A.check(eu_state(A, qn["id"])["status"] == "waiting" and eu_state(A, qn["id"])["approve_calls"] == 0, "batch: the address request was touched")

        # 11. the member's approved addresses and Stop; another person of the room sees none of it
        A.mock("eu-sub", {"member_id": planner, "url": HOSTILE_URL, "host": "evil.example"})
        A.go(f"/rooms/{acme}"); A.settle(400)
        pg.locator(".roster-item", has_text="planner").click()
        sheet = pg.locator("dialog.sheet[open]")
        expect(sheet.locator(".eu-sub")).to_have_count(3, timeout=5000)   # approved in 1 and 2, and the hostile one
        rows = sheet.locator(".eu-sub")
        first = rows.filter(has_text="hooks.example.com")
        A.check(first.locator(".eu-host").inner_text() == "hooks.example.com", "member: host large")
        A.check(first.locator(".cw-text[data-field=url]").inner_text() == GOOD_URL, "member: full address")
        A.check(re.search(r"Approved by you on \S.*\. " + re.escape(LASTS.format(chat="planner")), first.inner_text()) is not None, f"member: approved by you on, and how long: {first.inner_text()!r}")
        hostile_row = rows.filter(has=pg.locator(".eu-host", has_text="evil.example"))
        A.check(hostile_row.locator("img, script, a").count() == 0 and RLO not in hostile_row.inner_text(), "member: hostile address not inert")
        A.settle(300); A.audit("eventurl-member"); A.shot("40i-eventurl-member")
        first.get_by_role("button", name="Stop").click()
        cd = pg.locator("dialog[open]").last
        expect(cd.get_by_text(STOP_BODY.format(chat="planner"))).to_be_visible()
        A.shot("40j-eventurl-stop-confirm")
        cd.get_by_role("button", name="Stop", exact=True).click()
        expect(sheet.locator(".eu-sub")).to_have_count(2, timeout=5000)
        A.check(len([1 for m, u in A.reqs if m == "POST" and re.search(rf"/members/{planner}/event-urls/sub_[0-9a-f]+/stop$", u)]) == 1, "stop: want exactly one request")
        A.check(len(subs(A, planner)) == 2 and not any(x["url"] == GOOD_URL for x in subs(A, planner)), "stop: the subscription is still there")
        res = A.pg.request.post(base + "/__mock/eu-plain-subscribe", data={"member_id": planner, "url": GOOD_URL})
        A.check(res.status == 409 and res.json()["error"]["code"] == "stopped_by_person" and res.json()["error"]["details"]["reason"] == "stopped", f"a plain subscribe after Stop: {res.status} {res.text()}")
        res = A.pg.request.post(base + "/__mock/eu-plain-subscribe", data={"member_id": planner, "url": "https://api.example.org/hooks/second"})
        A.check(res.status == 200, f"a plain subscribe of an address not stopped: {res.status}")
        B = run(f"bea-{vp}@eu.test", "Bea")
        A.mock("eu-person", {"room_id": acme, "email": f"bea-{vp}@eu.test"})
        B.go(f"/rooms/{acme}"); B.settle(500)
        B.pg.locator(".roster-item", has_text="planner").click()
        bs = B.pg.locator("dialog.sheet[open]")
        expect(bs).to_be_visible(); B.settle(500)
        B.check(bs.locator(".eu-subs, .eu-sub").count() == 0 and "Stop" not in bs.inner_text(), "another person sees the addresses")
        B.check(not any("/event-urls" in u for m, u in B.reqs), "another person's browser asked for the addresses")
        r = api(B, "GET", f"/app/v1/members/{planner}/event-urls")
        B.check(r["status"] == 404, f"another person reads the addresses: {r['status']}")
        e0 = len(B.errors)
        r = api(B, "POST", f"/app/v1/members/{planner}/event-urls/{subs(A, planner)[0]['subscription_id']}/stop")
        B.check(r["status"] == 404 and len(subs(A, planner)) == 2, f"another person stops an address: {r['status']}")
        allow(B, 0, 404, r"/event-urls(/\S+)?")

        # 12. signed out: sign in, then back to the link
        S = run(None, None)
        qs = A.mock("eu-request", {"member_id": planner, "url": "https://signin.example/x"})
        S.pg.goto(f"{base}/approve-url/{qs['id']}")
        S.pg.wait_for_url(re.compile(r".*/login\?return_to=%2Fapprove-url%2F" + qs["id"]))
        S.pg.fill("#dev-email", f"adam-{vp}@eu.test"); S.pg.fill("#dev-name", "Adam")
        S.pg.click("button:has-text('Sign in (dev)')")
        S.pg.wait_for_url(f"**/approve-url/{qs['id']}")
        expect(card(S, qs["id"])).to_be_visible()
        allow(S, 0, 401, r"/app/v1/me(\?\S*)?")
    except Exception as ex:
        fails.append(f"[{vp}] {type(ex).__name__}: {' | '.join(str(ex).splitlines()[:4])[:600]}")
        for k, x in enumerate(runs):
            try:
                p = pathlib.Path(tempfile.gettempdir()) / f"eventurl-fail-{vp}-{k}.png"; x.pg.screenshot(path=str(p)); fails.append(f"[{vp}] tab {k} at {x.pg.url}: {p}")
            except Exception: pass
    for x in runs:
        errs += x.errors; fails += x.failures
        try: x.close()
        except Exception: pass
    return errs, fails


def dark(b, base, vp):
    """The card, a hostile and a lookalike address, and the member's addresses in dark mode."""
    r = watch(Run(b, base, vp, scheme="dark"))
    fails = []
    try:
        sign_in(r, f"dana-{vp}@eu.test", "Dana")
        room = new_room(r, "dark")
        mem = r.mock("eu-member", {"room_id": room, "name": "planner", "email": f"dana-{vp}@eu.test"})["member_id"]
        q = r.mock("eu-request", {"member_id": mem, "url": GOOD_URL})
        home(r); common_card(r, q["id"], "planner", "dark", GOOD_URL, "hooks.example.com")
        r.audit("dark-eventurl-card"); r.shot("dark-40-eventurl-card")
        q = r.mock("eu-request", {"member_id": mem, "url": HOSTILE_URL, "host": "evil.example", "unchecked": True})
        open_page(r, q["id"]); common_card(r, q["id"], "planner", "dark", HOSTILE_URL, "evil.example")
        r.audit("dark-eventurl-hostile"); r.shot("dark-40f-eventurl-hostile")
        q = r.mock("eu-request", {"member_id": mem, "url": LOOKALIKES[0], "host": "xn--80ak6aa92e.com", "unchecked": True})
        open_page(r, q["id"]); r.audit("dark-eventurl-lookalike"); r.shot("dark-40g-eventurl-lookalike")
        r.mock("eu-sub", {"member_id": mem, "url": GOOD_URL})
        r.go(f"/rooms/{room}"); r.settle(400)
        r.pg.locator(".roster-item", has_text="planner").click()
        expect(r.pg.locator("dialog.sheet[open] .eu-sub")).to_have_count(1, timeout=5000)
        r.settle(300); r.audit("dark-eventurl-member"); r.shot("dark-40i-eventurl-member")
    except Exception as ex:
        fails.append(f"[{vp} dark] {type(ex).__name__}: {' | '.join(str(ex).splitlines()[:4])[:600]}")
    errs, fails = r.errors, fails + r.failures
    r.close()
    return errs, fails


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base")
    ap.add_argument("--port", type=int, default=10121)
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
