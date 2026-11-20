"""An event address a person approves, against the REAL Go server and REAL chats (client/dist/cli.js).

A real chat of the signed-in person asks bot-link to call a local endpoint the test runs (a signed
POST /api/v1/me/events/subscriptions {name: "message.received", url, approval: "person"}: web/test/agent_call.mjs).
The endpoint counts what reaches it and answers 200, as a routine's trigger does. Asserted:
- nothing reaches the endpoint after the request, also not when a message waits for the chat;
- the card on Your rooms shows our heading, the warning, the host large and the full address, no tick box;
- on /approve-url/<id>, Approve with the stub human check: exactly one human check (approve_event_url, the request id)
  and one approve request (200), the page says the approved line;
- a new message to that chat makes the server call the endpoint (count >= 1), signed, and no call carries message text;
- the member's details sheet lists the address; a second person of the room sees no list and reads 404;
- Stop (confirm, one request) and the next message makes no call.
--real: on a server with BOTLINK_HUMAN_CHECK=real, a passkey set up on a join approval, then the approval of the address
asks the passkey again (webauthn step "assert", never "skip") and the virtual authenticator signs again.

    BOTLINK_ENV=dev BOTLINK_ADDR=127.0.0.1:10130 BOTLINK_DEV_LOGIN=1 BOTLINK_HUMAN_CHECK=stub BOTLINK_PUSH_ALLOW_LOOPBACK=1 \\
      BOTLINK_APP_ORIGIN=http://localhost:10130 BOTLINK_WEB_DIR=web/public BOTLINK_METRICS_ADDR=off \\
      BOTLINK_DATABASE_URL=postgres://botlink@127.0.0.1:<port>/<throwaway db> .dev/bin/botlink &
    python3 web/test/test_eventurl_real.py --base http://localhost:10130 [--hook-port 10131] [--only phone|desktop]
    real: the same with BOTLINK_HUMAN_CHECK=real BOTLINK_TURNSTILE_SITE_KEY=1x00000000000000000000AA
      BOTLINK_TURNSTILE_SECRET=1x0000000000000000000000000000000AA (needs challenges.cloudflare.com), then --real
"""
import argparse, json, os, pathlib, re, subprocess, sys, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from playwright.sync_api import sync_playwright, expect

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from test_e2e import Run, VIEWPORTS, approve_dialog  # noqa: E402
from test_real_server import CLI  # noqa: E402
from test_create_real import sign_in, local  # noqa: E402
from test_batch_real import new_room, ask  # noqa: E402
from test_batch import watch, allow  # noqa: E402
from test_eventurl import card, common_card, offered, look, hc_bodies, n_posts, approve_btn, APPROVED, STOP_BODY, ENCODED  # noqa: E402

HELPER = pathlib.Path(__file__).parent / "agent_call.mjs"
PSQL = "/usr/lib/postgresql/16/bin/psql"


class Hook:
    """A routine's trigger: counts what reaches it, answers 200 with nothing to check."""
    def __init__(self, port):
        self.calls, self.lock = [], threading.Lock()
        hook = self

        class H(BaseHTTPRequestHandler):
            def do_POST(self):
                body = self.rfile.read(int(self.headers.get("Content-Length") or 0)).decode("utf-8", "replace")
                with hook.lock: hook.calls.append({"path": self.path, "headers": {k.lower(): v for k, v in self.headers.items()}, "body": body})
                self.send_response(200); self.send_header("Content-Length", "2"); self.end_headers(); self.wfile.write(b"{}")
            do_GET = do_PUT = do_POST
            def log_message(self, *a): pass
        self.srv = ThreadingHTTPServer(("127.0.0.1", port), H)
        self.port = port
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    def count(self, path):
        with self.lock: return sum(1 for c in self.calls if c["path"].startswith(path))

    def bodies(self, path):
        with self.lock: return [c for c in self.calls if c["path"].startswith(path)]

    def close(self):
        self.srv.shutdown()


def agent(chat, name, method, path, body=None):
    r = subprocess.run(["node", str(HELPER), name, method, path, *( [json.dumps(body)] if body is not None else [])], env=chat.env, capture_output=True, text=True, timeout=60, cwd=getattr(chat, "cwd", None))
    assert r.returncode == 0, f"agent call failed: {r.stdout}{r.stderr}"
    return json.loads(r.stdout.strip().splitlines()[-1])


