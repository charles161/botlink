package appapi

// Guards around an account's first passkey and its delete wait (third security pass at 9f90062, fix-all last builder).
//
// 1. A delete ask that registered the account's FIRST passkey (an account that never had one: the ask's human check
//    sets one up from a fresh sign-in) and is then cancelled by a sign-in that did not prove a passkey: every passkey
//    made since the ask started is removed in the same transaction, "has had a passkey" goes back to what it was, and
//    every other sign-in ends (the cancelling one stays). Otherwise someone holding only the person's Google or GitHub
//    sign-in kept the passkey they set up for the ask, and with it answered the owner's approvals, removed the owner's
//    browsers and cancelled the owner's passkey reset. The same happens when such an ask is cancelled by "sign out
//    other browsers". A cancel proved by a passkey removes nothing, and an ask made on an account that already had a
//    passkey never removes anything: its asker proved a passkey that existed before, and passkeys added since then
//    were added by proving one too, so a sign-in without a passkey must not take them away.
// 2. More generally, for FirstPasskeyUndo (72 h) after an account's first passkey was registered, a sign-in made
//    BEFORE that passkey may remove it, and every passkey made since, without a passkey (POST
//    /app/v1/me/first-passkey/remove). Sign-ins made after the remover's own end. It needs a live sign-in older than the
//    passkey: whoever signs in with the Google or GitHub account after the owner set up their first passkey can't use
//    it, and the owner closes it for everyone older by signing out other browsers.
// 3. A pending delete is cancelled when a browser of the account is removed or "sign out other browsers" is used, and
//    a new ask is refused for BOTLINK_ACCOUNT_DELETE_ASK_HOLD (24 h) after either.
//
// None of this replaces a notice by mail (there is no mail sender): a delete that nobody looks at for its whole wait
// still goes through.

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/charles161/botlink/server/internal/auth"
	"github.com/charles161/botlink/server/internal/httpx"
	"github.com/charles161/botlink/server/internal/store"
)

// checkLife is how long a human check lives (humancheck: now() + 5 minutes). An ask's passkey is registered while its
// check is answered, so it is at most this much older than the ask.
const checkLife = 5 * time.Minute

// FirstPasskeyUndo is how long after an account's first passkey a sign-in made before it may remove it.
const FirstPasskeyUndo = 72 * time.Hour

func (a *API) guardRoutes(mux *http.ServeMux) {
	mux.Handle("POST /app/v1/me/first-passkey/remove", a.sess(a.postFirstPasskeyRemove))
}

func undoneJSON(u *store.Undone) map[string]any {
	if u == nil {
		return map[string]any{}
	}
	return map[string]any{"passkeys_removed": u.Passkeys, "sign_ins_ended": u.SignIns, "resets_cancelled": u.Resets}
}

// cancelDeleteTx closes the open delete ask inside tx (by: session | passkey | signed_out | browser_removed). When the
// cancel proved no passkey (session, signed_out) and the ask registered the account's first passkey, the passkeys made
// since the ask started are removed and every other sign-in ends (see the top of this file). had is false when no ask
// was open.
func (a *API) cancelDeleteTx(ctx context.Context, tx pgx.Tx, s *auth.Session, by string) (had bool, undone *store.Undone, err error) {
	if _, err := tx.Exec(ctx, `select pg_advisory_xact_lock(hashtextextended('account_delete:' || $1::text, 0))`, s.AccountID); err != nil {
		return false, nil, err
	}
	d, err := store.OpenDelete(ctx, tx, s.AccountID, true)
	if err != nil {
		return false, nil, err
	}
	if d != nil && !d.Lapsed && (by == "session" || by == "signed_out") {
		if err := store.LockPasskeys(ctx, tx, s.AccountID); err != nil {
			return false, nil, err
		}
		since := d.CreatedAt.Add(-checkLife)
		first, err := store.FirstPasskeyAt(ctx, tx, s.AccountID)
		if err != nil {
			return false, nil, err
		}
		if first != nil && !first.Before(since) {
			u, err := store.UndoPasskeysSince(ctx, tx, s.AccountID, since, s.Hash, nil)
			if err != nil {
				return false, nil, err
			}
			undone = &u
		}
	}
	extra := map[string]any{}
	if undone != nil {
		extra = undoneJSON(undone)
		extra["first_passkey_removed"] = true
	}
	had, err = store.CancelDelete(ctx, tx, s.AccountID, by, s.Hash, extra)
	return had, undone, err
}

