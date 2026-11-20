package test

import (
	"encoding/hex"
	"testing"
	"time"

	"github.com/charles161/botlink/server/internal/wire"
)

// MoveRequest: chat `session` on the same computer asks to continue as old's member (critical fix H1). The request is
// signed with the member's current key from the new chat's session and carries the new chat's own keys; returns the
// new chat's agent (its request id set, the member id = old's) and the response.
func MoveRequest(c *Copy, old *Agent, session string) (*Agent, *Resp) {
	old.t.Helper()
	nw := NewAgentKeys(old.t, old.Name)
	nw.Session = session
	nw.ID, nw.Room = old.ID, old.Room
	nw.ReqID = wire.NewV7().String()
	from := *old
	from.Session = session
	r := from.Do(c, "POST", "/api/v1/me/claim", map[string]any{"session_id": session, "request": map[string]any{
		"id": nw.ReqID, "ed25519_pk": nw.Key.Hex(), "x25519_pk": hex.EncodeToString(nw.X), "app": "claude-code",
		"machine": "box", "folder": "~/acme", "turn": "wake", "job": ""}})
	return nw, r
}

// MoveApproved: MoveRequest + the person's approval (human check + member_rekey). Fails the test otherwise.
func MoveApproved(c *Copy, p *Person, room *Room, old *Agent, session string) *Agent {
	old.t.Helper()
	nw, r := MoveRequest(c, old, session)
	if r.Status != 201 || r.J["pending"] != true {
		old.t.Fatalf("move request: %s", r)
	}
	if a := p.Approve(room, nw); a.Status != 200 {
		old.t.Fatalf("approve move: %s", a)
	}
	nw.ID = old.ID
	return nw
}

