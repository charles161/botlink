package test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/charles161/botlink/server/internal/config"
)

// Security review 12 Nov 2026, item 11: a chat that used another person's chat invite. The request goes to the
// invite's person; a different person of the same room may take it over (once), then approve it as their own chat.
func TestJoinReaddress(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A")
	charles := NewPerson(t, c, "Charles")
	victor := NewPerson(t, c, "Victor")
	eve := NewPerson(t, c, "Eve")
	room := charles.CreateRoom("shared")
	addPerson(t, charles, victor, room)

	v2 := NewAgentKeys(t, "v2")
	// ENVELOPE §5.4: the view names the invite's account, which the client's self-check requires
	if r := v2.Join(c, charles.Invite(room)); r.Status != 201 || r.Str("approver_name") != "Charles" || r.Str("approver_account") != charles.AccountID {
		t.Fatalf("join with Charles's invite: %s", r)
	}
	path := "/app/v1/join-requests/" + v2.ReqID + "/readdress"
	// the person it is addressed to, someone outside the room, an unknown id: the same "no offer"
	noOffer := func(p *Person, path string) bool {
		r := p.Do("GET", path, nil)
		return r.Status == 200 && r.J["offer"] == nil
	}
	if !noOffer(charles, path) {
		t.Fatal("addressee offered a takeover")
	}
	if !noOffer(eve, path) {
		t.Fatal("outsider offered a takeover")
	}
	if !noOffer(victor, "/app/v1/join-requests/01a1cbd8-0000-7000-8000-000000000000/readdress") {
		t.Fatal("unknown id offered")
	}
	if r := eve.Do("POST", path, nil); r.Status != 404 {
		t.Fatalf("outsider took it over: %s", r)
	}
	// a person of the room: offered, with whose link it used
	off := victor.Do("GET", path, nil)
	o, _ := off.J["offer"].(map[string]any)
	if off.Status != 200 || o == nil || o["invite_owner_name"] != "Charles" || o["name"] != "v2" {
		t.Fatalf("offer: %s", off)
	}
	if r := victor.Do("POST", path, nil); r.Status != 200 {
		t.Fatalf("take over: %s", r)
	}
	// the card moved; the chat's own view now waits for Victor
	if ny := charles.Do("GET", "/app/v1/needs-you", nil); strings.Contains(string(ny.Body), v2.ReqID) {
		t.Fatalf("still on Charles's dashboard: %s", ny)
	}
	ny := victor.Do("GET", "/app/v1/needs-you", nil)
	if !strings.Contains(string(ny.Body), "Charles's chat invite for #shared (you made it yours)") {
		t.Fatalf("Victor's card: %s", ny)
	}
	if w := v2.Do(c, "POST", "/api/v1/join-requests/"+v2.ReqID+"/wait", map[string]any{"wait_s": 0}); w.Str("approver_name") != "Victor" || w.Str("approver_account") != victor.AccountID {
		t.Fatalf("wait view: %s", w)
	}
	// once only: nobody takes it again (not even Charles, who is in the room)
	if !noOffer(charles, path) {
		t.Fatal("offered twice")
	}
	if r := charles.Do("POST", path, nil); r.Status != 404 {
		t.Fatalf("taken over twice: %s", r)
	}
	// Charles can no longer approve it; Victor can, and it is Victor's chat
	if r := charles.Do("POST", "/app/v1/join-requests/"+v2.ReqID+"/reject", nil); r.Status != 404 {
		t.Fatalf("old addressee rejected it: %s", r)
	}
	if r := victor.Approve(room, v2); r.Status != 200 || r.Str("account_id") != victor.AccountID {
		t.Fatalf("approve as Victor: %s", r)
	}
	// a decided request is not offered
	if !noOffer(charles, path) {
		t.Fatal("decided request offered")
	}
}

