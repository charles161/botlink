package store

// Guards around an account's first passkey and its delete wait (third security pass at 9f90062, fix-all last builder).
//
// An account that never had a passkey is locked only by its Google or GitHub sign-in. Whoever holds that sign-in can
// register the account's first passkey (inside a delete ask, or with "Add a passkey") and, from then on, the owner can
// approve nothing without it. UndoPasskeysSince takes the account back to where it was before that passkey: the
// passkeys made since then are removed, "has had a passkey" returns to what it was, open resets end, nobody's sign-in
// stays verified by them, and the given sign-ins end. Callers decide who may do this (appapi/account_guard.go).

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

// Undone is what UndoPasskeysSince removed.
type Undone struct {
	Passkeys int64 `json:"passkeys_removed"`
	SignIns  int64 `json:"sign_ins_ended"`
	Resets   int64 `json:"resets_cancelled"`
}

// UndoPasskeysSince removes every passkey of the account made at or after since and puts accounts.had_passkey_at back
// to the oldest passkey left (none: never had one). Open passkey resets are cancelled (there was nothing to reset
// before), every sign-in's "verified by a passkey" stamp and every answered but unused human check are dropped (they
// may come from a removed passkey), and the account's other sign-ins end: all of them (endNewerThan nil) or only those
// made after endNewerThan. keep is the caller's own sign-in, which stays. Run it under the passkey lock (LockPasskeys).
func UndoPasskeysSince(ctx context.Context, tx pgx.Tx, account string, since time.Time, keep []byte, endNewerThan *time.Time) (Undone, error) {
	var u Undone
	tag, err := tx.Exec(ctx, `delete from webauthn_credentials where account_id = $1 and created_at >= $2`, account, since)
	if err != nil {
		return u, err
	}
	u.Passkeys = tag.RowsAffected()
	if _, err := tx.Exec(ctx, `update accounts set had_passkey_at = (select min(created_at) from webauthn_credentials where account_id = $1)
		where id = $1 and had_passkey_at >= $2`, account, since); err != nil {
		return u, err
	}
	if tag, err = tx.Exec(ctx, `update passkey_resets set cancelled_at = now(), cancelled_by = 'session'
		where account_id = $1 and cancelled_at is null and completed_at is null`, account); err != nil {
		return u, err
	}
	u.Resets = tag.RowsAffected()
	if u.Resets > 0 {
		if err := AccountEvent(ctx, tx, account, "passkey_reset_cancelled", map[string]any{"by": "session", "why": "first_passkey_removed"}); err != nil {
			return u, err
		}
	}
	if _, err := tx.Exec(ctx, `update web_sessions set uv_at = null where account_id = $1`, account); err != nil {
		return u, err
	}
	if _, err := tx.Exec(ctx, `update human_checks set used_at = now() where account_id = $1 and used_at is null`, account); err != nil {
		return u, err
	}
	if endNewerThan == nil {
		tag, err = tx.Exec(ctx, `delete from web_sessions where account_id = $1 and token_hash <> $2`, account, keep)
	} else {
		tag, err = tx.Exec(ctx, `delete from web_sessions where account_id = $1 and token_hash <> $2 and created_at > $3`, account, keep, *endNewerThan)
	}
	if err != nil {
		return u, err
	}
	u.SignIns = tag.RowsAffected()
	return u, DashChanged(ctx, tx, account)
}

// FirstPasskeyAt is when the account's first passkey was registered (accounts.had_passkey_at), nil if it never had one.
func FirstPasskeyAt(ctx context.Context, q Q, account string) (*time.Time, error) {
	var at *time.Time
	err := q.QueryRow(ctx, `select had_passkey_at from accounts where id = $1`, account).Scan(&at)
	return at, err
}

// DeleteAskPausedUntil is when a delete ask is allowed again after the account's last browser removal or "sign out
// other browsers" (nil: not paused).
func DeleteAskPausedUntil(ctx context.Context, q Q, account string, hold time.Duration) (*time.Time, error) {
	if hold <= 0 {
		return nil, nil
	}
	var until *time.Time
	err := q.QueryRow(ctx, `select max(at) + make_interval(secs => $2) from account_events
		where account_id = $1 and kind in ('device_removed', 'signed_out_others') having max(at) + make_interval(secs => $2) > now()`,
		account, hold.Seconds()).Scan(&until)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if until != nil {
		u := until.UTC()
		until = &u
	}
	return until, err
}

// AccountEventBy is AccountEvent with who did it: the user agent of the sign-in behind sessionHash and, when that
// sign-in proved which browser it is (POST /app/v1/me/browser), that browser's id and name (actor_user_agent,
// actor_device_id, actor_device_label). The dashboard's list of recent changes says them in a sentence. Call it before
// that sign-in is ended.
func AccountEventBy(ctx context.Context, q Q, account string, sessionHash []byte, kind string, data map[string]any) error {
	if data == nil {
		data = map[string]any{}
	}
	b, err := json.Marshal(data)
	if err != nil {
		return err
	}
	_, err = q.Exec(ctx, `insert into account_events (account_id, kind, data) select $1, $2, $3::jsonb || coalesce((
			select jsonb_strip_nulls(jsonb_build_object('actor_user_agent', nullif(w.user_agent, ''), 'actor_device_id', d.id, 'actor_device_label', d.label))
			from web_sessions w left join devices d on d.id = w.device_id and d.account_id = w.account_id
			where w.token_hash = $4 and w.account_id = $1), '{}'::jsonb)`, account, kind, b, sessionHash)
	return err
}
