package test

import (
	"context"
	"encoding/hex"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/charles161/botlink/server/internal/sweeper"
	"github.com/charles161/botlink/server/internal/wire"
)

func labelOf(t *testing.T, p *Person, room *Room, name string) string {
	t.Helper()
	r := p.Do("GET", "/app/v1/rooms/"+room.ID, nil)
	for _, m := range r.J["members"].([]any) {
		mm := m.(map[string]any)
		if mm["name"] == name {
			return mm["turn_label"].(string)
		}
	}
	t.Fatalf("%s not in room: %s", name, r)
	return ""
}

// SPEC §6.9 presence (r3): an inbox / wait / presence call marks a member seen (presence_live) for 90 s; only the flips
// NOTIFY the room's people (not every heartbeat); the sweeper flips it back. Polling never changes the label: without an
// observed idle wake the member stays "answers on its next turn" (founder live bug 2026-11-06: Codex desktop shown
// "listening now" because its hooks polled at its turns).
func TestPresenceLabel(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A")
	adam := NewPerson(t, c, "Adam")
	room := adam.CreateRoom("presence")
	a := NewAgentKeys(t, "looper")
	a.Session = ""
	r := a.Do(c, "POST", "/api/v1/join-requests", map[string]any{"id": newID(), "kind": "join", "invite": adam.Invite(room), "name": "looper",
		"job": "own loop", "app": "other", "app_name": "T3 Code", "machine": "box", "folder": "~/x", "turn": "on_turn",
		"ed25519_pk": a.Key.Hex(), "x25519_pk": hex.EncodeToString(a.X)})
	if r.Status != 201 {
		t.Fatalf("join: %s", r)
	}
	a.ReqID = r.Str("id")
	if r := adam.Approve(room, a); r.Status != 200 || r.Str("app_name") != "T3 Code" {
		t.Fatalf("approve: %s", r)
	}
	later := "answers on its next turn"
	if l := labelOf(t, adam, room, "looper"); l != later {
		t.Fatalf("before: %q", l)
	}

	// listen for the dashboard bell of Adam's account
	conn, err := pgx.Connect(context.Background(), c.Pool.Config().ConnConfig.ConnString())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(context.Background())
	if _, err := conn.Exec(context.Background(), "listen bl_dash"); err != nil {
		t.Fatal(err)
	}
	bells := func() int {
		n := 0
		for {
			ctx, cancel := context.WithTimeout(context.Background(), 400*time.Millisecond)
			ntf, err := conn.WaitForNotification(ctx)
			cancel()
			if err != nil {
				return n
			}
			if ntf.Payload == adam.AccountID {
				n++
			}
		}
	}
	bells()

	p := a.Do(c, "POST", "/api/v1/me/presence", nil)
	if p.Status != 200 || p.Str("turn_label") != later {
		t.Fatalf("presence: %s", p)
	}
	if n := bells(); n != 1 {
		t.Fatalf("first heartbeat: %d dashboard bells, want 1 (the flip)", n)
	}
	if l := labelOf(t, adam, room, "looper"); l != later {
		t.Fatalf("after heartbeat: %q", l)
	}
	if p := a.Do(c, "POST", "/api/v1/me/presence", map[string]any{}); p.Status != 200 {
		t.Fatal(p)
	}
	if n := bells(); n != 0 {
		t.Fatalf("second heartbeat rang the dashboard %d times", n)
	}
	// 100 s later (no call): the label is back at once, and the sweeper's flip rings once
	exec(t, c, `update members set last_seen_at = now() - interval '100 seconds' where name = 'looper'`)
	if l := labelOf(t, adam, room, "looper"); l != later {
		t.Fatalf("after 100 s: %q", l)
	}
	sconn, err := c.Pool.Acquire(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if err := sweeper.Sweep(context.Background(), sconn.Conn()); err != nil {
		t.Fatal(err)
	}
	sconn.Release()
	if n := bells(); n != 1 {
		t.Fatalf("sweeper flip: %d bells, want 1", n)
	}
	// an inbox count call (a chat's own loop) counts as presence too
	if r := a.Do(c, "GET", "/api/v1/me/inbox/count", nil); r.Status != 200 {
		t.Fatal(r)
	}
	if l := labelOf(t, adam, room, "looper"); l != later {
		t.Fatalf("after count: %q", l)
	}
	// app_name shows on the roster views; the signed roster says other
	ro := adam.Do("GET", "/app/v1/rooms/"+room.ID+"/roster", nil)
	if !strings.Contains(string(ro.Body), `"app_name":"T3 Code"`) {
		t.Fatalf("roster view: %s", ro)
	}
}

func TestAppNameValidation(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A")
	adam := NewPerson(t, c, "Adam")
	room := adam.CreateRoom("names")
	for _, tc := range []struct {
		app, name string
		ok        bool
	}{
		{"other", "OpenCode", true}, {"other", "T3 Code", true}, {"claude-code", "OpenCode", false}, {"other", "", false},
		{"other", " padded", false}, {"other", "line\nbreak", false}, {"other", strings.Repeat("x", 41), false},
		{"other", "evil‮edoc", false}, {"other", "a <<<fence", false},
	} {
		a := NewAgentKeys(t, "n"+strings.ToLower(wire.RandCode(5)))
		r := a.Do(c, "POST", "/api/v1/join-requests", map[string]any{"id": newID(), "kind": "join", "invite": adam.Invite(room), "name": a.Name,
			"job": "", "app": tc.app, "app_name": tc.name, "machine": "box", "folder": "~/x", "turn": "on_turn",
			"ed25519_pk": a.Key.Hex(), "x25519_pk": hex.EncodeToString(a.X)})
		if (r.Status == 201) != tc.ok {
			t.Errorf("app %q app_name %q: %s", tc.app, tc.name, r)
		}
	}
}
