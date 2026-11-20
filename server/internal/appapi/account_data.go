package appapi

// Self-serve account export and delete (fix-all blocker 3, lane ACCOUNT; SPEC §6.15). The rows themselves are in
// store/account.go.
//
//   GET  /app/v1/me/export   one JSON file with everything the server holds about this account
//   GET  /app/v1/me/delete          what deleting would do, as this browser sees it (?device_id=), and the pending ask
//   POST /app/v1/me/delete/ask      {confirm, human_check}: start the wait; nothing is removed or signed
//   POST /app/v1/me/delete/cancel   {human_check?}: any sign-in of the account, with or without a passkey
//   POST /app/v1/me/delete          {confirm, human_check, entries: [{room_id, roster_entry}]}: finish, after the wait
//
// Ask and finish each need the human check "account_delete" (a passkey every time, like a join approval) and the
// account's email typed in. Between them, a wait (BOTLINK_ACCOUNT_DELETE_DELAY, 72 h) shown on every signed-in page of
// the account (security re-review of fix-all: a thief with a passkey on a stolen laptop, or with only the Google or
// GitHub sign-in of an account that never had a passkey, deleted it at once). The leaves are signed only at the finish,
// so nothing irreversible happens before the wait is over.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/charles161/botlink/server/internal/auth"
	"github.com/charles161/botlink/server/internal/httpx"
	"github.com/charles161/botlink/server/internal/humancheck"
	"github.com/charles161/botlink/server/internal/ratelimit"
	"github.com/charles161/botlink/server/internal/roster"
	"github.com/charles161/botlink/server/internal/store"
	"github.com/charles161/botlink/server/internal/wire"
)

// AccountDeleteAction is the human check of POST /app/v1/me/delete: no target, a fresh passkey answer every time
// (step "assert"; an account with no passkey registers its first one in the same step, which needs a sign-in within
// 5 minutes). Registered here so the humancheck package stays as it is (another lane edits it).
const AccountDeleteAction = "account_delete"

func init() {
	humancheck.Actions[AccountDeleteAction] = true
	humancheck.NoTarget[AccountDeleteAction] = true
	humancheck.EveryTime[AccountDeleteAction] = true
}

var (
	// AccountExports: an export reads every row of the account; a person needs one, a few at most.
	AccountExports = ratelimit.Limit{Name: "export:a", Window: time.Hour, Max: 5}
	// AccountDeletes: delete attempts (a roster conflict retries a few times with the same human check).
	AccountDeletes = ratelimit.Limit{Name: "acctdel:a", Window: time.Hour, Max: 10}
	// AccountDeleteAsks: asks to delete per account per day (each one shows on every page and sends a notice).
	AccountDeleteAsks = ratelimit.Limit{Name: "delask:a", Window: 24 * time.Hour, Max: 3}
)

func (a *API) accountRoutes(mux *http.ServeMux) {
	mux.Handle("GET /app/v1/me/export", a.sess(a.getExport))
	mux.Handle("GET /app/v1/me/delete", a.sess(a.getDeletePlan))
	mux.Handle("POST /app/v1/me/delete", a.sess(a.postDelete))
	mux.Handle("POST /app/v1/me/delete/ask", a.sess(a.postDeleteAsk))
	mux.Handle("POST /app/v1/me/delete/cancel", a.sess(a.postDeleteCancel))
}

const exportNotes = "Everything bot-link's server holds about this account on the date above. " +
	"Messages: the server only ever holds sealed copies it cannot open. They are counted and sized under messages, not included: " +
	"your chats already have the text, and a sealed copy opens only with the key on that chat's computer. " +
	"Message records list at most 5000 sent and 5000 received, newest first; the totals count them all. " +
	"Left out on purpose: sign-in tokens, the keys behind push and wake addresses, human check challenges, " +
	"and other people's email addresses. Other people appear by the name they show in rooms you share. " +
	"Kept outside the server: server logs (no email addresses or message text), backups, and, if product counts are on, " +
	"counts sent to PostHog under a code in place of your id."

