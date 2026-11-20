package test

import (
	"encoding/hex"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/charles161/botlink/server/internal/config"
	"github.com/charles161/botlink/server/internal/testkit"
	"github.com/charles161/botlink/server/internal/wire"
)

// Follow-ups to the security review of fix-all (16 Nov 2026), lane RECOVER: removing a browser deals with the passkeys
// that live there; destructive actions wait around a reset; an account that had a passkey never falls back to a fresh
// sign-in; passkey-set changes are serialised per account.

// proveBrowser asks for a challenge and answers it, signed with key as browser devID (re-review: a sign-in's browser
// label must be proved by that browser's own key).
func proveBrowser(p *Person, devID string, key testkit.Key) *Resp {
	ch := p.Do("POST", "/app/v1/me/browser/challenge", map[string]any{})
	if ch.Status != 200 {
		return ch
	}
	raw, _ := wire.DecodeB64URL(ch.Str("challenge"))
	sig := wire.Sign(key.Priv, "botlink-browser-proof-v1", append(raw, []byte(devID)...))
	return p.Do("POST", "/app/v1/me/browser", map[string]any{"device_id": devID, "proof_id": ch.Str("id"), "sig": hex.EncodeToString(sig)})
}

// bindBrowser proves which browser key this sign-in uses (the dashboard does it on every page load).
func bindBrowser(t *testing.T, p *Person) {
	t.Helper()
	if r := proveBrowser(p, p.DevID, p.Dev); r.Status != 200 {
		t.Fatalf("bind browser: %s", r)
	}
}

// addPasskey adds nk to p's account, confirmed with the existing passkey with.
func addPasskey(t *testing.T, p *Person, with, nk *softAuthenticator) {
	t.Helper()
	ch := p.Do("POST", "/app/v1/human-check", map[string]any{"action": "webauthn_register"})
	if ch.Status != 200 {
		t.Fatalf("add passkey check: %s", ch)
	}
	if r := p.Do("POST", "/app/v1/me/passkeys", map[string]any{"human_check": map[string]any{"id": ch.Str("id"), "turnstile_token": goodTS,
		"webauthn": with.Assert(opt(ch.J, "webauthn"), []byte(p.AccountID))}, "credential": nk.Register(opt(ch.J, "register"))}); r.Status != 200 {
		t.Fatalf("add passkey: %s", r)
	}
}

func passkeyRow(t *testing.T, p *Person, k *softAuthenticator) map[string]any {
	t.Helper()
	for _, x := range p.Do("GET", "/app/v1/me/passkeys", nil).J["passkeys"].([]any) {
		if m := x.(map[string]any); m["id"] == b64u(k.credID) {
			return m
		}
	}
	return nil
}

// removeWith removes devID asserting with k, taking out the passkeys named; every other passkey of the account is kept
// (named in keep_ids: the server wants a choice for each passkey whose place it can't tell).
func removeWith(t *testing.T, p *Person, devID string, k *softAuthenticator, passkeys ...*softAuthenticator) *Resp {
	return removeChoose(t, p, devID, k, passkeys, nil, true)
}

func removeChoose(t *testing.T, p *Person, devID string, k *softAuthenticator, drop, keep []*softAuthenticator, keepRest bool) *Resp {
	t.Helper()
	ch := p.Do("POST", "/app/v1/human-check", map[string]any{"action": "device_remove", "target_id": devID})
	if ch.Status != 200 {
		return ch
	}
	ids, keeps := []string{}, []string{}
	for _, x := range drop {
		ids = append(ids, b64u(x.credID))
	}
	for _, x := range keep {
		keeps = append(keeps, b64u(x.credID))
	}
	if keepRest {
		for _, x := range p.Do("GET", "/app/v1/me/passkeys", nil).J["passkeys"].([]any) {
			id := x.(map[string]any)["id"].(string)
			if !slices.Contains(ids, id) {
				keeps = append(keeps, id)
			}
		}
	}
	return p.Do("POST", "/app/v1/devices/"+devID+"/remove", map[string]any{"human_check": map[string]any{"id": ch.Str("id"), "turnstile_token": goodTS,
		"webauthn": k.Assert(opt(ch.J, "webauthn"), []byte(p.AccountID))}, "entries": []any{}, "passkey_ids": ids, "keep_ids": keeps})
}

