package test

import (
	"slices"
	"testing"
	"time"
)

// Account delete waits (security re-review of fix-all): ask (passkey + typed email) → wait 72 h, shown on every page
// of the account, cancellable by any of its sign-ins → finish (passkey again), within 7 days. The clock is moved for
// everything of the account at once (asks, sign-ins, resets, events), never for one row alone.

// moveClock moves time forward by d for every time-stamped row of account that a delete or a reset reads.
func moveClock(t *testing.T, c *Copy, account string, d time.Duration) {
	t.Helper()
	iv := d.String()
	exec(t, c, `update account_deletes set created_at = created_at - $2::interval, ready_at = ready_at - $2::interval,
		lapses_at = lapses_at - $2::interval, cancelled_at = cancelled_at - $2::interval where account_id = $1`, account, iv)
	exec(t, c, `update web_sessions set created_at = created_at - $2::interval, last_seen_at = last_seen_at - $2::interval,
		uv_at = uv_at - $2::interval where account_id = $1`, account, iv)
	exec(t, c, `update passkey_resets set created_at = created_at - $2::interval, ready_at = ready_at - $2::interval,
		cancelled_at = cancelled_at - $2::interval, completed_at = completed_at - $2::interval where account_id = $1`, account, iv)
	exec(t, c, `update account_events set at = at - $2::interval where account_id = $1`, account, iv)
}

func deletePlan(t *testing.T, p *Person) map[string]any {
	t.Helper()
	r := p.Do("GET", "/app/v1/me/delete", nil)
	if r.Status != 200 {
		t.Fatalf("delete plan: %s", r)
	}
	return r.J
}

func pendingDelete(t *testing.T, p *Person) map[string]any {
	t.Helper()
	v, _ := deletePlan(t, p)["pending"].(map[string]any)
	return v
}

func finishDelete(p *Person) *Resp {
	return p.Do("POST", "/app/v1/me/delete", deleteBody(p.Email, p.Check("account_delete", "")))
}

func eventKinds(t *testing.T, c *Copy, account string) []string {
	t.Helper()
	rows, err := c.Pool.Query(t.Context(), `select kind from account_events where account_id = $1 order by id`, account)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var k string
		_ = rows.Scan(&k)
		out = append(out, k)
	}
	return out
}

func accountThere(t *testing.T, c *Copy, account string, rooms int) {
	t.Helper()
	if n := count(t, c, `select count(*) from accounts where id = $1 and deleted_at is null`, account); n != 1 {
		t.Fatal("the account was deleted")
	}
	if n := count(t, c, `select count(*) from rooms where owner_account_id = $1 and deleted_at is null`, account); n != rooms {
		t.Fatalf("rooms left: %d, want %d", n, rooms)
	}
}

