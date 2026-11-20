package test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/charles161/botlink/server/internal/appapi"
	"github.com/charles161/botlink/server/internal/config"
	"github.com/charles161/botlink/server/internal/roster"
	"github.com/charles161/botlink/server/internal/testkit"
	"github.com/charles161/botlink/server/internal/wire"
)

// Lost passkey / lost laptop (prod-readiness blocker 5). Read as an attacker would: a reset is the easiest way around
// the passkey, so it needs a fresh sign-in, waits (72 h by default), is shown on every dashboard of the account, can be
// cancelled by any passkey or by a sign-in older than the request, is bound to the browser that asked, and swaps the
// passkeys in one step: the account never has zero passkeys and approvals never work without one.

const goodTS = "XXXX.DUMMY.TOKEN.XXXX"

func realCopy(t *testing.T, mods ...func(*config.Config)) *Copy {
	t.Helper()
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		_ = json.NewEncoder(w).Encode(map[string]any{"success": r.Form.Get("response") == goodTS})
	}))
	t.Cleanup(ts.Close)
	return StartCopy(t, NewDB(t), "A", append([]func(*config.Config){func(cfg *config.Config) {
		cfg.HumanCheck = "real"
		cfg.TurnstileSiteKey = "1x00000000000000000000AA"
		cfg.TurnstileSecret = "1x0000000000000000000000000000000AA"
		cfg.TurnstileVerifyURL = ts.URL
	}}, mods...)...)
}

// signInAgain is the same person signing in from another browser: its own session (cookie jar) and device key.
func signInAgain(t *testing.T, p *Person, label string) *Person {
	t.Helper()
	q := *p
	q.Client = &http.Client{Jar: newJar(), Timeout: 30 * time.Second}
	r := q.Do("POST", "/app/v1/auth/dev-login", map[string]any{"email": p.Email, "display_name": p.Name})
	if r.Status != 200 {
		t.Fatalf("sign in again: %s", r)
	}
	q.CSRF = r.Str("csrf_token")
	q.Dev = testkit.NewKey()
	q.DevID = newID()
	if r := q.Do("POST", "/app/v1/devices", map[string]any{"id": q.DevID, "ed25519_pk": q.Dev.Hex(), "label": label}); r.Status != 201 {
		t.Fatalf("register %s: %s", label, r)
	}
	return &q
}

func opt(ch map[string]any, k string) map[string]any {
	return ch[k].(map[string]any)["options"].(map[string]any)
}

func step(ch map[string]any) any { return ch["webauthn"].(map[string]any)["step"] }

// addFirstPasskey registers k as p's first passkey (needs a fresh sign-in).
func addFirstPasskey(t *testing.T, c *Copy, p *Person, k *softAuthenticator) {
	t.Helper()
	ch := p.Do("POST", "/app/v1/human-check", map[string]any{"action": "webauthn_register"})
	if ch.Status != 200 || step(ch.J) != "register" {
		t.Fatalf("first passkey check: %s", ch)
	}
	if r := p.Do("POST", "/app/v1/me/passkeys", map[string]any{"human_check": map[string]any{"id": ch.Str("id"), "turnstile_token": goodTS,
		"webauthn": k.Register(opt(ch.J, "webauthn"))}}); r.Status != 200 {
		t.Fatalf("first passkey: %s", r)
	}
}

type fakeMail struct {
	mu   sync.Mutex
	sent []appapi.RecoveryNotice
}

func (f *fakeMail) Send(_ context.Context, n appapi.RecoveryNotice) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.sent = append(f.sent, n)
	return nil
}

func (f *fakeMail) kinds() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []string
	for _, n := range f.sent {
		out = append(out, n.Kind)
	}
	return out
}

func resetState(t *testing.T, p *Person) map[string]any {
	t.Helper()
	r := p.Do("GET", "/app/v1/me/passkey-reset", nil)
	if r.Status != 200 {
		t.Fatalf("reset state: %s", r)
	}
	return r.J
}

func pending(t *testing.T, p *Person) map[string]any {
	t.Helper()
	v, _ := resetState(t, p)["reset"].(map[string]any)
	return v
}

