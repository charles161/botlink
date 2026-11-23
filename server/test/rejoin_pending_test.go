package test

import (
	"encoding/hex"
	"strings"
	"testing"

	"github.com/charles161/botlink/server/internal/wire"
)

// Founder bug, 21 Nov 2026: an OpenCode chat on the founder's Mac asked to join,
// then asked again and was told its own name "is already taken"; after the approval it kept asking under new names
// (opencode-2, opencode-mj, sec-research all pending at once, one computer, one folder, one app).
//
// (1) A name clash with a request that only WAITS answers 409 name_taken with details.pending = true, and
// details.same_machine when that request came from the computer this one names. Older clients only know name_taken
// and keep their answer; newer ones tell a waiting request from a member.
// (2) One waiting join per (room, person invited, computer, folder, app, app name, session): a second one under
// another name is 409 join_pending with details.name. A guard for honest but confused clients, not a security
// control: computer and folder are the client's own unsigned display words, so it never blocks another app, another
// session, another folder, another person's invite or a Cursor chat without a session (two Cursor chats in one folder
// are two chats: H2).

type joinShape struct {
	name, app, machine, folder, session string
	appName                             *string
}

func joinAs(t *testing.T, c *Copy, invite string, s joinShape) *Resp {
	t.Helper()
	a := NewAgentKeys(t, s.name)
	a.Session = s.session
	body := map[string]any{"id": wire.NewV7().String(), "kind": "join", "invite": invite, "name": s.name, "job": "job", "app": s.app,
		"machine": s.machine, "folder": s.folder, "turn": "on_turn", "ed25519_pk": a.Key.Hex(), "x25519_pk": hex.EncodeToString(a.X)}
	if s.session != "" {
		body["session_id"] = s.session
	}
	if s.appName != nil {
		body["app_name"] = *s.appName
	}
	return a.Do(c, "POST", "/api/v1/join-requests", body)
}

func details(r *Resp) map[string]any {
	e, _ := r.J["error"].(map[string]any)
	d, _ := e["details"].(map[string]any)
	return d
}

