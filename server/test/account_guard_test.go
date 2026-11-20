package test

import (
	"slices"
	"testing"
	"time"
)

// Third security pass at 9f90062 (fix-all, last builder): an account's first passkey and the delete wait.
// Finding 1: a passkey set up for a day-0 delete ask stayed after the owner cancelled, and with it the attacker kept
// answering the owner's approvals, removing the owner's browser and cancelling the owner's reset. Finding 2: without
// mail, the wait only protects an owner who looks. Server: appapi/account_guard.go.

// moveAll is moveClock plus the passkey times (made, first passkey of the account) and browsers.
func moveAll(t *testing.T, c *Copy, account string, d time.Duration) {
	t.Helper()
	moveClock(t, c, account, d)
	iv := d.String()
	exec(t, c, `update webauthn_credentials set created_at = created_at - $2::interval, last_used_at = last_used_at - $2::interval where account_id = $1`, account, iv)
	exec(t, c, `update accounts set had_passkey_at = had_passkey_at - $2::interval where id = $1`, account, iv)
	exec(t, c, `update devices set created_at = created_at - $2::interval where account_id = $1`, account, iv)
}

// proofWith starts the human check body as p and answers it with k (a passkey assertion). A check that can't start
// (no passkey on the account) gives a proof that fails.
func proofWith(t *testing.T, p *Person, k *softAuthenticator, body map[string]any) map[string]any {
	t.Helper()
	ch := p.Do("POST", "/app/v1/human-check", body)
	if ch.Status != 200 || step(ch.J) != "assert" {
		return map[string]any{"id": newID(), "turnstile_token": goodTS}
	}
	return map[string]any{"id": ch.Str("id"), "turnstile_token": goodTS, "webauthn": k.Assert(opt(ch.J, "webauthn"), []byte(p.AccountID))}
}

func passkeyCount(t *testing.T, c *Copy, account string) int {
	return count(t, c, `select count(*) from webauthn_credentials where account_id = $1`, account)
}

// The three things the reviewer's attacker did with the passkey left behind: (i) answer an approval, (ii) remove the
// owner's browser with freeze_ok, (iii) cancel the owner's passkey reset. want is "human_check_failed" when they must
// all be refused for want of a working passkey; "" means they must all pass the passkey (control).
func attackerUses(t *testing.T, c *Copy, thief, owner *Person, tk *softAuthenticator, joinReq, ownerDev string, refused bool) {
	t.Helper()
	// (i) a join approval: the human check comes first; past it, the thief's browser can't sign in the room anyway
	r := thief.Do("POST", "/app/v1/join-requests/"+joinReq+"/approve", map[string]any{
		"human_check": proofWith(t, thief, tk, map[string]any{"action": "approve_join", "target_id": joinReq}), "roster_entry": map[string]any{}})
	if refused != (r.Code() == "human_check_failed") {
		t.Errorf("(i) approval answered with the thief's passkey (refused=%v): %s", refused, r)
	}
	// (ii) remove the owner's browser, rooms freezing accepted
	r = thief.Do("POST", "/app/v1/devices/"+ownerDev+"/remove", map[string]any{"human_check": proofWith(t, thief, tk,
		map[string]any{"action": "device_remove", "target_id": ownerDev}), "entries": []any{}, "freeze_ok": true, "keep_ids": []string{b64u(tk.credID)}})
	if refused != (r.Code() == "human_check_failed") {
		t.Errorf("(ii) the owner's browser removed with the thief's passkey (refused=%v): %s", refused, r)
	}
	// (iii) cancel the owner's passkey reset (the thief's sign-in is newer than it, so it needs a passkey)
	ch := resetCheck(t, thief, "cancel")
	proof := map[string]any{"id": newID(), "turnstile_token": goodTS}
	if ch.Status == 200 && step(ch.J) == "assert" {
		proof = map[string]any{"id": ch.Str("id"), "turnstile_token": goodTS, "webauthn": tk.Assert(opt(ch.J, "webauthn"), []byte(owner.AccountID))}
	}
	r = thief.Do("POST", "/app/v1/me/passkey-reset/cancel", map[string]any{"human_check": proof})
	if refused != (r.Code() == "human_check_failed") {
		t.Errorf("(iii) the owner's reset cancelled with the thief's passkey (refused=%v): %s", refused, r)
	}
}

