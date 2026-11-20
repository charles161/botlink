"""A chat that names its own app is shown with that app's icon when we keep one (web/public/assets/js/app-logos.js).

17 Nov 2026: Grok Bot chats join with `--app-name "Grok Bot"` (app "other"). Wherever the dashboard shows a chat's
app, a self-named app we have an icon for gets that app's name and icon as the bot's badge; the bot keeps the generic
"other" body and its per-name tint (how a self-named app is told apart from a detected one), and a name we have no
icon for keeps the generic bot with its letters. A chat detected as Cursor is unchanged.

Covered, on the fixture server: the /create/<id> card, the waiting card on "What needs you", /approve/<id>, the batch dialog, and the room's
member list and table after the batch approval: "Grok Bot" with the grok-bot.png badge (the image loads), "Totally New
App" with letters and no image, "Cursor" with the Cursor bot. Desktop 1440x900 and phone 390x844, light and dark:
0 console errors, no horizontal overflow. Screenshots: web/shots/<vp>[-dark]-40-app-logo-waiting-card.png

    python3 web/test/test_app_logos.py                      # starts its own mock on :9946 and stops it after
    python3 web/test/test_app_logos.py --base http://localhost:9940
"""
import argparse, pathlib, sys, time
from playwright.sync_api import sync_playwright, expect

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from test_e2e import Run, sign_in, approve_dialog, VIEWPORTS, SHOTS  # noqa: E402
from test_batch import watch, new_room, card, group, go_btn, home, tick, part_shot, start_mock  # noqa: E402

GROK_SRC = "/assets/apps/grok-bot.png"

# What a chat's bot shows: its body kind, the badge image (href, and whether it loads) and the badge letters.
BOT_JS = r"""
async (el) => {
  const svg = el.matches("svg.char") ? el : el.querySelector("svg.char");
  if (!svg) return null;
  const img = svg.querySelector(".c-logo-badge image");
  const href = img ? (img.getAttribute("href") || img.getAttribute("xlink:href")) : null;
  const loads = href ? await new Promise((ok) => { const i = new Image(); i.onload = () => ok(i.naturalWidth > 0); i.onerror = () => ok(false); i.src = href; }) : false;
  const r = img ? img.getBoundingClientRect() : null;
  return { cls: svg.getAttribute("class"), href, loads, w: r ? r.width : 0, mono: (svg.querySelector(".c-mono")?.textContent || "").trim(),
    tinted: svg.classList.contains("char-tinted"), label: svg.getAttribute("aria-label") };
}
"""


def bot(r, loc):
    return loc.first.evaluate(BOT_JS) if loc.count() else None


def expect_grok(r, where, b, text):
    r.check(b is not None, f"{where}: no bot")
    if not b: return
    r.check("char-other" in b["cls"] and b["tinted"], f"{where}: Grok Bot keeps the generic, tinted bot of a self-named app: {b['cls']}")
    r.check(b["href"] == GROK_SRC and b["loads"] and b["w"] >= 6, f"{where}: Grok Bot badge {b['href']!r} loads={b['loads']} width={b['w']:.1f}")
    r.check(not b["mono"], f"{where}: Grok Bot badge still shows letters {b['mono']!r}")
    r.check("Grok Bot" in text, f"{where}: does not say Grok Bot: {text[:200]!r}")


def expect_new_app(r, where, b, text):
    r.check(b is not None and "char-other" in b["cls"] and b["tinted"] and not b["href"] and b["mono"] == "TN", f"{where}: Totally New App bot {b}")
    r.check("Totally New App" in text, f"{where}: does not say Totally New App: {text[:200]!r}")


def expect_cursor(r, where, b, text):
    r.check(b is not None and "char-cursor" in b["cls"] and not b["href"], f"{where}: Cursor bot {b}")
    r.check("Cursor" in text, f"{where}: does not say Cursor: {text[:200]!r}")


