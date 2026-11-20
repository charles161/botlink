package test

import (
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/charles161/botlink/server/internal/wire"
)

// Release r2 (onboarding feedback 2026-11-06): quiet FYIs, urgent-only waits, peek, self-tests, woken acks and the
// labels computed from real behaviour, the member's own label, 6-character codes and the approve link.

func r2Room(t *testing.T) (*Copy, *Person, *Room, *Agent, *Agent) {
	c := StartCopy(t, NewDB(t), "A")
	adam := NewPerson(t, c, "Adam")
	room := adam.CreateRoom("r2")
	lead := adam.Member(c, room, "lead")
	tester := adam.Member(c, room, "tester")
	lead.Drain(c)
	tester.Drain(c)
	// Drain polled: start from "nobody has seen these chats do anything"
	exec(t, c, `update members set last_poll_at = null, last_seen_at = null, last_wait_at = null, presence_live = false`)
	return c, adam, room, lead, tester
}

func TestR2QuietFYI(t *testing.T) {
	c, _, _, lead, tester := r2Room(t)
	id := wire.NewV7().String()
	b := lead.SendBody(id, false, []*Agent{tester}, nil)
	b["quiet"] = true
	if r := lead.Do(c, "POST", "/api/v1/messages", b); r.Status != 201 {
		t.Fatalf("quiet send: %s", r)
	}
	cnt := tester.Do(c, "GET", "/api/v1/me/inbox/count", nil)
	if cnt.J["queued"].(float64) != 1 || cnt.J["urgent"].(float64) != 0 {
		t.Fatalf("count: %s", cnt)
	}
	// an urgent-only wait doesn't count (or wake for) it, and bumps no wake
	if r := tester.Do(c, "POST", "/api/v1/me/wait", map[string]any{"wait_s": 0, "urgent_only": true}); r.J["count"].(float64) != 0 {
		t.Fatalf("urgent wait: %s", r)
	}
	if n := count(t, c, `select wakes from deliveries where message_id = $1`, id); n != 0 {
		t.Fatalf("wakes %d", n)
	}
	// Claude Code's idle waiter (urgent_only lease) gets nothing for it
	if r := tester.Do(c, "POST", "/api/v1/me/inbox/lease", map[string]any{"wait_s": 0, "urgent_only": true}); len(deliveries(r)) != 0 {
		t.Fatalf("urgent lease: %s", r)
	}
	// a question arrives: the next urgent lease takes both (the FYI rides along)
	q, r := lead.Send(c, tester)
	if r.Status != 201 {
		t.Fatal(r)
	}
	lr := tester.Do(c, "POST", "/api/v1/me/inbox/lease", map[string]any{"wait_s": 0, "urgent_only": true})
	if got := len(deliveries(lr)); got != 2 {
		t.Fatalf("urgent lease after a question: %d (%s)", got, lr)
	}
	//: "available" is what an inbox read gets right now; copies another read holds (leased) aren't in it
	if cnt := tester.Do(c, "GET", "/api/v1/me/inbox/count", nil); cnt.J["queued"].(float64) != 2 || cnt.J["available"].(float64) != 0 {
		t.Fatalf("count while leased: %s", cnt)
	}
	_ = q
}

func TestR2PeekCountsNoWake(t *testing.T) {
	c, _, _, lead, tester := r2Room(t)
	id, r := lead.Send(c, tester)
	if r.Status != 201 {
		t.Fatal(r)
	}
	for i := 0; i < 3; i++ {
		p := tester.Do(c, "POST", "/api/v1/me/wait", map[string]any{"wait_s": 0, "peek": true})
		if p.J["count"].(float64) != 1 {
			t.Fatalf("peek: %s", p)
		}
	}
	if n := count(t, c, `select wakes from deliveries where message_id = $1`, id); n != 0 {
		t.Fatalf("peeks counted %d wakes", n)
	}
	if p := tester.Do(c, "POST", "/api/v1/me/wait", map[string]any{"wait_s": 0}); p.J["count"].(float64) != 1 {
		t.Fatal(p)
	}
	if n := count(t, c, `select wakes from deliveries where message_id = $1`, id); n != 1 {
		t.Fatalf("a real wait counts one wake, got %d", n)
	}
}