def until(pred, s):
    end = time.time() + s
    while time.time() < end:
        if pred(): return True
        time.sleep(0.5)
    return pred()


def join_both(A, base, rid, invite, tag, names, approve=lambda r: approve_dialog(r)):
    chats = {n: ask(base, invite, tag, n) for n in names}
    A.pg.goto(f"{base}/rooms/{rid}"); A.settle(700)
    for n, (c, jid, _, _) in chats.items():
        k = A.pg.locator(f"[data-need=join][data-request='{jid}']")
        expect(k).to_be_visible(timeout=10000)
        k.get_by_role("button", name="Approve", exact=True).click(); approve(A)
        rc, out = c.wait()
        A.check(rc == 0, f"{n} join rc={rc}: {out[-300:]}")
    return {n: v[0] for n, v in chats.items()}


def send(chat, frm, to, text):
    rc, out = chat.run("send", "--as", frm, "--to", to, "--intent", "fyi", "--text", text)
    assert rc == 0, f"send rc={rc}: {out[-400:]}"


def flow(b, base, vp, hook, db=None):
    tag = f"{vp[:1]}{os.urandom(2).hex()}"
    runs, fails = [], []
    try:
        A = watch(Run(b, base, vp)); runs.append(A); pg = A.pg
        sign_in(A, f"adam-{tag}@eu.test", "Adam")
        room = f"wake-{tag}"
        rid, invite = new_room(A, room)
        chats = join_both(A, base, rid, invite, tag, ("planner", "sender"))
        planner, sender = chats["planner"], chats["sender"]
        path = f"/hook/{tag}"
        url = f"http://127.0.0.1:{hook.port}{path}?key=k_{tag}"

        # 1. the chat asks; nothing reaches the address, also not when a message waits for the chat
        r = agent(planner, "planner", "POST", "/api/v1/me/events/subscriptions", {"name": "message.received", "url": url, "approval": "person"})
        A.check(r["status"] == 202 and r["body"]["request"]["status"] == "waiting", f"the ask: {r}")
        rq, approve_url = r["body"]["request"]["id"], r["body"]["approve_url"]
        A.check(approve_url.endswith(f"/approve-url/{rq}"), f"approve_url {approve_url}")
        t1 = f"before approval {tag} SECRET-ONE"
        send(sender, "sender", "planner", t1)
        time.sleep(4)
        A.check(hook.count(path) == 0, f"{hook.count(path)} calls reached the address before approval")

        # 2. the card on Your rooms
        A.go("/rooms"); pg.wait_for_selector(".needs-panel", timeout=8000)
        expect(card(A, rq)).to_be_visible(timeout=10000)
        offered(A, common_card(A, rq, "planner", room, url, "127.0.0.1"))
        A.audit("real-eventurl-card"); A.shot("real-40-eventurl-card")

        # 3. its page; approve with the stub human check
        A.pg.goto(local(base, approve_url)); pg.wait_for_selector("[data-eu-page]", timeout=10000); A.settle(300)
        approve_btn(A, rq).click(); approve_dialog(A, "Approve")
        expect(pg.locator("[data-eu-state=approved]")).to_be_visible(timeout=8000)
        A.check(APPROVED.format(chat="planner") in pg.locator("main").inner_text(), "the approved line")
        A.check(hc_bodies(A) == [{"action": "approve_event_url", "target_id": rq}], f"human checks {hc_bodies(A)}")
        A.check(n_posts(A, f"/event-urls/{rq}/approve") == 1, "want exactly one approve request")
        st = [s for m, u, s in A.resps if u.endswith(f"/event-urls/{rq}/approve")]
        A.check(st == [200], f"approve answers {st}")
        A.shot("real-40c-eventurl-approved")

        # 4. a new message makes the server call the address; no call carries message text
        planner.run("inbox", "--as", "planner")  # the waiting message is read: the next call is for the new one
        time.sleep(3)
        n0 = hook.count(path)
        t2 = f"after approval {tag} SECRET-TWO"
        send(sender, "sender", "planner", t2)
        A.check(until(lambda: hook.count(path) > n0, 25), f"no call after a message ({hook.count(path)} calls, {n0} before)")
        calls = hook.bodies(path)
        A.check(calls and all("SECRET" not in c["body"] and t1 not in c["body"] and t2 not in c["body"] for c in calls), f"message text in a call: {[c['body'][:300] for c in calls]}")
        last = json.loads(calls[-1]["body"])
        A.check(last.get("name") == "message.received" and last.get("data", {}).get("member", {}).get("name") == "planner", f"event body {last}")
        A.check(calls[-1]["headers"].get("webhook-signature", "").startswith("v1,"), f"unsigned call {calls[-1]['headers']}")

        # 5. the member's details list the address
        A.go(f"/rooms/{rid}"); A.settle(600)
        pg.locator(".roster-item", has_text="planner").click()
        sheet = pg.locator("dialog.sheet[open]")
        expect(sheet.locator(".eu-sub")).to_have_count(1, timeout=8000)
        A.check(sheet.locator(".eu-sub .eu-host").inner_text() == "127.0.0.1", "member: host")
        A.check(sheet.locator(".eu-sub .cw-text[data-field=url]").inner_text() == url, "member: full address")
        A.settle(300); A.audit("real-eventurl-member"); A.shot("real-40i-eventurl-member")
        sheet.locator(".sheet-close").click()

        # 6. a second person of the room sees nothing of it
        pg.get_by_role("button", name="Invite a person").click()
        expect(pg.locator(".pinv.is-fresh")).to_be_visible(timeout=8000)
        pinv = pg.locator(".pinv.is-fresh .pinv-url").inner_text().rsplit("/", 1)[1]
        B = watch(Run(b, base, vp)); runs.append(B)
        B.go(f"/login?return_to=/p/{pinv}")
        B.pg.fill("#dev-email", f"bea-{tag}@eu.test"); B.pg.fill("#dev-name", "Bea")
        B.pg.click("button:has-text('Sign in (dev)')"); B.pg.wait_for_url(f"**/p/{pinv}")
        B.pg.get_by_role("button", name="Ask to join").click()
        expect(B.pg.get_by_role("heading", name="Asked.")).to_be_visible(timeout=8000)
        pr = pg.locator("[data-need=person]")
        expect(pr).to_be_visible(timeout=10000)
        pr.get_by_role("button", name="Approve").click(); approve_dialog(A)
        B.go(f"/rooms/{rid}"); B.settle(800)
        B.pg.locator(".roster-item", has_text="planner").click()
        bs = B.pg.locator("dialog.sheet[open]")
        expect(bs).to_be_visible(); B.settle(800)
        B.check(bs.locator(".eu-subs:not([hidden]), .eu-sub").count() == 0 and "Stop" not in bs.inner_text(), "another person sees the addresses")
        B.check(not any("/event-urls" in u for m, u in B.reqs), "another person's browser asked for the addresses")
        e0 = len(B.errors)
        mid = pg.evaluate("(n) => fetch(location.pathname.replace('/rooms/', '/app/v1/rooms/')).then((x) => x.json()).then((d) => d.members.find((m) => m.name === n).id)", "planner")
        got = B.pg.evaluate("(p) => fetch(p).then((x) => x.status)", f"/app/v1/members/{mid}/event-urls")
        B.check(got == 404, f"another person reads the addresses: {got}")
        allow(B, e0, 404, r"/event-urls")

        # 7. Stop: one request, the row leaves, the next message makes no call
        pg.locator(".roster-item", has_text="planner").click()
        sheet = pg.locator("dialog.sheet[open]")
        expect(sheet.locator(".eu-sub")).to_have_count(1, timeout=8000)
        sheet.locator(".eu-sub").get_by_role("button", name="Stop").click()
        cd = pg.locator("dialog[open]").last
        expect(cd.get_by_text(STOP_BODY.format(chat="planner"))).to_be_visible()
        cd.get_by_role("button", name="Stop", exact=True).click()
        expect(sheet.locator(".eu-sub")).to_have_count(0, timeout=8000)
        stops = [s for m, u, s in A.resps if re.search(r"/event-urls/sub_[0-9a-f]+/stop$", u)]
        A.check(stops == [204], f"stop answers {stops}")
        r = agent(planner, "planner", "GET", "/api/v1/me/events/subscriptions")
        A.check(r["status"] == 200 and not [s for s in r["body"].get("subscriptions", []) if s.get("url") == url], f"still subscribed: {r}")
        planner.run("inbox", "--as", "planner"); time.sleep(3)
        n1 = hook.count(path)
        send(sender, "sender", "planner", f"after stop {tag} SECRET-THREE")
        time.sleep(8)
        A.check(hook.count(path) == n1, f"a call after Stop ({hook.count(path)} vs {n1})")
        # a plain subscribe to the stopped address: refused, and the address gets nothing, not even the check
        r = agent(planner, "planner", "POST", "/api/v1/me/events/subscriptions", {"name": "message.received", "url": url})
        err = r["body"].get("error", {}) if isinstance(r["body"], dict) else {}
        A.check(r["status"] == 409 and err.get("code") == "stopped_by_person" and (err.get("details") or {}).get("reason") == "stopped", f"a plain subscribe after Stop: {r}")
        time.sleep(2)
        A.check(hook.count(path) == n1, f"the stopped address got a request after a plain subscribe ({hook.count(path)} vs {n1})")
        # 8. an encoded (xn--) host: the server is to refuse it at the ask; a row put straight into the database shows
        # what the page does with one: the xn-- form large, the encoded-name line, no Approve
        if db:
            seeded = subprocess.run([PSQL, db, "-qtAc", "insert into event_url_requests (id, member_id, key_epoch, url, name, urgent_only, secret, ttl_s, expires_at) "
                                     "select gen_random_uuid(), member_id, key_epoch, 'https://xn--80ak6aa92e.example/hook', name, urgent_only, secret, ttl_s, now() + interval '1 day' "
                                     f"from event_url_requests where id = '{rq}' returning id"], capture_output=True, text=True, timeout=30)
            xid = seeded.stdout.strip().splitlines()[0] if seeded.returncode == 0 and seeded.stdout.strip() else None
            A.check(xid, f"could not seed the xn-- request: {seeded.stderr[-300:]}")
            if xid:
                A.go(f"/approve-url/{xid}"); pg.wait_for_selector("[data-eu-page]", timeout=10000)
                i = look(A, xid, "planner")
                A.check(i and i["host"] == "xn--80ak6aa92e.example" and i["encoded"] == ENCODED and not i["hasApprove"] and not i["nonAscii"], f"xn-- host: {i}")
                A.shot("real-40g-eventurl-encoded")
        r = agent(planner, "planner", "POST", "/api/v1/me/events/subscriptions", {"name": "message.received", "url": "https://xn--80ak6aa92e.example/hook", "approval": "person"})
        A.check(r["status"] == 422 and r["body"].get("error", {}).get("code") == "event_url_blocked", f"an xn-- host at the ask: {r}")
        print(f"[{vp}] calls to the address: 0 before approval, {n0} after approval (catch-up), {n1} after a new message, {hook.count(path)} after Stop and one more message")
    except Exception as ex:
        fails.append(f"[{vp}] {type(ex).__name__}: {' | '.join(str(ex).splitlines()[:4])[:700]}")
    errs = []
    for x in runs:
        errs += x.errors; fails += x.failures
        try: x.close()
        except Exception: pass
    return errs, fails