// GET /app/v1/me/export
func (a *API) getExport(w http.ResponseWriter, r *http.Request, s *auth.Session) error {
	ctx := r.Context()
	// a sign-in from the last few minutes, never a passkey: someone who lost theirs must still get their data, and a
	// copied session cookie alone must not (lost-passkey lane, security review of fix-all)
	if err := a.freshSignIn(ctx, a.St.Pool, s); err != nil {
		return err
	}
	if err := ratelimit.Hit(ctx, a.St.Pool, AccountExports, s.AccountID); err != nil {
		return err
	}
	var out map[string]any
	// one snapshot: every section is read in the same repeatable-read transaction
	err := pgx.BeginTxFunc(ctx, a.St.Pool, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly}, func(tx pgx.Tx) error {
		var err error
		out, err = store.ExportAccount(ctx, tx, s.AccountID, s.Hash, a.Cfg.Plans.Paywall())
		return err
	})
	if err != nil {
		return err
	}
	now := time.Now().UTC()
	out["format"] = "botlink-account-export"
	out["version"] = 1
	out["exported_at"] = now
	out["notes"] = exportNotes
	w.Header().Set("Content-Disposition", `attachment; filename="botlink-account-`+now.Format("2006-01-02")+`.json"`)
	w.Header().Set("Cache-Control", "no-store")
	httpx.WriteJSON(w, 200, out)
	return nil
}

// GET /app/v1/me/delete?device_id=: what deleting would do. confirm_text is what the person types.
func (a *API) getDeletePlan(w http.ResponseWriter, r *http.Request, s *auth.Session) error {
	ctx := r.Context()
	var pk []byte
	if dev := r.URL.Query().Get("device_id"); dev != "" {
		if !wire.IsUUID(dev) {
			return httpx.BadRequest("device_id must be a uuid.")
		}
		var err error
		if pk, err = a.myDevicePK(ctx, a.St.Pool, s.AccountID, dev); err != nil {
			var he *httpx.Error
			if !errors.As(err, &he) || he.Status != 404 {
				return err
			}
			pk = nil // not this account's browser (or removed): it can sign nowhere
		}
	}
	p, err := store.GetDeletePlan(ctx, a.St.Pool, s.AccountID, pk)
	if err != nil {
		return err
	}
	pend, err := a.pendingJSON(ctx, a.St.Pool, s)
	if err != nil {
		return err
	}
	paused, err := store.DeleteAskPausedUntil(ctx, a.St.Pool, s.AccountID, a.Cfg.DeleteAskHold())
	if err != nil {
		return err
	}
	out := map[string]any{"confirm_text": s.Email, "owned_rooms": p.OwnedRooms, "joined_rooms": p.JoinedRooms,
		"chats": p.Chats, "passkeys": p.Passkeys, "human_check_mode": a.Cfg.HumanCheck,
		"pending": pend, "delay_s": int(a.Cfg.DeleteDelay().Seconds()), "window_s": int(a.Cfg.DeleteWindow().Seconds()),
		"ask_paused_until": paused, "ask_hold_s": int(a.Cfg.DeleteAskHold().Seconds())}
	if a.Cfg.Plans.Paywall() {
		out["plan_renews"] = p.PlanRenews
	}
	httpx.WriteJSON(w, 200, out)
	return nil
}

// pendingJSON is the open, not lapsed delete ask (null when there is none).
func (a *API) pendingJSON(ctx context.Context, q store.Q, s *auth.Session) (any, error) {
	d, err := store.OpenDelete(ctx, q, s.AccountID, false)
	if err != nil || d == nil || d.Lapsed {
		return nil, err
	}
	// first_passkey: the ask set up the account's first passkey, so a cancel without a passkey removes it (account_guard.go)
	first, err := store.FirstPasskeyAt(ctx, q, s.AccountID)
	if err != nil {
		return nil, err
	}
	return map[string]any{"asked_at": d.CreatedAt.UTC(), "ready_at": d.ReadyAt.UTC(), "lapses_at": d.LapsesAt.UTC(), "ready": d.Ready,
		"user_agent": d.UserAgent, "asked_here": bytes.Equal(d.SessionHash, s.Hash),
		"first_passkey": first != nil && !first.Before(d.CreatedAt.Add(-checkLife))}, nil
}

// deleteChecks: the typed email, no renewing paid plan (paywall on only), no passkey reset holding deletes.
func (a *API) deleteChecks(ctx context.Context, s *auth.Session, confirm string) error {
	if !strings.EqualFold(strings.TrimSpace(confirm), s.Email) {
		return httpx.BadRequest("Type your account's email address to confirm.").With("field", "confirm")
	}
	if a.Cfg.Plans.Paywall() {
		if err := a.planRenews(ctx, s.AccountID); err != nil {
			return err
		}
	}
	return a.deleteHeld(ctx, a.St.Pool, s.AccountID)
}

