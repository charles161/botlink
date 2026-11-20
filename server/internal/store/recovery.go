package store

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

// Reset is an open passkey reset of an account (migration 0042): asked by one sign-in, ready after a wait.
type Reset struct {
	ID          string
	AccountID   string
	SessionHash []byte
	BrowserHash []byte // sha256 of the asking browser's reset cookie (nil: asked before migration 0043)
	UserAgent   string
	CreatedAt   time.Time
	ReadyAt     time.Time
	Ready       bool // ready_at has passed (database clock)
}

// OpenReset is the account's open (neither cancelled nor completed) passkey reset, or nil. forUpdate locks the row.
func OpenReset(ctx context.Context, q Q, account string, forUpdate bool) (*Reset, error) {
	sql := `select id, account_id, session_hash, browser_hash, user_agent, created_at, ready_at, ready_at <= now() from passkey_resets
		where account_id = $1 and cancelled_at is null and completed_at is null`
	if forUpdate {
		sql += ` for update`
	}
	r := &Reset{}
	err := q.QueryRow(ctx, sql, account).Scan(&r.ID, &r.AccountID, &r.SessionHash, &r.BrowserHash, &r.UserAgent, &r.CreatedAt, &r.ReadyAt, &r.Ready)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return r, nil
}

// LockPasskeys serialises every change to an account's set of passkeys (add, remove, remove with a browser, a reset's
// swap) for the rest of the transaction: two removals each confirmed with the other passkey can't both pass the "never
// the last one" check, and a passkey added while a reset finishes can't survive it.
func LockPasskeys(ctx context.Context, q Q, account string) error {
	_, err := q.Exec(ctx, `select pg_advisory_xact_lock(hashtextextended('passkeys:' || $1::text, 0))`, account)
	return err
}

// DeleteHeld says whether account delete must wait because of a passkey reset: while one is open (until nil), or until
// hold after the last one finished.
func DeleteHeld(ctx context.Context, q Q, account string, hold time.Duration) (held bool, until *time.Time, err error) {
	var open, waiting bool
	var last *time.Time
	if err := q.QueryRow(ctx, `with l as (select max(completed_at) + make_interval(secs => $2) as until from passkey_resets
			where account_id = $1 and completed_at is not null)
		select exists(select 1 from passkey_resets where account_id = $1 and cancelled_at is null and completed_at is null),
			l.until, coalesce(l.until > now(), false) from l`, account, hold.Seconds()).Scan(&open, &last, &waiting); err != nil {
		return false, nil, err
	}
	if open {
		return true, nil, nil
	}
	if waiting {
		u := last.UTC()
		return true, &u, nil
	}
	return false, nil, nil
}

// AccountEvent records something that changed an account's locks (account_events).
func AccountEvent(ctx context.Context, q Q, account, kind string, data map[string]any) error {
	if data == nil {
		data = map[string]any{}
	}
	b, err := json.Marshal(data)
	if err != nil {
		return err
	}
	_, err = q.Exec(ctx, `insert into account_events (account_id, kind, data) values ($1, $2, $3)`, account, kind, b)
	return err
}

// Event is one account_events row.
type Event struct {
	Kind string         `json:"kind"`
	At   time.Time      `json:"at"`
	Data map[string]any `json:"data"`
}

// RecentAccountEvents lists the account's last n events, newest first.
func RecentAccountEvents(ctx context.Context, q Q, account string, n int) ([]Event, error) {
	rows, err := q.Query(ctx, `select kind, at, data from account_events where account_id = $1 order by at desc, id desc limit $2`, account, n)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Event{}
	for rows.Next() {
		var e Event
		if err := rows.Scan(&e.Kind, &e.At, &e.Data); err != nil {
			return nil, err
		}
		e.At = e.At.UTC()
		if e.Data == nil {
			e.Data = map[string]any{}
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// SessionSignedIn is when the sign-in behind a session was made (web_sessions.created_at) and how old it is now, on
// the database clock.
func SessionSignedIn(ctx context.Context, q Q, sessionHash []byte) (time.Time, time.Duration, error) {
	var at time.Time
	var ageS float64
	err := q.QueryRow(ctx, `select created_at, extract(epoch from now() - created_at) from web_sessions where token_hash = $1`,
		sessionHash).Scan(&at, &ageS)
	return at, time.Duration(ageS * float64(time.Second)), err
}

// DashChanged rings every open dashboard of the account (SSE "changed").
func DashChanged(ctx context.Context, q Q, account string) error {
	_, err := q.Exec(ctx, `select pg_notify('bl_dash', $1::text)`, account)
	return err
}