func TestAccountDeleteWaitStateMachine(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A")
	mail := &fakeMail{}
	c.S.App.Mail = mail
	dana := NewPerson(t, c, "Dana")
	dana.CreateRoom("mine")
	other := signInAgain(t, dana, "Dana's phone")

	st := deletePlan(t, dana)
	if st["pending"] != nil || st["delay_s"] != float64(72*3600) || st["window_s"] != float64(7*24*3600) {
		t.Fatalf("initial: %v", st)
	}
	// 1. ask: nothing removed, the wait starts, every sign-in sees it, the person is told
	askDelete(t, dana)
	if p := pendingDelete(t, dana); p == nil || p["ready"] != false || p["asked_here"] != true {
		t.Fatalf("pending after ask: %v", p)
	}
	if p := pendingDelete(t, other); p == nil || p["asked_here"] != false {
		t.Fatalf("pending seen from the other sign-in: %v", p)
	}
	accountThere(t, c, dana.AccountID, 1)
	if r := dana.Do("POST", "/app/v1/me/delete/ask", map[string]any{"confirm": dana.Email, "human_check": map[string]any{"id": dana.Check("account_delete", ""), "stub": true}}); r.Code() != "delete_pending" {
		t.Fatalf("second ask: %s", r)
	}
	// 2. finish too early
	if r := finishDelete(dana); r.Status != 409 || r.Code() != "delete_not_ready" {
		t.Fatalf("finish before the wait: %s", r)
	}
	moveClock(t, c, dana.AccountID, 71*time.Hour)
	if r := finishDelete(dana); r.Code() != "delete_not_ready" {
		t.Fatalf("finish after 71 h: %s", r)
	}
	// 3. cancelled by the other sign-in, no passkey
	if r := other.Do("POST", "/app/v1/me/delete/cancel", nil); r.Status != 200 || r.Str("cancelled_by") != "session" {
		t.Fatalf("cancel by another sign-in: %s", r)
	}
	if pendingDelete(t, dana) != nil {
		t.Fatal("still pending after cancel")
	}
	if r := other.Do("POST", "/app/v1/me/delete/cancel", nil); r.Status != 404 {
		t.Fatalf("cancel with nothing pending: %s", r)
	}
	moveClock(t, c, dana.AccountID, 2*time.Hour)
	if r := finishDelete(dana); r.Code() != "delete_not_asked" {
		t.Fatalf("finish after a cancel: %s", r)
	}
	// 4. asked again and left past the window: it lapses
	askDelete(t, dana)
	moveClock(t, c, dana.AccountID, 72*time.Hour+7*24*time.Hour+time.Second)
	if r := finishDelete(dana); r.Status != 409 || r.Code() != "delete_lapsed" {
		t.Fatalf("finish after the window: %s", r)
	}
	if pendingDelete(t, dana) != nil {
		t.Fatal("a lapsed ask is shown as pending")
	}
	accountThere(t, c, dana.AccountID, 1)
	// 5. asked again, the wait passes, finished inside the window
	askDelete(t, dana)
	moveClock(t, c, dana.AccountID, 72*time.Hour+time.Second)
	if p := pendingDelete(t, dana); p == nil || p["ready"] != true {
		t.Fatalf("ready: %v", p)
	}
	kinds := eventKinds(t, c, dana.AccountID)
	if want := []string{"account_delete_asked", "account_delete_cancelled", "account_delete_asked", "account_delete_asked"}; !slices.Equal(kinds, want) {
		t.Errorf("events: %v, want %v", kinds, want)
	}
	if r := finishDelete(dana); r.Status != 200 {
		t.Fatalf("finish: %s", r)
	}
	if n := count(t, c, `select count(*) from accounts where id = $1 and deleted_at is not null`, dana.AccountID); n != 1 {
		t.Fatal("not deleted")
	}
	if got := mail.kinds(); !slices.Contains(got, "delete_asked") || !slices.Contains(got, "delete_cancelled") || !slices.Contains(got, "delete_finished") {
		t.Errorf("notices: %v", got)
	}

	// asks are limited: 3 a day
	gus := NewPerson(t, c, "Gus")
	for i := 0; i < 3; i++ {
		askDelete(t, gus)
		if r := gus.Do("POST", "/app/v1/me/delete/cancel", nil); r.Status != 200 {
			t.Fatalf("cancel %d: %s", i, r)
		}
	}
	if r := gus.Do("POST", "/app/v1/me/delete/ask", map[string]any{"confirm": gus.Email, "human_check": map[string]any{"id": gus.Check("account_delete", ""), "stub": true}}); r.Status != 429 {
		t.Fatalf("fourth ask in a day: %s", r)
	}
}

// Cancel with a passkey (real check): recorded as such.
func TestAccountDeleteCancelByPasskey(t *testing.T) {
	c := realCopy(t)
	adam := NewPerson(t, c, "Adam")
	k1 := newSoftAuth("localhost", c.URL)
	addFirstPasskey(t, c, adam, k1)
	ch := adam.Do("POST", "/app/v1/human-check", map[string]any{"action": "account_delete"})
	if r := adam.Do("POST", "/app/v1/me/delete/ask", map[string]any{"confirm": adam.Email, "human_check": map[string]any{"id": ch.Str("id"),
		"turnstile_token": goodTS, "webauthn": k1.Assert(opt(ch.J, "webauthn"), []byte(adam.AccountID))}}); r.Status != 201 {
		t.Fatalf("ask: %s", r)
	}
	ch = adam.Do("POST", "/app/v1/human-check", map[string]any{"action": "account_delete"})
	r := adam.Do("POST", "/app/v1/me/delete/cancel", map[string]any{"human_check": map[string]any{"id": ch.Str("id"),
		"turnstile_token": goodTS, "webauthn": k1.Assert(opt(ch.J, "webauthn"), []byte(adam.AccountID))}})
	if r.Status != 200 || r.Str("cancelled_by") != "passkey" {
		t.Fatalf("cancel by passkey: %s", r)
	}
	if n := count(t, c, `select count(*) from account_events where account_id = $1 and kind = 'account_delete_cancelled' and data->>'by' = 'passkey'`, adam.AccountID); n != 1 {
		t.Error("cancel by passkey not recorded")
	}
}