// Security review item 5 / High "the human check falls to an agent that can drive the browser": the passkey step was
// skipped for 60 min after the last one and 5 min after sign-in, leaving only Turnstile. Every join approval now needs
// a fresh WebAuthn answer (a touch or a fingerprint: something an agent driving the browser can't do). Person and
// browser approvals keep their windows.
func TestEveryJoinApprovalNeedsPasskey(t *testing.T) {
	turnstile := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		_ = json.NewEncoder(w).Encode(map[string]any{"success": r.Form.Get("response") == "XXXX.DUMMY.TOKEN.XXXX"})
	}))
	defer turnstile.Close()
	c := StartCopy(t, NewDB(t), "A", func(cfg *config.Config) {
		cfg.HumanCheck = "real"
		cfg.TurnstileSiteKey = "1x00000000000000000000AA"
		cfg.TurnstileSecret = "1x0000000000000000000000000000000AA"
		cfg.TurnstileVerifyURL = turnstile.URL
	})
	adam := NewPerson(t, c, "Adam")
	room := adam.CreateRoom("uv")
	good := "XXXX.DUMMY.TOKEN.XXXX"
	pass := newSoftAuth("localhost", c.URL)
	approve := func(a *Agent, proof map[string]any) *Resp {
		adam.Sync(room)
		e := room.Log.Build("member_add", adam.Dev, map[string]any{"member": joinCardMember(t, adam, a.ReqID), "account": adam.AccountID, "name": a.Name,
			"app": "claude-code", "ed": a.Key.Hex(), "x": hexs(a.X)})
		r := adam.Do("POST", "/app/v1/join-requests/"+a.ReqID+"/approve", map[string]any{"human_check": proof, "roster_entry": e})
		if r.Status == 200 {
			room.Log.Push(e)
		}
		return r
	}
	join := func(name string) *Agent {
		a := NewAgentKeys(t, name)
		if r := a.Join(c, adam.Invite(room)); r.Status != 201 {
			t.Fatal(r)
		}
		return a
	}
	// 1. a fresh sign-in (< 5 min) is no longer enough: register a passkey in the same step
	a1 := join("one")
	ch := newCheck(t, adam, a1.ReqID)
	wa := ch["webauthn"].(map[string]any)
	if wa["step"] != "register" {
		t.Fatalf("fresh sign-in must not skip the passkey for a join approval: %v", wa)
	}
	if r := approve(a1, map[string]any{"id": ch["id"], "turnstile_token": good}); r.Code() != "human_check_failed" {
		t.Fatalf("join approved on Turnstile and a fresh sign-in alone: %s", r)
	}
	ch = newCheck(t, adam, a1.ReqID)
	if r := approve(a1, map[string]any{"id": ch["id"], "turnstile_token": good, "webauthn": pass.Register(ch["webauthn"].(map[string]any)["options"].(map[string]any))}); r.Status != 200 {
		t.Fatalf("approve with a new passkey: %s", r)
	}
	// 2. right after (uv fresh): the next join approval asks the passkey again
	a2 := join("two")
	ch = newCheck(t, adam, a2.ReqID)
	wa = ch["webauthn"].(map[string]any)
	if wa["step"] != "assert" {
		t.Fatalf("a passkey used a minute ago must be asked again for the next join: %v", wa)
	}
	if r := approve(a2, map[string]any{"id": ch["id"], "turnstile_token": good}); r.Code() != "human_check_failed" {
		t.Fatalf("join approved without a fresh passkey answer: %s", r)
	}
	ch = newCheck(t, adam, a2.ReqID)
	if r := approve(a2, map[string]any{"id": ch["id"], "turnstile_token": good, "webauthn": pass.Assert(ch["webauthn"].(map[string]any)["options"].(map[string]any), []byte(adam.AccountID))}); r.Status != 200 {
		t.Fatalf("approve with the passkey: %s", r)
	}
	// 3. other approvals keep their window (uv fresh → skip)
	if r := adam.Do("POST", "/app/v1/human-check", map[string]any{"action": "approve_device", "target_id": adam.DevID}); r.Status != 200 || r.J["webauthn"].(map[string]any)["step"] != "skip" {
		t.Fatalf("device approval with fresh uv: %s", r)
	}
}

