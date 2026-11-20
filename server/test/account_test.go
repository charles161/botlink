package test

import (
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/charles161/botlink/server/internal/config"
	"github.com/charles161/botlink/server/internal/roster"
	"github.com/charles161/botlink/server/internal/wire"
)

// Self-serve account export and delete (fix-all blocker 3). Dana is a person in Olive's room "shared" (with a chat,
// a queued copy and a pending join request), owns "solo" alone and "dshared" with Eve, and has asked to join Eve's room.

type acctWorld struct {
	c                *Copy
	olive, dana, eve *Person
	shared, solo     *Room
	dshared, everoom *Room
	helper, waiter   *Agent
	olivebot, evebot *Agent
	secretHex        string
	envelope         string
	personReq        string
}

func newAcctWorld(t *testing.T, mods ...func(*config.Config)) *acctWorld {
	t.Helper()
	w := &acctWorld{c: StartCopy(t, NewDB(t), "A", append([]func(*config.Config){noWait}, mods...)...)}
	c := w.c
	w.olive, w.dana, w.eve = NewPerson(t, c, "Olive"), NewPerson(t, c, "Dana"), NewPerson(t, c, "Eve")
	w.shared = w.olive.CreateRoom("shared")
	addPerson(t, w.olive, w.dana, w.shared)
	w.helper = w.dana.Member(c, w.shared, "helper")
	w.olivebot = w.olive.Member(c, w.shared, "olivebot")
	w.waiter = NewAgentKeys(t, "waiter")
	if r := w.waiter.Join(c, w.dana.Invite(w.shared)); r.Status != 201 {
		t.Fatalf("waiter join: %s", r)
	}
	w.solo = w.dana.CreateRoom("solo")
	w.dana.Member(c, w.solo, "solo-bot")
	w.dshared = w.dana.CreateRoom("dshared")
	addPerson(t, w.dana, w.eve, w.dshared)
	w.evebot = w.eve.Member(c, w.dshared, "evebot")
	w.everoom = w.eve.CreateRoom("everoom")
	pi := w.eve.Do("POST", "/app/v1/rooms/"+w.everoom.ID+"/person-invites", map[string]any{"id": newID()})
	code := pi.Str("url")[strings.LastIndex(pi.Str("url"), "/")+1:]
	acc := w.dana.Do("POST", "/app/v1/person-invites/"+code+"/accept", map[string]any{"device_id": w.dana.DevID})
	if acc.Status != 201 {
		t.Fatalf("accept: %s", acc)
	}
	w.personReq = acc.Str("id")
	// a queued copy for Dana's chat, a wake subscription with a secret, a passkey (public part)
	if _, r := w.olivebot.Send(c, w.helper); r.Status != 201 && r.Status != 200 {
		t.Fatalf("send: %s", r)
	}
	if err := c.Pool.QueryRow(t.Context(), `select envelope from deliveries where member_id = $1`, w.helper.ID).Scan(&w.envelope); err != nil {
		t.Fatal(err)
	}
	secret := wire.RandBytes(32)
	w.secretHex = hex.EncodeToString(secret)
	exec(t, c, `insert into event_subscriptions (id, member_id, key_epoch, url, name, secret, expires_at, verified_at)
		values ('sub_0123456789abcdef01234567', $1, 1, 'https://hooks.example/dana', 'message.received', $2, now() + interval '1 day', now())`, w.helper.ID, secret)
	exec(t, c, `insert into webauthn_credentials (id, account_id, public_key, transports) values ($1, $2, $3, '{internal}')`,
		[]byte("dana-cred-1"), w.dana.AccountID, []byte("dana-public-key"))
	return w
}

