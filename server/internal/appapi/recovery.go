package appapi

import (
	"bytes"
	"context"
	"crypto/subtle"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/charles161/botlink/server/internal/auth"
	"github.com/charles161/botlink/server/internal/httpx"
	"github.com/charles161/botlink/server/internal/humancheck"
	"github.com/charles161/botlink/server/internal/store"
	"github.com/charles161/botlink/server/internal/wire"
)

// Lost passkey (prod-readiness blocker 5, migration 0042). Every join approval needs a passkey and adding one needs an
// existing one, so a person whose only passkey is gone had no way back. A passkey reset is that way back, and it is
// the easiest way around the passkey, so:
//   - it starts only from a sign-in made in the last BOTLINK_PASSKEY_RESET_SIGNIN_MAX_AGE (10 min): a copied session
//     cookie or a long-open browser can't start one;
//   - it waits BOTLINK_PASSKEY_RESET_DELAY (72 h). Meanwhile every signed-in dashboard of the account shows it, and it
//     can be cancelled with any passkey of the account, or by any sign-in made before the reset was asked (a sign-in
//     made after it, e.g. by whoever asked, can't cancel without a passkey);
//   - only the BROWSER that asked can finish it (an HttpOnly cookie set when it asked holds a random token whose hash is
//     kept with the reset; security review of fix-all, finding 1: binding it to the sign-in made it unfinishable,
//     because after 72 h that browser must sign in again, which makes a new session), from a fresh sign-in, with
//     Turnstile. A fresh sign-in anywhere else, or a copied session cookie without the reset cookie, never can. Finishing sets up the new
//     passkey and, in the same transaction, removes every old passkey and ends every other sign-in. The account never
//     has zero passkeys, and approvals never stop asking for one (humancheck: a fresh sign-in no longer stands in for
//     a passkey once the account has one);
//   - at most resetStartsPerDay starts per account per 24 hours; start, cancel and finish are account_events.
//
// The server has no mail sender: Mail (recoverymail.go) is NoMail unless something sets it.

const resetStartsPerDay = 3

func (a *API) recoveryRoutes(mux *http.ServeMux) {
	mux.Handle("GET /app/v1/me/passkey-reset", a.sess(a.getPasskeyReset))
	mux.Handle("POST /app/v1/me/passkey-reset", a.sess(a.postPasskeyReset))
	mux.Handle("POST /app/v1/me/passkey-reset/check", a.sess(a.postPasskeyResetCheck))
	mux.Handle("POST /app/v1/me/passkey-reset/cancel", a.sess(a.postPasskeyResetCancel))
	mux.Handle("POST /app/v1/me/passkey-reset/finish", a.sess(a.postPasskeyResetFinish))
	mux.Handle("POST /app/v1/devices/{id}/remove", a.sess(a.postDeviceRemove))
	mux.Handle("POST /app/v1/me/browser/challenge", a.sess(a.postBrowserChallenge))
	mux.Handle("POST /app/v1/me/browser", a.sess(a.postThisBrowser))
}

// The reset cookie: which browser asked for the reset. A random token; the reset row keeps its sha256. HttpOnly (page
// scripts can't read it), SameSite=Strict, and __Host- where cookies are Secure (only this exact host can set it).
// The device key is not used for this: a page script can make it sign, and a removed or re-made key would orphan the reset.
const (
	resetCookieHost = "__Host-bl_reset"
	resetCookieBare = "bl_reset"
)

func (a *API) resetCookieName() string {
	if a.Cfg.SecureCookies() {
		return resetCookieHost
	}
	return resetCookieBare
}

func (a *API) setResetCookie(w http.ResponseWriter, val string, maxAge int) {
	http.SetCookie(w, &http.Cookie{Name: a.resetCookieName(), Value: val, Path: "/", HttpOnly: true, Secure: a.Cfg.SecureCookies(),
		SameSite: http.SameSiteStrictMode, MaxAge: maxAge})
}

// browserHash is sha256 of this browser's reset cookie, or nil.
func (a *API) browserHash(r *http.Request) []byte {
	ck, err := r.Cookie(a.resetCookieName())
	if err != nil || ck.Value == "" || len(ck.Value) > 100 {
		return nil
	}
	return wire.SHA256([]byte(ck.Value))
}