// Security review 12 Nov 2026, Medium: login CSRF. The OAuth state was checked against the database only, so an
// attacker could start a sign-in in their own browser and hand the victim the callback URL: the victim would be signed
// into the attacker's account. The state is now bound to the browser that started the sign-in (a cookie). Also: a tab
// in return_to made "/\t/evil.example" pass the same-site check (browsers drop the tab: "//evil.example").
func TestLoginStateBoundToBrowser(t *testing.T) {
	codes := map[string]string{}
	var mu sync.Mutex
	fake := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/token":
			_ = r.ParseForm()
			mu.Lock()
			ch := codes[r.Form.Get("code")]
			mu.Unlock()
			if ch == "" || pkce(r.Form.Get("code_verifier")) != ch {
				w.WriteHeader(400)
				_, _ = w.Write([]byte(`{"error":"invalid_grant"}`))
				return
			}
			_, _ = w.Write([]byte(`{"access_token":"at-1","token_type":"bearer"}`))
		case "/user":
			_, _ = w.Write([]byte(`{"id":4243,"login":"mallory","name":"Mallory"}`))
		case "/user/emails":
			_, _ = w.Write([]byte(`[{"email":"mallory@evil.example","primary":true,"verified":true}]`))
		}
	}))
	defer fake.Close()
	c := StartCopy(t, NewDB(t), "A", func(cfg *config.Config) {
		cfg.GitHubClientID, cfg.GitHubSecret, cfg.GoogleClientID, cfg.GoogleSecret = "id", "sec", "gid", "sec"
	})
	setFakeEndpoints(c, fake.URL)
	noFollow := func() *http.Client {
		return &http.Client{Jar: newJar(), CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	}
	start := func(cl *http.Client, returnTo string) (state string) {
		res, err := cl.Get(c.URL + "/app/v1/auth/github/start?return_to=" + url.QueryEscape(returnTo))
		if err != nil || res.StatusCode != 302 {
			t.Fatalf("start: %v %v", err, res)
		}
		loc, _ := url.Parse(res.Header.Get("Location"))
		code := "code-" + newID()
		mu.Lock()
		codes[code] = loc.Query().Get("code_challenge")
		mu.Unlock()
		return "code=" + code + "&state=" + url.QueryEscape(loc.Query().Get("state"))
	}
	signedIn := func(cl *http.Client) bool {
		res, err := cl.Get(c.URL + "/app/v1/me")
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		return res.StatusCode == 200
	}
	// the attacker starts; the victim's browser (no state cookie) opens the callback: refused, not signed in
	attacker, victim := noFollow(), noFollow()
	q := start(attacker, "/rooms")
	res, err := victim.Get(c.URL + "/app/v1/auth/github/callback?" + q)
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != 400 || signedIn(victim) {
		t.Fatalf("callback from another browser signed it in: %d", res.StatusCode)
	}
	// the browser that started it signs in (and a tab in return_to does not leave the site)
	own := noFollow()
	q = start(own, "/\t/evil.example")
	res, err = own.Get(c.URL + "/app/v1/auth/github/callback?" + q)
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != 302 || !signedIn(own) {
		t.Fatalf("own browser: %d %s", res.StatusCode, res.Header.Get("Location"))
	}
	if loc := res.Header.Get("Location"); loc != "/rooms" {
		t.Fatalf("return_to with a tab redirected to %q", loc)
	}
}

// Security review, Low: no HSTS. Every response of a deployment with Secure cookies (staging, prod) carries it.
func TestHSTS(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A", func(cfg *config.Config) { cfg.Env = "staging" })
	for _, p := range []string{"/", "/api/v1/health", "/app/v1/auth/providers", "/healthz"} {
		r := doRaw(t, mustReq("GET", c.URL+p))
		if h := r.Header.Get("Strict-Transport-Security"); !strings.Contains(h, "max-age=31536000") {
			t.Errorf("GET %s: Strict-Transport-Security %q", p, h)
		}
	}
	d := StartCopy(t, NewDB(t), "B")
	if h := doRaw(t, mustReq("GET", d.URL+"/")).Header.Get("Strict-Transport-Security"); h != "" {
		t.Errorf("dev over plain http sent HSTS %q", h)
	}
}