func TestR2SelftestAndVerifiedWake(t *testing.T) {
	c, adam, room, lead, tester := r2Room(t)
	// a self-test: sealed to itself, scope self
	id := wire.NewV7().String()
	env := tester.Envelope(id, "self", tester.ID, tester.FP(), nil, time.Now().Unix()+3600)
	r := tester.Do(c, "POST", "/api/v1/me/selftest", map[string]any{"id": id, "envelope": env})
	if r.Status != 201 {
		t.Fatalf("selftest: %s", r)
	}
	if r := tester.Do(c, "POST", "/api/v1/me/selftest", map[string]any{"id": id, "envelope": env}); r.Status != 200 || r.J["duplicate"] != true {
		t.Fatalf("retry: %s", r)
	}
	// someone else's envelope, or a member scope, is refused
	bad := lead.Envelope(wire.NewV7().String(), "self", lead.ID, lead.FP(), nil, time.Now().Unix()+3600)
	if r := tester.Do(c, "POST", "/api/v1/me/selftest", map[string]any{"id": wire.NewV7().String(), "envelope": bad}); r.Status == 201 {
		t.Fatalf("foreign self-test accepted: %s", r)
	}
	g := tester.Do(c, "GET", "/api/v1/me/selftest/"+id, nil)
	if g.Status != 200 || g.Str("state") != "waiting" || g.J["wake_verified_at"] != nil {
		t.Fatalf("state: %s", g)
	}
	// not in the room's activity
	act := adam.Do("GET", "/app/v1/rooms/"+room.ID+"/activity", nil)
	if strings.Contains(string(act.Body), `"to_name":"tester"`) && strings.Contains(string(act.Body), `"from_name":"tester"`) {
		t.Fatalf("self-test in activity: %s", act)
	}
	// a listener holds the wait; the label stays "answers on its next turn" until a woken run shows something
	if w := tester.Do(c, "POST", "/api/v1/me/wait", map[string]any{"wait_s": 0}); w.J["count"].(float64) != 1 {
		t.Fatalf("wait sees the self-test: %s", w)
	}
	if l := labelOf(t, adam, room, "tester"); l != "answers on its next turn" {
		t.Fatalf("before a verified wake: %q", l)
	}
	lr := tester.Lease(c, 0)
	ds := deliveries(lr)
	if len(ds) != 1 || ds[0]["scope"] != "self" {
		t.Fatalf("lease: %s", lr)
	}
	exec(t, c, `update deliveries set wakes = 0 where message_id = $1`, id) // only the woken flag may verify here
	if a := tester.Do(c, "POST", "/api/v1/me/inbox/ack", map[string]any{"items": []any{map[string]any{"message_id": id, "action": "shown"}}, "woken": true}); a.Status != 200 {
		t.Fatalf("ack: %s", a)
	}
	if g := tester.Do(c, "GET", "/api/v1/me/selftest/"+id, nil); g.Str("state") != "shown" || g.J["wake_verified_at"] == nil {
		t.Fatalf("after a woken ack: %s", g)
	}
	tester.Do(c, "POST", "/api/v1/me/wait", map[string]any{"wait_s": 0})
	if l := labelOf(t, adam, room, "tester"); l != "wakes on its own" {
		t.Fatalf("after a verified wake: %q", l)
	}
	// a stuck copy takes the verification away again (the chat itself hasn't polled for a while)
	exec(t, c, `update members set last_poll_at = now() - interval '5 minutes', last_seen_at = now() - interval '5 minutes' where id = $1`, tester.ID)
	sid, _ := lead.Send(c, tester)
	exec(t, c, `update deliveries set state = 'stuck', stuck_reason = 'wakes', lease_until = null where message_id = $1`, sid)
	tester.Do(c, "POST", "/api/v1/me/wait", map[string]any{"wait_s": 0})
	if l := labelOf(t, adam, room, "tester"); l != "answers on its next turn" {
		t.Fatalf("with a stuck copy: %q", l)
	}
}