// The reviewer's sequence: the person removes the lost laptop; the thief signs in again there and uses the laptop's
// passkey to revoke the person's own browser (and then delete the account). Removing a browser now removes the
// passkeys chosen in the same step, and the server knows which passkeys were made or last used in that browser.
func TestRemoveBrowserRemovesItsPasskeys(t *testing.T) {
	c := realCopy(t)
	adam := NewPerson(t, c, "Adam")
	bindBrowser(t, adam)
	kA, kL := newSoftAuth("localhost", c.URL), newSoftAuth("localhost", c.URL)
	addFirstPasskey(t, c, adam, kA)
	lost := signInAgain(t, adam, "Lost laptop")
	bindBrowser(t, lost)
	addPasskey(t, lost, kA, kL) // the laptop's own passkey, made there

	// where each passkey lives, as far as the server can tell
	if m := passkeyRow(t, adam, kL); m == nil || m["created_device_id"] != lost.DevID || m["last_used_device_id"] != nil {
		t.Fatalf("laptop passkey record: %v", m)
	}
	if m := passkeyRow(t, adam, kA); m == nil || m["created_device_id"] != adam.DevID || m["last_used_device_id"] != lost.DevID {
		t.Fatalf("everyday passkey record: %v", m)
	}
	// another account's passkey id: not found, nothing changes
	if r := removeWith(t, adam, lost.DevID, kA, newSoftAuth("localhost", c.URL)); r.Status != 404 {
		t.Fatalf("a passkey that isn't the account's: %s", r)
	}
	if n := count(t, c, `select count(*) from devices where id = $1 and revoked_at is not null`, lost.DevID); n != 0 {
		t.Fatal("a refused removal revoked the browser")
	}
	// the passkey answering the check is named too: it stays (said in the answer), the other one goes
	r := removeWith(t, adam, lost.DevID, kA, kA, kL)
	if r.Status != 200 || r.J["passkeys_removed"] != float64(1) || r.J["answering_kept"] != true {
		t.Fatalf("remove the laptop and its passkey: %s", r)
	}
	if n := count(t, c, `select count(*) from webauthn_credentials where id = $1`, kA.credID); n != 1 {
		t.Fatal("the answering passkey was removed")
	}
	if n := count(t, c, `select count(*) from webauthn_credentials where id = $1`, kL.credID); n != 0 {
		t.Fatal("the laptop's passkey still works")
	}
	// the thief on the laptop: one provider click signs in again; the laptop's passkey answers nothing any more
	thief := reSignIn(t, lost)
	if r := removeWith(t, thief, adam.DevID, kL); r.Code() != "human_check_failed" {
		t.Fatalf("the thief revoked the person's browser with the laptop's passkey: %s", r)
	}
	if r := adam.Do("GET", "/app/v1/me", nil); r.Status != 200 {
		t.Fatalf("the person was signed out by the thief: %s", r)
	}
}

// finishResetHere runs a whole reset for p's browser and finishes it with nk (the clock moved, never slept).
func finishResetHere(t *testing.T, c *Copy, p *Person, nk *softAuthenticator) *Person {
	t.Helper()
	p = signInHere(t, p)
	if r := p.Do("POST", "/app/v1/me/passkey-reset", nil); r.Status != 201 {
		t.Fatalf("start: %s", r)
	}
	moveClock(t, c, p.AccountID, 72*time.Hour+time.Second)
	p = signInHere(t, p)
	ch := resetCheck(t, p, "finish")
	if r := p.Do("POST", "/app/v1/me/passkey-reset/finish", map[string]any{"human_check": map[string]any{"id": ch.Str("id"), "turnstile_token": goodTS,
		"webauthn": nk.Register(opt(ch.J, "webauthn"))}}); r.Status != 200 {
		t.Fatalf("finish: %s", r)
	}
	return p
}

// deleteAccount asks to delete p's account (unless an ask waits) and finishes it, each with passkey k; on a server with
// no wait (noWait) the finish follows at once. It returns the first refusal, or the finish.
func deleteAccount(t *testing.T, p *Person, k *softAuthenticator) *Resp {
	t.Helper()
	if v, _ := p.Do("GET", "/app/v1/me/delete", nil).J["pending"].(map[string]any); v == nil {
		ch := p.Do("POST", "/app/v1/human-check", map[string]any{"action": "account_delete"})
		if ch.Status != 200 {
			return ch
		}
		if r := p.Do("POST", "/app/v1/me/delete/ask", map[string]any{"confirm": p.Email,
			"human_check": map[string]any{"id": ch.Str("id"), "turnstile_token": goodTS, "webauthn": k.Assert(opt(ch.J, "webauthn"), []byte(p.AccountID))}}); r.Status != 201 {
			return r
		}
	}
	ch := p.Do("POST", "/app/v1/human-check", map[string]any{"action": "account_delete"})
	if ch.Status != 200 {
		return ch
	}
	return p.Do("POST", "/app/v1/me/delete", map[string]any{"confirm": p.Email, "entries": []any{},
		"human_check": map[string]any{"id": ch.Str("id"), "turnstile_token": goodTS, "webauthn": k.Assert(opt(ch.J, "webauthn"), []byte(p.AccountID))}})
}