func resetCheck(t *testing.T, p *Person, action string) *Resp {
	t.Helper()
	return p.Do("POST", "/app/v1/me/passkey-reset/check", map[string]any{"action": action})
}

func TestPasskeyResetStateMachine(t *testing.T) {
	c := realCopy(t)
	mail := &fakeMail{}
	c.S.App.Mail = mail
	adam := NewPerson(t, c, "Adam") // his everyday browser (it signed in long ago)
	room := adam.CreateRoom("lost")
	k1, k2, thief := newSoftAuth("localhost", c.URL), newSoftAuth("localhost", c.URL), newSoftAuth("localhost", c.URL)
	addFirstPasskey(t, c, adam, k1)
	exec(t, c, `update web_sessions set created_at = now() - interval '3 days', uv_at = null where account_id = $1`, adam.AccountID)

	// the laptop with k1 is lost; Adam signs in on a new browser
	newb := signInAgain(t, adam, "New laptop")
	stale := func(p *Person) {
		exec(t, c, `update web_sessions set created_at = now() - interval '11 minutes' where token_hash = $1`, sessionHash(t, p))
	}

	// 0. nothing pending: the state says so, and how long a reset takes
	st := resetState(t, newb)
	if st["reset"] != nil || st["delay_s"] != float64(72*3600) || st["signin_max_age_s"] != float64(600) || st["signin_fresh"] != true {
		t.Fatalf("initial state: %v", st)
	}
	// 1. a reset needs a sign-in within the configured window (an old session, a copied cookie, can't start one)
	stale(newb)
	if st := resetState(t, newb); st["signin_fresh"] != false {
		t.Fatalf("stale sign-in shown as fresh: %v", st)
	}
	if r := newb.Do("POST", "/app/v1/me/passkey-reset", nil); r.Status != 403 || r.Code() != "reauth_required" {
		t.Fatalf("stale sign-in started a reset: %s", r)
	}
	newb = signInHere(t, newb) // the same browser signs in again: a fresh sign-in
	r := newb.Do("POST", "/app/v1/me/passkey-reset", nil)
	if r.Status != 201 {
		t.Fatalf("start: %s", r)
	}
	pr := r.J["reset"].(map[string]any)
	created, _ := time.Parse(time.RFC3339Nano, pr["created_at"].(string))
	ready, _ := time.Parse(time.RFC3339Nano, pr["ready_at"].(string))
	if d := ready.Sub(created); d < 72*time.Hour-time.Second || d > 72*time.Hour+time.Second || pr["ready"] != false || pr["started_here"] != true {
		t.Fatalf("reset: %v (%s)", pr, d)
	}
	if n := count(t, c, `select count(*) from account_events where account_id = $1 and kind = 'passkey_reset_started'`, adam.AccountID); n != 1 {
		t.Fatalf("started events: %d", n)
	}
	// 2. the banner: every signed-in dashboard of the account sees it (the old browser too, and says it can cancel)
	if p := pending(t, adam); p == nil || p["started_here"] != false || p["cancel_needs_passkey"] != false {
		t.Fatalf("old browser's banner data: %v", p)
	}
	if r := newb.Do("POST", "/app/v1/me/passkey-reset", nil); r.Code() != "reset_pending" {
		t.Fatalf("second reset while one waits: %s", r)
	}
	// 3. approvals keep needing a passkey while it waits: the fresh sign-in is no way around it
	a := NewAgentKeys(t, "one")
	if r := a.Join(c, adam.Invite(room)); r.Status != 201 {
		t.Fatal(r)
	}
	for _, act := range []struct{ action, target string }{{"approve_join", a.ReqID}, {"approve_device", newb.DevID}} {
		ch := newb.Do("POST", "/app/v1/human-check", map[string]any{"action": act.action, "target_id": act.target})
		if ch.Status != 200 || step(ch.J) != "assert" {
			t.Fatalf("%s during a reset from a fresh sign-in: %s", act.action, ch)
		}
	}
	// 4. it can't be finished early
	if r := resetCheck(t, newb, "finish"); r.Code() != "reset_not_ready" {
		t.Fatalf("finish check before the wait ended: %s", r)
	}
	if r := newb.Do("POST", "/app/v1/me/passkey-reset/finish", map[string]any{"human_check": map[string]any{"id": newID(), "turnstile_token": goodTS}}); r.Code() != "reset_not_ready" {
		t.Fatalf("finish before the wait ended: %s", r)
	}
	// 5. cancel by a session: not one that signed in after the request (an attacker who signed in again), yes the old one
	late := signInAgain(t, adam, "Late browser")
	if r := late.Do("POST", "/app/v1/me/passkey-reset/cancel", map[string]any{}); r.Status != 403 {
		t.Fatalf("a sign-in newer than the request cancelled without a passkey: %s", r)
	}
	if p := pending(t, late); p == nil || p["cancel_needs_passkey"] != true {
		t.Fatalf("late browser's banner data: %v", p)
	}
	if r := adam.Do("POST", "/app/v1/me/passkey-reset/cancel", map[string]any{}); r.Status != 200 || r.J["reset"] != nil {
		t.Fatalf("cancel from the old browser: %s", r)
	}
	if n := count(t, c, `select count(*) from account_events where account_id = $1 and kind = 'passkey_reset_cancelled' and data->>'by' = 'session'`, adam.AccountID); n != 1 {
		t.Fatalf("cancel event: %d", n)
	}
	// 6. cancel by a passkey: from any session, the late one included; a stranger's key doesn't count
	if r := newb.Do("POST", "/app/v1/me/passkey-reset", nil); r.Status != 201 {
		t.Fatalf("start again: %s", r)
	}
	ch := resetCheck(t, late, "cancel")
	if ch.Status != 200 || step(ch.J) != "assert" {
		t.Fatalf("cancel check: %s", ch)
	}
	if r := late.Do("POST", "/app/v1/me/passkey-reset/cancel", map[string]any{"human_check": map[string]any{"id": ch.Str("id"), "turnstile_token": goodTS,
		"webauthn": thief.Assert(opt(ch.J, "webauthn"), []byte(adam.AccountID))}}); r.Code() != "human_check_failed" {
		t.Fatalf("a stranger's key cancelled: %s", r)
	}
	ch = resetCheck(t, late, "cancel")
	if r := late.Do("POST", "/app/v1/me/passkey-reset/cancel", map[string]any{"human_check": map[string]any{"id": ch.Str("id"), "turnstile_token": goodTS,
		"webauthn": k1.Assert(opt(ch.J, "webauthn"), []byte(adam.AccountID))}}); r.Status != 200 || r.J["reset"] != nil {
		t.Fatalf("cancel with a passkey: %s", r)
	}
	// 7. how often: three starts a day
	if r := newb.Do("POST", "/app/v1/me/passkey-reset", nil); r.Status != 201 {
		t.Fatalf("third start: %s", r)
	}
	adam.Do("POST", "/app/v1/me/passkey-reset/cancel", map[string]any{})
	if r := newb.Do("POST", "/app/v1/me/passkey-reset", nil); r.Status != 429 || r.Code() != "rate_limited" {
		t.Fatalf("fourth start in a day: %s", r)
	}
	exec(t, c, `update passkey_resets set created_at = created_at - interval '25 hours' where account_id = $1`, adam.AccountID)
	if r := newb.Do("POST", "/app/v1/me/passkey-reset", nil); r.Status != 201 {
		t.Fatalf("start after a day: %s", r)
	}
	// 8. the wait ends. The clock moves 72 h for everything (the reset AND every sign-in of the account), never slept.
	moveClock(t, c, adam.AccountID, 72*time.Hour+time.Second)
	if p := pending(t, adam); p == nil || p["ready"] != true {
		t.Fatalf("ready: %v", p)
	}
	// the asking browser's sign-in is 72 h old now: sign in again first
	if r := resetCheck(t, newb, "finish"); r.Code() != "reauth_required" {
		t.Fatalf("finish check from the 72 h old sign-in: %s", r)
	}
	// another browser, freshly signed in (whoever controls the Google or GitHub account): never
	other := signInAgain(t, adam, "Other browser")
	if r := resetCheck(t, other, "finish"); r.Status != 403 || r.Code() != "forbidden" {
		t.Fatalf("a fresh sign-in in another browser picked up the reset: %s", r)
	}
	if p := pending(t, other); p["started_here"] != false {
		t.Fatalf("other browser shown as the asking one: %v", p)
	}
	// the asking browser signs in again: a NEW session, the same browser (its reset cookie)
	newb = signInHere(t, newb)
	if p := pending(t, newb); p["started_here"] != true {
		t.Fatalf("the asking browser, signed in again, is not recognised: %v", p)
	}
	// a copy of that fresh session cookie, without the browser's reset cookie: never
	copied := sessionOnly(t, newb)
	if r := resetCheck(t, copied, "finish"); r.Status != 403 || r.Code() != "forbidden" {
		t.Fatalf("a copied session without the reset cookie picked up the reset: %s", r)
	}
	ch = resetCheck(t, newb, "finish")
	if ch.Status != 200 || step(ch.J) != "register" {
		t.Fatalf("finish check: %s", ch)
	}
	if r := newb.Do("POST", "/app/v1/me/passkey-reset/finish", map[string]any{"human_check": map[string]any{"id": ch.Str("id"),
		"webauthn": k2.Register(opt(ch.J, "webauthn"))}}); r.Code() != "human_check_failed" {
		t.Fatalf("finish without Turnstile: %s", r)
	}
	if n := count(t, c, `select count(*) from webauthn_credentials where account_id = $1`, adam.AccountID); n != 1 {
		t.Fatalf("passkeys after a refused finish: %d", n)
	}
	ch = resetCheck(t, newb, "finish")
	r = newb.Do("POST", "/app/v1/me/passkey-reset/finish", map[string]any{"human_check": map[string]any{"id": ch.Str("id"), "turnstile_token": goodTS,
		"webauthn": k2.Register(opt(ch.J, "webauthn"))}})
	if r.Status != 200 || len(r.J["passkeys"].([]any)) != 1 || r.J["passkeys"].([]any)[0].(map[string]any)["id"] != b64u(k2.credID) {
		t.Fatalf("finish: %s", r)
	}
	// 9. at that moment: every old passkey gone, every other sign-in ended, the reset closed and recorded
	if n := count(t, c, `select count(*) from webauthn_credentials where account_id = $1 and id = $2`, adam.AccountID, k1.credID); n != 0 {
		t.Fatal("the lost passkey survived the reset")
	}
	for name, p := range map[string]*Person{"old": adam, "late": late, "other": other} {
		if r := p.Do("GET", "/app/v1/me", nil); r.Status != 401 {
			t.Fatalf("%s browser still signed in after the reset: %s", name, r)
		}
	}
	if pending(t, newb) != nil {
		t.Fatal("reset still open")
	}
	if n := count(t, c, `select count(*) from account_events where account_id = $1 and kind = 'passkey_reset_completed'`, adam.AccountID); n != 1 {
		t.Fatalf("completed events: %d", n)
	}
	// 10. and approvals still need a passkey: the new one, not the lost one
	exec(t, c, `update web_sessions set uv_at = null where account_id = $1`, adam.AccountID)
	if nc := newCheck(t, newb, a.ReqID); step(nc) != "assert" {
		t.Fatalf("approve after the reset: %v", nc)
	}
	// the mail notice went out for every step (to a fake: no real mail is ever sent)
	want := []string{"started", "cancelled", "started", "cancelled", "started", "cancelled", "started", "completed"}
	if got := mail.kinds(); len(got) != len(want) {
		t.Fatalf("mail notices: %v", got)
	}
	for _, n := range mail.sent {
		if n.Email != adam.Email {
			t.Fatalf("notice to %q", n.Email)
		}
	}
}