// askedHere: this browser is the one that asked for the reset.
func askedHere(rs *store.Reset, bh []byte) bool {
	return len(rs.BrowserHash) == 32 && len(bh) == 32 && subtle.ConstantTimeCompare(rs.BrowserHash, bh) == 1
}

func resetOff() *httpx.Error {
	return httpx.E(409, "reset_off", "Passkey resets are turned off on this server.")
}

// BrowserProofContext is the signing context of a browser proof (wire.Sign / wire.Verify; the roster uses
// "botlink-roster-v1", so a proof can never pass for a roster entry or the other way round).
const BrowserProofContext = "botlink-browser-proof-v1"

func proofFailed() *httpx.Error {
	return httpx.E(403, "proof_failed", "This browser couldn't prove which browser it is.")
}

// POST /app/v1/me/browser/challenge: a single-use challenge (5 minutes) for this session to sign with its browser key.
func (a *API) postBrowserChallenge(w http.ResponseWriter, r *http.Request, s *auth.Session) error {
	ctx := r.Context()
	id, challenge := wire.NewV7().String(), wire.RandBytes(32)
	var exp time.Time
	if err := a.St.Tx(ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `delete from browser_proofs where session_hash = $1 and (used_at is not null or expires_at < now())`, s.Hash); err != nil {
			return err
		}
		var open int
		if err := tx.QueryRow(ctx, `select count(*) from browser_proofs where session_hash = $1`, s.Hash).Scan(&open); err != nil {
			return err
		}
		if open >= 20 {
			return httpx.RateLimited("", 300)
		}
		return tx.QueryRow(ctx, `insert into browser_proofs (id, session_hash, challenge, expires_at) values ($1,$2,$3, now() + interval '5 minutes')
			returning expires_at`, id, s.Hash, challenge).Scan(&exp)
	}); err != nil {
		return err
	}
	httpx.WriteJSON(w, 200, map[string]any{"id": id, "challenge": wire.B64URL(challenge), "expires_at": exp.UTC()})
	return nil
}

// POST /app/v1/me/browser {device_id, proof_id, sig}: this sign-in proves which of the account's browser keys it uses:
// sig = Ed25519(that key, "botlink-browser-proof-v1\n" || challenge || device_id), with a challenge this session got
// and hasn't used. A removed browser's key is refused. Only what is proved is recorded: it says where a passkey is made
// or used, so removing a browser can offer to remove the passkeys that live there. It grants nothing. A browser whose
// key is registered but not yet approved proves itself like any other and is recorded as itself (its own label), never
// as an approved one; a sign-in that proved nothing is an unknown browser.
func (a *API) postThisBrowser(w http.ResponseWriter, r *http.Request, s *auth.Session) error {
	ctx := r.Context()
	body, err := httpx.ReadBody(r)
	if err != nil {
		return err
	}
	var b struct {
		DeviceID string `json:"device_id"`
		ProofID  string `json:"proof_id"`
		Sig      string `json:"sig"`
	}
	if err := httpx.DecodeStrict(body, &b); err != nil {
		return err
	}
	if !wire.IsUUID(b.DeviceID) || !wire.IsUUID(b.ProofID) {
		return httpx.BadRequest("device_id and proof_id must be uuids, sig 128 hex chars.")
	}
	sig, ok := wire.DecodeSig(b.Sig)
	if !ok {
		return httpx.BadRequest("device_id and proof_id must be uuids, sig 128 hex chars.")
	}
	return a.St.Tx(ctx, func(tx pgx.Tx) error {
		var challenge []byte
		err := tx.QueryRow(ctx, `update browser_proofs set used_at = now() where id = $1 and session_hash = $2 and used_at is null and expires_at > now()
			returning challenge`, b.ProofID, s.Hash).Scan(&challenge)
		if errors.Is(err, pgx.ErrNoRows) {
			return proofFailed()
		}
		if err != nil {
			return err
		}
		var pk []byte
		err = tx.QueryRow(ctx, `select ed25519_pk from devices where id = $1 and account_id = $2 and revoked_at is null`, b.DeviceID, s.AccountID).Scan(&pk)
		if errors.Is(err, pgx.ErrNoRows) {
			return proofFailed()
		}
		if err != nil {
			return err
		}
		if !wire.Verify(pk, BrowserProofContext, append(append([]byte{}, challenge...), []byte(b.DeviceID)...), sig) {
			return proofFailed()
		}
		if _, err := tx.Exec(ctx, `update web_sessions set device_id = $2 where token_hash = $1`, s.Hash, b.DeviceID); err != nil {
			return err
		}
		httpx.WriteJSON(w, 200, map[string]any{"ok": true})
		return nil
	})
}

