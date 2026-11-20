package test

import (
	"encoding/hex"
	"testing"

	"github.com/charles161/botlink/server/internal/wire"
)

// Prod-readiness review blocker 10, the dashboard side: a card that leaves says why. GET /app/v1/needs-you lists the
// person's own join requests that ended in the last 30 minutes and how each ended, so an open approval page can say
// "withdrawn by the chat" instead of leaving a card that can no longer be approved.

func endedOf(t *testing.T, p *Person) map[string]map[string]any {
	t.Helper()
	ny := p.Do("GET", "/app/v1/needs-you", nil)
	if ny.Status != 200 {
		t.Fatal(ny)
	}
	list, ok := ny.J["ended_join_requests"].([]any)
	if !ok {
		t.Fatalf("needs-you has no ended_join_requests: %s", ny)
	}
	out := map[string]map[string]any{}
	for _, x := range list {
		m := x.(map[string]any)
		out[m["id"].(string)] = m
	}
	return out
}

func TestNeedsYouSaysHowAJoinRequestEnded(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A")
	adam := NewPerson(t, c, "Adam")
	room := adam.CreateRoom("ends")
	inv := adam.Invite(room)
	join := func(name string) *Agent {
		t.Helper()
		a := NewAgentKeys(t, name)
		if r := a.Join(c, inv); r.Status != 201 {
			t.Fatal(r)
		}
		return a
	}
	gone, late, yes, no, waiting := join("gone"), join("late"), join("yes"), join("no"), join("waiting")
	if r := gone.Do(c, "POST", "/api/v1/join-requests/"+gone.ReqID+"/cancel", map[string]any{}); r.Status != 200 {
		t.Fatal(r)
	}
	exec(t, c, `update join_requests set expires_at = now() - interval '1 second' where id = $1`, late.ReqID)
	if r := adam.Approve(room, yes); r.Status != 200 {
		t.Fatal(r)
	}
	if r := adam.Do("POST", "/app/v1/join-requests/"+no.ReqID+"/reject", nil); r.Status != 200 {
		t.Fatal(r)
	}
	// a move asked twice: the older one is replaced by the newer
	mover := yes
	claim := func() string {
		t.Helper()
		id := wire.NewV7().String()
		k := NewAgentKeys(t, mover.Name)
		r := k.Do(c, "POST", "/api/v1/join-requests", map[string]any{"id": id, "kind": "claim", "invite": inv, "name": mover.Name,
			"app": "codex", "machine": "laptop-2", "folder": "~/acme", "turn": "wake", "session_id": k.Session,
			"ed25519_pk": k.Key.Hex(), "x25519_pk": hex.EncodeToString(k.X)})
		if r.Status != 201 {
			t.Fatal(r)
		}
		return id
	}
	first := claim()
	second := claim()

	e := endedOf(t, adam)
	for id, want := range map[string]string{gone.ReqID: "withdrawn", late.ReqID: "expired", yes.ReqID: "approved", no.ReqID: "rejected", first: "replaced"} {
		got := e[id]
		if got == nil || got["ended"] != want {
			t.Errorf("request %s: want ended %q, got %v", id, want, got)
			continue
		}
		if got["room_id"] != room.ID || got["room_name"] != "ends" || got["name"] == nil || got["ended_at"] == nil {
			t.Errorf("request %s: room, name and time: %v", id, got)
		}
	}
	if e[waiting.ReqID] != nil || e[second] != nil {
		t.Errorf("a waiting request hasn't ended: %v", e)
	}
	// only the person it was for sees it
	if eve := endedOf(t, NewPerson(t, c, "Eve")); len(eve) != 0 {
		t.Errorf("another person sees ended requests: %v", eve)
	}
	// older than 30 minutes: no longer listed
	exec(t, c, `update join_requests set decided_at = now() - interval '31 minutes' where id = $1`, gone.ReqID)
	exec(t, c, `update join_requests set expires_at = now() - interval '31 minutes' where id = $1`, late.ReqID)
	if e := endedOf(t, adam); e[gone.ReqID] != nil || e[late.ReqID] != nil {
		t.Errorf("an old end is still listed: %v", e)
	}
	// the room was deleted: the waiting request can't go ahead any more
	exec(t, c, `update rooms set deleted_at = now() where id = $1`, room.ID)
	exec(t, c, `update join_requests set status = 'cancelled', decided_at = now() where room_id = $1 and status = 'pending'`, room.ID)
	if got := endedOf(t, adam)[waiting.ReqID]; got == nil || got["ended"] != "closed" {
		t.Errorf("deleted room: want closed, got %v", got)
	}
}