// A reset only for an account that has a passkey to lose; the default delay is never zero.
func TestPasskeyResetEdges(t *testing.T) {
	c := realCopy(t, func(cfg *config.Config) { cfg.PasskeyResetDelay = 0 })
	eve := NewPerson(t, c, "Eve")
	if r := eve.Do("POST", "/app/v1/me/passkey-reset", nil); r.Status != 409 || r.Code() != "no_passkey" {
		t.Fatalf("reset without a passkey: %s", r)
	}
	addFirstPasskey(t, c, eve, newSoftAuth("localhost", c.URL))
	r := eve.Do("POST", "/app/v1/me/passkey-reset", nil)
	if r.Status != 201 || r.J["reset"].(map[string]any)["ready"] != false {
		t.Fatalf("a zero delay in config must mean the default, not none: %s", r)
	}
	if r := resetCheck(t, eve, "nonsense"); r.Status != 400 {
		t.Fatalf("unknown check: %s", r)
	}
	// the generic route never hands out a reset check
	if r := eve.Do("POST", "/app/v1/human-check", map[string]any{"action": "passkey_reset_finish"}); r.Status != 400 {
		t.Fatalf("generic route issued a finish check: %s", r)
	}
	other := NewPerson(t, c, "Other")
	if r := other.Do("POST", "/app/v1/me/passkey-reset/cancel", map[string]any{}); r.Status != 404 {
		t.Fatalf("cancel with nothing pending: %s", r)
	}
}