func reauthRequired(maxAge time.Duration) *httpx.Error {
	return httpx.E(403, "reauth_required", "Sign in again first. This needs a sign-in from the last few minutes.").
		With("max_age_s", int(maxAge.Seconds()))
}

func noResetPending() *httpx.Error {
	return httpx.E(404, "not_found", "No passkey reset is waiting.")
}

// resetJSON is PasskeyResetState: the open reset (or null) as this browser sees it, the settings, the recent events.
func (a *API) resetJSON(ctx context.Context, q store.Q, s *auth.Session, bh []byte) (map[string]any, error) {
	r, err := store.OpenReset(ctx, q, s.AccountID, false)
	if err != nil {
		return nil, err
	}
	signedIn, age, err := store.SessionSignedIn(ctx, q, s.Hash)
	if err != nil {
		return nil, err
	}
	var passkeys int
	var had bool
	if err := q.QueryRow(ctx, `select (select count(*) from webauthn_credentials where account_id = $1),
		(select had_passkey_at is not null from accounts where id = $1)`, s.AccountID).Scan(&passkeys, &had); err != nil {
		return nil, err
	}
	events, err := store.RecentAccountEvents(ctx, q, s.AccountID, 10)
	if err != nil {
		return nil, err
	}
	var reset any
	if r != nil {
		here := askedHere(r, bh)
		reset = map[string]any{"id": r.ID, "created_at": r.CreatedAt.UTC(), "ready_at": r.ReadyAt.UTC(), "ready": r.Ready,
			"started_here": here, "cancel_needs_passkey": !here && signedIn.After(r.CreatedAt), "user_agent": r.UserAgent}
	}
	first, err := a.firstPasskeyJSON(ctx, q, s)
	if err != nil {
		return nil, err
	}
	return map[string]any{"reset": reset, "passkeys": passkeys, "had_passkey": had || passkeys > 0, "first_passkey_undo": first,
		"reset_enabled": a.Cfg.ResetEnabled(), "delete_hold_s": int(a.Cfg.ResetDeleteHold().Seconds()), "delay_s": int(a.Cfg.ResetDelay().Seconds()),
		"signin_max_age_s": int(a.Cfg.ResetSignInMaxAge().Seconds()), "signed_in_at": signedIn.UTC(),
		"signin_fresh": age <= a.Cfg.ResetSignInMaxAge(), "events": events}, nil
}

func (a *API) writeReset(w http.ResponseWriter, r *http.Request, s *auth.Session, status int) error {
	v, err := a.resetJSON(r.Context(), a.St.Pool, s, a.browserHash(r))
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, status, v)
	return nil
}

// notify sends a recovery notice after the change committed. A failure is logged, never shown: the change stands.
func (a *API) notify(ctx context.Context, s *auth.Session, n RecoveryNotice) {
	if a.Mail == nil {
		return
	}
	n.Email, n.Name = s.Email, s.DisplayName
	mctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	if err := a.Mail.Send(mctx, n); err != nil {
		slog.WarnContext(ctx, "recovery notice not sent", "kind", n.Kind, "err", err, "request_id", httpx.RequestID(ctx))
	}
}

func (a *API) freshSignIn(ctx context.Context, q store.Q, s *auth.Session) error {
	_, age, err := store.SessionSignedIn(ctx, q, s.Hash)
	if err != nil {
		return err
	}
	if age > a.Cfg.ResetSignInMaxAge() {
		return reauthRequired(a.Cfg.ResetSignInMaxAge())
	}
	return nil
}

// GET /app/v1/me/passkey-reset
func (a *API) getPasskeyReset(w http.ResponseWriter, r *http.Request, s *auth.Session) error {
	return a.writeReset(w, r, s, 200)
}