// The export with the paywall on has the plan section (with it off: TestFreeNothingRefusedForAPlan).
func TestAccountExport(t *testing.T) {
	w := newAcctWorld(t, paywallOn)
	r := w.dana.Do("GET", "/app/v1/me/export", nil)
	if r.Status != 200 {
		t.Fatalf("export: %s", r)
	}
	if cd := r.Header.Get("Content-Disposition"); !strings.HasPrefix(cd, "attachment;") || !strings.Contains(cd, ".json") {
		t.Errorf("Content-Disposition: %q", cd)
	}
	body := string(r.Body)
	acct, _ := r.J["account"].(map[string]any)
	if acct["email"] != w.dana.Email || acct["id"] != w.dana.AccountID {
		t.Errorf("account: %v", acct)
	}
	for _, want := range []string{w.shared.ID, w.solo.ID, w.dshared.ID, w.helper.ID, w.waiter.ReqID, w.personReq, w.dana.DevID,
		"https://hooks.example/dana"} {
		if !strings.Contains(body, want) {
			t.Errorf("export lacks %q", want)
		}
	}
	// the passkey's public part, as base64url
	if !strings.Contains(body, "ZGFuYS1wdWJsaWMta2V5") {
		t.Error("export lacks the passkey's public key")
	}
	for _, sec := range []string{"plan", "sessions", "browsers", "passkeys", "rooms", "chats", "join_requests", "person_requests",
		"wake", "messages", "events", "limit_counters", "notes"} {
		if _, ok := r.J[sec]; !ok {
			t.Errorf("export has no %q section", sec)
		}
	}
	// no secrets, no sealed bytes, no other people's email addresses
	for _, bad := range []string{w.secretHex, w.envelope, w.olive.Email, w.eve.Email, w.dana.CSRF, "csrf", "token_hash", "push_secret\":", "\"secret\":", "\"challenge\":"} {
		if strings.Contains(body, bad) {
			t.Errorf("export contains %q", trunc([]byte(bad)))
		}
	}
	// sealed copies: counts and sizes, not bytes
	msgs, _ := r.J["messages"].(map[string]any)
	var copies, bytes float64
	for _, x := range msgs["per_chat"].([]any) {
		m := x.(map[string]any)
		if m["chat_id"] == w.helper.ID {
			copies, bytes = m["sealed_copies_stored"].(float64), m["sealed_bytes_stored"].(float64)
		}
	}
	if copies != 1 || bytes < 10 {
		t.Errorf("helper's stored copies: %v copies, %v bytes", copies, bytes)
	}
	// Eve's export knows nothing of Dana's address
	er := w.eve.Do("GET", "/app/v1/me/export", nil)
	if er.Status != 200 || strings.Contains(string(er.Body), w.dana.Email) || !strings.Contains(string(er.Body), w.eve.Email) {
		t.Errorf("eve export: %d", er.Status)
	}
	// signed out: 401
	anon := &http.Client{Timeout: 10 * time.Second}
	res, err := anon.Get(w.c.URL + "/app/v1/me/export")
	if err != nil || res.StatusCode != 401 {
		t.Errorf("anonymous export: %v %v", err, res)
	}
}

// noWait: a dev server whose account deletes need no wait (BOTLINK_ACCOUNT_DELETE_DELAY=0), for tests of what a finished
// delete does. The wait itself is tested in account_wait_test.go.
func noWait(cfg *config.Config) { cfg.AccountDeleteNoWait = true }

// askDelete asks to delete p's account (stub human check) and expects the ask to be recorded.
func askDelete(t *testing.T, p *Person) {
	t.Helper()
	r := p.Do("POST", "/app/v1/me/delete/ask", map[string]any{"confirm": p.Email, "human_check": map[string]any{"id": p.Check("account_delete", ""), "stub": true}})
	if r.Status != 201 {
		t.Fatalf("ask to delete: %s", r)
	}
}

func deleteBody(email, check string, entries ...map[string]any) map[string]any {
	b := map[string]any{"confirm": email, "entries": entries}
	if entries == nil {
		b["entries"] = []any{}
	}
	if check != "" {
		b["human_check"] = map[string]any{"id": check, "stub": true}
	}
	return b
}

