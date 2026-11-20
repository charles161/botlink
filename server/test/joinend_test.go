package test

import (
	"testing"
)

// Prod-readiness review blocker 10, "waits that end in nothing". A join request lasts 15 minutes and its chat invite
// 24 hours: a request that ran out says whether the invite still lets a chat in. And a chat whose approval self-check
// failed takes its own request back, so no card is left on the person's dashboard with no chat behind it.

func TestJoinEndedSaysWhetherTheInviteStillWorks(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A")
	adam := NewPerson(t, c, "Adam")
	room := adam.CreateRoom("ended")
	inv := adam.Invite(room)
	a := NewAgentKeys(t, "late")
	if r := a.Join(c, inv); r.Status != 201 {
		t.Fatal(r)
	}
	if r := a.Do(c, "POST", "/api/v1/join-requests/"+a.ReqID+"/wait", map[string]any{"wait_s": 0}); r.J["invite"] != nil {
		t.Fatalf("a pending request says nothing about the invite: %s", r)
	}
	exec(t, c, `update join_requests set expires_at = now() - interval '1 second' where id = $1`, a.ReqID)
	state := func(want string) map[string]any {
		t.Helper()
		r := a.Do(c, "POST", "/api/v1/join-requests/"+a.ReqID+"/wait", map[string]any{"wait_s": 0})
		if r.Status != 200 || r.Str("status") != "expired" {
			t.Fatalf("expired request: %s", r)
		}
		iv, _ := r.J["invite"].(map[string]any)
		if iv == nil || iv["state"] != want {
			t.Fatalf("invite state: want %q: %s", want, r)
		}
		return iv
	}
	if iv := state("works"); iv["expires_at"] == nil {
		t.Fatal("a working invite says until when")
	}
	exec(t, c, `update invites set off = true where room_id = $1`, room.ID)
	state("off")
	exec(t, c, `update invites set off = false, expires_at = now() - interval '1 second' where room_id = $1`, room.ID)
	if iv := state("expired"); iv["expires_at"] != nil {
		t.Fatal("only a working invite carries its expiry")
	}
	exec(t, c, `update rooms set deleted_at = now() where id = $1`, room.ID)
	state("closed")
}

func TestJoinCancelByTheRequestsOwnKey(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A")
	adam := NewPerson(t, c, "Adam")
	room := adam.CreateRoom("withdraw")
	a := NewAgentKeys(t, "mismatched")
	if r := a.Join(c, adam.Invite(room)); r.Status != 201 {
		t.Fatal(r)
	}
	path := "/api/v1/join-requests/" + a.ReqID + "/cancel"
	if r := NewAgentKeys(t, "other").Do(c, "POST", path, map[string]any{}); r.Status != 403 {
		t.Fatalf("another key can't take it back: %s", r)
	}
	if r := a.Do(c, "POST", "/api/v1/join-requests/00000000-0000-7000-8000-000000000000/cancel", map[string]any{}); r.Status != 404 {
		t.Fatalf("unknown request: %s", r)
	}
	if r := a.Do(c, "POST", path, map[string]any{"why": "x"}); r.Status != 400 {
		t.Fatalf("no fields: %s", r)
	}
	if r := a.Do(c, "POST", path, map[string]any{}); r.Status != 200 || r.Str("status") != "cancelled" {
		t.Fatalf("cancel: %s", r)
	}
	ny := adam.Do("GET", "/app/v1/needs-you", nil)
	if js, _ := ny.J["join_requests"].([]any); len(js) != 0 {
		t.Fatalf("the card is gone from the dashboard: %s", ny)
	}
	// the name it held is free again
	b := NewAgentKeys(t, "mismatched")
	if r := b.Join(c, adam.Invite(room)); r.Status != 201 {
		t.Fatalf("the name is free after the cancel: %s", r)
	}
	// approved already: the cancel changes nothing and says so (the chat then leaves by its own key)
	if r := adam.Approve(room, b); r.Status != 200 {
		t.Fatal(r)
	}
	if r := b.Do(c, "POST", "/api/v1/join-requests/"+b.ReqID+"/cancel", map[string]any{}); r.Status != 200 || r.Str("status") != "approved" {
		t.Fatalf("approved stays approved: %s", r)
	}
	if n := count(t, c, `select count(*) from members where name = 'mismatched' and removed_at is null`); n != 1 {
		t.Fatal("the cancel touched the member")
	}
}
