package test

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5"

	"github.com/charles161/botlink/server/internal/store"
)

// Deleting an account must not keep its passkey reset records (browser user agent) and account events (browser names),
// nor the new placeholder columns that still say something about the person (had_passkey_at, sends_refused_at).
// Lane RECOVER's rule stays: an OPEN reset holds the delete (409 delete_held). The store's delete still closes any
// reset it finds, so none can ever finish against the placeholder.
func TestAccountDeleteRemovesResetRecords(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A", noWait)
	dana := NewPerson(t, c, "Dana")
	exec(t, c, `insert into passkey_resets (id, account_id, session_hash, user_agent, ready_at) values (gen_random_uuid(), $1, decode(repeat('ab', 32), 'hex'), 'Mozilla/5.0 (Macintosh)', now() + interval '3 days')`, dana.AccountID)
	// two days ago: a browser removed in the last 24 h pauses delete asks (account_guard.go), which this test isn't about
	exec(t, c, `insert into account_events (account_id, kind, data, at) values ($1, 'device_removed', '{"label":"Dana''s MacBook"}', now() - interval '2 days')`, dana.AccountID)
	exec(t, c, `update accounts set had_passkey_at = now(), sends_refused_at = now() where id = $1`, dana.AccountID)
	if r := dana.Do("POST", "/app/v1/me/delete/ask", map[string]any{"confirm": dana.Email, "human_check": map[string]any{"id": dana.Check("account_delete", ""), "stub": true}}); r.Status != 409 || r.Code() != "delete_held" {
		t.Fatalf("ask to delete with an open reset: %s", r)
	}
	exec(t, c, `update passkey_resets set cancelled_at = now(), cancelled_by = 'passkey' where account_id = $1`, dana.AccountID)
	askDelete(t, dana)
	if r := dana.Do("POST", "/app/v1/me/delete", deleteBody(dana.Email, dana.Check("account_delete", ""))); r.Status != 200 {
		t.Fatalf("delete: %s", r)
	}
	if n := count(t, c, `select count(*) from passkey_resets where account_id = $1`, dana.AccountID); n != 0 {
		t.Errorf("passkey_resets rows kept after delete: %d", n)
	}
	if n := count(t, c, `select count(*) from account_events where account_id = $1`, dana.AccountID); n != 0 {
		t.Errorf("account_events rows kept after delete: %d", n)
	}
	if n := count(t, c, `select count(*) from accounts where id = $1 and (had_passkey_at is not null or sends_refused_at is not null)`, dana.AccountID); n != 0 {
		t.Error("placeholder still records had_passkey_at or sends_refused_at")
	}
	// the store's delete closes an open reset (no path reaches it with one today; it must still never survive)
	finn := NewPerson(t, c, "Finn")
	exec(t, c, `insert into passkey_resets (id, account_id, session_hash, user_agent, ready_at) values (gen_random_uuid(), $1, decode(repeat('cd', 32), 'hex'), 'Mozilla/5.0 (X11)', now() + interval '3 days')`, finn.AccountID)
	if err := pgx.BeginFunc(context.Background(), c.Pool, func(tx pgx.Tx) error {
		_, err := store.DeleteAccount(context.Background(), tx, finn.AccountID, nil)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if n := count(t, c, `select count(*) from passkey_resets where account_id = $1`, finn.AccountID); n != 0 {
		t.Errorf("open reset left after delete: %d", n)
	}
}