// signOutOthers ends every other sign-in of the account, records it, and cancels a pending delete (see the top).
func (a *API) signOutOthers(ctx context.Context, s *auth.Session) (signedOut int64, cancelled bool, undone *store.Undone, err error) {
	err = a.St.Tx(ctx, func(tx pgx.Tx) error {
		if cancelled, undone, err = a.cancelDeleteTx(ctx, tx, s, "signed_out"); err != nil {
			return err
		}
		tag, err := tx.Exec(ctx, `delete from web_sessions where account_id = $1 and token_hash <> $2`, s.AccountID, s.Hash)
		if err != nil {
			return err
		}
		signedOut = tag.RowsAffected()
		if undone != nil {
			signedOut += undone.SignIns
		}
		if err := store.AccountEventBy(ctx, tx, s.AccountID, s.Hash, "signed_out_others", map[string]any{"sign_ins_ended": signedOut,
			"delete_cancelled": cancelled}); err != nil {
			return err
		}
		return store.DashChanged(ctx, tx, s.AccountID)
	})
	if err == nil && cancelled {
		a.notify(ctx, s, RecoveryNotice{Kind: "delete_cancelled", How: "signed_out"})
	}
	return
}

// deleteAskPaused refuses a delete ask for DeleteAskHold after a browser was removed or the others were signed out.
func (a *API) deleteAskPaused(ctx context.Context, q store.Q, account string) error {
	until, err := store.DeleteAskPausedUntil(ctx, q, account, a.Cfg.DeleteAskHold())
	if err != nil || until == nil {
		return err
	}
	return httpx.E(409, "delete_held", "A browser of this account was removed or signed out recently, so asking to delete it is paused until "+
		until.Format("2 Jan 2006, 15:04 UTC")+".").With("until", until)
}

// firstPasskeyUndo says whether this sign-in may remove the account's first passkey now (rule 2), and until when.
func (a *API) firstPasskeyUndo(ctx context.Context, q store.Q, s *auth.Session) (first *time.Time, until *time.Time, err error) {
	// the first passkey's own time: had_passkey_at is stamped a moment after the passkey row is written
	var ok bool
	err = q.QueryRow(ctx, `with f as (select least(a.had_passkey_at, (select min(created_at) from webauthn_credentials c where c.account_id = a.id)) as at
			from accounts a where a.id = $1 and a.had_passkey_at is not null)
		select f.at, f.at + make_interval(secs => $3),
			f.at > now() - make_interval(secs => $3) and w.created_at < f.at
			and exists(select 1 from webauthn_credentials c where c.account_id = $1)
		from f join web_sessions w on w.token_hash = $2 and w.account_id = $1`,
		s.AccountID, s.Hash, FirstPasskeyUndo.Seconds()).Scan(&first, &until, &ok)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil, nil
	}
	if err != nil || !ok {
		return nil, nil, err
	}
	f, u := first.UTC(), until.UTC()
	return &f, &u, nil
}

// firstPasskeyJSON is what the dashboard shows a sign-in that may remove the account's first passkey (null otherwise).
func (a *API) firstPasskeyJSON(ctx context.Context, q store.Q, s *auth.Session) (any, error) {
	first, until, err := a.firstPasskeyUndo(ctx, q, s)
	if err != nil || first == nil {
		return nil, err
	}
	var agent string
	if err := q.QueryRow(ctx, `select coalesce((select created_user_agent from webauthn_credentials where account_id = $1 order by created_at limit 1), '')`,
		s.AccountID).Scan(&agent); err != nil {
		return nil, err
	}
	return map[string]any{"made_at": first, "until": until, "user_agent": agent}, nil
}

// POST /app/v1/me/first-passkey/remove {}: rule 2. No passkey; this sign-in must be older than the account's first
// passkey, which must be younger than FirstPasskeyUndo.
func (a *API) postFirstPasskeyRemove(w http.ResponseWriter, r *http.Request, s *auth.Session) error {
	ctx := r.Context()
	var u store.Undone
	err := a.St.Tx(ctx, func(tx pgx.Tx) error {
		// the delete lock first, then the passkey lock: the same order as a delete cancel
		if _, err := tx.Exec(ctx, `select pg_advisory_xact_lock(hashtextextended('account_delete:' || $1::text, 0))`, s.AccountID); err != nil {
			return err
		}
		if err := store.LockPasskeys(ctx, tx, s.AccountID); err != nil {
			return err
		}
		first, _, err := a.firstPasskeyUndo(ctx, tx, s)
		if err != nil {
			return err
		}
		if first == nil {
			return httpx.E(403, "forbidden", "Only a browser that was signed in before the account's first passkey was set up can remove it, and only in its first "+
				span(FirstPasskeyUndo)+".")
		}
		var signedIn time.Time
		if err := tx.QueryRow(ctx, `select created_at from web_sessions where token_hash = $1`, s.Hash).Scan(&signedIn); err != nil {
			return err
		}
		if u, err = store.UndoPasskeysSince(ctx, tx, s.AccountID, *first, s.Hash, &signedIn); err != nil {
			return err
		}
		// a pending delete asked with that passkey goes too
		if _, _, err := a.cancelDeleteTx(ctx, tx, s, "session"); err != nil {
			return err
		}
		return store.AccountEventBy(ctx, tx, s.AccountID, s.Hash, "first_passkey_removed", undoneJSON(&u))
	})
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, 200, undoneJSON(&u))
	return nil
}