// Security review 12 Nov 2026, High: the security page claimed what the code does not back. This keeps the truth pass:
// no "cannot add a chat / cannot pretend" (served dashboard code could sign an add, and the compared code is made by
// the server), no "open source" while the repository is private, the metadata list names folder, computer and IP,
// and the page says which promises code enforces and which the model is only told.
func TestSecurityPageTruth(t *testing.T) {
	b, err := os.ReadFile("../../web/public/security.html")
	if err != nil {
		t.Fatal(err)
	}
	page := strings.Join(strings.Fields(string(b)), " ") // one line: sentences wrap in the file
	for _, bad := range []string{"cannot add a chat", "cannot pretend", "are open source", "these specs are open source", "on the public repository", "are published under Apache-2.0"} {
		if strings.Contains(page, bad) {
			t.Errorf("security page still says %q", bad)
		}
	}
	for _, want := range []string{"folder", "computer name", "IP address", "Enforced by code", "The model is told to", "passkey"} {
		if !strings.Contains(page, want) {
			t.Errorf("security page lacks %q", want)
		}
	}
	// internal names, rot13-encoded so the names themselves are not spelled in this public file
	for _, internal := range rot13All("Pnera", "Rqvgu", "Snoyr", "yvtugfyvcf", "zbxh") {
		if strings.Contains(page, internal) {
			t.Errorf("security page names %q", internal)
		}
	}
}

// Security review 12 Nov 2026, Medium "wake and cost abuse" + review points 7 and 9. A member could wake another
// person's chat (a full resume, paid by its person) 30 times a minute; nothing let a person quiet one member or all of
// their chats. Now: a person mutes a member for their chats, pauses all their chats, and each sender has a wake budget
// per recipient. All three only stop WAKES: the messages still wait and are read on the chat's next turn.
func TestWakeControls(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A")
	adam := NewPerson(t, c, "Adam")
	eve := NewPerson(t, c, "Eve")
	room := adam.CreateRoom("wakes")
	addPerson(t, adam, eve, room)
	a := adam.Member(c, room, "mine")
	e := eve.Member(c, room, "loud")
	a.Drain(c)
	wakeCount := func() int {
		r := a.Do(c, "POST", "/api/v1/me/wait", map[string]any{"wait_s": 0, "peek": true})
		if r.Status != 200 {
			t.Fatalf("wait: %s", r)
		}
		return int(r.J["count"].(float64))
	}
	readable := func() int {
		r := a.Do(c, "GET", "/api/v1/me/inbox/count", nil)
		return int(r.J["available"].(float64))
	}
	send := func(from *Agent) {
		if _, r := from.Send(c, a); r.Status != 201 {
			t.Fatalf("send: %s", r)
		}
	}
	send(e)
	if n := wakeCount(); n != 1 {
		t.Fatalf("a normal message wakes: %d", n)
	}
	// 1. mute: Eve's member no longer wakes Adam's chats; its messages still wait
	if r := eve.Do("POST", "/app/v1/members/"+e.ID+"/mute", map[string]any{"muted": true}); r.Status != 404 && r.Status != 403 {
		t.Fatalf("muting your own chat: %s", r)
	}
	if r := adam.Do("POST", "/app/v1/members/"+e.ID+"/mute", map[string]any{"muted": true}); r.Status != 200 || r.J["muted"] != true {
		t.Fatalf("mute: %s", r)
	}
	if d := adam.Do("GET", "/app/v1/rooms/"+room.ID, nil); !strings.Contains(string(d.Body), `"muted_by_me":true`) {
		t.Fatalf("room page doesn't show the mute: %s", d)
	}
	if n := wakeCount(); n != 0 {
		t.Fatalf("muting quiets what that member already sent: %d", n)
	}
	send(e)
	if n := wakeCount(); n != 0 {
		t.Fatalf("a muted member's message woke the chat: %d", n)
	}
	if n := readable(); n != 2 {
		t.Fatalf("a muted member's message must still wait to be read: %d", n)
	}
	if r := adam.Do("POST", "/app/v1/members/"+e.ID+"/mute", map[string]any{"muted": false}); r.Status != 200 || r.J["muted"] != false {
		t.Fatalf("unmute: %s", r)
	}
	// 2. pause all my chats: nothing wakes them, including what already waits; the dashboard says so
	if r := adam.Do("POST", "/app/v1/me/pause", map[string]any{"paused": true}); r.Status != 200 || r.J["paused"] != true {
		t.Fatalf("pause: %s", r)
	}
	if me := adam.Do("GET", "/app/v1/me", nil); me.J["wakes_paused"] != true {
		t.Fatalf("me: %s", me)
	}
	if n := wakeCount(); n != 0 {
		t.Fatalf("a paused chat is still woken for what waited: %d", n)
	}
	send(e)
	if n := wakeCount(); n != 0 {
		t.Fatalf("a paused chat was woken: %d", n)
	}
	if n := readable(); n != 3 {
		t.Fatalf("paused chats still get their messages on their next turn: %d", n)
	}
	if r := adam.Do("POST", "/app/v1/me/pause", map[string]any{"paused": false}); r.Status != 200 || r.J["paused"] != false {
		t.Fatalf("unpause: %s", r)
	}
	// 3. wake budget: one sender wakes one recipient at most 20 times an hour; the rest wait for the next turn
	for i := 0; i < 22; i++ {
		send(e)
	}
	// (the very first message used one of the 20 before it was muted; muted and paused copies used none)
	if n := wakeCount(); n != 19 {
		t.Fatalf("wake budget: %d copies would wake, want 19", n)
	}
	if n := readable(); n != 25 {
		t.Fatalf("over the budget, copies still wait to be read: %d", n)
	}
	// 4. a member can't mute for the person through the agent API in a way that undoes the dashboard: mute only
	if r := a.Do(c, "PUT", "/api/v1/me/mutes/"+e.ID, nil); r.Status != 200 {
		t.Fatalf("agent mute: %s", r)
	}
	if r := adam.Do("GET", "/app/v1/rooms/"+room.ID, nil); !strings.Contains(string(r.Body), `"muted_by_me":true`) {
		t.Fatalf("agent mute not on the room page: %s", r)
	}
}