// Finding 1, the reviewer's sequence: an account that never had a passkey; someone with only its Google or GitHub
// sign-in asks to delete it, which sets up their passkey; the owner cancels from the sign-in they had. Now that
// passkey goes with the cancel, the attacker's sign-ins end, and afterwards it answers nothing of the owner's.
func TestDay0CancelRemovesTheAsksPasskey(t *testing.T) {
	c := realCopy(t)
	bea := NewPerson(t, c, "Bea")
	room := bea.CreateRoom("studio")
	moveAll(t, c, bea.AccountID, 3*24*time.Hour) // Bea's sign-in is days old

	thief := signInAgain(t, bea, "Somewhere else")
	tk := newSoftAuth("localhost", c.URL)
	ch := thief.Do("POST", "/app/v1/human-check", map[string]any{"action": "account_delete"})
	if step(ch.J) != "register" {
		t.Fatalf("no passkey yet: step %v", step(ch.J))
	}
	if r := thief.Do("POST", "/app/v1/me/delete/ask", map[string]any{"confirm": bea.Email, "human_check": map[string]any{"id": ch.Str("id"),
		"turnstile_token": goodTS, "webauthn": tk.Register(opt(ch.J, "webauthn"))}}); r.Status != 201 {
		t.Fatalf("ask: %s", r)
	}
	if n := passkeyCount(t, c, bea.AccountID); n != 1 {
		t.Fatalf("passkeys after the ask: %d", n)
	}
	if p := pendingDelete(t, bea); p == nil || p["first_passkey"] != true {
		t.Fatalf("Bea's view of the ask: %v", p)
	}
	agent := NewAgentKeys(t, "helper")
	if r := agent.Join(c, bea.Invite(room)); r.Status != 201 {
		t.Fatalf("join: %s", r)
	}
	// control: before the cancel, the passkey answers all three (what the reviewer proved); (ii) and (iii) are only
	// checked after, so they don't change the account here
	r := thief.Do("POST", "/app/v1/join-requests/"+agent.ReqID+"/approve", map[string]any{
		"human_check": proofWith(t, thief, tk, map[string]any{"action": "approve_join", "target_id": agent.ReqID}), "roster_entry": map[string]any{}})
	if r.Code() == "human_check_failed" {
		t.Fatalf("control: the passkey did not pass an approval check: %s", r)
	}

	// Bea cancels without a passkey
	r = bea.Do("POST", "/app/v1/me/delete/cancel", nil)
	if r.Status != 200 || r.J["first_passkey_removed"] != true || r.J["passkeys_removed"] != float64(1) || r.J["sign_ins_ended"].(float64) < 1 {
		t.Fatalf("Bea cancels: %s", r)
	}
	if n := passkeyCount(t, c, bea.AccountID); n != 0 {
		t.Fatalf("the ask's passkey stayed: %d", n)
	}
	if n := count(t, c, `select count(*) from accounts where id = $1 and had_passkey_at is null`, bea.AccountID); n != 1 {
		t.Error("the account still counts as having had a passkey")
	}
	if r := thief.Do("GET", "/app/v1/me", nil); r.Status != 401 {
		t.Errorf("the asking sign-in still works: %s", r)
	}
	if r := bea.Do("GET", "/app/v1/me", nil); r.Status != 200 {
		t.Errorf("the cancelling sign-in ended: %s", r)
	}
	if n := count(t, c, `select count(*) from account_events where account_id = $1 and kind = 'account_delete_cancelled'
		and data->>'by' = 'session' and (data->>'passkeys_removed')::int = 1 and data->>'actor_user_agent' is not null`, bea.AccountID); n != 1 {
		t.Error("the cancel and what it removed are not recorded")
	}

	// Bea sets up her own first passkey (a fresh sign-in), starts a reset in another browser of hers; the attacker
	// signs in again with the Google account, after all that
	kb := newSoftAuth("localhost", c.URL)
	fresh := reSignIn(t, bea)
	addFirstPasskey(t, c, fresh, kb)
	resetter := reSignIn(t, bea)
	if r := resetter.Do("POST", "/app/v1/me/passkey-reset", nil); r.Status != 201 {
		t.Fatalf("Bea starts a reset: %s", r)
	}
	thief = reSignIn(t, thief)
	attackerUses(t, c, thief, bea, tk, agent.ReqID, bea.DevID, true)
	if r := thief.Do("POST", "/app/v1/me/first-passkey/remove", map[string]any{}); r.Status != 403 {
		t.Errorf("a sign-in made after Bea's passkey removed it: %s", r)
	}
	if passkeyCount(t, c, bea.AccountID) != 1 || pending(t, bea) == nil {
		t.Error("Bea's passkey or reset is gone")
	}
	if r := bea.Do("GET", "/app/v1/me", nil); r.Status != 200 {
		t.Errorf("Bea signed out: %s", r)
	}
}