func TestAccountDelete(t *testing.T) {
	w := newAcctWorld(t)
	c, olive, dana, eve := w.c, w.olive, w.dana, w.eve

	// a second sign-in of Dana (another browser)
	jar, _ := cookiejar.New(nil)
	dana2 := &Person{t: t, C: c, Client: &http.Client{Jar: jar, Timeout: 30 * time.Second}, Name: "Dana", Email: dana.Email}
	if r := dana2.Do("POST", "/app/v1/auth/dev-login", map[string]any{"email": dana.Email}); r.Status != 200 {
		t.Fatalf("second sign-in: %s", r)
	}

	// what deleting would do, as this browser sees it
	plan := dana.Do("GET", "/app/v1/me/delete?device_id="+dana.DevID, nil)
	if plan.Status != 200 || plan.J["confirm_text"] != dana.Email {
		t.Fatalf("plan: %s", plan)
	}
	joined := plan.J["joined_rooms"].([]any)
	if len(joined) != 1 || joined[0].(map[string]any)["id"] != w.shared.ID || joined[0].(map[string]any)["can_sign"] != true {
		t.Errorf("joined rooms: %v", joined)
	}
	owned := map[string]float64{}
	for _, x := range plan.J["owned_rooms"].([]any) {
		owned[x.(map[string]any)["name"].(string)] = x.(map[string]any)["other_people"].(float64)
	}
	if len(owned) != 2 || owned["solo"] != 0 || owned["dshared"] != 1 {
		t.Errorf("owned rooms: %v", owned)
	}

	olivePeople := count(t, c, `select count(*) from devices where account_id = $1`, olive.AccountID)
	dana.Sync(w.shared)
	leave := w.shared.Log.Build("person_remove", dana.Dev, map[string]any{"account": dana.AccountID})
	entry := map[string]any{"room_id": w.shared.ID, "roster_entry": leave}

	// finishing without an ask is refused; then Dana asks (no wait on this server)
	if r := dana.Do("POST", "/app/v1/me/delete", deleteBody(dana.Email, dana.Check("account_delete", ""), entry)); r.Code() != "delete_not_asked" {
		t.Errorf("finish without an ask: %s", r)
	}
	askDelete(t, dana)
	askDelete(t, eve)
	// refused: no human check, a check of another action, another account's check, the wrong typed confirmation
	if r := dana.Do("POST", "/app/v1/me/delete", deleteBody(dana.Email, "", entry)); r.Status != 403 || r.Code() != "human_check_failed" {
		t.Errorf("no human check: %s", r)
	}
	if r := dana.Do("POST", "/app/v1/me/delete", deleteBody(dana.Email, dana.Check("webauthn_register", ""), entry)); r.Status != 403 {
		t.Errorf("check of another action: %s", r)
	}
	hc := dana.Check("account_delete", "")
	if r := eve.Do("POST", "/app/v1/me/delete", deleteBody(eve.Email, hc)); r.Status != 403 || r.Code() != "human_check_failed" {
		t.Errorf("eve with dana's check: %s", r)
	}
	if r := dana.Do("POST", "/app/v1/me/delete", deleteBody("someone@else.example", hc, entry)); r.Status != 400 {
		t.Errorf("wrong confirmation: %s", r)
	}
	// every room Dana is a person in needs her signed leave
	if r := dana.Do("POST", "/app/v1/me/delete", deleteBody(dana.Email, hc)); r.Status != 409 || r.Code() != "roster_conflict" {
		t.Errorf("missing leave entry: %s", r)
	}
	// a leave signed by someone else's browser is refused (Olive's key, Dana's name on it)
	forged := w.shared.Log.Build("person_remove", olive.Dev, map[string]any{"account": dana.AccountID})
	if r := dana.Do("POST", "/app/v1/me/delete", deleteBody(dana.Email, hc, map[string]any{"room_id": w.shared.ID, "roster_entry": forged})); r.Status != 403 || r.Code() != "not_signer" {
		t.Errorf("leave signed by another browser: %s", r)
	}
	if count(t, c, `select count(*) from accounts where id = $1 and deleted_at is null`, dana.AccountID) != 1 {
		t.Fatal("a refused delete changed the account")
	}

	// the member list moves under us (Olive removes her own chat): 409, then re-signed with the same human check
	olive.Sync(w.shared)
	rm := w.shared.Log.Build("member_remove", olive.Dev, map[string]any{"member": w.olivebot.ID})
	if r := olive.Do("POST", "/app/v1/rooms/"+w.shared.ID+"/roster", map[string]any{"roster_entry": rm}); r.Status != 200 {
		t.Fatalf("olive remove: %s", r)
	}
	if r := dana.Do("POST", "/app/v1/me/delete", deleteBody(dana.Email, hc, entry)); r.Status != 409 || r.Code() != "roster_conflict" {
		t.Fatalf("stale leave: %s", r)
	}
	// open waits: the waiting chat's join wait and Dana's chat's inbox poll, held across the delete
	joinWait := make(chan *Resp, 1)
	go func() {
		joinWait <- w.waiter.Do(c, "POST", "/api/v1/join-requests/"+w.waiter.ReqID+"/wait", map[string]any{"wait_s": 20})
	}()
	w.helper.Drain(c)
	if lr := w.helper.Lease(c, 0); len(deliveries(lr)) != 1 { // take the waiting copy's lease, so the next poll waits
		t.Fatalf("lease: %s", lr)
	}
	poll := make(chan *Resp, 1)
	go func() { poll <- w.helper.Lease(c, 20) }()
	time.Sleep(300 * time.Millisecond)
	dana.Sync(w.shared)
	leave = w.shared.Log.Build("person_remove", dana.Dev, map[string]any{"account": dana.AccountID})
	r := dana.Do("POST", "/app/v1/me/delete", deleteBody(strings.ToUpper(dana.Email), hc, map[string]any{"room_id": w.shared.ID, "roster_entry": leave}))
	if r.Status != 200 || r.J["deleted"] != true {
		t.Fatalf("delete: %s", r)
	}
	if r.J["rooms_left"].(float64) != 1 || r.J["rooms_deleted"].(float64) != 2 {
		t.Errorf("delete result: %s", r)
	}
	for name, ch := range map[string]chan *Resp{"join wait": joinWait, "inbox poll": poll} {
		select {
		case got := <-ch:
			if name == "join wait" && got.Str("status") != "cancelled" || name == "inbox poll" && got.Status != 410 {
				t.Errorf("%s after delete: %s", name, got)
			}
		case <-time.After(5 * time.Second):
			t.Errorf("%s still open after delete", name)
		}
	}

	// sessions dead (this one and the other browser)
	if r := dana.Do("GET", "/app/v1/me", nil); r.Status != 401 {
		t.Errorf("deleted session: %s", r)
	}
	if r := dana2.Do("GET", "/app/v1/me", nil); r.Status != 401 {
		t.Errorf("other session of the deleted account: %s", r)
	}
	// rows gone or anonymised
	for _, q := range []string{
		`select count(*) from identities where account_id = $1`,
		`select count(*) from web_sessions where account_id = $1`,
		`select count(*) from devices where account_id = $1`,
		`select count(*) from webauthn_credentials where account_id = $1`,
		`select count(*) from human_checks where account_id = $1`,
		`select count(*) from attention where account_id = $1`,
		`select count(*) from rooms where owner_account_id = $1 and deleted_at is null`,
		`select count(*) from members where account_id = $1 and (removed_at is null or job <> '' or folder <> '' or machine <> '')`,
		`select count(*) from event_subscriptions s join members m on m.id = s.member_id where m.account_id = $1`,
		`select count(*) from deliveries d join members m on m.id = d.member_id where m.account_id = $1 and d.envelope is not null`,
		`select count(*) from join_requests where for_account_id = $1 and (status = 'pending' or job <> '' or folder <> '')`,
		`select count(*) from person_requests where account_id = $1 and status = 'pending'`,
		`select count(*) from accounts where id = $1 and (email = '` + dana.Email + `' or display_name = 'Dana' or deleted_at is null)`,
	} {
		if n := count(t, c, q, dana.AccountID); n != 0 {
			t.Errorf("%d rows left: %s", n, q)
		}
	}
	if count(t, c, `select count(*) from rooms where id = $1`, w.solo.ID) != 0 {
		t.Error("the room only Dana was in is still stored")
	}
	if count(t, c, `select count(*) from rooms where id = $1 and deleted_at is not null`, w.dshared.ID) != 1 {
		t.Error("the room Dana shared with Eve is not deleted for Eve")
	}

	// Olive's room still verifies, without Dana; her chat reads it too
	rr := olive.Do("GET", "/app/v1/rooms/"+w.shared.ID+"/roster", nil)
	var ws []roster.Wire
	_ = json.Unmarshal(mustJSON(rr.J["entries"]), &ws)
	st, err := roster.Replay(w.shared.ID, ws)
	if err != nil || st.ActivePerson(dana.AccountID) || !st.ActivePerson(olive.AccountID) {
		t.Fatalf("shared roster after delete: %v", err)
	}
	if d := olive.Do("GET", "/app/v1/rooms/"+w.shared.ID, nil); d.Status != 200 || len(d.J["people"].([]any)) != 1 {
		t.Errorf("shared room people: %s", d)
	}
	// Dana's chats are gone; their names (and the pending request's) are free again
	if r := w.helper.Do(c, "GET", "/api/v1/me", nil); r.Status != 410 {
		t.Errorf("deleted account's chat: %s", r)
	}
	for _, name := range []string{"helper", "waiter"} {
		a := NewAgentKeys(t, name)
		if r := a.Join(c, olive.Invite(w.shared)); r.Status != 201 {
			t.Errorf("name %s not freed: %s", name, r)
		}
	}
	// Eve: the room Dana owned is gone for her chat; Dana's request to Eve's room no longer waits; Eve's room is fine
	if r := w.evebot.Do(c, "GET", "/api/v1/me", nil); r.Status != 410 || r.Code() != "room_gone" {
		t.Errorf("eve's chat in dana's room: %s", r)
	}
	ny := eve.Do("GET", "/app/v1/needs-you", nil)
	if len(ny.J["person_requests"].([]any)) != 0 {
		t.Errorf("eve still sees dana's request: %s", ny)
	}
	if r := eve.Do("GET", "/app/v1/rooms/"+w.everoom.ID, nil); r.Status != 200 {
		t.Errorf("eve's room: %s", r)
	}
	// Olive untouched
	if r := olive.Do("GET", "/app/v1/me", nil); r.Status != 200 {
		t.Errorf("olive: %s", r)
	}
	if count(t, c, `select count(*) from devices where account_id = $1`, olive.AccountID) != olivePeople ||
		count(t, c, `select count(*) from accounts where id = $1 and deleted_at is null and email = $2`, olive.AccountID, olive.Email) != 1 {
		t.Error("olive's rows changed")
	}
	// the same address can sign up again: a new, empty account
	jar3, _ := cookiejar.New(nil)
	dana3 := &Person{t: t, C: c, Client: &http.Client{Jar: jar3, Timeout: 30 * time.Second}, Email: dana.Email}
	lr := dana3.Do("POST", "/app/v1/auth/dev-login", map[string]any{"email": dana.Email})
	if lr.Status != 200 || lr.J["account"].(map[string]any)["id"] == dana.AccountID {
		t.Fatalf("sign up again: %s", lr)
	}
	if rs := dana3.Do("GET", "/app/v1/rooms", nil); len(rs.J["rooms"].([]any)) != 0 {
		t.Errorf("new account sees rooms: %s", rs)
	}
}