def flow(b, base, vp, scheme):
    r = watch(Run(b, base, vp, scheme=scheme))
    tag = f"[{vp} {scheme}]"
    fails = []
    try:
        sign_in(r, f"gwen-{vp}-{scheme}-{int(time.time() * 1000) % 100000}@logos.test", "Gwen")
        # the /create/<id> card of a room a chat asked for (a name spelled another way still matches)
        d = r.mock("draft", {"room_name": "grokroom", "name": "grokker", "app": "other", "app_name": "grok-bot", "machine": "grok-box"})
        r.go(f"/create/{d['id']}"); r.settle(1000)
        expect(r.pg.locator("main svg.char").first).to_be_visible(timeout=8000)
        expect_grok(r, f"{tag} /create", bot(r, r.pg.locator("main svg.char")), r.pg.locator("main").inner_text())
        d2 = r.mock("draft", {"room_name": "newroom", "name": "newer", "app": "other", "app_name": "Totally New App", "machine": "lab"})
        r.go(f"/create/{d2['id']}"); r.settle(1000)
        expect(r.pg.locator("main svg.char").first).to_be_visible(timeout=8000)
        expect_new_app(r, f"{tag} /create", bot(r, r.pg.locator("main svg.char")), r.pg.locator("main").inner_text())
        room = new_room(r, "logos")
        j = {
            "grok": r.mock("join", {"room_id": room, "name": "grok", "app": "other", "app_name": "Grok Bot", "machine": "grok-box", "job": "Answers from Grok Bot."}),
            "newbie": r.mock("join", {"room_id": room, "name": "newbie", "app": "other", "app_name": "Totally New App", "machine": "lab", "job": "Tries things."}),
            "edit": r.mock("join", {"room_id": room, "name": "edit", "app": "cursor", "machine": "adams-macbook", "job": "Edits."}),
        }
        # the waiting cards on "What needs you"
        home(r)
        for n in j: expect(card(r, j[n]["id"])).to_be_visible(timeout=8000)
        g = card(r, j["grok"]["id"])
        expect_grok(r, f"{tag} waiting card", bot(r, g.locator("svg.char")), g.inner_text())
        expect_new_app(r, f"{tag} waiting card", bot(r, card(r, j["newbie"]["id"]).locator("svg.char")), card(r, j["newbie"]["id"]).inner_text())
        expect_cursor(r, f"{tag} waiting card", bot(r, card(r, j["edit"]["id"]).locator("svg.char")), card(r, j["edit"]["id"]).inner_text())
        r.audit("app-logo-waiting")
        part_shot(r, g, f"{'dark-' if scheme == 'dark' else ''}40-app-logo-waiting-card")
        # the approve page
        r.go(f"/approve/{j['grok']['id']}"); r.settle(800)
        main = r.pg.locator("main")
        expect(main.locator("svg.char").first).to_be_visible(timeout=8000)
        expect_grok(r, f"{tag} /approve", bot(r, main.locator("svg.char")), main.inner_text())
        r.go(f"/approve/{j['newbie']['id']}"); r.settle(800)
        expect_new_app(r, f"{tag} /approve", bot(r, r.pg.locator("main svg.char")), r.pg.locator("main").inner_text())
        # the batch dialog
        home(r)
        tick(r, j["grok"]["id"]); tick(r, j["newbie"]["id"]); tick(r, j["edit"]["id"])
        go_btn(r, room).click()
        dlg = r.pg.locator("dialog[open]")
        expect(dlg.get_by_role("button", name="Approve 3 chats")).to_be_enabled(timeout=5000)
        rows = dlg.locator(".batch-list li")
        r.check(rows.count() == 3, f"{tag} batch dialog: {rows.count()} rows")
        for i in range(rows.count()):
            row = rows.nth(i); t = row.inner_text(); bb = bot(r, row.locator("svg.char"))
            who = row.locator(".batch-list-name").inner_text().strip()
            if who == "grok": expect_grok(r, f"{tag} batch dialog", bb, t)
            elif who == "newbie": expect_new_app(r, f"{tag} batch dialog", bb, t)
            else: expect_cursor(r, f"{tag} batch dialog", bb, t)
        r.audit("app-logo-batch")
        approve_dialog(r, "Approve 3 chats")
        # the room: its member list and its table
        r.go(f"/rooms/{room}"); r.settle(1200)
        expect(r.pg.get_by_text("Grok Bot · Gwen's chat").first).to_be_visible(timeout=8000)
        item = r.pg.locator("li", has=r.pg.get_by_text("Grok Bot · Gwen's chat")).first
        expect_grok(r, f"{tag} member list", bot(r, item.locator("svg.char")), item.inner_text())
        item2 = r.pg.locator("li", has=r.pg.get_by_text("Totally New App · Gwen's chat")).first
        expect_new_app(r, f"{tag} member list", bot(r, item2.locator("svg.char")), item2.inner_text())
        item3 = r.pg.locator("li", has=r.pg.get_by_text("Cursor · Gwen's chat")).first
        expect_cursor(r, f"{tag} member list", bot(r, item3.locator("svg.char")), item3.inner_text())
        seat = r.pg.locator(".seat", has=r.pg.get_by_text("grok", exact=True)).first
        said = seat.inner_text() + " " + (seat.evaluate("(e) => (e.matches('[aria-label]') ? e : e.querySelector('[aria-label]'))?.getAttribute('aria-label') || ''"))
        expect_grok(r, f"{tag} room table", bot(r, seat.locator("svg.char")), said)
        r.audit("app-logo-room")
    except Exception as ex:
        fails.append(f"{tag} {type(ex).__name__}: {' | '.join(str(ex).splitlines()[:4])[:600]}")
    errs, fails = r.errors, fails + r.failures
    r.close()
    return errs, fails


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base")
    ap.add_argument("--port", type=int, default=9946)
    a = ap.parse_args()
    proc, base = (None, a.base) if a.base else start_mock(a.port)
    all_errs, all_fails = [], []
    try:
        with sync_playwright() as p:
            b = p.chromium.launch()
            for vp in VIEWPORTS:
                for scheme in ("light", "dark"):
                    e, f = flow(b, base, vp, scheme)
                    all_errs += e; all_fails += f
                    print(f"{vp} {scheme}: {len(e)} console errors, {len(f)} failures")
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