// The other direction: the cancel can't be used against an owner.
func TestDeleteCancelRemovesNothingElse(t *testing.T) {
	c := realCopy(t)
	// 1. a cancel proved by a passkey removes nothing, even the ask's own; nobody is signed out
	bea := NewPerson(t, c, "Bea")
	moveAll(t, c, bea.AccountID, 3*24*time.Hour)
	thief := signInAgain(t, bea, "Somewhere else")
	tk := newSoftAuth("localhost", c.URL)
	ch := thief.Do("POST", "/app/v1/human-check", map[string]any{"action": "account_delete"})
	if r := thief.Do("POST", "/app/v1/me/delete/ask", map[string]any{"confirm": bea.Email, "human_check": map[string]any{"id": ch.Str("id"),
		"turnstile_token": goodTS, "webauthn": tk.Register(opt(ch.J, "webauthn"))}}); r.Status != 201 {
		t.Fatalf("ask: %s", r)
	}
	ch = thief.Do("POST", "/app/v1/human-check", map[string]any{"action": "account_delete"})
	r := thief.Do("POST", "/app/v1/me/delete/cancel", map[string]any{"human_check": map[string]any{"id": ch.Str("id"), "turnstile_token": goodTS,
		"webauthn": tk.Assert(opt(ch.J, "webauthn"), []byte(bea.AccountID))}})
	if r.Status != 200 || r.Str("cancelled_by") != "passkey" || r.J["first_passkey_removed"] != false {
		t.Fatalf("cancel with the passkey: %s", r)
	}
	if passkeyCount(t, c, bea.AccountID) != 1 {
		t.Error("a cancel proved by a passkey removed one")
	}
	if r := bea.Do("GET", "/app/v1/me", nil); r.Status != 200 {
		t.Errorf("a cancel proved by a passkey signed Bea out: %s", r)
	}
	// (that passkey is still the account's first and Bea's sign-in is older: she removes it under rule 2)
	if r := bea.Do("POST", "/app/v1/me/first-passkey/remove", map[string]any{}); r.Status != 200 || r.J["passkeys_removed"] != float64(1) {
		t.Fatalf("Bea removes the first passkey: %s", r)
	}

	// 2. an account that had a passkey before the ask: a cancel without one removes nothing and signs nobody out,
	// even the passkey Adam added after he asked; the canceller is someone with only the Google sign-in
	adam := NewPerson(t, c, "Adam")
	k1, k2 := newSoftAuth("localhost", c.URL), newSoftAuth("localhost", c.URL)
	addFirstPasskey(t, c, adam, k1)
	moveAll(t, c, adam.AccountID, 4*24*time.Hour)
	ch = adam.Do("POST", "/app/v1/human-check", map[string]any{"action": "account_delete"})
	if r := adam.Do("POST", "/app/v1/me/delete/ask", map[string]any{"confirm": adam.Email, "human_check": map[string]any{"id": ch.Str("id"),
		"turnstile_token": goodTS, "webauthn": k1.Assert(opt(ch.J, "webauthn"), []byte(adam.AccountID))}}); r.Status != 201 {
		t.Fatalf("Adam asks: %s", r)
	}
	if p := pendingDelete(t, adam); p["first_passkey"] != false {
		t.Errorf("an ask on an account that had a passkey shown as setting up the first: %v", p)
	}
	addPasskey(t, adam, k1, k2)
	google := signInAgain(t, adam, "Attacker")
	if r := google.Do("POST", "/app/v1/me/delete/cancel", nil); r.Status != 200 || r.J["first_passkey_removed"] != false {
		t.Fatalf("cancel by a Google-only sign-in: %s", r)
	}
	if passkeyCount(t, c, adam.AccountID) != 2 {
		t.Error("a cancel without a passkey removed one of Adam's")
	}
	if r := adam.Do("GET", "/app/v1/me", nil); r.Status != 200 {
		t.Errorf("a cancel without a passkey signed Adam out: %s", r)
	}
	if r := google.Do("POST", "/app/v1/me/first-passkey/remove", map[string]any{}); r.Status != 403 {
		t.Errorf("rule 2 used by a sign-in made after the passkey, days later: %s", r)
	}
}