func TestAccountDeleteNeedsSigner(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A", noWait)
	olive, dana := NewPerson(t, c, "Olive"), NewPerson(t, c, "Dana")
	room := olive.CreateRoom("shared")
	addPerson(t, olive, dana, room)
	// a second browser of Dana that was never approved in Olive's room
	other := Person{t: t, C: c, Client: dana.Client, CSRF: dana.CSRF, AccountID: dana.AccountID, Dev: NewAgentKeys(t, "x").Key, DevID: newID()}
	if r := other.Do("POST", "/app/v1/devices", map[string]any{"id": other.DevID, "ed25519_pk": other.Dev.Hex(), "label": "Dana's laptop"}); r.Status != 201 {
		t.Fatal(r)
	}
	plan := dana.Do("GET", "/app/v1/me/delete?device_id="+other.DevID, nil)
	if j := plan.J["joined_rooms"].([]any); len(j) != 1 || j[0].(map[string]any)["can_sign"] != false {
		t.Errorf("unapproved browser plan: %s", plan)
	}
	askDelete(t, dana)
	dana.Sync(room)
	e := room.Log.Build("person_remove", other.Dev, map[string]any{"account": dana.AccountID})
	r := dana.Do("POST", "/app/v1/me/delete", deleteBody(dana.Email, dana.Check("account_delete", ""), map[string]any{"room_id": room.ID, "roster_entry": e}))
	if r.Status != 403 || r.Code() != "not_signer" {
		t.Errorf("unapproved browser's leave: %s", r)
	}
	if count(t, c, `select count(*) from accounts where id = $1 and deleted_at is null`, dana.AccountID) != 1 {
		t.Error("account changed")
	}
}

