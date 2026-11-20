package test

import (
	"testing"

	"github.com/charles161/botlink/server/internal/wire"
)

// Hotfix 2026-11-06 (founder live bugs in #test-3): honest labels (polling at a chat's own turns is not a wake;
// a member is "wakes on its own" only after an observed idle wake) and a per-member poll budget (a client looped
// lease + roster ~290 times a minute).

// The Codex desktop case: the chat's hooks lease / count / ack at its turns, nothing wakes it. It must stay
// "answers on its next turn" and never be verified.
func TestHotfixPollingAtTurnsIsNotAWake(t *testing.T) {
	c, adam, room, lead, tester := r2Room(t)
	id, _ := lead.Send(c, tester)
	if l := labelOf(t, adam, room, "tester"); l != "answers on its next turn" {
		t.Fatalf("idle: %q", l)
	}
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
func TestHotfixHeuristicNeedsAListener(t *testing.T) {
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
func TestHotfixClaimResetsVerification(t *testing.T) {
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

// Live bug B: lease / roster / count / wait share a per-member budget; a loop gets 429 too_many_polls + Retry-After,
// other members are unaffected.
func TestHotfixPollBudget(t *testing.T) {
	c, _, _, lead, tester := r2Room(t)
	exec(t, c, `insert into rate_counters (bucket, window_start, count)
		values ('poll:m:' || $1::text || ':1m0s', date_bin('60 seconds'::interval, now(), timestamptz 'epoch'), 240)
		on conflict (bucket, window_start) do update set count = 240`, tester.ID)
	r := tester.Lease(c, 0)
	if r.Status != 429 || r.Code() != "too_many_polls" || r.Header.Get("Retry-After") == "" {
		t.Fatalf("over budget: %d %s", r.Status, r)
	}
	if r := tester.Do(c, "GET", "/api/v1/me/roster", nil); r.Status != 429 {
		t.Fatalf("roster over budget: %s", r)
	}
	if r := lead.Lease(c, 0); r.Status != 200 {
		t.Fatalf("another member: %s", r)
	}
}