// Rule 2: for 72 h after an account's first passkey, a sign-in made before it may remove it without a passkey (the
// planted passkey with "Add a passkey", no delete at all). Sign-ins made after the remover's end. Not after 72 h, and
// never from a sign-in made after the passkey.
func TestFirstPasskeyRemovableByOlderSignIn(t *testing.T) {
	c := realCopy(t)
	bea := NewPerson(t, c, "Bea")
	bea.CreateRoom("studio")
	moveAll(t, c, bea.AccountID, 2*24*time.Hour)
	thief := signInAgain(t, bea, "Somewhere else")
	tk := newSoftAuth("localhost", c.URL)
	addFirstPasskey(t, c, thief, tk)
	st := resetState(t, bea)
	fp, _ := st["first_passkey_undo"].(map[string]any)
	if fp == nil || fp["until"] == nil {
		t.Fatalf("Bea's older sign-in is not offered the removal: %v", st)
	}
	if r := bea.Do("POST", "/app/v1/me/first-passkey/remove", map[string]any{}); r.Status != 200 || r.J["passkeys_removed"] != float64(1) || r.J["sign_ins_ended"] != float64(1) {
		t.Fatalf("Bea removes it: %s", r)
	}
	if passkeyCount(t, c, bea.AccountID) != 0 {
		t.Fatal("still there")
	}
	if r := thief.Do("GET", "/app/v1/me", nil); r.Status != 401 {
		t.Errorf("the newer sign-in still works: %s", r)
	}
	if k := eventKinds(t, c, bea.AccountID); !slices.Contains(k, "first_passkey_removed") {
		t.Errorf("events: %v", k)
	}
	// after 72 h: no longer
	thief = reSignIn(t, thief)
	addFirstPasskey(t, c, thief, newSoftAuth("localhost", c.URL))
	moveAll(t, c, bea.AccountID, 72*time.Hour+time.Minute)
	if r := bea.Do("POST", "/app/v1/me/first-passkey/remove", map[string]any{}); r.Status != 403 {
		t.Errorf("removed after 72 h: %s", r)
	}
	if st := resetState(t, bea); st["first_passkey_undo"] != nil {
		t.Errorf("offered after 72 h: %v", st["first_passkey_undo"])
	}

	// the owner sets up her own first passkey and signs out the other browsers; whoever signs in with the Google
	// account afterwards can't remove it
	cat := NewPerson(t, c, "Cat")
	kc := newSoftAuth("localhost", c.URL)
	addFirstPasskey(t, c, cat, kc)
	google := signInAgain(t, cat, "Attacker")
	if r := google.Do("POST", "/app/v1/me/first-passkey/remove", map[string]any{}); r.Status != 403 {
		t.Errorf("a sign-in made after Cat's first passkey removed it: %s", r)
	}
	if passkeyCount(t, c, cat.AccountID) != 1 {
		t.Error("Cat's passkey is gone")
	}
}