// POST /app/v1/me/passkey-reset: ask for a reset (fresh sign-in; the account has a passkey to lose; none open; limit).
func (a *API) postPasskeyReset(w http.ResponseWriter, r *http.Request, s *auth.Session) error {
	ctx := r.Context()
	if !a.Cfg.ResetEnabled() {
		return resetOff()
	}
	var had bool
	if err := a.St.Pool.QueryRow(ctx, `select exists(select 1 from webauthn_credentials where account_id = $1)
		or (select had_passkey_at is not null from accounts where id = $1)`, s.AccountID).Scan(&had); err != nil {
		return err
	}
	if !had {
		return httpx.E(409, "no_passkey", "You have no passkey to reset. Your next approval sets one up.")
	}
	token := wire.B64URL(wire.RandBytes(32))
	if err := a.freshSignIn(ctx, a.St.Pool, s); err != nil {
		return err
	}
	var readyAt time.Time
	var agent string
	err := a.St.Tx(ctx, func(tx pgx.Tx) error {
		// one account at a time: the open-reset index catches a double start, the lock makes the day's count exact
		if _, err := tx.Exec(ctx, `select pg_advisory_xact_lock(hashtextextended('passkey_reset:' || $1::text, 0))`, s.AccountID); err != nil {
			return err
		}
		open, err := store.OpenReset(ctx, tx, s.AccountID, false)
		if err != nil {
			return err
		}
		if open != nil {
			return httpx.E(409, "reset_pending", "A passkey reset is already waiting for this account.")
		}
		var started int
		var retry float64
		if err := tx.QueryRow(ctx, `select count(*), coalesce(extract(epoch from min(created_at) + interval '24 hours' - now()), 0)
			from passkey_resets where account_id = $1 and created_at > now() - interval '24 hours'`, s.AccountID).Scan(&started, &retry); err != nil {
			return err
		}
		if started >= resetStartsPerDay {
			e := httpx.RateLimited("", int(retry)+1)
			e.Message = "Too many passkey resets were asked today. Try again tomorrow."
			return e
		}
		if err := tx.QueryRow(ctx, `insert into passkey_resets (id, account_id, session_hash, browser_hash, user_agent, ready_at)
			select $1, $2, $3, $5, coalesce((select user_agent from web_sessions where token_hash = $3), ''), now() + make_interval(secs => $4)
			returning ready_at, user_agent`, wire.NewV7().String(), s.AccountID, s.Hash, a.Cfg.ResetDelay().Seconds(),
			wire.SHA256([]byte(token))).Scan(&readyAt, &agent); err != nil {
			return err
		}
		if err := store.AccountEventBy(ctx, tx, s.AccountID, s.Hash, "passkey_reset_started", map[string]any{"ready_at": readyAt.UTC(), "user_agent": agent}); err != nil {
			return err
		}
		return store.DashChanged(ctx, tx, s.AccountID)
	})
	if err != nil {
		return err
	}
	a.notify(ctx, s, RecoveryNotice{Kind: "started", ReadyAt: readyAt, Agent: agent})
	a.setResetCookie(w, token, int((a.Cfg.ResetDelay() + 30*24*time.Hour).Seconds()))
	v, err := a.resetJSON(ctx, a.St.Pool, s, wire.SHA256([]byte(token)))
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, 201, v)
	return nil
}

// finishable: resets are on, the open reset is ready, this is the browser that asked (bh), and its sign-in is fresh.
func (a *API) finishable(ctx context.Context, q store.Q, s *auth.Session, bh []byte, lock bool) (*store.Reset, error) {
	if !a.Cfg.ResetEnabled() {
		return nil, resetOff()
	}
	rs, err := store.OpenReset(ctx, q, s.AccountID, lock)
	if err != nil {
		return nil, err
	}
	if rs == nil {
		return nil, noResetPending()
	}
	if !askedHere(rs, bh) {
		return nil, httpx.Forbidden("Finish the reset in the browser that asked for it.")
	}
	if !rs.Ready {
		return nil, httpx.E(409, "reset_not_ready", "The waiting time isn't over yet.").With("ready_at", rs.ReadyAt.UTC())
	}
	if err := a.freshSignIn(ctx, q, s); err != nil {
		return nil, err
	}
	return rs, nil
}