// Whoever controls only the Google or GitHub account and lets a reset run out must not then delete the account (and every
// room it owns, for all members) at once: delete waits while a reset is open and for 7 days after one finished. Export
// needs a fresh sign-in, never a passkey (a person who lost theirs must still get their data).
func TestResetGuardsDeleteAndExport(t *testing.T) {
	c := realCopy(t, noWait) // the reset guard on its own; the delete's own wait is account_wait_test.go
	eve := NewPerson(t, c, "Eve")
	k1, k2 := newSoftAuth("localhost", c.URL), newSoftAuth("localhost", c.URL)
	addFirstPasskey(t, c, eve, k1)
	// export: a fresh sign-in, no passkey
	if r := eve.Do("GET", "/app/v1/me/export", nil); r.Status != 200 {
		t.Fatalf("export from a fresh sign-in: %s", r)
	}
	exec(t, c, `update web_sessions set created_at = created_at - interval '1 hour' where account_id = $1`, eve.AccountID)
	if r := eve.Do("GET", "/app/v1/me/export", nil); r.Status != 403 || r.Code() != "reauth_required" {
		t.Fatalf("export from an hour-old sign-in: %s", r)
	}
	// a reset is open: delete waits
	eve = signInHere(t, eve)
	if r := eve.Do("POST", "/app/v1/me/passkey-reset", nil); r.Status != 201 {
		t.Fatalf("start: %s", r)
	}
	if r := deleteAccount(t, eve, k1); r.Status != 409 || r.Code() != "delete_held" {
		t.Fatalf("delete while a reset waits: %s", r)
	}
	eve.Do("POST", "/app/v1/me/passkey-reset/cancel", map[string]any{})
	exec(t, c, `update passkey_resets set created_at = created_at - interval '2 days' where account_id = $1`, eve.AccountID) // keep the day's limit out of it
	// a reset finished: delete waits 7 days, and says until when
	eve = finishResetHere(t, c, eve, k2)
	r := deleteAccount(t, eve, k2)
	if r.Status != 409 || r.Code() != "delete_held" {
		t.Fatalf("delete right after a reset: %s", r)
	}
	until, err := time.Parse(time.RFC3339Nano, r.J["error"].(map[string]any)["details"].(map[string]any)["until"].(string))
	if err != nil || time.Until(until) < 6*24*time.Hour || time.Until(until) > 7*24*time.Hour+time.Minute {
		t.Fatalf("held until %v (%v)", until, err)
	}
	exec(t, c, `update passkey_resets set completed_at = completed_at - interval '7 days 1 minute' where account_id = $1`, eve.AccountID)
	if r := deleteAccount(t, eve, k2); r.Status != 200 {
		t.Fatalf("delete 7 days after the reset: %s", r)
	}
}

// BOTLINK_PASSKEY_RESET=off: no reset can be started or finished; a waiting one can still be cancelled.
func TestPasskeyResetOff(t *testing.T) {
	c := realCopy(t, func(cfg *config.Config) { cfg.PasskeyReset = "off" })
	eve := NewPerson(t, c, "Eve")
	addFirstPasskey(t, c, eve, newSoftAuth("localhost", c.URL))
	if st := resetState(t, eve); st["reset_enabled"] != false {
		t.Fatalf("state: %v", st)
	}
	if r := eve.Do("POST", "/app/v1/me/passkey-reset", nil); r.Status != 409 || r.Code() != "reset_off" {
		t.Fatalf("start while off: %s", r)
	}
	if r := resetCheck(t, eve, "finish"); r.Code() != "reset_off" {
		t.Fatalf("finish check while off: %s", r)
	}
}

// An account that ever had a passkey never falls back to "a fresh sign-in instead of a passkey", even with none left:
// it needs a reset (which it may start).
func TestHadPasskeyNeverFallsBack(t *testing.T) {
	c := realCopy(t)
	eve := NewPerson(t, c, "Eve")
	addFirstPasskey(t, c, eve, newSoftAuth("localhost", c.URL))
	exec(t, c, `delete from webauthn_credentials where account_id = $1`, eve.AccountID)
	exec(t, c, `update web_sessions set uv_at = null where account_id = $1`, eve.AccountID)
	for _, b := range []map[string]any{{"action": "approve_device", "target_id": eve.DevID}, {"action": "webauthn_register"}} {
		if r := eve.Do("POST", "/app/v1/human-check", b); r.Status != 409 || r.Code() != "no_passkey" {
			t.Fatalf("%v on an account whose passkeys are gone: %s", b["action"], r)
		}
	}
	if r := eve.Do("POST", "/app/v1/me/passkey-reset", nil); r.Status != 201 {
		t.Fatalf("reset for an account whose passkeys are gone: %s", r)
	}
}

