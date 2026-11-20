package appapi

import (
	"context"
	"errors"
	"maps"
	"net/http"

	"github.com/jackc/pgx/v5"

	"github.com/charles161/botlink/server/internal/analytics"
	"github.com/charles161/botlink/server/internal/auth"
	"github.com/charles161/botlink/server/internal/httpx"
	"github.com/charles161/botlink/server/internal/humancheck"
	"github.com/charles161/botlink/server/internal/plans"
	"github.com/charles161/botlink/server/internal/ratelimit"
	"github.com/charles161/botlink/server/internal/roster"
	"github.com/charles161/botlink/server/internal/store"
	"github.com/charles161/botlink/server/internal/wire"
)

// Several waiting chats of one room approved in one step (SPEC §6.4 step 7a, docs/protocol/join-and-approval.md §4a).
// The person ticks up to humancheck.MaxTargets chats on the room's waiting list, each beside its own code, and answers
// one human check that the server bound to this room and exactly that set. Each chat is let in by admitChat, the code
// behind a single approval, in one transaction: all of them or none. There is no "approve all": the set is the list
// of ids the request names, and nothing outside it is touched.

type batchItem struct {
	ID          string      `json:"id"`
	RosterEntry roster.Wire `json:"roster_entry"`
}

type batchBody struct {
	HumanCheck humancheck.Proof `json:"human_check"`
	Items      []batchItem      `json:"items"`
}

// batchChanged: one or more ticked requests no longer wait for the caller (details.items: id and reason, one of
// already_decided, expired, not_found). Nothing was approved; the human check is spent.
func batchChanged(items []map[string]string) *httpx.Error {
	return httpx.E(409, "batch_changed", "Some of the chats you ticked no longer wait for you. Nothing was approved; refresh the list and tick again.").
		With("items", items)
}

// forItem names the item an error is about (details.id), on a copy: an error value may be shared.
func forItem(err error, id string) error {
	var he *httpx.Error
	if !errors.As(err, &he) {
		return err
	}
	e := *he
	e.Details = maps.Clone(he.Details)
	if e.Details == nil {
		e.Details = map[string]any{}
	}
	e.Details["id"] = id
	return &e
}

// POST /app/v1/rooms/{id}/join-requests/approve {human_check, items: [{id, roster_entry}]}. One transaction, in this
// order: lock the room, then the ticked requests, and check each (pending, a join, of this room, for the caller,
// unexpired; if one is not, 409 batch_changed and the check is spent); use up the human check (this room, this exact
// set); count n approvals; mark them approved; admitChat each in the order given (the entries are a chain at head+1 …
// head+n). Any other failure rolls everything back, the human check included, so the same check can be sent again.
func (a *API) postJoinApproveBatch(w http.ResponseWriter, r *http.Request, s *auth.Session) error {
	ctx := r.Context()
	roomID := r.PathValue("id")
	if !wire.IsUUID(roomID) {
		return httpx.NotFound()
	}
	body, err := httpx.ReadBody(r)
	if err != nil {
		return err
	}
	var b batchBody
	if err := httpx.DecodeStrict(body, &b); err != nil {
		return err
	}
	ids := make([]string, len(b.Items))
	for i, it := range b.Items {
		if it.RosterEntry.Entry == "" || it.RosterEntry.Sig == "" || it.RosterEntry.Signer == "" {
			return httpx.BadRequest("Each ticked chat needs its signed roster_entry.")
		}
		ids[i] = it.ID
	}
	if err := humancheck.Targets(ids); err != nil {
		return err
	}
	if err := a.HC.VerifySet(ctx, a.St.Pool, s, &b.HumanCheck, roomID, ids, httpx.ClientIP(r, a.Cfg.TrustCF)); err != nil {
		return err
	}
	var hit plans.Hit
	var changed error
	err = a.St.Tx(ctx, func(tx pgx.Tx) error {
		// the room first, then the requests (store.LockRoom: one lock order)
		if err := store.LockRoom(ctx, tx, roomID); err != nil {
			return err
		}
		chats, gone, err := lockBatch(ctx, tx, roomID, s.AccountID, ids)
		if err != nil {
			return err
		}
		if len(gone) > 0 {
			// nothing is approved and the passed check is spent (committed): it never waits for its set to become
			// approvable (a takeover by readdress needs no check); the page asks a new one
			changed = batchChanged(gone)
			return humancheck.Spend(ctx, tx, b.HumanCheck.ID, s)
		}
		if err := humancheck.ConsumeSet(ctx, tx, b.HumanCheck.ID, s, roomID, ids); err != nil {
			return err
		}
		for range ids { // a batch counts as n approvals
			if err := ratelimit.Hit(ctx, tx, ratelimit.Approvals, s.AccountID); err != nil {
				return err
			}
		}
		if _, err := tx.Exec(ctx, `update join_requests set status = 'approved', decided_at = now(), decided_by = $2 where id = any($1::uuid[])`,
			ids, s.AccountID); err != nil {
			return err
		}
		for i, it := range b.Items {
			if err := a.admitChat(ctx, tx, s.AccountID, roomID, it.RosterEntry, chats[i], &hit); err != nil {
				return forItem(err, it.ID)
			}
		}
		return nil
	})
	hit.Report(a.An, err)
	if err != nil {
		return err
	}
	if changed != nil {
		return changed
	}
	for range ids {
		a.An.Capture(analytics.JoinApproved, a.An.ID(s.AccountID), analytics.Props{"room": a.An.ID(roomID), "kind": "chat"})
	}
	httpx.WriteJSON(w, 200, map[string]any{"approved": ids})
	return nil
}