// The fresh-sign-in fallback (Turnstile only) is for accounts that never set up a passkey. Once there is one, a fresh
// sign-in (one click where the browser is still signed in to Google or GitHub) must not stand in for it: a stolen,
// signed-in laptop could otherwise approve a person (an attacker's own account) into every room it signs in.
func TestFreshSignInIsNoPasskey(t *testing.T) {
	c := realCopy(t)
	adam := NewPerson(t, c, "Adam")
	if ch := adam.Do("POST", "/app/v1/human-check", map[string]any{"action": "approve_device", "target_id": adam.DevID}); step(ch.J) != "skip" {
		t.Fatalf("no passkey yet: the fallback stays: %s", ch)
	}
	addFirstPasskey(t, c, adam, newSoftAuth("localhost", c.URL))
	adam = reSignIn(t, adam) // a fresh sign-in (no passkey answered yet) is a new sign-in
	for _, act := range []string{"approve_device", "approve_person"} {
		if ch := adam.Do("POST", "/app/v1/human-check", map[string]any{"action": act, "target_id": newID()}); step(ch.J) != "assert" {
			t.Fatalf("%s from a fresh sign-in on an account with a passkey: %s", act, ch)
		}
	}
}

// removeEntries signs one device_remove per room with signer's key.
func removeEntries(signer *Person, target testkit.Key, rooms ...*Room) []map[string]any {
	out := []map[string]any{}
	for _, rm := range rooms {
		signer.Sync(rm)
		out = append(out, map[string]any{"room_id": rm.ID, "roster_entry": rm.Log.Build("device_remove", signer.Dev,
			map[string]any{"account": signer.AccountID, "device": target.Hex()})})
	}
	return out
}