// SPEC §6.9 (2026-11-11): the room says "wakes on its own" only when the CLIENT says a read showed that an idle chat
// is reached (woken: true). Until then a third way counted: "shown within 3 minutes of a wait that had seen the copy".
// The server cannot tell who started the turn that read: a bot whose background wait ended without giving it a turn,
// and whose person then typed, was shown as waking on its own (evals: wake/label-after-a-person-reads).
func TestWakeIsVerifiedOnlyWhenTheClientSaysSo(t *testing.T) {
	c, adam, room, lead, tester := r2Room(t)
	verified := func() int {
		return count(t, c, `select count(*) from members where id = $1 and wake_verified_at is not null`, tester.ID)
	}
	ack := func(id string, extra map[string]any) *Resp {
		body := map[string]any{"items": []any{map[string]any{"message_id": id, "action": "shown"}}}
		for k, v := range extra {
			body[k] = v
		}
		return tester.Do(c, "POST", "/api/v1/me/inbox/ack", body)
	}
	// 1. a wait saw the copy, then the chat read it with no claim (its person typed): nothing is shown
	id, _ := lead.Send(c, tester)
	tester.Do(c, "POST", "/api/v1/me/wait", map[string]any{"wait_s": 0}) // counts a wake
	tester.Lease(c, 0)
	if r := ack(id, nil); r.Status != 200 {
		t.Fatalf("ack: %s", r)
	}
	if verified() != 0 {
		t.Fatal("a read with no wake claim verified a wake")
	}
	tester.Do(c, "POST", "/api/v1/me/wait", map[string]any{"wait_s": 0})
	if l := labelOf(t, adam, room, "tester"); l != "answers on its next turn" {
		t.Fatalf("label after an unclaimed read: %q", l)
	}
	// 2. the client says this read showed an idle chat is reached
	id2, _ := lead.Send(c, tester)
	tester.Do(c, "POST", "/api/v1/me/wait", map[string]any{"wait_s": 0})
	tester.Lease(c, 0)
	ack(id2, map[string]any{"woken": true})
	if verified() != 1 {
		t.Fatal("woken: true did not verify")
	}
	tester.Do(c, "POST", "/api/v1/me/wait", map[string]any{"wait_s": 0})
	if l := labelOf(t, adam, room, "tester"); l != "wakes on its own" {
		t.Fatalf("label after a claimed wake: %q", l)
	}
	// 3. a wake test FAILED later (woken: false): the earlier proof no longer holds
	id3, _ := lead.Send(c, tester)
	tester.Lease(c, 0)
	ack(id3, map[string]any{"woken": false})
	if verified() != 0 {
		t.Fatal("woken: false did not clear the proof")
	}
	tester.Do(c, "POST", "/api/v1/me/wait", map[string]any{"wait_s": 0})
	if l := labelOf(t, adam, room, "tester"); l != "answers on its next turn" {
		t.Fatalf("label after a failed test: %q", l)
	}
	// 4. five wakes went unanswered (the copy goes stuck): a proof from before is forgotten, and the read that takes
	// the copy back says how many it took (the client never counts such a read as a wake)
	id4, _ := lead.Send(c, tester)
	tester.Lease(c, 0)
	ack(id4, map[string]any{"woken": true})
	if verified() != 1 {
		t.Fatal("setup: not verified")
	}
	id5, _ := lead.Send(c, tester)
	exec(t, c, `update deliveries set wakes = 5 where message_id = $1`, id5)
	if r := tester.Do(c, "POST", "/api/v1/me/inbox/lease", map[string]any{"wait_s": 0, "max": 10}); r.Status != 200 || len(r.J["deliveries"].([]any)) != 0 || r.J["unstuck"].(float64) != 0 {
		t.Fatalf("a stuck copy is not handed out by a plain lease: %s", r)
	}
	if n := count(t, c, `select count(*) from deliveries where message_id = $1 and state = 'stuck' and stuck_reason = 'wakes'`, id5); n != 1 {
		t.Fatal("the copy did not go stuck")
	}
	if verified() != 0 {
		t.Fatal("five unanswered wakes did not clear the proof")
	}
	r := tester.Do(c, "POST", "/api/v1/me/inbox/lease", map[string]any{"wait_s": 0, "max": 10, "unstick": true})
	if r.Status != 200 || len(r.J["deliveries"].([]any)) != 1 || r.J["unstuck"].(float64) != 1 {
		t.Fatalf("the chat's own read takes the stuck copy back and says so: %s", r)
	}
}

func TestR2SelfLabel(t *testing.T) {
	c, adam, room, _, tester := r2Room(t)
	if r := tester.Do(c, "PUT", "/api/v1/me/card", map[string]any{"label": "always on, server chat"}); r.Status != 200 || r.Str("self_label") != "always on, server chat" {
		t.Fatalf("label: %s", r)
	}
	ro := adam.Do("GET", "/app/v1/rooms/"+room.ID, nil)
	if !strings.Contains(string(ro.Body), `"self_label":"always on, server chat"`) {
		t.Fatalf("room view: %s", ro)
	}
	// the computed label is unchanged by the member's own words
	if l := labelOf(t, adam, room, "tester"); l != "answers on its next turn" {
		t.Fatalf("computed label %q", l)
	}
	for _, bad := range []string{strings.Repeat("x", 61), "two\nlines", "bidi ‮"} {
		if r := tester.Do(c, "PUT", "/api/v1/me/card", map[string]any{"label": bad}); r.Status != 400 {
			t.Errorf("%q: %s", bad, r)
		}
	}
	if r := tester.Do(c, "PUT", "/api/v1/me/card", map[string]any{"label": ""}); r.Status != 200 || r.J["self_label"] != nil {
		t.Fatalf("clear: %s", r)
	}
}