// Security review: join waits were uncapped per key (join.go:356-396): one key could hold many open waits.
func TestJoinWaitCap(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A")
	adam := NewPerson(t, c, "Adam")
	room := adam.CreateRoom("waits")
	a := NewAgentKeys(t, "waiter")
	if r := a.Join(c, adam.Invite(room)); r.Status != 201 {
		t.Fatal(r)
	}
	limited := false
	for i := 0; i < 40 && !limited; i++ {
		r := a.Do(c, "POST", "/api/v1/join-requests/"+a.ReqID+"/wait", map[string]any{"wait_s": 0})
		limited = r.Status == 429
	}
	if !limited {
		t.Fatal("40 join waits a minute from one key were all accepted")
	}
}

// Security review, Low: a leaked chat invite let anyone file a join request and read the room's purpose in the answer
// (join.go: the request view). Before approval the view gives the room name and who approves, not the purpose. And
// member names "bot-link" and "system" are taken: bot-link's own notes (wake tests, notices) speak under those words.
func TestJoinLeaksLessAndReservedNames(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A")
	adam := NewPerson(t, c, "Adam")
	room := adam.CreateRoom("leak")
	exec(t, c, `update rooms set purpose = 'Purposesecret launch plan' where id = $1`, room.ID)
	a := NewAgentKeys(t, "outsider")
	r := a.Join(c, adam.Invite(room))
	if r.Status != 201 || strings.Contains(string(r.Body), "Purposesecret") {
		t.Fatalf("pending join view shows the purpose: %s", r)
	}
	if w := a.Do(c, "POST", "/api/v1/join-requests/"+a.ReqID+"/wait", map[string]any{"wait_s": 0}); strings.Contains(string(w.Body), "Purposesecret") {
		t.Fatalf("pending wait view shows the purpose: %s", w)
	}
	if r := adam.Approve(room, a); r.Status != 200 {
		t.Fatal(r)
	}
	if w := a.Do(c, "POST", "/api/v1/join-requests/"+a.ReqID+"/wait", map[string]any{"wait_s": 0}); !strings.Contains(string(w.Body), "Purposesecret") {
		t.Fatalf("approved view should carry the purpose: %s", w)
	}
	for _, name := range []string{"system", "bot-link", "botlink"} {
		b := NewAgentKeys(t, name)
		if r := b.Join(c, adam.Invite(room)); r.Code() != "name_taken" || r.J["error"].(map[string]any)["details"].(map[string]any)["suggestion"] == name {
			t.Errorf("name %q: %s", name, r)
		}
	}
}