// planRenews refuses an account delete while a paid plan still renews (paywall on only).
func (a *API) planRenews(ctx context.Context, account string) error {
	renews, err := store.PlanRenews(ctx, a.St.Pool, account)
	if err != nil {
		return err
	}
	if renews {
		return httpx.E(409, "plan_renews", "Your paid plan renews. Cancel it under Plan and usage first, then delete your account.")
	}
	return nil
}

func deletePending() *httpx.Error {
	return httpx.E(409, "delete_pending", "A delete of this account is already waiting. Cancel it first, or finish it when it is ready.")
}

func deleteNotAsked() *httpx.Error {
	return httpx.E(409, "delete_not_asked", "Ask to delete the account first. It can be finished after the wait.")
}

// POST /app/v1/me/delete/ask {confirm, human_check}: start the wait. Nothing is removed and nothing is signed.
func (a *API) postDeleteAsk(w http.ResponseWriter, r *http.Request, s *auth.Session) error {
	ctx := r.Context()
	body, err := httpx.ReadBody(r)
	if err != nil {
		return err
	}
	var b struct {
		Confirm    string            `json:"confirm"`
		HumanCheck *humancheck.Proof `json:"human_check"`
	}
	if err := httpx.DecodeStrict(body, &b); err != nil {
		return err
	}
	if err := a.deleteChecks(ctx, s, b.Confirm); err != nil {
		return err
	}
	if d, err := store.OpenDelete(ctx, a.St.Pool, s.AccountID, false); err != nil {
		return err
	} else if d != nil && !d.Lapsed {
		return deletePending()
	}
	if err := a.deleteAskPaused(ctx, a.St.Pool, s.AccountID); err != nil {
		return err
	}
	if err := ratelimit.Hit(ctx, a.St.Pool, AccountDeleteAsks, s.AccountID); err != nil {
		return err
	}
	if err := a.verifyHuman(r, s, b.HumanCheck, AccountDeleteAction, ""); err != nil {
		return err
	}
	var d *store.PendingDelete
	err = a.St.Tx(ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `select pg_advisory_xact_lock(hashtextextended('account_delete:' || $1::text, 0))`, s.AccountID); err != nil {
			return err
		}
		if err := humancheck.Consume(ctx, tx, b.HumanCheck.ID, s); err != nil {
			return err
		}
		if err := a.deleteHeld(ctx, tx, s.AccountID); err != nil {
			return err
		}
		if err := a.deleteAskPaused(ctx, tx, s.AccountID); err != nil {
			return err
		}
		if cur, err := store.OpenDelete(ctx, tx, s.AccountID, true); err != nil {
			return err
		} else if cur != nil && !cur.Lapsed {
			return deletePending()
		}
		var err error
		if d, err = store.AskDelete(ctx, tx, s.AccountID, s.Hash, wire.NewV7().String(), a.Cfg.DeleteDelay(), a.Cfg.DeleteWindow()); err != nil {
			return err
		}
		return store.DashChanged(ctx, tx, s.AccountID)
	})
	if err != nil {
		return err
	}
	a.notify(ctx, s, RecoveryNotice{Kind: "delete_asked", ReadyAt: d.ReadyAt, Agent: d.UserAgent})
	pend, err := a.pendingJSON(ctx, a.St.Pool, s)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, 201, map[string]any{"pending": pend})
	return nil
}