func removeDevice(t *testing.T, p *Person, devID string, entries []map[string]any, thisBrowser bool) *Resp {
	t.Helper()
	hc := p.Check("device_remove", devID)
	body := map[string]any{"human_check": map[string]any{"id": hc, "stub": true}, "entries": entries}
	if thisBrowser {
		body["this_browser"] = true
	}
	return p.Do("POST", "/app/v1/devices/"+devID+"/remove", body)
}

// "Remove this browser" and removing a lost one: the server refuses its key on every path from then on, its sign-ins
// end, and the signed member list of each room says it is gone, so the other people's chats see it too.
func TestRemoveBrowser(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A")
	adam := NewPerson(t, c, "Adam")
	r1, r2 := adam.CreateRoom("one"), adam.CreateRoom("two")
	lost := signInAgain(t, adam, "Lost laptop")
	if r := certify(t, adam, lost, "Lost laptop", r1, r2); r.Status != 200 {
		t.Fatalf("certify: %s", r)
	}
	bob := NewPerson(t, c, "Bob")
	adam.Sync(r1)
	addPerson(t, adam, bob, r1)
	// a third browser that signs in nowhere yet (it can't sign a removal anywhere)
	fresh := signInAgain(t, adam, "Fresh browser")

	// 1. from the fresh browser: the server revokes now, the lists of r1 and r2 still name the key (said, not hidden)
	if r := removeDevice(t, fresh, lost.DevID, []map[string]any{}, false); r.Status != 200 || r.J["revoked_at"] == nil || r.J["certified_rooms"] != float64(2) {
		t.Fatalf("remove from a browser that can't sign: %s", r)
	}
	if n := count(t, c, `select count(*) from account_events where account_id = $1 and kind = 'device_removed'`, adam.AccountID); n != 1 {
		t.Fatalf("device_removed events: %d", n)
	}
	// every other sign-in ended (the lost laptop's among them); this one stays
	if r := lost.Do("GET", "/app/v1/me", nil); r.Status != 401 {
		t.Fatalf("lost laptop still signed in: %s", r)
	}
	if r := fresh.Do("GET", "/app/v1/me", nil); r.Status != 200 {
		t.Fatalf("the removing browser was signed out: %s", r)
	}
	// 2. Adam's everyday browser signs in again (its key is still good) and finishes the removal in each room
	adam = reSignIn(t, adam)
	// an entry that removes another browser than the one named: refused, nothing changes
	wrong := removeEntries(adam, adam.Dev, r2)
	if r := removeDevice(t, adam, lost.DevID, wrong, false); r.Status != 400 || r.Code() != "roster_invalid" {
		t.Fatalf("an entry for another browser: %s", r)
	}
	if r := removeDevice(t, adam, lost.DevID, removeEntries(adam, lost.Dev, r1, r2), false); r.Status != 200 || r.J["certified_rooms"] != float64(0) {
		t.Fatalf("finish the removal: %s", r)
	}
	// the other people's view: the signed list Bob's chats verify no longer has the key
	rr := bob.Do("GET", "/app/v1/rooms/"+r1.ID+"/roster", nil)
	var ws []roster.Wire
	_ = json.Unmarshal(mustJSON(rr.J["entries"]), &ws)
	stv, err := roster.Replay(r1.ID, ws)
	if err != nil {
		t.Fatalf("Bob's verify: %v", err)
	}
	if _, still := stv.DeviceOwner[lost.Dev.Hex()]; still {
		t.Fatal("the removed browser is still a signer in the signed list")
	}
	if last, _ := roster.Parse(mustB64(t, ws[len(ws)-1].Entry), 0); last == nil || last.Op != "device_remove" || last.Device != lost.Dev.Hex() {
		t.Fatalf("last entry: %+v", last)
	}

	// 3. the removed key is refused on every path that takes a browser key (signed in through Adam's session here)
	adam.Sync(r1)
	if r := adam.Do("POST", "/app/v1/rooms/"+r1.ID+"/roster", map[string]any{"roster_entry": r1.Log.Build("person_remove", lost.Dev,
		map[string]any{"account": bob.AccountID})}); r.Code() != "not_signer" {
		t.Fatalf("roster change signed by the removed key: %s", r)
	}
	ag := NewAgentKeys(t, "joiner")
	if r := ag.Join(c, adam.Invite(r1)); r.Status != 201 {
		t.Fatal(r)
	}
	adam.Sync(r1)
	e := r1.Log.Build("member_add", lost.Dev, map[string]any{"member": joinCardMember(t, adam, ag.ReqID), "account": adam.AccountID, "name": ag.Name,
		"app": "claude-code", "ed": ag.Key.Hex(), "x": hexs(ag.X)})
	if r := adam.Do("POST", "/app/v1/join-requests/"+ag.ReqID+"/approve", map[string]any{"human_check": map[string]any{"id": adam.Check("approve_join", ag.ReqID), "stub": true},
		"roster_entry": e}); r.Code() != "not_signer" {
		t.Fatalf("join approved with the removed key: %s", r)
	}
	carol := NewPerson(t, c, "Carol")
	pi := adam.Do("POST", "/app/v1/rooms/"+r1.ID+"/person-invites", map[string]any{"id": newID()})
	acc := carol.Do("POST", "/app/v1/person-invites/"+pi.Str("url")[len(pi.Str("url"))-16:]+"/accept", map[string]any{"device_id": carol.DevID})
	if acc.Status != 201 {
		t.Fatalf("accept: %s", acc)
	}
	adam.Sync(r1)
	pe := r1.Log.Build("person_add", lost.Dev, map[string]any{"account": carol.AccountID, "name": "Carol", "device": carol.Dev.Hex()})
	if r := adam.Do("POST", "/app/v1/person-requests/"+acc.Str("id")+"/approve", map[string]any{"human_check": map[string]any{"id": adam.Check("approve_person", acc.Str("id")), "stub": true},
		"roster_entry": pe}); r.Code() != "not_signer" {
		t.Fatalf("person approved with the removed key: %s", r)
	}
	adam.Sync(r1)
	ce := r1.Log.Build("device_add", lost.Dev, map[string]any{"account": adam.AccountID, "device": fresh.Dev.Hex(), "label": "Fresh"})
	if r := adam.Do("POST", "/app/v1/devices/"+fresh.DevID+"/certify", map[string]any{"human_check": map[string]any{"id": adam.Check("approve_device", fresh.DevID), "stub": true},
		"entries": []map[string]any{{"room_id": r1.ID, "roster_entry": ce}}}); r.Code() != "not_signer" {
		t.Fatalf("a browser certified with the removed key: %s", r)
	}
	for _, path := range []string{"/app/v1/devices/" + lost.DevID + "/certify", "/app/v1/devices/" + lost.DevID + "/ask"} {
		body := map[string]any{}
		if path[len(path)-7:] == "certify" {
			body = map[string]any{"human_check": map[string]any{"id": newID(), "stub": true}, "entries": []any{}}
		}
		if r := adam.Do("POST", path, body); r.Status != 404 {
			t.Fatalf("%s for the removed browser: %s", path, r)
		}
	}
	if r := adam.Do("GET", "/app/v1/devices/"+lost.DevID+"/pending-rooms", nil); r.Status != 404 {
		t.Fatalf("pending rooms of the removed browser: %s", r)
	}
	pi2 := adam.Do("POST", "/app/v1/rooms/"+r2.ID+"/person-invites", map[string]any{"id": newID()})
	if r := adam.Do("POST", "/app/v1/person-invites/"+pi2.Str("url")[len(pi2.Str("url"))-16:]+"/accept", map[string]any{"device_id": lost.DevID}); r.Status != 400 && r.Status != 409 {
		t.Fatalf("person invite accepted with the removed browser: %s", r)
	}
	nid := wire.NewV7().String()
	nl := testkit.NewLog(nid)
	g := nl.Build("genesis", lost.Dev, map[string]any{"name": "fromlost", "owner": adam.AccountID, "device": lost.Dev.Hex()})
	if r := adam.Do("POST", "/app/v1/rooms", map[string]any{"id": nid, "name": "fromlost", "purpose": "", "genesis": g}); r.Code() != "not_signer" {
		t.Fatalf("room created with the removed key: %s", r)
	}
	// registering it again doesn't bring it back
	if r := adam.Do("POST", "/app/v1/devices", map[string]any{"id": lost.DevID, "ed25519_pk": lost.Dev.Hex(), "label": "Lost laptop"}); r.J["revoked_at"] == nil {
		t.Fatalf("re-registering un-removed it: %s", r)
	}
	// the lost laptop signs in again (a thief with its Google session): its key is still refused
	thief := reSignIn(t, lost)
	thief.Sync(r1)
	if r := thief.Do("POST", "/app/v1/rooms/"+r1.ID+"/roster", map[string]any{"roster_entry": r1.Log.Build("person_remove", lost.Dev,
		map[string]any{"account": bob.AccountID})}); r.Code() != "not_signer" {
		t.Fatalf("thief's roster change: %s", r)
	}

	// 4. "Remove this browser": the fresh browser (signed out by step 2, it signs in again) removes itself; its own
	// sign-in ends, the others stay
	fresh = reSignIn(t, fresh)
	if r := removeDevice(t, fresh, fresh.DevID, []map[string]any{}, true); r.Status != 200 || r.J["revoked_at"] == nil {
		t.Fatalf("remove this browser: %s", r)
	}
	if r := fresh.Do("GET", "/app/v1/me", nil); r.Status != 401 {
		t.Fatalf("removed browser still signed in: %s", r)
	}
	if r := adam.Do("GET", "/app/v1/me", nil); r.Status != 200 {
		t.Fatalf("removing this browser signed out another: %s", r)
	}
	// 5. never another person's browser
	if r := removeDevice(t, bob, adam.DevID, []map[string]any{}, false); r.Status != 404 {
		t.Fatalf("Bob removed Adam's browser: %s", r)
	}
}