func TestAccountDeletePaidPlan(t *testing.T) {
	c := startPaid(t, NewDB(t), "A", noWait)
	dana := NewPerson(t, c, "Dana")
	exec(t, c, `insert into account_billing (account_id, plan_id, paid_until, status, gateway, customer_id, subscription_id)
		values ($1, 'pro', now() + interval '20 days', 'active', 'fake', 'cus_1', 'sub_1')`, dana.AccountID)
	if p := dana.Do("GET", "/app/v1/me/delete", nil); p.J["plan_renews"] != true {
		t.Errorf("plan: %s", p)
	}
	r := dana.Do("POST", "/app/v1/me/delete/ask", map[string]any{"confirm": dana.Email, "human_check": map[string]any{"id": dana.Check("account_delete", ""), "stub": true}})
	if r.Status != 409 || r.Code() != "plan_renews" {
		t.Fatalf("ask to delete with a renewing plan: %s", r)
	}
	exec(t, c, `update account_billing set cancel_at_period_end = true where account_id = $1`, dana.AccountID)
	askDelete(t, dana)
	exec(t, c, `update account_billing set cancel_at_period_end = false where account_id = $1`, dana.AccountID)
	if r := dana.Do("POST", "/app/v1/me/delete", deleteBody(dana.Email, dana.Check("account_delete", ""))); r.Code() != "plan_renews" {
		t.Fatalf("finish with a renewing plan: %s", r)
	}
	exec(t, c, `update account_billing set cancel_at_period_end = true where account_id = $1`, dana.AccountID)
	if r := dana.Do("POST", "/app/v1/me/delete", deleteBody(dana.Email, dana.Check("account_delete", ""))); r.Status != 200 {
		t.Fatalf("delete after cancelling: %s", r)
	}
	// payment records stay, tied to the anonymised account
	if count(t, c, `select count(*) from account_billing b join accounts a on a.id = b.account_id where b.account_id = $1 and a.deleted_at is not null`, dana.AccountID) != 1 {
		t.Error("payment record not kept")
	}
}