// Finding 2's way out, end to end: a thief and the owner share one synced passkey k1. The owner adds a new passkey k2
// (confirmed with k1) and removes k1 (confirmed with k2). After that the thief's ask, revoke and reset cancel fail.
func TestSyncedPasskeyWayOut(t *testing.T) {
	c := realCopy(t)
	adam := NewPerson(t, c, "Adam")
	room := adam.CreateRoom("family")
	k1, k2 := newSoftAuth("localhost", c.URL), newSoftAuth("localhost", c.URL)
	addFirstPasskey(t, c, adam, k1)
	moveAll(t, c, adam.AccountID, 4*24*time.Hour)
	agent := NewAgentKeys(t, "helper")
	if r := agent.Join(c, adam.Invite(room)); r.Status != 201 {
		t.Fatalf("join: %s", r)
	}
	thief := signInAgain(t, adam, "Stolen laptop")
	// control: k1 answers an approval for the thief
	r := thief.Do("POST", "/app/v1/join-requests/"+agent.ReqID+"/approve", map[string]any{
		"human_check": proofWith(t, thief, k1, map[string]any{"action": "approve_join", "target_id": agent.ReqID}), "roster_entry": map[string]any{}})
	if r.Code() == "human_check_failed" {
		t.Fatalf("control: k1 did not pass an approval check: %s", r)
	}

	// step 1: add a new passkey, confirmed with the shared one; step 2: remove the shared one, confirmed with the new one
	addPasskey(t, adam, k1, k2)
	ch := adam.Do("POST", "/app/v1/human-check", map[string]any{"action": "passkey_remove"})
	if r := adam.Do("POST", "/app/v1/me/passkeys/remove", map[string]any{"credential_id": b64u(k1.credID), "human_check": map[string]any{"id": ch.Str("id"),
		"turnstile_token": goodTS, "webauthn": k2.Assert(opt(ch.J, "webauthn"), []byte(adam.AccountID))}}); r.Status != 200 {
		t.Fatalf("remove the shared passkey: %s", r)
	}
	ch = thief.Do("POST", "/app/v1/human-check", map[string]any{"action": "account_delete"})
	if r := thief.Do("POST", "/app/v1/me/delete/ask", map[string]any{"confirm": adam.Email, "human_check": map[string]any{"id": ch.Str("id"),
		"turnstile_token": goodTS, "webauthn": k1.Assert(opt(ch.J, "webauthn"), []byte(adam.AccountID))}}); r.Code() != "human_check_failed" {
		t.Errorf("the thief asks to delete with k1: %s", r)
	}
	// Adam has a reset waiting (to show the thief can't cancel it)
	fresh := reSignIn(t, adam)
	if r := fresh.Do("POST", "/app/v1/me/passkey-reset", nil); r.Status != 201 {
		t.Fatalf("reset: %s", r)
	}
	attackerUses(t, c, thief, adam, k1, agent.ReqID, adam.DevID, true)
	if r := adam.Do("GET", "/app/v1/me", nil); r.Status != 200 {
		t.Errorf("Adam signed out: %s", r)
	}
}

// A pending delete is cancelled when a browser is removed or the others are signed out; a new ask is then paused for
// 24 h. Both are recorded.
func TestDeleteCancelledBySignOutAndRemoval(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A")
	dana := NewPerson(t, c, "Dana")
	other := signInAgain(t, dana, "Dana's phone")
	askDelete(t, dana)
	r := other.Do("POST", "/app/v1/me/sessions/sign-out-others", nil)
	if r.Status != 200 || r.J["delete_cancelled"] != true || r.J["signed_out"] != float64(1) {
		t.Fatalf("sign out others: %s", r)
	}
	if pendingDelete(t, other) != nil {
		t.Fatal("still pending after sign out others")
	}
	ask := func() *Resp {
		return other.Do("POST", "/app/v1/me/delete/ask", map[string]any{"confirm": dana.Email, "human_check": map[string]any{"id": other.Check("account_delete", ""), "stub": true}})
	}
	if r := ask(); r.Code() != "delete_held" || r.J["error"].(map[string]any)["details"].(map[string]any)["until"] == nil {
		t.Fatalf("ask right after sign out others: %s", r)
	}
	if p := deletePlan(t, other); p["ask_paused_until"] == nil {
		t.Errorf("the plan does not say asks are paused: %v", p)
	}
	moveClock(t, c, dana.AccountID, 24*time.Hour+time.Minute)
	if r := ask(); r.Status != 201 {
		t.Fatalf("ask a day later: %s", r)
	}
	third := signInAgain(t, dana, "Dana's tablet")
	if r := removeDevice(t, other, third.DevID, []map[string]any{}, false); r.Status != 200 {
		t.Fatalf("remove a browser: %s", r)
	}
	if pendingDelete(t, other) != nil {
		t.Fatal("still pending after removing a browser")
	}
	if r := ask(); r.Code() != "delete_held" {
		t.Fatalf("ask right after removing a browser: %s", r)
	}
	n := count(t, c, `select count(*) from account_deletes where account_id = $1 and cancelled_by in ('signed_out', 'browser_removed')`, dana.AccountID)
	if n != 2 {
		t.Errorf("automatic cancels recorded: %d", n)
	}
	if k := eventKinds(t, c, dana.AccountID); !slices.Contains(k, "signed_out_others") || !slices.Contains(k, "device_removed") {
		t.Errorf("events: %v", k)
	}
}

