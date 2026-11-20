package store

// Account delete waits (migration 0041, security re-review of fix-all): an ask records a pending delete that can be
// finished only between ready_at and lapses_at; any sign-in of the account can cancel it, and finishing a passkey
// reset cancels it. Nothing is removed or signed until the finish (DeleteAccount).

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

// PendingDelete is an account's open (not cancelled) delete ask.
type PendingDelete struct {
	ID          string
	SessionHash []byte
	UserAgent   string
	CreatedAt   time.Time
	ReadyAt     time.Time
	LapsesAt    time.Time
	Ready       bool // ready_at has passed (database clock)
	Lapsed      bool // lapses_at has passed: it can no longer be finished
}

// OpenDelete is the account's open delete ask, or nil. forUpdate locks the row.
func OpenDelete(ctx context.Context, q Q, account string, forUpdate bool) (*PendingDelete, error) {
	sql := `select id, session_hash, user_agent, created_at, ready_at, lapses_at, ready_at <= now(), lapses_at <= now()
		from account_deletes where account_id = $1 and cancelled_at is null`
	if forUpdate {
		sql += ` for update`
	}
	d := &PendingDelete{}
	err := q.QueryRow(ctx, sql, account).Scan(&d.ID, &d.SessionHash, &d.UserAgent, &d.CreatedAt, &d.ReadyAt, &d.LapsesAt, &d.Ready, &d.Lapsed)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return d, nil
}

// AskDelete records a pending delete (the caller checked there is none open). A lapsed ask is closed first.
func AskDelete(ctx context.Context, tx pgx.Tx, account string, sessionHash []byte, id string, delay, window time.Duration) (*PendingDelete, error) {
	if _, err := tx.Exec(ctx, `update account_deletes set cancelled_at = now(), cancelled_by = 'lapsed'
		where account_id = $1 and cancelled_at is null and lapses_at <= now()`, account); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `insert into account_deletes (id, account_id, session_hash, user_agent, ready_at, lapses_at)
		select $1, $2, $3, coalesce((select user_agent from web_sessions where token_hash = $3), ''),
		       now() + make_interval(secs => $4), now() + make_interval(secs => $4 + $5)`,
		id, account, sessionHash, delay.Seconds(), window.Seconds()); err != nil {
		return nil, err
	}
	d, err := OpenDelete(ctx, tx, account, false)
	if err != nil {
		return nil, err
	}
	return d, AccountEventBy(ctx, tx, account, sessionHash, "account_delete_asked", map[string]any{"ready_at": d.ReadyAt.UTC(), "lapses_at": d.LapsesAt.UTC(),
		"user_agent": d.UserAgent})
}

// CancelDelete closes the account's open delete ask (by: session | passkey | passkey_reset | browser_removed |
// signed_out) and records it, with extra in the event's data and the sign-in behind sessionHash as who did it. It
// reports whether there was one. A lapsed one is closed as lapsed and reported as none.
func CancelDelete(ctx context.Context, tx pgx.Tx, account, by string, sessionHash []byte, extra map[string]any) (bool, error) {
	var lapsed bool
	err := tx.QueryRow(ctx, `update account_deletes set cancelled_at = now(),
			cancelled_by = case when lapses_at <= now() then 'lapsed' else $2 end
		where account_id = $1 and cancelled_at is null returning cancelled_by = 'lapsed'`, account, by).Scan(&lapsed)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if lapsed {
		return false, nil
	}
	data := map[string]any{"by": by}
	for k, v := range extra {
		data[k] = v
	}
	if err := AccountEventBy(ctx, tx, account, sessionHash, "account_delete_cancelled", data); err != nil {
		return false, err
	}
	return true, DashChanged(ctx, tx, account)
}