func TestJoinPendingNameAndOneWaitingJoinPerChat(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A")
	adam := NewPerson(t, c, "Adam")
	room := adam.CreateRoom("neon")
	inv := adam.Invite(room)
	oc := "OpenCode"
	mac := joinShape{name: "opencode", app: "other", appName: &oc, machine: "Charless-MacBook-Air.local", folder: "~/Documents/Default Project"}
	if r := joinAs(t, c, inv, mac); r.Status != 201 {
		t.Fatal(r)
	}
	// the same name again, from the same computer (a chat that lost its local record): waiting, not taken
	r := joinAs(t, c, inv, mac)
	if r.Code() != "name_taken" || details(r)["pending"] != true || details(r)["same_machine"] != true || details(r)["suggestion"] != "opencode-2" {
		t.Fatalf("same name, same computer: %s", r)
	}
	// the same name from another computer: still waiting, not from this computer
	elsewhere := mac
	elsewhere.machine = "bob-pc"
	if r := joinAs(t, c, inv, elsewhere); r.Code() != "name_taken" || details(r)["pending"] != true || details(r)["same_machine"] != false {
		t.Fatalf("same name, other computer: %s", r)
	}
	// the founder's second symptom: the same chat (computer, folder, app) under new names while one waits
	// (each invite takes 10 join calls an hour: the cases are spread over two rooms)
	for _, n := range []string{"opencode-2", "opencode-mj"} {
		again := mac
		again.name = n
		r := joinAs(t, c, inv, again)
		if r.Status != 409 || r.Code() != "join_pending" || details(r)["name"] != "opencode" {
			t.Fatalf("%s while opencode waits: %s", n, r)
		}
	}
	if n := count(t, c, `select count(*) from join_requests where room_id = $1 and status = 'pending'`, room.ID); n != 1 {
		t.Fatalf("pending requests: %d, want 1", n)
	}
	// once a member holds those words, the same chat asking under any other name is already that member (the
	// founder's chat asked as opencode-2, opencode-mj and sec-research after opencode was approved)
	exec(t, c, `update join_requests set status = 'approved', decided_at = now() where room_id = $1 and name = 'opencode'`, room.ID)
	exec(t, c, `insert into members (id, room_id, account_id, name, app, app_name, folder, machine, turn, ed25519_pk, x25519_pk)
		values ($1, $2, $3, 'opencode', 'other', 'OpenCode', $4, $5, 'on_turn', $6, $7)`,
		wire.NewV7().String(), room.ID, adam.AccountID, mac.folder, mac.machine, wire.RandBytes(32), wire.RandBytes(32))
	for _, n := range []string{"opencode-mj", "sec-research"} {
		again := mac
		again.name = n
		if r := joinAs(t, c, inv, again); r.Status != 409 || r.Code() != "already_member" || details(r)["name"] != "opencode" {
			t.Fatalf("%s after opencode is a member: %s", n, r)
		}
	}
	// removed: the same chat may join again (one identity at a time, not one join ever)
	exec(t, c, `update members set removed_at = now() where room_id = $1 and name = 'opencode'`, room.ID)
	again := mac
	again.name = "opencode-2"
	if r := joinAs(t, c, inv, again); r.Status != 201 {
		t.Fatalf("after opencode was removed: %s", r)
	}

	// none of these is the same chat as a waiting OpenCode request, so none is blocked
	side := adam.CreateRoom("side")
	inv2 := adam.Invite(side)
	if r := joinAs(t, c, inv2, mac); r.Status != 201 {
		t.Fatal(r)
	}
	gem := "Gemini CLI"
	others := []joinShape{
		{name: "cc", app: "claude-code", machine: mac.machine, folder: mac.folder, session: "cc-session-1"},     // Claude Code beside it
		{name: "cx", app: "codex", machine: mac.machine, folder: mac.folder, session: "codex-thread-1"},         // and Codex
		{name: "cc-two", app: "claude-code", machine: mac.machine, folder: mac.folder, session: "cc-session-2"}, // a second Claude Code chat
		{name: "cur-a", app: "cursor", machine: mac.machine, folder: mac.folder},                                // two Cursor chats, no session
		{name: "cur-b", app: "cursor", machine: mac.machine, folder: mac.folder},
		{name: "oc-other", app: "other", appName: &oc, machine: mac.machine, folder: "~/Documents/Other"}, // OpenCode in another folder
		{name: "oc-mac2", app: "other", appName: &oc, machine: "another-mac", folder: mac.folder},         // another computer, same folder words
		{name: "gem", app: "other", appName: &gem, machine: mac.machine, folder: mac.folder},              // another app name
	}
	for _, s := range others {
		if r := joinAs(t, c, inv2, s); r.Status != 201 {
			t.Fatalf("%s must not be blocked: %s", s.name, r)
		}
	}
}

// Another person's invite to the same room is another person's chat: their waiting join never blocks this one.
func TestJoinPendingIsPerPersonInvited(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A")
	adam := NewPerson(t, c, "Adam")
	room := adam.CreateRoom("shared")
	bob := NewPerson(t, c, "the operator")
	addPerson(t, adam, bob, room)
	oc := "OpenCode"
	same := joinShape{app: "other", appName: &oc, machine: "MacBook-Air.local", folder: "~/Documents/Default Project"}
	a, e := same, same
	a.name, e.name = "adams-oc", "bobs-oc"
	if r := joinAs(t, c, adam.Invite(room), a); r.Status != 201 {
		t.Fatal(r)
	}
	if r := joinAs(t, c, bob.Invite(room), e); r.Status != 201 {
		t.Fatalf("another person's chat with the same computer and folder words: %s", r)
	}
}

// The invite page a chat reads first says what the founder's chat got wrong: join once, then join --wait; a refused
// name is the human's to change (founder bug 21 Nov 2026).
func TestInvitePageSaysJoinOnce(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A")
	adam := NewPerson(t, c, "Adam")
	room := adam.CreateRoom("neon")
	inv := adam.Invite(room)
	code := inv[strings.LastIndex(inv, "/i/")+3:]
	for _, accept := range []string{"text/html", "text/markdown"} {
		st, _, body := getWith(t, c.URL+"/i/"+code, accept)
		if st != 200 {
			t.Fatalf("%s page: %d", accept, st)
		}
		for _, want := range []string{"join --wait", "only once: never again, not under another name either", "ask your human which name to use; don't make one up"} {
			if accept == "text/html" && strings.HasPrefix(want, "ask your human") {
				want = "asks you which name to use instead of making one up" // the browser page speaks to the person
			}
			if !strings.Contains(body, want) {
				t.Errorf("%s invite page lacks %q", accept, want)
			}
		}
	}
}