// POST /app/v1/me/passkey-reset/check {action: cancel | finish}: the human check for cancelling (assert any passkey of
// the account) or finishing (register the new passkey), issued only when the reset's state allows it.
func (a *API) postPasskeyResetCheck(w http.ResponseWriter, r *http.Request, s *auth.Session) error {
	ctx := r.Context()
	body, err := httpx.ReadBody(r)
	if err != nil {
		return err
	}
	var b struct {
		Action string `json:"action"`
	}
	if err := httpx.DecodeStrict(body, &b); err != nil {
		return err
	}
	var action string
	switch b.Action {
	case "cancel":
		rs, err := store.OpenReset(ctx, a.St.Pool, s.AccountID, false)
		if err != nil {
			return err
		}
		if rs == nil {
			return noResetPending()
		}
		action = humancheck.ResetCancelAction
	case "finish":
		if _, err := a.finishable(ctx, a.St.Pool, s, a.browserHash(r), false); err != nil {
			return err
		}
		action = humancheck.ResetFinishAction
	default:
		return httpx.BadRequest("action must be cancel or finish.")
	}
	out, err := a.HC.StartReset(ctx, a.St.Pool, s, action)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, 200, out)
	return nil
}

// POST /app/v1/me/passkey-reset/cancel {human_check?}: with a passkey (any sign-in), or without one from a sign-in made
// before the reset was asked.
func (a *API) postPasskeyResetCancel(w http.ResponseWriter, r *http.Request, s *auth.Session) error {
	ctx := r.Context()
	body, err := httpx.ReadBody(r)
	if err != nil {
		return err
	}
	var b struct {
		HumanCheck *humancheck.Proof `json:"human_check"`
	}
	if len(bytes.TrimSpace(body)) > 0 {
		if err := httpx.DecodeStrict(body, &b); err != nil {
			return err
		}
	}
	rs, err := store.OpenReset(ctx, a.St.Pool, s.AccountID, false)
	if err != nil {
		return err
	}
	if rs == nil {
		return noResetPending()
	}
	by := "session"
	if b.HumanCheck != nil {
		used, err := a.HC.VerifyCred(ctx, a.St.Pool, s, b.HumanCheck, humancheck.ResetCancelAction, httpx.ClientIP(r, a.Cfg.TrustCF))
		if err != nil {
			return err
		}
		if used == nil {
			return httpx.E(403, "human_check_failed", "Confirm with one of your passkeys.").With("reason", "webauthn_assert")
		}
		by = "passkey"
	} else {
		signedIn, _, err := store.SessionSignedIn(ctx, a.St.Pool, s.Hash)
		if err != nil {
			return err
		}
		if !askedHere(rs, a.browserHash(r)) && signedIn.After(rs.CreatedAt) {
			return httpx.Forbidden("This browser signed in after the reset was asked. Cancel it with one of your passkeys, or from a browser that was signed in before.")
		}
	}
	err = a.St.Tx(ctx, func(tx pgx.Tx) error {
		cur, err := store.OpenReset(ctx, tx, s.AccountID, true)
		if err != nil {
			return err
		}
		if cur == nil || cur.ID != rs.ID {
			return noResetPending()
		}
		if by == "passkey" {
			if err := humancheck.Consume(ctx, tx, b.HumanCheck.ID, s); err != nil {
				return err
			}
		}
		if _, err := tx.Exec(ctx, `update passkey_resets set cancelled_at = now(), cancelled_by = $2 where id = $1`, rs.ID, by); err != nil {
			return err
		}
		if err := store.AccountEventBy(ctx, tx, s.AccountID, s.Hash, "passkey_reset_cancelled", map[string]any{"by": by}); err != nil {
			return err
		}
		return store.DashChanged(ctx, tx, s.AccountID)
	})
	if err != nil {
		return err
	}
	a.notify(ctx, s, RecoveryNotice{Kind: "cancelled", How: by})
	return a.writeReset(w, r, s, 200)
}

