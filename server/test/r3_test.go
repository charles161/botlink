package test

import (
	"context"
	"testing"
	"time"

	"github.com/charles161/botlink/server/internal/sweeper"
	"github.com/charles161/botlink/server/internal/wire"
)

func sweep(t *testing.T, c *Copy) {
	t.Helper()
	conn, err := c.Pool.Acquire(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Release()
	if err := sweeper.Sweep(context.Background(), conn.Conn()); err != nil {
		t.Fatal(err)
	}
}

// Release r3 "honest wake" (founder live bug 2026-11-06): a member is "wakes on its own" only after the server
// observed an idle wake; polling at its own turns never makes it fast; the wake test is held back (delay_s); the join
// hello (intro) never wakes anyone.

// The Codex desktop case: the chat's hooks lease / count / ack at its turns, nothing wakes it. It must stay
// "answers on its next turn" and never be verified.
func TestR3PollingAtTurnsIsNotAWake(t *testing.T) {
	c, adam, room, lead, tester := r2Room(t)
	id, _ := lead.Send(c, tester)
	if l := labelOf(t, adam, room, "tester"); l != "answers on its next turn" {
		t.Fatalf("idle: %q", l)
	}
	// the human types: the turn's hooks count, lease and ack (no woken flag, no wake counted)
	tester.Do(c, "GET", "/api/v1/me/inbox/count", nil)
	tester.Lease(c, 0)
	if a := tester.Do(c, "POST", "/api/v1/me/inbox/ack", map[string]any{"items": []any{map[string]any{"message_id": id, "action": "shown"}}}); a.Status != 200 {
		t.Fatal(a)
	}
	tester.Do(c, "POST", "/api/v1/me/presence", map[string]any{})
	if l := labelOf(t, adam, room, "tester"); l != "answers on its next turn" {
		t.Fatalf("polled at its turn: %q (polling is not a wake)", l)
	}
	if n := count(t, c, `select count(*) from members where id = $1 and wake_verified_at is not null`, tester.ID); n != 0 {
		t.Fatal("a copy shown at a turn verified a wake")
	}
}

// A wake counted long ago, with no listener holding the wait any more, doesn't verify a copy a turn later shows.
func TestR3HeuristicNeedsAListener(t *testing.T) {
	c, _, _, lead, tester := r2Room(t)
	id, _ := lead.Send(c, tester)
	tester.Do(c, "POST", "/api/v1/me/wait", map[string]any{"wait_s": 0}) // counts a wake
	exec(t, c, `update members set last_wait_at = now() - interval '10 minutes' where id = $1`, tester.ID)
	tester.Lease(c, 0)
	tester.Do(c, "POST", "/api/v1/me/inbox/ack", map[string]any{"items": []any{map[string]any{"message_id": id, "action": "shown"}}})
	if n := count(t, c, `select count(*) from members where id = $1 and wake_verified_at is not null`, tester.ID); n != 0 {
		t.Fatal("verified without a listener holding the wait")
	}
}

// Verification belongs to the chat that holds the member: a claim by a new chat resets it.
func TestR3ClaimResetsVerification(t *testing.T) {
	c, adam, room, _, tester := r2Room(t)
	exec(t, c, `update members set wake_verified_at = now(), last_wait_at = now() where id = $1`, tester.ID)
	if l := labelOf(t, adam, room, "tester"); l != "wakes on its own" {
		t.Fatalf("verified: %q", l)
	}
	MoveApproved(c, adam, room, tester, "new-chat-"+wire.NewV7().String()) // H1: the move is approved by the person
	if l := labelOf(t, adam, room, "tester"); l != "answers on its next turn" {
		t.Fatalf("after claim: %q", l)
	}
}

// The wake test is invisible to lease, wait and count until its delay passes.
func TestR3SelftestDelay(t *testing.T) {
	c, _, _, _, tester := r2Room(t)
	id := wire.NewV7().String()
	env := tester.Envelope(id, "self", tester.ID, tester.FP(), nil, time.Now().Unix()+3600)
	if r := tester.Do(c, "POST", "/api/v1/me/selftest", map[string]any{"id": id, "envelope": env, "delay_s": 121}); r.Status != 400 {
		t.Fatalf("delay 121: %s", r)
	}
	if r := tester.Do(c, "POST", "/api/v1/me/selftest", map[string]any{"id": id, "envelope": env, "delay_s": 30}); r.Status != 201 {
		t.Fatalf("selftest: %s", r)
	}
	if w := tester.Do(c, "POST", "/api/v1/me/wait", map[string]any{"wait_s": 0}); w.J["count"].(float64) != 0 {
		t.Fatalf("wait saw it early: %s", w)
	}
	if cnt := tester.Do(c, "GET", "/api/v1/me/inbox/count", nil); cnt.J["queued"].(float64) != 0 || cnt.J["urgent"].(float64) != 0 {
		t.Fatalf("count saw it early: %s", cnt)
	}
	if lr := tester.Lease(c, 0); len(deliveries(lr)) != 0 {
		t.Fatalf("lease saw it early: %s", lr)
	}
	if n := count(t, c, `select wakes from deliveries where message_id = $1`, id); n != 0 {
		t.Fatalf("wakes %d before it was due", n)
	}
	exec(t, c, `update deliveries set not_before = now() - interval '1 second' where message_id = $1`, id)
	if w := tester.Do(c, "POST", "/api/v1/me/wait", map[string]any{"wait_s": 0}); w.J["count"].(float64) != 1 {
		t.Fatalf("wait once due: %s", w)
	}
	if lr := tester.Lease(c, 0); len(deliveries(lr)) != 1 {
		t.Fatalf("lease once due: %s", lr)
	}
}

// The join hello: never counted by a wait (no wake), never fires an idle waiter, no expired_unread notice; it rides
// along with the next lease.
func TestR3IntroNeverWakes(t *testing.T) {
	c, _, _, lead, tester := r2Room(t)
	id := wire.NewV7().String()
	b := lead.SendBody(id, false, []*Agent{tester}, nil)
	b["quiet"], b["intro"] = true, true
	if r := lead.Do(c, "POST", "/api/v1/messages", b); r.Status != 201 {
		t.Fatalf("intro send: %s", r)
	}
	if n := count(t, c, `select count(*) from messages where id = $1 and intro`, id); n != 1 {
		t.Fatal("intro not stored")
	}
	if w := tester.Do(c, "POST", "/api/v1/me/wait", map[string]any{"wait_s": 0}); w.J["count"].(float64) != 0 {
		t.Fatalf("wait counted the hello: %s", w)
	}
	if lr := tester.Do(c, "POST", "/api/v1/me/inbox/lease", map[string]any{"wait_s": 0, "urgent_only": true}); len(deliveries(lr)) != 0 {
		t.Fatalf("idle waiter fired for the hello: %s", lr)
	}
	// expiry: no notice to the sender
	exec(t, c, `update deliveries set expires_at = now() - interval '1 second' where message_id = $1`, id)
	sweep(t, c)
	if n := count(t, c, `select count(*) from notices where member_id = $1 and kind = 'expired_unread'`, lead.ID); n != 0 {
		t.Fatalf("expired_unread for a hello: %d", n)
	}
	// a hello that hasn't expired rides along with a normal lease
	id2 := wire.NewV7().String()
	b2 := lead.SendBody(id2, false, []*Agent{tester}, nil)
	b2["quiet"], b2["intro"] = true, true
	lead.Do(c, "POST", "/api/v1/messages", b2)
	if lr := tester.Lease(c, 0); len(deliveries(lr)) != 1 {
		t.Fatalf("normal lease: %s", lr)
	}
}

// Listen lab 2026-11-06: a wake path that failed 5 times left the copy stuck and it vanished from the chat's inbox. Count
// reports it (stuck), a hook-style lease still doesn't show it, and the chat's own inbox call (unstick) shows it now.
func TestR3StuckStaysVisible(t *testing.T) {
	c, adam, room, lead, tester := r2Room(t)
	id, _ := lead.Send(c, tester)
	for i := 0; i < 5; i++ {
		tester.Do(c, "POST", "/api/v1/me/wait", map[string]any{"wait_s": 0}) // five wakes that never got it read
	}
	if lr := tester.Lease(c, 0); len(deliveries(lr)) != 0 {
		t.Fatalf("a stuck copy was leased by a plain lease: %s", lr)
	}
	if n := count(t, c, `select count(*) from deliveries where message_id = $1 and state = 'stuck' and stuck_reason = 'wakes'`, id); n != 1 {
		t.Fatal("not stuck after 5 wakes")
	}
	if cnt := tester.Do(c, "GET", "/api/v1/me/inbox/count", nil); cnt.J["stuck"].(float64) != 1 || cnt.J["queued"].(float64) != 0 {
		t.Fatalf("count: %s", cnt)
	}
	if n := count(t, c, `select count(*) from attention where subject_id = $1 and kind = 'stuck' and resolved_at is null`, tester.ID); n != 1 {
		t.Fatal("no stuck attention for the person")
	}
	lr := tester.Do(c, "POST", "/api/v1/me/inbox/lease", map[string]any{"wait_s": 0, "unstick": true})
	if ds := deliveries(lr); len(ds) != 1 || ds[0]["message_id"] != id {
		t.Fatalf("unstick lease: %s", lr)
	}
	if n := count(t, c, `select count(*) from deliveries where message_id = $1 and state = 'queued' and wakes = 0 and attempts = 1`, id); n != 1 {
		t.Fatal("not queued again with fresh counters")
	}
	if n := count(t, c, `select count(*) from attention where subject_id = $1 and kind = 'stuck' and resolved_at is null`, tester.ID); n != 0 {
		t.Fatal("stuck attention not resolved")
	}
	// poison copies stay stuck
	id2, _ := lead.Send(c, tester)
	exec(t, c, `update deliveries set state = 'stuck', stuck_reason = 'undecryptable', lease_until = null where message_id = $1`, id2)
	tester.Do(c, "POST", "/api/v1/me/inbox/lease", map[string]any{"wait_s": 0, "unstick": true})
	if n := count(t, c, `select count(*) from deliveries where message_id = $1 and state = 'stuck'`, id2); n != 1 {
		t.Fatal("a poison copy was unstuck")
	}
	_ = adam
	_ = room
}