// Reviewer, finding 2: a thief holds a laptop with the person's passkey on it, signs in there, removes the person's
// own browser and deletes the account. Now the delete only waits; the person signs in anywhere and cancels it.
func TestAccountDeleteThiefWithPasskey(t *testing.T) {
	c := realCopy(t)
	mail := &fakeMail{}
	c.S.App.Mail = mail
	adam := NewPerson(t, c, "Adam")
	adam.CreateRoom("family")
	k1 := newSoftAuth("localhost", c.URL) // synced: on Adam's browser and on the stolen laptop
	addFirstPasskey(t, c, adam, k1)
	moveClock(t, c, adam.AccountID, 3*24*time.Hour) // Adam's sign-in is days old

	thief := signInAgain(t, adam, "Stolen laptop")
	// k1's place is unknown (no browser proved it), so the remove dialog makes whoever removes a browser choose keep or
	// remove for it (lane RECOVER, passkeys_unchosen). The thief sees the same dialog and keeps it: that is what a real
	// thief can do. Leaving the choice out is refused, so the test shows the rule holds for the thief too.
	ch := thief.Do("POST", "/app/v1/human-check", map[string]any{"action": "device_remove", "target_id": adam.DevID})
	if r := thief.Do("POST", "/app/v1/devices/"+adam.DevID+"/remove", map[string]any{"human_check": map[string]any{"id": ch.Str("id"),
		"turnstile_token": goodTS, "webauthn": k1.Assert(opt(ch.J, "webauthn"), []byte(adam.AccountID))}, "entries": []any{}}); r.Code() != "passkeys_unchosen" {
		t.Fatalf("thief removes Adam's browser without choosing for k1: %s", r)
	}
	ch = thief.Do("POST", "/app/v1/human-check", map[string]any{"action": "device_remove", "target_id": adam.DevID})
	if r := thief.Do("POST", "/app/v1/devices/"+adam.DevID+"/remove", map[string]any{"human_check": map[string]any{"id": ch.Str("id"),
		"turnstile_token": goodTS, "webauthn": k1.Assert(opt(ch.J, "webauthn"), []byte(adam.AccountID))}, "entries": []any{},
		"keep_ids": []string{b64u(k1.credID)}, "freeze_ok": true}); r.Status != 200 {
		t.Fatalf("thief removes Adam's browser: %s", r)
	}
	if r := adam.Do("GET", "/app/v1/me", nil); r.Status != 401 {
		t.Fatalf("Adam's own browser after the thief removed it: %s", r)
	}
	// removing a browser pauses delete asks for a day (third security pass); the thief waits it out
	ch = thief.Do("POST", "/app/v1/human-check", map[string]any{"action": "account_delete"})
	if r := thief.Do("POST", "/app/v1/me/delete/ask", map[string]any{"confirm": adam.Email, "human_check": map[string]any{"id": ch.Str("id"),
		"turnstile_token": goodTS, "webauthn": k1.Assert(opt(ch.J, "webauthn"), []byte(adam.AccountID))}}); r.Code() != "delete_held" {
		t.Fatalf("thief asks right after removing Adam's browser: %s", r)
	}
	moveClock(t, c, adam.AccountID, 24*time.Hour+time.Minute)
	ch = thief.Do("POST", "/app/v1/human-check", map[string]any{"action": "account_delete"})
	if r := thief.Do("POST", "/app/v1/me/delete/ask", map[string]any{"confirm": adam.Email, "human_check": map[string]any{"id": ch.Str("id"),
		"turnstile_token": goodTS, "webauthn": k1.Assert(opt(ch.J, "webauthn"), []byte(adam.AccountID))}}); r.Status != 201 {
		t.Fatalf("thief asks to delete: %s", r)
	}
	ch = thief.Do("POST", "/app/v1/human-check", map[string]any{"action": "account_delete"})
	if r := thief.Do("POST", "/app/v1/me/delete", map[string]any{"confirm": adam.Email, "entries": []any{}, "human_check": map[string]any{"id": ch.Str("id"),
		"turnstile_token": goodTS, "webauthn": k1.Assert(opt(ch.J, "webauthn"), []byte(adam.AccountID))}}); r.Code() != "delete_not_ready" {
		t.Fatalf("thief finishes at once: %s", r)
	}
	// Adam is told, signs in again on any browser, sees it and cancels it without a passkey
	if !slices.Contains(mail.kinds(), "delete_asked") {
		t.Errorf("Adam was not told: %v", mail.kinds())
	}
	back := reSignIn(t, adam)
	if p := pendingDelete(t, back); p == nil || p["asked_here"] != false {
		t.Fatalf("Adam does not see the waiting delete: %v", p)
	}
	if r := back.Do("POST", "/app/v1/me/delete/cancel", nil); r.Status != 200 {
		t.Fatalf("Adam cancels: %s", r)
	}
	moveClock(t, c, adam.AccountID, 73*time.Hour)
	thief = reSignIn(t, thief) // a week of moved clock: sign-ins have expired
	ch = thief.Do("POST", "/app/v1/human-check", map[string]any{"action": "account_delete"})
	if r := thief.Do("POST", "/app/v1/me/delete", map[string]any{"confirm": adam.Email, "entries": []any{}, "human_check": map[string]any{"id": ch.Str("id"),
		"turnstile_token": goodTS, "webauthn": k1.Assert(opt(ch.J, "webauthn"), []byte(adam.AccountID))}}); r.Code() != "delete_not_asked" {
		t.Fatalf("thief finishes after the wait: %s", r)
	}
	accountThere(t, c, adam.AccountID, 1)
	if k := eventKinds(t, c, adam.AccountID); !slices.Contains(k, "account_delete_asked") || !slices.Contains(k, "account_delete_cancelled") {
		t.Errorf("events: %v", k)
	}
}