// POST /app/v1/me/passkey-reset/finish {human_check}: the new passkey (the check's registration) replaces every old one,
// and every other sign-in of the account ends, in one transaction.
func (a *API) postPasskeyResetFinish(w http.ResponseWriter, r *http.Request, s *auth.Session) error {
	ctx := r.Context()
	body, err := httpx.ReadBody(r)
	if err != nil {
		return err
	}
	var b struct {
		HumanCheck humancheck.Proof `json:"human_check"`
	}
	if err := httpx.DecodeStrict(body, &b); err != nil {
		return err
	}
	bh := a.browserHash(r)
	rs, err := a.finishable(ctx, a.St.Pool, s, bh, false)
	if err != nil {
		return err
	}
	held, err := a.HC.VerifyReset(ctx, a.St.Pool, s, &b.HumanCheck, httpx.ClientIP(r, a.Cfg.TrustCF))
	if err != nil {
		return err
	}
	var removed, ended int64
	err = a.St.Tx(ctx, func(tx pgx.Tx) error {
		cur, err := a.finishable(ctx, tx, s, bh, true)
		if err != nil {
			return err
		}
		if cur.ID != rs.ID {
			return noResetPending()
		}
		if err := store.LockPasskeys(ctx, tx, s.AccountID); err != nil { // a passkey added meanwhile can't survive
			return err
		}
		if err := humancheck.Consume(ctx, tx, b.HumanCheck.ID, s); err != nil {
			return err
		}
		if err := held.Store(ctx, tx, s); err != nil {
			return err
		}
		tag, err := tx.Exec(ctx, `delete from webauthn_credentials where account_id = $1 and id <> $2`, s.AccountID, held.ID())
		if err != nil {
			return err
		}
		removed = tag.RowsAffected()
		if tag, err = tx.Exec(ctx, `delete from web_sessions where account_id = $1 and token_hash <> $2`, s.AccountID, s.Hash); err != nil {
			return err
		}
		ended = tag.RowsAffected()
		if _, err := tx.Exec(ctx, `update passkey_resets set completed_at = now() where id = $1`, rs.ID); err != nil {
			return err
		}
		// the passkeys changed hands: a delete asked before is no longer the person's word (lane ACCOUNT, re-review)
		if _, err := store.CancelDelete(ctx, tx, s.AccountID, "passkey_reset", s.Hash, nil); err != nil {
			return err
		}
		if err := store.AccountEventBy(ctx, tx, s.AccountID, s.Hash, "passkey_reset_completed", map[string]any{"removed_passkeys": removed, "ended_sign_ins": ended}); err != nil {
			return err
		}
		return store.DashChanged(ctx, tx, s.AccountID)
	})
	if err != nil {
		return err
	}
	a.notify(ctx, s, RecoveryNotice{Kind: "completed"})
	a.setResetCookie(w, "", -1)
	return a.writePasskeys(w, r, s)
}

// deleteHeld refuses account delete while a passkey reset is open and for BOTLINK_PASSKEY_RESET_DELETE_HOLD (7 days)
// after one finished: whoever controls only the Google or GitHub account and lets a reset run out would otherwise get
// a passkey and delete the account, and every room it owns, for all members, at once (security review of fix-all).
func (a *API) deleteHeld(ctx context.Context, q store.Q, account string) error {
	held, until, err := store.DeleteHeld(ctx, q, account, a.Cfg.ResetDeleteHold())
	if err != nil || !held {
		return err
	}
	if until == nil {
		return httpx.E(409, "delete_held", "A passkey reset is waiting on this account. It can't be deleted until the reset is cancelled, or "+
			span(a.Cfg.ResetDeleteHold())+" after it is finished.")
	}
	return httpx.E(409, "delete_held", "Your passkeys were reset recently. This account can't be deleted until "+
		until.Format("2 Jan 2006, 15:04 UTC")+".").With("until", until)
}

// span: "7 days", "36 hours", "10 minutes".
func span(d time.Duration) string {
	switch {
	case d >= 24*time.Hour && d%(24*time.Hour) == 0:
		n := int(d / (24 * time.Hour))
		if n == 1 {
			return "1 day"
		}
		return fmt.Sprintf("%d days", n)
	case d >= time.Hour && d%time.Hour == 0:
		return fmt.Sprintf("%d hours", int(d/time.Hour))
	}
	return fmt.Sprintf("%d minutes", int(d/time.Minute))
}