// reSignIn: the same browser (same device key) signs in again: a new session.
func reSignIn(t *testing.T, p *Person) *Person {
	t.Helper()
	q := *p
	q.Client = &http.Client{Jar: newJar(), Timeout: 30 * time.Second}
	r := q.Do("POST", "/app/v1/auth/dev-login", map[string]any{"email": p.Email, "display_name": p.Name})
	if r.Status != 200 {
		t.Fatalf("sign in again: %s", r)
	}
	q.CSRF = r.Str("csrf_token")
	return &q
}

// signInHere: the same browser (same cookie jar, so its reset cookie too) signs in again: a new session.
func signInHere(t *testing.T, p *Person) *Person {
	t.Helper()
	q := *p
	r := q.Do("POST", "/app/v1/auth/dev-login", map[string]any{"email": p.Email, "display_name": p.Name})
	if r.Status != 200 {
		t.Fatalf("sign in here again: %s", r)
	}
	q.CSRF = r.Str("csrf_token")
	return &q
}

// sessionOnly is a copy of p's session cookie in a browser that has nothing else of p's (a stolen session).
func sessionOnly(t *testing.T, p *Person) *Person {
	t.Helper()
	q := *p
	q.Client = &http.Client{Jar: newJar(), Timeout: 30 * time.Second}
	for _, ck := range p.Client.Jar.Cookies(mustURL(p.C.URL)) {
		if ck.Name == "bl_session" {
			q.Client.Jar.SetCookies(mustURL(p.C.URL), []*http.Cookie{ck})
		}
	}
	return &q
}