// Reviewer, new medium finding: an account that never had a passkey, deleted on day 0 by someone who controls only its
// Google or GitHub sign-in (the delete check registers a first passkey from a fresh sign-in). Now the ask only waits,
// and the person's older sign-in sees it and cancels it.
func TestAccountDeleteNoPasskeyDay0(t *testing.T) {
	c := realCopy(t)
	mail := &fakeMail{}
	c.S.App.Mail = mail
	bea := NewPerson(t, c, "Bea")
	bea.CreateRoom("studio")
	moveClock(t, c, bea.AccountID, 3*24*time.Hour)

	thief := signInAgain(t, bea, "Somewhere else")
	tk := newSoftAuth("localhost", c.URL)
	ch := thief.Do("POST", "/app/v1/human-check", map[string]any{"action": "account_delete"})
	if step(ch.J) != "register" {
		t.Fatalf("no passkey: step %v", step(ch.J))
	}
	if r := thief.Do("POST", "/app/v1/me/delete/ask", map[string]any{"confirm": bea.Email, "human_check": map[string]any{"id": ch.Str("id"),
		"turnstile_token": goodTS, "webauthn": tk.Register(opt(ch.J, "webauthn"))}}); r.Status != 201 {
		t.Fatalf("ask from a fresh sign-in with a new passkey: %s", r)
	}
	ch = thief.Do("POST", "/app/v1/human-check", map[string]any{"action": "account_delete"})
	if r := thief.Do("POST", "/app/v1/me/delete", map[string]any{"confirm": bea.Email, "entries": []any{}, "human_check": map[string]any{"id": ch.Str("id"),
		"turnstile_token": goodTS, "webauthn": tk.Assert(opt(ch.J, "webauthn"), []byte(bea.AccountID))}}); r.Code() != "delete_not_ready" {
		t.Fatalf("day-0 finish: %s", r)
	}
	if !slices.Contains(mail.kinds(), "delete_asked") {
		t.Errorf("Bea was not told: %v", mail.kinds())
	}
	if p := pendingDelete(t, bea); p == nil || p["asked_here"] != false {
		t.Fatalf("Bea's own sign-in does not see it: %v", p)
	}
	if r := bea.Do("POST", "/app/v1/me/delete/cancel", nil); r.Status != 200 {
		t.Fatalf("Bea cancels: %s", r)
	}
	// the cancel also took the passkey the ask set up and ended the asker's sign-in (account_guard_test.go has the rest)
	if r := thief.Do("GET", "/app/v1/me", nil); r.Status != 401 {
		t.Fatalf("the asking sign-in after Bea's cancel: %s", r)
	}
	moveClock(t, c, bea.AccountID, 73*time.Hour)
	thief = reSignIn(t, thief)
	if r := thief.Do("POST", "/app/v1/me/delete", map[string]any{"confirm": bea.Email, "entries": []any{}, "human_check": map[string]any{"id": newID(),
		"turnstile_token": goodTS}}); r.Code() != "delete_not_asked" {
		t.Fatalf("finish after Bea cancelled: %s", r)
	}
	accountThere(t, c, bea.AccountID, 1)
}