def real_pass(b, base, hook):
    """The real human check: the approval of an address asks the passkey again within the hour (never "skip")."""
    tag = f"k{os.urandom(2).hex()}"
    fails = []
    r = watch(Run(b, base, "desktop"))
    cdp = r.ctx.new_cdp_session(r.pg)
    cdp.send("WebAuthn.enable")
    auth = cdp.send("WebAuthn.addVirtualAuthenticator", {"options": {"protocol": "ctap2", "transport": "internal", "hasResidentKey": True,
                                                                       "hasUserVerification": True, "isUserVerified": True, "automaticPresenceSimulation": True}})["authenticatorId"]
    hcs = []
    def on_hc(s):
        if s.url.endswith("/app/v1/human-check") and s.request.method == "POST":
            try: hcs.append((json.loads(s.request.post_data or "{}").get("action"), s.json()["webauthn"]["step"]))
            except Exception as ex: hcs.append(("?", f"unreadable: {ex}"))
    r.pg.on("response", on_hc)

    def approve(label):
        dlg = r.pg.locator("dialog[open]")
        go = dlg.get_by_role("button", name=re.compile(label))
        expect(go).to_be_enabled(timeout=30000)
        go.click()
        expect(r.pg.locator("dialog[open]")).to_have_count(0, timeout=20000)
        r.settle(600)
    try:
        sign_in(r, f"kim-{tag}@eu.test", "Kim")
        rid, invite = new_room(r, f"keys-{tag}")
        planner = join_both(r, base, rid, invite, tag, ("planner",), approve=lambda x: approve(r"Set up|Approve|Unlock"))["planner"]
        c0 = cdp.send("WebAuthn.getCredentials", {"authenticatorId": auth})["credentials"]
        r.check(len(c0) == 1, f"no passkey after the join approval: {c0}")
        q = agent(planner, "planner", "POST", "/api/v1/me/events/subscriptions", {"name": "message.received", "url": f"http://127.0.0.1:{hook.port}/hook/{tag}", "approval": "person"})
        rq = q["body"]["request"]["id"]
        r.pg.goto(local(base, q["body"]["approve_url"])); r.pg.wait_for_selector("[data-eu-page]", timeout=10000)
        approve_btn(r, rq).click()
        expect(r.pg.locator("dialog[open]")).to_contain_text("Face ID, fingerprint or Windows Hello, to let bot-link call this address. Asked each time.", timeout=15000)
        r.check(r.pg.locator("dialog[open]").get_by_text("Sign in again instead").is_hidden(), "a sign-in-again way out is offered")
        r.shot("real-40k-eventurl-passkey")
        approve(r"Unlock")
        expect(r.pg.locator("[data-eu-state=approved]")).to_be_visible(timeout=10000)
        print(f"[real] human checks (action, webauthn step): {hcs}")
        r.check(hcs and hcs[-1] == ("approve_event_url", "assert"), f"approve_event_url within the hour of a passkey: {hcs}, want assert")
        c1 = cdp.send("WebAuthn.getCredentials", {"authenticatorId": auth})["credentials"]
        r.check(c1 and c1[0]["signCount"] > c0[0]["signCount"], f"the passkey did not sign for the approval: {c0} -> {c1}")
    except Exception as ex:
        fails.append(f"[real] {type(ex).__name__}: {' | '.join(str(ex).splitlines()[:4])[:700]}")
    errs = [e for e in r.errors if "challenges.cloudflare.com" not in e]
    fails += r.failures
    r.close()
    return errs, fails


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://localhost:10130")
    ap.add_argument("--hook-port", type=int, default=10131)
    ap.add_argument("--only", choices=list(VIEWPORTS))
    ap.add_argument("--real", action="store_true", help="the passkey pass, on a server with BOTLINK_HUMAN_CHECK=real")
    ap.add_argument("--db", help="the server's database URL: also seed an xn-- request straight into it (what the page does with one)")
    a = ap.parse_args()
    assert CLI.exists(), f"{CLI} missing (cd client && npm ci && npm run build)"
    hook = Hook(a.hook_port)
    E, F = [], []
    try:
        with sync_playwright() as p:
            b = p.chromium.launch()
            if a.real:
                e, f = real_pass(b, a.base, hook)
                print(f"real human check: {len(e)} console errors, {len(f)} failures")
                E += e; F += f
            else:
                for vp in [a.only] if a.only else list(VIEWPORTS):
                    t = time.time()
                    e, f = flow(b, a.base, vp, hook, a.db)
                    print(f"{vp}: event address on the real server {time.time() - t:.0f}s, {len(e)} console errors, {len(f)} failures")
                    E += e; F += f
            b.close()
    finally:
        hook.close()
    for e in E: print("ERROR", e)
    for f in F: print("FAIL ", f)
    ok = not E and not F
    print("OK" if ok else "NOT OK")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