// Security review, Low: no way to revoke another browser's session. "Sign out other browsers" ends every session of
// the account but this one.
func TestSignOutOtherBrowsers(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A")
	adam := NewPerson(t, c, "Adam")
	// a second sign-in of the same account (another browser)
	other := NewPerson(t, c, "Adam")
	other.Email = adam.Email
	jar := newJar()
	other.Client = &http.Client{Jar: jar, Timeout: 30 * time.Second}
	if r := other.Do("POST", "/app/v1/auth/dev-login", map[string]any{"email": adam.Email, "display_name": "Adam"}); r.Status != 200 {
		t.Fatal(r)
	} else {
		other.CSRF = r.Str("csrf_token")
	}
	if r := other.Do("GET", "/app/v1/me", nil); r.Status != 200 {
		t.Fatalf("second browser: %s", r)
	}
	r := adam.Do("POST", "/app/v1/me/sessions/sign-out-others", nil)
	if r.Status != 200 || r.J["signed_out"] != float64(1) {
		t.Fatalf("sign out others: %s", r)
	}
	if r := other.Do("GET", "/app/v1/me", nil); r.Status != 401 {
		t.Fatalf("other browser still signed in: %s", r)
	}
	if r := adam.Do("GET", "/app/v1/me", nil); r.Status != 200 {
		t.Fatalf("this browser signed out too: %s", r)
	}
}