// The reset guard applies to ask and finish; starting a reset leaves a pending delete alone; finishing one cancels it
// (the passkeys changed hands); and deletes stay held for 7 days after.
func TestAccountDeleteAndPasskeyReset(t *testing.T) {
	c := realCopy(t)
	adam := NewPerson(t, c, "Adam")
	k1, k2 := newSoftAuth("localhost", c.URL), newSoftAuth("localhost", c.URL)
	addFirstPasskey(t, c, adam, k1)
	ask := func(p *Person) *Resp {
		ch := p.Do("POST", "/app/v1/human-check", map[string]any{"action": "account_delete"})
		return p.Do("POST", "/app/v1/me/delete/ask", map[string]any{"confirm": p.Email, "human_check": map[string]any{"id": ch.Str("id"),
			"turnstile_token": goodTS, "webauthn": k1.Assert(opt(ch.J, "webauthn"), []byte(adam.AccountID))}})
	}
	finish := func(p *Person) *Resp {
		ch := p.Do("POST", "/app/v1/human-check", map[string]any{"action": "account_delete"})
		return p.Do("POST", "/app/v1/me/delete", map[string]any{"confirm": p.Email, "entries": []any{}, "human_check": map[string]any{"id": ch.Str("id"),
			"turnstile_token": goodTS, "webauthn": k1.Assert(opt(ch.J, "webauthn"), []byte(adam.AccountID))}})
	}
	if r := ask(adam); r.Status != 201 {
		t.Fatalf("ask: %s", r)
	}
	// a reset starts: the pending delete stays
	if r := adam.Do("POST", "/app/v1/me/passkey-reset", nil); r.Status != 201 {
		t.Fatalf("start reset: %s", r)
	}
	if pendingDelete(t, adam) == nil {
		t.Fatal("starting a reset cancelled the pending delete")
	}
	moveClock(t, c, adam.AccountID, 72*time.Hour+time.Second)
	if r := finish(adam); r.Code() != "delete_held" {
		t.Fatalf("finish with a reset open: %s", r)
	}
	// the reset finishes (same browser, signed in again): the pending delete is cancelled
	adam = signInHere(t, adam)
	ch := resetCheck(t, adam, "finish")
	if r := adam.Do("POST", "/app/v1/me/passkey-reset/finish", map[string]any{"human_check": map[string]any{"id": ch.Str("id"), "turnstile_token": goodTS,
		"webauthn": k2.Register(opt(ch.J, "webauthn"))}}); r.Status != 200 {
		t.Fatalf("finish reset: %s", r)
	}
	if pendingDelete(t, adam) != nil {
		t.Fatal("a finished reset left the delete pending")
	}
	if n := count(t, c, `select count(*) from account_deletes where account_id = $1 and cancelled_by = 'passkey_reset'`, adam.AccountID); n != 1 {
		t.Error("cancel by reset not recorded")
	}
	// held for 7 days after the reset: ask refused, with the date
	ch = adam.Do("POST", "/app/v1/human-check", map[string]any{"action": "account_delete"})
	r := adam.Do("POST", "/app/v1/me/delete/ask", map[string]any{"confirm": adam.Email, "human_check": map[string]any{"id": ch.Str("id"),
		"turnstile_token": goodTS, "webauthn": k2.Assert(opt(ch.J, "webauthn"), []byte(adam.AccountID))}})
	if r.Code() != "delete_held" {
		t.Fatalf("ask right after a reset: %s", r)
	}
	accountThere(t, c, adam.AccountID, 0)
}