var code6 = regexp.MustCompile(`^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$`)

func TestR2SixCharCodeAndApproveLink(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A")
	adam := NewPerson(t, c, "Adam")
	room := adam.CreateRoom("codes")
	a := NewAgentKeys(t, "sixer")
	r := a.Join(c, adam.Invite(room))
	if r.Status != 201 {
		t.Fatal(r)
	}
	if !code6.MatchString(r.Str("match_code")) {
		t.Fatalf("match code %q", r.Str("match_code"))
	}
	if r.Str("approve_url") != c.URL+"/approve/"+a.ReqID {
		t.Fatalf("approve_url %q", r.Str("approve_url"))
	}
	// the page route exists (SPA) for anyone; only the request's person gets the card from needs-you
	if p := doRaw(t, mustReq("GET", c.URL+"/approve/"+a.ReqID)); p.Status != 200 {
		t.Fatalf("/approve page: %s", p)
	}
	other := NewPerson(t, c, "Mallory")
	ny := other.Do("GET", "/app/v1/needs-you", nil)
	if strings.Contains(string(ny.Body), a.ReqID) {
		t.Fatal("another account sees the request")
	}
	if ny := adam.Do("GET", "/app/v1/needs-you", nil); !strings.Contains(string(ny.Body), a.ReqID) {
		t.Fatal("the invite's person doesn't see the request")
	}
}

// founder: a request signed with a held member's key but from another chat's session is refused (403
// not_holder) on every member route except claim; the holder's own session works; holder-less members are unaffected.
func TestR2KeyBoundToSession(t *testing.T) {
	c, _, _, lead, tester := r2Room(t)
	own := tester.Session
	other := "cursor-chat-" + strings.ToLower(wire.RandCode(6))
	tester.Session = other
	for _, rt := range []struct {
		m, p string
		b    any
	}{
		{"GET", "/api/v1/me", nil}, {"GET", "/api/v1/me/roster", nil}, {"POST", "/api/v1/me/wait", map[string]any{"wait_s": 0}},
		{"POST", "/api/v1/me/presence", nil}, {"PUT", "/api/v1/me/card", map[string]any{"label": "x"}},
		{"POST", "/api/v1/me/ask-human", map[string]any{"reason": "needs_ok"}},
	} {
		if r := tester.Do(c, rt.m, rt.p, rt.b); r.Status != 403 || r.Code() != "not_holder" {
			t.Errorf("%s %s from another session: %s", rt.m, rt.p, r)
		}
	}
	id := wire.NewV7().String()
	if r := tester.Do(c, "POST", "/api/v1/messages", tester.SendBody(id, false, []*Agent{lead}, nil)); r.Status != 403 || r.Code() != "not_holder" {
		t.Fatalf("send from another session: %s", r)
	}
	if n := count(t, c, `select count(*) from messages where id = $1`, id); n != 0 {
		t.Fatal("a message was stored")
	}
	if r := tester.Lease(c, 0); r.Status != 409 || r.Code() != "not_holder" {
		t.Fatalf("lease from another session: %s", r)
	}
	// no session header at all is not the holder either
	empty := ""
	if r := doRaw(t, tester.Req(c, "GET", "/api/v1/me/roster", nil, &SignOpts{Session: &empty})); r.Status != 403 {
		t.Fatalf("no session: %s", r)
	}
	tester.Session = own
	if r := tester.Do(c, "GET", "/api/v1/me/roster", nil); r.Status != 200 {
		t.Fatalf("holder: %s", r)
	}
	// holder-less (Cursor / OpenCode / scripts): any session
	exec(t, c, `update members set holder_session = null where id = $1`, tester.ID)
	tester.Session = other
	if r := tester.Do(c, "GET", "/api/v1/me/roster", nil); r.Status != 200 {
		t.Fatalf("holder-less: %s", r)
	}
}