// Follow-up to the security review (owner, 12 Nov 2026): passkeys are the lock on join approvals, so adding and removing
// them is itself locked. Adding one when the account has one needs a fresh assertion with an existing passkey; the FIRST
// passkey (anywhere, an approval's register step included) needs a sign-in within 5 minutes plus Turnstile. Removing one
// needs an assertion with ANOTHER passkey of the account, and the last one can't be removed. A stolen session (an old
// sign-in, no passkey of its own) can do none of it.
func TestPasskeyAddRemoveAndStolenSession(t *testing.T) {
	turnstile := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		_ = json.NewEncoder(w).Encode(map[string]any{"success": r.Form.Get("response") == "XXXX.DUMMY.TOKEN.XXXX"})
	}))
	defer turnstile.Close()
	c := StartCopy(t, NewDB(t), "A", func(cfg *config.Config) {
		cfg.HumanCheck = "real"
		cfg.TurnstileSiteKey = "1x00000000000000000000AA"
		cfg.TurnstileSecret = "1x0000000000000000000000000000000AA"
		cfg.TurnstileVerifyURL = turnstile.URL
	})
	good := "XXXX.DUMMY.TOKEN.XXXX"
	adam := NewPerson(t, c, "Adam")
	room := adam.CreateRoom("keys")
	stale := func() {
		exec(t, c, `update web_sessions set created_at = now() - interval '10 minutes' where account_id = $1`, adam.AccountID)
	}
	fresh := func() { adam = reSignIn(t, adam) } // a fresh sign-in is a new sign-in
	start := func(action string) map[string]any {
		r := adam.Do("POST", "/app/v1/human-check", map[string]any{"action": action})
		if r.Status != 200 {
			t.Fatalf("human-check %s: %s", action, r)
		}
		return r.J
	}
	opts := func(ch map[string]any, k string) map[string]any {
		return ch[k].(map[string]any)["options"].(map[string]any)
	}
	k1, k2, thief := newSoftAuth("localhost", c.URL), newSoftAuth("localhost", c.URL), newSoftAuth("localhost", c.URL)
	thief.cross, thief.noUV = true, true

	// 1. a stolen session on an account with no passkey yet: the first passkey needs a fresh sign-in, at approval too
	stale()
	a := NewAgentKeys(t, "one")
	if r := a.Join(c, adam.Invite(room)); r.Status != 201 {
		t.Fatal(r)
	}
	ch := newCheck(t, adam, a.ReqID)
	adam.Sync(room)
	e := room.Log.Build("member_add", adam.Dev, map[string]any{"member": joinCardMember(t, adam, a.ReqID), "account": adam.AccountID, "name": a.Name,
		"app": "claude-code", "ed": a.Key.Hex(), "x": hexs(a.X)})
	r := adam.Do("POST", "/app/v1/join-requests/"+a.ReqID+"/approve", map[string]any{"human_check": map[string]any{"id": ch["id"], "turnstile_token": good,
		"webauthn": thief.Register(opts(ch, "webauthn"))}, "roster_entry": e})
	if r.Code() != "human_check_failed" || r.J["error"].(map[string]any)["details"].(map[string]any)["reason"] != "fresh_login_required" {
		t.Fatalf("a stale session registered the account's first passkey at approval: %s", r)
	}
	ch = start("webauthn_register")
	if r := adam.Do("POST", "/app/v1/me/passkeys", map[string]any{"human_check": map[string]any{"id": ch["id"], "turnstile_token": good, "webauthn": thief.Register(opts(ch, "webauthn"))}}); r.Code() != "human_check_failed" {
		t.Fatalf("a stale session added the first passkey: %s", r)
	}
	if n := count(t, c, `select count(*) from webauthn_credentials where account_id = $1`, adam.AccountID); n != 0 {
		t.Fatalf("credentials after refused tries: %d", n)
	}
	// 2. the owner, freshly signed in: first passkey (Turnstile still required)
	fresh()
	ch = start("webauthn_register")
	if ch["webauthn"].(map[string]any)["step"] != "register" {
		t.Fatalf("first passkey: %v", ch["webauthn"])
	}
	if r := adam.Do("POST", "/app/v1/me/passkeys", map[string]any{"human_check": map[string]any{"id": ch["id"], "webauthn": k1.Register(opts(ch, "webauthn"))}}); r.Code() != "human_check_failed" {
		t.Fatalf("first passkey without Turnstile: %s", r)
	}
	ch = start("webauthn_register")
	if r := adam.Do("POST", "/app/v1/me/passkeys", map[string]any{"human_check": map[string]any{"id": ch["id"], "turnstile_token": good, "webauthn": k1.Register(opts(ch, "webauthn"))}}); r.Status != 200 {
		t.Fatalf("first passkey: %s", r)
	}
	// 3. the thief (old sign-in) tries to add its own key next to it: an existing passkey must answer first
	stale()
	ch = start("webauthn_register")
	if ch["webauthn"].(map[string]any)["step"] != "assert" || ch["register"] == nil {
		t.Fatalf("adding with a passkey on the account must assert first: %v", ch)
	}
	if r := adam.Do("POST", "/app/v1/me/passkeys", map[string]any{"human_check": map[string]any{"id": ch["id"], "turnstile_token": good}, "credential": thief.Register(opts(ch, "register"))}); r.Code() != "human_check_failed" {
		t.Fatalf("thief added a passkey without an assertion: %s", r)
	}
	ch = start("webauthn_register")
	if r := adam.Do("POST", "/app/v1/me/passkeys", map[string]any{"human_check": map[string]any{"id": ch["id"], "turnstile_token": good, "webauthn": thief.Register(opts(ch, "register"))}, "credential": thief.Register(opts(ch, "register"))}); r.Code() != "human_check_failed" {
		t.Fatalf("thief passed a registration off as the assertion: %s", r)
	}
	if n := count(t, c, `select count(*) from webauthn_credentials where account_id = $1`, adam.AccountID); n != 1 {
		t.Fatalf("thief's key got in: %d credentials", n)
	}
	// 4. the owner adds a second passkey: assertion with k1, then the new credential
	ch = start("webauthn_register")
	r = adam.Do("POST", "/app/v1/me/passkeys", map[string]any{"human_check": map[string]any{"id": ch["id"], "turnstile_token": good,
		"webauthn": k1.Assert(opts(ch, "webauthn"), []byte(adam.AccountID))}, "credential": k2.Register(opts(ch, "register"))})
	if r.Status != 200 || len(r.J["passkeys"].([]any)) != 2 {
		t.Fatalf("second passkey: %s", r)
	}
	list := adam.Do("GET", "/app/v1/me/passkeys", nil)
	if list.Status != 200 || len(list.J["passkeys"].([]any)) != 2 {
		t.Fatalf("list: %s", list)
	}
	k1id, k2id := b64u(k1.credID), b64u(k2.credID)
	// 5. remove: never with the key being removed, never by another account, never the last one
	remove := func(p *Person, id string, with *softAuthenticator) *Resp {
		rc := p.Do("POST", "/app/v1/human-check", map[string]any{"action": "passkey_remove"})
		if rc.Status != 200 {
			return rc // e.g. 409 last_passkey: no check is even issued
		}
		proof := map[string]any{"id": rc.Str("id"), "turnstile_token": good}
		if wa, _ := rc.J["webauthn"].(map[string]any); with != nil && wa != nil && wa["options"] != nil {
			proof["webauthn"] = with.Assert(wa["options"].(map[string]any), []byte(p.AccountID))
		}
		return p.Do("POST", "/app/v1/me/passkeys/remove", map[string]any{"credential_id": id, "human_check": proof})
	}
	if r := remove(adam, k1id, k1); r.Code() != "human_check_failed" {
		t.Fatalf("a passkey vouched for its own removal: %s", r)
	}
	if r := remove(adam, k1id, nil); r.Code() != "human_check_failed" {
		t.Fatalf("removal without an assertion: %s", r)
	}
	eve := NewPerson(t, c, "Eve")
	if r := remove(eve, k1id, nil); r.Status != 404 && r.Code() != "human_check_failed" && r.Code() != "last_passkey" {
		t.Fatalf("another account removed Adam's passkey: %s", r)
	}
	if r := remove(adam, k1id, k2); r.Status != 200 || len(r.J["passkeys"].([]any)) != 1 {
		t.Fatalf("remove k1 with k2: %s", r)
	}
	if r := remove(adam, k2id, k2); r.Code() != "last_passkey" {
		t.Fatalf("the last passkey was removable: %s", r)
	}
	if n := count(t, c, `select count(*) from webauthn_credentials where account_id = $1`, adam.AccountID); n != 1 {
		t.Fatalf("credentials at the end: %d", n)
	}
}