func TestAccountRateLimits(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A")
	dana := NewPerson(t, c, "Dana")
	var last *Resp
	for i := 0; i < 6; i++ {
		last = dana.Do("GET", "/app/v1/me/export", nil)
	}
	if last.Status != 429 {
		t.Errorf("6th export in an hour: %s", last)
	}
	for i := 0; i < 11; i++ {
		last = dana.Do("POST", "/app/v1/me/delete", deleteBody("wrong@example.com", ""))
	}
	if last.Status != 429 {
		t.Errorf("11th delete try in an hour: %s", last)
	}
}

// Real human check: delete asks for a passkey every time (no skip while uv is fresh); an account with no passkey
// registers its first one in the same step, which needs a sign-in within 5 minutes.
func TestAccountDeleteRealPasskey(t *testing.T) {
	turnstile := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true})
	}))
	defer turnstile.Close()
	c := StartCopy(t, NewDB(t), "A", func(cfg *config.Config) {
		cfg.HumanCheck = "real"
		cfg.TurnstileSiteKey = "1x00000000000000000000AA"
		cfg.TurnstileSecret = "1x0000000000000000000000000000000AA"
		cfg.TurnstileVerifyURL = turnstile.URL
		cfg.AccountDeleteNoWait = true
	})
	start := func(p *Person) (string, map[string]any) {
		r := p.Do("POST", "/app/v1/human-check", map[string]any{"action": "account_delete"})
		if r.Status != 200 {
			t.Fatalf("check: %s", r)
		}
		return r.Str("id"), r.J["webauthn"].(map[string]any)
	}
	ask := func(p *Person, proof map[string]any) *Resp {
		return p.Do("POST", "/app/v1/me/delete/ask", map[string]any{"confirm": p.Email, "human_check": proof})
	}
	del := func(p *Person, proof map[string]any) *Resp {
		return p.Do("POST", "/app/v1/me/delete", map[string]any{"confirm": p.Email, "human_check": proof, "entries": []any{}})
	}

	// Eve has a passkey and used it a moment ago (uv fresh): delete still asks for it
	eve := NewPerson(t, c, "Eve")
	key := newSoftAuth("localhost", c.URL)
	r := eve.Do("POST", "/app/v1/human-check", map[string]any{"action": "webauthn_register"})
	if r := eve.Do("POST", "/app/v1/me/passkeys", map[string]any{"human_check": map[string]any{"id": r.Str("id"), "turnstile_token": "t",
		"webauthn": key.Register(r.J["webauthn"].(map[string]any)["options"].(map[string]any))}}); r.Status != 200 {
		t.Fatalf("first passkey: %s", r)
	}
	id, wa := start(eve)
	if wa["step"] != "assert" {
		t.Fatalf("delete with uv fresh must assert, got %v", wa["step"])
	}
	if r := ask(eve, map[string]any{"id": id, "turnstile_token": "t"}); r.Status != 403 || r.Code() != "human_check_failed" {
		t.Fatalf("ask without the passkey: %s", r)
	}
	if r := ask(eve, map[string]any{"id": id, "turnstile_token": "t", "webauthn": key.Assert(wa["options"].(map[string]any), []byte(eve.AccountID))}); r.Status != 201 {
		t.Fatalf("ask with the passkey: %s", r)
	}
	// the finish asks for the passkey again
	id, wa = start(eve)
	if r := del(eve, map[string]any{"id": id, "turnstile_token": "t"}); r.Status != 403 || r.Code() != "human_check_failed" {
		t.Fatalf("finish without the passkey: %s", r)
	}
	if r := del(eve, map[string]any{"id": id, "turnstile_token": "t", "webauthn": key.Assert(wa["options"].(map[string]any), []byte(eve.AccountID))}); r.Status != 200 {
		t.Fatalf("finish with the passkey: %s", r)
	}

	// Finn never set up a passkey: a sign-in older than 5 minutes is refused, a fresh one registers and deletes
	finn := NewPerson(t, c, "Finn")
	exec(t, c, `update web_sessions set created_at = now() - interval '10 minutes' where account_id = $1`, finn.AccountID)
	fk := newSoftAuth("localhost", c.URL)
	id, wa = start(finn)
	if wa["step"] != "register" {
		t.Fatalf("no passkey: step %v", wa["step"])
	}
	r = ask(finn, map[string]any{"id": id, "turnstile_token": "t", "webauthn": fk.Register(wa["options"].(map[string]any))})
	if r.Status != 403 || r.J["error"].(map[string]any)["details"].(map[string]any)["reason"] != "fresh_login_required" {
		t.Fatalf("stale sign-in, no passkey: %s", r)
	}
	finn = reSignIn(t, finn) // a fresh sign-in is a new sign-in
	id, wa = start(finn)
	if r := ask(finn, map[string]any{"id": id, "turnstile_token": "t", "webauthn": fk.Register(wa["options"].(map[string]any))}); r.Status != 201 {
		t.Fatalf("fresh sign-in, no passkey: %s", r)
	}
	// the ask set up Finn's first passkey: the finish asserts it
	id, wa = start(finn)
	if wa["step"] != "assert" {
		t.Fatalf("finish after the first passkey: step %v", wa["step"])
	}
	if r := del(finn, map[string]any{"id": id, "turnstile_token": "t", "webauthn": fk.Assert(wa["options"].(map[string]any), []byte(finn.AccountID))}); r.Status != 200 {
		t.Fatalf("finish: %s", r)
	}
	if count(t, c, `select count(*) from webauthn_credentials where account_id = $1`, finn.AccountID) != 0 {
		t.Error("the passkey made during the delete is still stored")
	}
}