// lockBatch locks the ticked requests of the room (in id order; the caller holds the room row already, so another
// approval of that room waits for it before it locks any request) and returns their chats in the order of ids, or the
// ones that no longer wait for the caller. A
// request that is not the caller's, or does not exist, is not_found, as on the single approval; one of the caller's of
// another room, or a move (claim), is a 400: a move is approved on its own.
func lockBatch(ctx context.Context, tx pgx.Tx, roomID, account string, ids []string) ([]joinedChat, []map[string]string, error) {
	type held struct {
		forAcct, room, kind, status string
		expired                     bool
		chat                        joinedChat
	}
	// lock the ticked requests of this room (the caller holds the room), then read them all as they are now
	if _, err := tx.Exec(ctx, `select 1 from join_requests where id = any($1::uuid[]) and room_id = $2 order by id for update`, ids, roomID); err != nil {
		return nil, nil, err
	}
	rows, err := tx.Query(ctx, `select id, for_account_id, room_id, kind, status, expires_at <= now(),
			member_id, name, job, app, app_name, machine, folder, turn, session_id, ed25519_pk, x25519_pk
		from join_requests where id = any($1::uuid[])`, ids)
	if err != nil {
		return nil, nil, err
	}
	byID := map[string]*held{}
	for rows.Next() {
		var id string
		h := &held{}
		c := &h.chat
		if err := rows.Scan(&id, &h.forAcct, &h.room, &h.kind, &h.status, &h.expired,
			&c.MemberID, &c.Name, &c.Job, &c.App, &c.AppName, &c.Machine, &c.Folder, &c.Turn, &c.Session, &c.Ed, &c.X); err != nil {
			rows.Close()
			return nil, nil, err
		}
		byID[id] = h
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}
	changed := []map[string]string{}
	chats := make([]joinedChat, len(ids))
	for i, id := range ids {
		h := byID[id]
		switch {
		case h == nil || h.forAcct != account:
			changed = append(changed, map[string]string{"id": id, "reason": "not_found"})
		case h.room != roomID:
			return nil, nil, httpx.BadRequest("Every ticked chat must be waiting to join this room.").With("id", id)
		case h.kind != "join":
			return nil, nil, httpx.BadRequest("A chat moving to another chat or computer is approved on its own.").With("id", id)
		case h.status != "pending":
			changed = append(changed, map[string]string{"id": id, "reason": "already_decided"})
		case h.expired:
			changed = append(changed, map[string]string{"id": id, "reason": "expired"})
		default:
			chats[i] = h.chat
		}
	}
	if len(changed) > 0 {
		return nil, changed, nil
	}
	return chats, nil, nil
}