// Two removals at once, each confirmed with the other passkey: one wins, never zero passkeys left.
func TestConcurrentPasskeyRemovalsKeepOne(t *testing.T) {
	c := realCopy(t)
	adam := NewPerson(t, c, "Adam")
	k1, k2 := newSoftAuth("localhost", c.URL), newSoftAuth("localhost", c.URL)
	addFirstPasskey(t, c, adam, k1)
	addPasskey(t, adam, k1, k2)
	for round := 0; round < 5; round++ {
		if round > 0 { // put the removed one back
			gone := k1
			if count(t, c, `select count(*) from webauthn_credentials where id = $1`, k1.credID) == 1 {
				gone = k2
			}
			other := k1
			if gone == k1 {
				other = k2
			}
			*gone = *newSoftAuth("localhost", c.URL)
			addPasskey(t, adam, other, gone)
		}
		prep := func(remove, with *softAuthenticator) map[string]any {
			ch := adam.Do("POST", "/app/v1/human-check", map[string]any{"action": "passkey_remove"})
			return map[string]any{"credential_id": b64u(remove.credID), "human_check": map[string]any{"id": ch.Str("id"), "turnstile_token": goodTS,
				"webauthn": with.Assert(opt(ch.J, "webauthn"), []byte(adam.AccountID))}}
		}
		b1, b2 := prep(k1, k2), prep(k2, k1)
		var wg sync.WaitGroup
		for _, b := range []map[string]any{b1, b2} {
			wg.Add(1)
			go func(b map[string]any) { defer wg.Done(); adam.Do("POST", "/app/v1/me/passkeys/remove", b) }(b)
		}
		wg.Wait()
		if n := count(t, c, `select count(*) from webauthn_credentials where account_id = $1`, adam.AccountID); n != 1 {
			t.Fatalf("round %d: %d passkeys left", round, n)
		}
	}
}

// The re-review's mislabel: the thief's live session on the laptop claimed the person's own browser id, added a passkey,
// and the person's dashboard showed it as "made in this browser" (unticked when the laptop was removed). A label now
// needs a fresh, single-use challenge signed by that browser's own key, bound to the session.
func TestBrowserLabelNeedsProof(t *testing.T) {
	c := realCopy(t)
	adam := NewPerson(t, c, "Adam")
	bindBrowser(t, adam)
	kA, kT, kU := newSoftAuth("localhost", c.URL), newSoftAuth("localhost", c.URL), newSoftAuth("localhost", c.URL)
	addFirstPasskey(t, c, adam, kA)
	lost := signInAgain(t, adam, "Lost laptop")
	// the old unproved claim is gone
	if r := lost.Do("POST", "/app/v1/me/browser", map[string]any{"device_id": adam.DevID}); r.Status != 400 {
		t.Fatalf("an unproved claim: %s", r)
	}
	// the thief claims the person's browser: signed with the laptop's key, or with nothing that verifies
	if r := proveBrowser(lost, adam.DevID, lost.Dev); r.Status != 403 || r.Code() != "proof_failed" {
		t.Fatalf("claimed the person's browser with the laptop's key: %s", r)
	}
	if r := proveBrowser(lost, adam.DevID, testkit.NewKey()); r.Status != 403 {
		t.Fatalf("claimed the person's browser with a made-up key: %s", r)
	}
	// a challenge is single-use, short-lived and belongs to the session that asked
	ch := lost.Do("POST", "/app/v1/me/browser/challenge", map[string]any{})
	raw, _ := wire.DecodeB64URL(ch.Str("challenge"))
	body := map[string]any{"device_id": lost.DevID, "proof_id": ch.Str("id"), "sig": hex.EncodeToString(wire.Sign(lost.Dev.Priv, "botlink-browser-proof-v1", append(raw, []byte(lost.DevID)...)))}
	other := reSignIn(t, lost)
	if r := other.Do("POST", "/app/v1/me/browser", body); r.Status != 403 {
		t.Fatalf("another session used the challenge: %s", r)
	}
	exec(t, c, `update browser_proofs set expires_at = now() - interval '1 second' where id = $1`, ch.Str("id"))
	if r := lost.Do("POST", "/app/v1/me/browser", body); r.Status != 403 {
		t.Fatalf("an expired challenge: %s", r)
	}
	exec(t, c, `update browser_proofs set expires_at = now() + interval '1 minute' where id = $1`, ch.Str("id"))
	if r := lost.Do("POST", "/app/v1/me/browser", body); r.Status != 200 {
		t.Fatalf("its own browser, proved: %s", r)
	}
	if r := lost.Do("POST", "/app/v1/me/browser", body); r.Status != 403 {
		t.Fatalf("a used challenge again: %s", r)
	}
	// the thief adds a passkey from the laptop: it is shown as made on the laptop, never on the person's browser
	addPasskey(t, lost, kA, kT)
	if m := passkeyRow(t, adam, kT); m["created_device_id"] != lost.DevID {
		t.Fatalf("thief's passkey place: %v", m)
	}
	// from a session that proved nothing: unknown
	addPasskey(t, other, kA, kU)
	if m := passkeyRow(t, adam, kU); m["created_device_id"] != nil {
		t.Fatalf("unproved session's passkey place: %v", m)
	}
	// a removed browser can't prove itself
	if r := removeWith(t, adam, lost.DevID, kA, kT, kU); r.Status != 200 {
		t.Fatalf("remove the laptop: %s", r)
	}
	thief := reSignIn(t, lost)
	if r := proveBrowser(thief, lost.DevID, lost.Dev); r.Status != 403 {
		t.Fatalf("a removed browser proved itself: %s", r)
	}
}