// rot13All decodes rot13 strings (lists of forbidden internal names are kept encoded in public test files).
func rot13All(enc ...string) []string {
	out := make([]string, len(enc))
	for i, e := range enc {
		out[i] = strings.Map(func(r rune) rune {
			switch {
			case r >= 'a' && r <= 'z':
				return 'a' + (r-'a'+13)%26
			case r >= 'A' && r <= 'Z':
				return 'A' + (r-'A'+13)%26
			}
			return r
		}, e)
	}
	return out
}

// Founder report 16 Nov 2026: a chat whose session id changed between asking to join and waiting. The holder of the
// request's key moves its still pending join to the session it has now; the approved member is held by that session.
// Nobody else can move it, and a decided request never moves.
func TestJoinWaitMovesPendingSession(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A")
	adam := NewPerson(t, c, "Adam")
	room := adam.CreateRoom("moves")
	a := NewAgentKeys(t, "mover")
	if r := a.Join(c, adam.Invite(room)); r.Status != 201 {
		t.Fatal(r)
	}
	if r := a.Do(c, "POST", "/api/v1/join-requests/"+a.ReqID+"/wait", map[string]any{"wait_s": 0, "session_id": "bad session!"}); r.Status != 400 {
		t.Fatalf("an invalid session id is refused: %s", r)
	}
	other := NewAgentKeys(t, "other")
	if r := other.Do(c, "POST", "/api/v1/join-requests/"+a.ReqID+"/wait", map[string]any{"wait_s": 0, "session_id": "sess-thief"}); r.Status != 403 {
		t.Fatalf("another key can't move it: %s", r)
	}
	if n := count(t, c, `select count(*) from join_requests where id = $1 and session_id = 'sess-thief'`, a.ReqID); n != 0 {
		t.Fatal("moved by another key")
	}
	if r := a.Do(c, "POST", "/api/v1/join-requests/"+a.ReqID+"/wait", map[string]any{"wait_s": 0, "session_id": "sess-after-resume"}); r.Status != 200 || r.Str("status") != "pending" {
		t.Fatal(r)
	}
	if r := adam.Approve(room, a); r.Status != 200 {
		t.Fatal(r)
	}
	if n := count(t, c, `select count(*) from members where ed25519_pk = decode($1, 'hex') and holder_session = 'sess-after-resume'`, a.Key.Hex()); n != 1 {
		t.Fatal("the member is not held by the session that waited")
	}
	a.Do(c, "POST", "/api/v1/join-requests/"+a.ReqID+"/wait", map[string]any{"wait_s": 0, "session_id": "sess-later"})
	if n := count(t, c, `select count(*) from join_requests where id = $1 and session_id = 'sess-later'`, a.ReqID); n != 0 {
		t.Fatal("a decided request moved")
	}
}