// sessionHash is the token_hash of p's session (sha256 of its cookie value).
func sessionHash(t *testing.T, p *Person) []byte {
	t.Helper()
	for _, ck := range p.Client.Jar.Cookies(mustURL(p.C.URL)) {
		if ck.Name == "bl_session" {
			return wire.SHA256([]byte(ck.Value))
		}
	}
	t.Fatal("no session cookie")
	return nil
}

func mustB64(t *testing.T, s string) []byte {
	t.Helper()
	b, err := wire.DecodeB64URL(s)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// Removing a browser asks a passkey every time (real check, no skip window), and needs one to exist.
func TestRemoveBrowserNeedsPasskey(t *testing.T) {
	c := realCopy(t)
	adam := NewPerson(t, c, "Adam")
	other := signInAgain(t, adam, "Other")
	if r := adam.Do("POST", "/app/v1/human-check", map[string]any{"action": "device_remove", "target_id": other.DevID}); r.Status != 409 || r.Code() != "no_passkey" {
		t.Fatalf("remove check without any passkey: %s", r)
	}
	k := newSoftAuth("localhost", c.URL)
	addFirstPasskey(t, c, adam, k) // uv is fresh now: still asked
	ch := adam.Do("POST", "/app/v1/human-check", map[string]any{"action": "device_remove", "target_id": other.DevID})
	if ch.Status != 200 || step(ch.J) != "assert" {
		t.Fatalf("remove check: %s", ch)
	}
	if r := adam.Do("POST", "/app/v1/devices/"+other.DevID+"/remove", map[string]any{"human_check": map[string]any{"id": ch.Str("id"), "turnstile_token": goodTS},
		"entries": []any{}}); r.Code() != "human_check_failed" {
		t.Fatalf("removed without a passkey answer: %s", r)
	}
	ch = adam.Do("POST", "/app/v1/human-check", map[string]any{"action": "device_remove", "target_id": other.DevID})
	if r := adam.Do("POST", "/app/v1/devices/"+other.DevID+"/remove", map[string]any{"human_check": map[string]any{"id": ch.Str("id"), "turnstile_token": goodTS,
		"webauthn": k.Assert(opt(ch.J, "webauthn"), []byte(adam.AccountID))}, "entries": []any{}, "keep_ids": []string{b64u(k.credID)}}); r.Status != 200 {
		t.Fatalf("remove with a passkey: %s", r)
	}
}