// Passkeys whose place bot-link can't tell: the person must choose keep or remove for each; nothing is kept by default.
func TestRemoveBrowserUnknownPasskeysMustBeChosen(t *testing.T) {
	c := realCopy(t)
	adam := NewPerson(t, c, "Adam") // never proves its browser: its passkey's place is unknown
	kA := newSoftAuth("localhost", c.URL)
	addFirstPasskey(t, c, adam, kA)
	lost := signInAgain(t, adam, "Lost laptop")
	r := removeChoose(t, adam, lost.DevID, kA, nil, nil, false)
	if r.Status != 400 || r.Code() != "passkeys_unchosen" {
		t.Fatalf("removed without a choice for an unknown passkey: %s", r)
	}
	if r := removeChoose(t, adam, lost.DevID, kA, nil, []*softAuthenticator{kA}, false); r.Status != 200 {
		t.Fatalf("with the choice made: %s", r)
	}
}

// A revoked browser can't be restored: removing the only browser of an owner that can change a room's members freezes
// that room for good, so the server wants that said and accepted (freeze_ok); with a second browser approved there first,
// nothing freezes.
func TestRemoveBrowserFreezingOwnedRooms(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A")
	adam := NewPerson(t, c, "Adam")
	room := adam.CreateRoom("solo")
	other := signInAgain(t, adam, "Other browser")
	hc := other.Check("device_remove", adam.DevID)
	r := other.Do("POST", "/app/v1/devices/"+adam.DevID+"/remove", map[string]any{"human_check": map[string]any{"id": hc, "stub": true}, "entries": []any{}})
	if r.Status != 409 || r.Code() != "rooms_freeze" {
		t.Fatalf("froze an owned room silently: %s", r)
	}
	// approving the other browser there first avoids it
	if r := certify(t, adam, other, "Other browser", room); r.Status != 200 {
		t.Fatalf("certify: %s", r)
	}
	other = reSignIn(t, other)
	hc = other.Check("device_remove", adam.DevID)
	if r := other.Do("POST", "/app/v1/devices/"+adam.DevID+"/remove", map[string]any{"human_check": map[string]any{"id": hc, "stub": true},
		"entries": removeEntries(other, adam.Dev, room)}); r.Status != 200 {
		t.Fatalf("remove after approving a second browser: %s", r)
	}
	// and when it can't be avoided, freeze_ok goes ahead
	solo2 := other.CreateRoom("solo2")
	_ = solo2
	third := signInAgain(t, other, "Third")
	hc = third.Check("device_remove", other.DevID)
	if r := third.Do("POST", "/app/v1/devices/"+other.DevID+"/remove", map[string]any{"human_check": map[string]any{"id": hc, "stub": true}, "entries": []any{}}); r.Code() != "rooms_freeze" {
		t.Fatalf("second freeze: %s", r)
	}
	hc = third.Check("device_remove", other.DevID)
	if r := third.Do("POST", "/app/v1/devices/"+other.DevID+"/remove", map[string]any{"human_check": map[string]any{"id": hc, "stub": true}, "entries": []any{}, "freeze_ok": true}); r.Status != 200 {
		t.Fatalf("freeze accepted: %s", r)
	}
}