// POST /app/v1/me/delete/cancel {human_check?}: any signed-in session of the account cancels, no passkey needed; with
// a passkey (human check account_delete) it is recorded as cancelled by a passkey. Without one, an ask that set up the
// account's first passkey loses it, and every other sign-in ends (account_guard.go).
func (a *API) postDeleteCancel(w http.ResponseWriter, r *http.Request, s *auth.Session) error {
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
	by := "session"
	if b.HumanCheck != nil {
		used, err := a.HC.VerifyCred(ctx, a.St.Pool, s, b.HumanCheck, AccountDeleteAction, httpx.ClientIP(r, a.Cfg.TrustCF))
		if err != nil {
			return err
		}
		if used != nil {
			by = "passkey"
		}
	}
	var had bool
	var undone *store.Undone
	err = a.St.Tx(ctx, func(tx pgx.Tx) error {
		if b.HumanCheck != nil {
			if err := humancheck.Consume(ctx, tx, b.HumanCheck.ID, s); err != nil {
				return err
			}
		}
		var err error
		// without a passkey, an ask that set up the account's first passkey takes that passkey with it (account_guard.go)
		had, undone, err = a.cancelDeleteTx(ctx, tx, s, by)
		if err == nil && !had {
			err = httpx.E(404, "not_found", "No delete is waiting.")
		}
		return err
	})
	if err != nil {
		return err
	}
	a.notify(ctx, s, RecoveryNotice{Kind: "delete_cancelled", How: by})
	out := undoneJSON(undone)
	out["pending"], out["cancelled_by"], out["first_passkey_removed"] = nil, by, undone != nil
	httpx.WriteJSON(w, 200, out)
	return nil
}

// finishable: an ask is open, its wait is over, and it has not lapsed.
func finishable(d *store.PendingDelete) error {
	switch {
	case d == nil:
		return deleteNotAsked()
	case d.Lapsed:
		return httpx.E(409, "delete_lapsed", "The time to finish this delete has passed. Ask again if you still want it.").With("lapsed_at", d.LapsesAt.UTC())
	case !d.Ready:
		return httpx.E(409, "delete_not_ready", "The wait isn't over yet.").With("ready_at", d.ReadyAt.UTC())
	}
	return nil
}

type leaveEntry struct {
	RoomID      string      `json:"room_id"`
	RosterEntry roster.Wire `json:"roster_entry"`
}

// POST /app/v1/me/delete
func (a *API) postDelete(w http.ResponseWriter, r *http.Request, s *auth.Session) error {
	ctx := r.Context()
	if err := ratelimit.Hit(ctx, a.St.Pool, AccountDeletes, s.AccountID); err != nil {
		return err
	}
	body, err := httpx.ReadBody(r)
	if err != nil {
		return err
	}
	var b struct {
		Confirm    string            `json:"confirm"`
		HumanCheck *humancheck.Proof `json:"human_check"`
		Entries    []leaveEntry      `json:"entries"`
	}
	if err := httpx.DecodeStrict(body, &b); err != nil {
		return err
	}
	if len(b.Entries) > 200 {
		return httpx.BadRequest("At most 200 entries.")
	}
	leaves := map[string]roster.Wire{}
	for _, e := range b.Entries {
		if !wire.IsUUID(e.RoomID) {
			return httpx.BadRequest("room_id must be a uuid.")
		}
		if _, dup := leaves[e.RoomID]; dup {
			return httpx.BadRequest("One entry per room.")
		}
		leaves[e.RoomID] = e.RosterEntry
	}
	if err := a.deleteChecks(ctx, s, b.Confirm); err != nil {
		return err
	}
	pend, err := store.OpenDelete(ctx, a.St.Pool, s.AccountID, false)
	if err != nil {
		return err
	}
	if err := finishable(pend); err != nil {
		return err
	}
	if err := a.verifyHuman(r, s, b.HumanCheck, AccountDeleteAction, ""); err != nil {
		return err
	}
	var res *store.DeleteResult
	err = a.St.Tx(ctx, func(tx pgx.Tx) error {
		if err := humancheck.Consume(ctx, tx, b.HumanCheck.ID, s); err != nil {
			return err
		}
		if err := a.deleteHeld(ctx, tx, s.AccountID); err != nil {
			return err
		}
		cur, err := store.OpenDelete(ctx, tx, s.AccountID, true)
		if err != nil {
			return err
		}
		if err := finishable(cur); err != nil {
			return err
		}
		if cur.ID != pend.ID {
			return deleteNotAsked()
		}
		if err := store.AccountEventBy(ctx, tx, s.AccountID, s.Hash, "account_delete_finished", nil); err != nil {
			return err
		}
		res, err = store.DeleteAccount(ctx, tx, s.AccountID, leaves)
		return err
	})
	if err != nil {
		return err
	}
	a.notify(ctx, s, RecoveryNotice{Kind: "delete_finished"})
	http.SetCookie(w, auth.Cookie("", a.Cfg.SecureCookies(), -1))
	out := map[string]any{"deleted": true}
	raw, _ := json.Marshal(res)
	_ = json.Unmarshal(raw, &out)
	httpx.WriteJSON(w, 200, out)
	return nil
}
