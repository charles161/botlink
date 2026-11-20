package test

import "testing"

// M1 + L5 (a field test T12): the roster label follows what the chat's wake path really does.
func TestM1ListenerDownLabel(t *testing.T) {
	c, adam, room, _, tester := r2Room(t)
	set := func(sql string) {
		t.Helper()
		exec(t, c, `update members set last_wait_at = null, last_poll_at = null, last_seen_at = null, wake_verified_at = null where id = $1`, tester.ID)
		if sql != "" {
			exec(t, c, `update members set `+sql+` where id = $1`, tester.ID)
		}
	}
	cases := []struct{ name, sql, want string }{
		{"nothing seen", "", "answers on its next turn"},
		{"never verified, only polls at turns", "last_seen_at = now()", "answers on its next turn"},
		{"verified, listener holds the wait", "wake_verified_at = now(), last_wait_at = now()", "wakes on its own"},
		// L5: a verified chat in a turn (its idle waiter isn't running then) keeps its label
		{"verified, in a turn", "wake_verified_at = now(), last_poll_at = now() - interval '10 minutes', last_seen_at = now() - interval '30 seconds'", "wakes on its own"},
		// M1: the wake path was working and went silent
		{"verified, listener silent 5 min", "wake_verified_at = now() - interval '1 hour', last_wait_at = now() - interval '5 minutes', last_seen_at = now() - interval '5 minutes'", "listener down"},
		{"verified, idle waiter silent 5 min", "wake_verified_at = now() - interval '1 hour', last_poll_at = now() - interval '5 minutes', last_seen_at = now() - interval '5 minutes'", "listener down"},
		{"listener ran (never verified), silent 5 min", "last_wait_at = now() - interval '5 minutes'", "listener down"},
		{"listener silent for 2 days", "last_wait_at = now() - interval '2 days'", "answers on its next turn"},
		{"verified listener, in a turn right after a wake (--once re-arms after it)", "wake_verified_at = now(), last_wait_at = now() - interval '100 seconds', last_seen_at = now() - interval '5 seconds'", "wakes on its own"},
	}
	for _, k := range cases {
		set(k.sql)
		if l := labelOf(t, adam, room, "tester"); l != k.want {
			t.Errorf("%s: %q, want %q", k.name, l, k.want)
		}
	}
	// the member's own roster call shows it too (status / roster in the chat)
	set("wake_verified_at = now() - interval '1 hour', last_wait_at = now() - interval '5 minutes'")
	r := tester.Do(c, "GET", "/api/v1/me/roster", nil)
	found := false
	for _, m := range r.J["members"].([]any) {
		mm := m.(map[string]any)
		if mm["name"] == "tester" {
			found = mm["turn_label"] == "listener down" // its own call (in a turn) never hides a dead listener
		}
	}
	if !found {
		t.Fatalf("roster: %s", r)
	}
}