// H1 (a field test T10): another chat on the same computer never takes a member over with the member's key alone.
func TestH1ClaimNeedsApproval(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A")
	adam := NewPerson(t, c, "Adam")
	room := adam.CreateRoom("h1")
	mac := adam.Member(c, room, "mac-claude")
	peer := adam.Member(c, room, "tester")
	mac.Drain(c)
	peer.Drain(c)
	exec(t, c, `update members set wake_verified_at = now() where id = $1`, mac.ID)

	// 1. an old client's bare claim from another session: refused, nothing changes
	thief := *mac
	thief.Session = "sess-qa-lead"
	if r := thief.Do(c, "POST", "/api/v1/me/claim", map[string]any{"session_id": thief.Session}); r.Status != 403 || r.Code() != "claim_needs_approval" {
		t.Fatalf("bare claim: %s", r)
	}
	if n := count(t, c, `select count(*) from members where id = $1 and holder_session = $2 and wake_verified_at is not null`, mac.ID, mac.Session); n != 1 {
		t.Fatal("holder changed by a bare claim")
	}
	// the same chat (same session id: restart / resume) is a no-op 200
	if r := mac.Do(c, "POST", "/api/v1/me/claim", map[string]any{"session_id": mac.Session}); r.Status != 200 || r.J["previous_session"] != mac.Session {
		t.Fatalf("same chat: %s", r)
	}
	// another app can't move in this way
	bad := *mac
	bad.Session = "sess-cursor"
	if r := bad.Do(c, "POST", "/api/v1/me/claim", map[string]any{"session_id": bad.Session, "request": map[string]any{
		"id": wire.NewV7().String(), "ed25519_pk": hex.EncodeToString(wire.RandBytes(32)), "x25519_pk": hex.EncodeToString(wire.RandBytes(32)),
		"app": "cursor", "machine": "box", "folder": "~/acme", "turn": "on_turn", "job": ""}}); r.Status != 400 {
		t.Fatalf("cross-app move: %s", r)
	}

	// 2. with the new chat's keys: a pending move request, the old chat keeps working until the person decides
	nw, r := MoveRequest(c, mac, "sess-qa-lead")
	if r.Status != 201 || r.J["pending"] != true || r.Str("kind") != "claim" || r.Str("move_to") != "chat" || r.Str("approve_url") == "" || len(r.Str("match_code")) != 6 {
		t.Fatalf("move request: %s", r)
	}
	if again := func() *Resp { // same id + same body: the same request (the client retries)
		from := *mac
		from.Session = "sess-qa-lead"
		return from.Do(c, "POST", "/api/v1/me/claim", map[string]any{"session_id": "sess-qa-lead", "request": map[string]any{
			"id": nw.ReqID, "ed25519_pk": nw.Key.Hex(), "x25519_pk": hex.EncodeToString(nw.X), "app": "claude-code",
			"machine": "box", "folder": "~/acme", "turn": "wake", "job": ""}})
	}(); again.Status != 200 || again.Str("id") != nw.ReqID {
		t.Fatalf("retry: %s", again)
	}
	if w := mac.Do(c, "POST", "/api/v1/me/wait", map[string]any{"wait_s": 0}); w.Status != 200 {
		t.Fatalf("old holder while pending: %s", w)
	}
	if w := nw.Do(c, "POST", "/api/v1/me/wait", map[string]any{"wait_s": 0}); w.Code() != "unknown_key" {
		t.Fatalf("new key before approval: %s", w)
	}
	ny := adam.Do("GET", "/app/v1/needs-you", nil)
	var card map[string]any
	for _, j := range ny.J["join_requests"].([]any) {
		if j.(map[string]any)["id"] == nw.ReqID {
			card = j.(map[string]any)
		}
	}
	if card == nil || card["move_to"] != "chat" || card["kind"] != "claim" || card["name"] != "mac-claude" {
		t.Fatalf("dashboard card: %v", card)
	}
	// a message waiting for mac-claude before the move is re-sent by its sender after it (sealed to the old key)
	msgID, sr := peer.Send(c, mac)
	if sr.Status != 201 {
		t.Fatal(sr)
	}

	// 3. approval: new key + new holder, the old key stops working, wake verification resets, the room's signed list
	// has a member_rekey (every member's client shows "mac-claude moved to a new chat")
	if a := adam.Approve(room, nw); a.Status != 200 {
		t.Fatalf("approve: %s", a)
	}
	nw.ID = mac.ID
	if n := count(t, c, `select count(*) from members where id = $1 and holder_session = 'sess-qa-lead' and wake_verified_at is null and key_epoch = 2`, mac.ID); n != 1 {
		t.Fatal("not moved")
	}
	if w := mac.Do(c, "POST", "/api/v1/me/wait", map[string]any{"wait_s": 0}); w.Code() != "unknown_key" {
		t.Fatalf("old key after the move: %s", w)
	}
	if w := nw.Do(c, "POST", "/api/v1/me/wait", map[string]any{"wait_s": 0}); w.Status != 200 {
		t.Fatalf("new chat: %s", w)
	}
	if n := count(t, c, `select count(*) from roster_entries where room_id = $1 and op = 'member_rekey'`, room.ID); n != 1 {
		t.Fatalf("member_rekey entries: %d", n)
	}
	if n := count(t, c, `select count(*) from deliveries where message_id = $1 and state = 'needs_resend'`, msgID); n != 1 {
		t.Fatal("queued copy not marked for re-send")
	}

	// 4. a rejected move changes nothing
	nw2, r2 := MoveRequest(c, nw, "sess-third")
	if r2.Status != 201 {
		t.Fatal(r2)
	}
	if rj := adam.Do("POST", "/app/v1/join-requests/"+nw2.ReqID+"/reject", nil); rj.Status != 200 {
		t.Fatal(rj)
	}
	if n := count(t, c, `select count(*) from members where id = $1 and holder_session = 'sess-qa-lead'`, mac.ID); n != 1 {
		t.Fatal("holder changed by a rejected move")
	}
	_ = time.Second
}