// Finding 2, the reviewer's sequence, with the pause in: what still goes through. A thief with a synced passkey
// removes the owner's browser and asks; the ask is paused for a day, the thief asks again; the owner looks, cancels;
// the thief signs the owner out, which cancels nothing new and pauses asks again. If nobody looks for the whole wait
// after that, the delete finishes: the wait only protects an owner who looks (no mail).
func TestDeleteWaitOnlyProtectsWhoLooks(t *testing.T) {
	c := realCopy(t)
	adam := NewPerson(t, c, "Adam")
	adam.CreateRoom("family")
	k1 := newSoftAuth("localhost", c.URL)
	addFirstPasskey(t, c, adam, k1)
	moveAll(t, c, adam.AccountID, 3*24*time.Hour)
	thief := signInAgain(t, adam, "Stolen laptop")
	ask := func() *Resp {
		return thief.Do("POST", "/app/v1/me/delete/ask", map[string]any{"confirm": adam.Email,
			"human_check": proofWith(t, thief, k1, map[string]any{"action": "account_delete"})})
	}
	r := thief.Do("POST", "/app/v1/devices/"+adam.DevID+"/remove", map[string]any{"human_check": proofWith(t, thief, k1,
		map[string]any{"action": "device_remove", "target_id": adam.DevID}), "entries": []any{}, "freeze_ok": true, "keep_ids": []string{b64u(k1.credID)}})
	if r.Status != 200 {
		t.Fatalf("thief removes Adam's browser: %s", r)
	}
	if r := ask(); r.Code() != "delete_held" {
		t.Fatalf("ask right after removing a browser: %s", r)
	}
	moveAll(t, c, adam.AccountID, 24*time.Hour+time.Minute)
	if r := ask(); r.Status != 201 {
		t.Fatalf("ask a day later: %s", r)
	}
	back := reSignIn(t, adam)
	if r := back.Do("POST", "/app/v1/me/delete/cancel", nil); r.Status != 200 {
		t.Fatalf("Adam cancels: %s", r)
	}
	if r := thief.Do("POST", "/app/v1/me/sessions/sign-out-others", nil); r.Status != 200 || r.J["delete_cancelled"] != false {
		t.Fatalf("thief signs Adam out: %s", r)
	}
	if r := ask(); r.Code() != "delete_held" {
		t.Fatalf("re-ask right after signing out others: %s", r)
	}
	moveAll(t, c, adam.AccountID, 24*time.Hour+time.Minute)
	if r := ask(); r.Status != 201 {
		t.Fatalf("ask the next day: %s", r)
	}
	moveAll(t, c, adam.AccountID, 72*time.Hour+time.Minute)
	r = thief.Do("POST", "/app/v1/me/delete", map[string]any{"confirm": adam.Email, "entries": []any{},
		"human_check": proofWith(t, thief, k1, map[string]any{"action": "account_delete"})})
	if r.Status != 200 {
		t.Fatalf("nobody looked for the wait: the delete finishes (no mail): %s", r)
	}
}
