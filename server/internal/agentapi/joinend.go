package agentapi

import (
	"context"
	"encoding/hex"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/charles161/botlink/server/internal/httpx"
	"github.com/charles161/botlink/server/internal/store"
	"github.com/charles161/botlink/server/internal/wire"
)

// Waits that end in nothing (prod-readiness review, blocker 10). Two things a chat needs from the server when its join
// request ends without it getting in: whether the invite it used still lets a chat in (a request lasts 15 minutes,
// a chat invite 24 hours), and a way to take its own request back when its approval self-check failed (ENVELOPE
// §5.4), so no card is left on the person's dashboard with no chat behind it.

// inviteState is the state of the chat invite a join request was made with, for a request that ended without an
// approval: "works" (with the invite's expiry), "expired", "off", or "closed" (the room was deleted or the invite's
// person is no longer in it). nil for a request without an invite (a move). Only the holder of the request's key
// reads this (the request views are signed by it), and it never carries the invite's code: a renewed invite reads
// "works", and the client, which knows the code it used, tells "renewed" apart by asking for its own code.
func inviteState(ctx context.Context, q store.Q, requestID string) (map[string]any, error) {
	var off, roomGone, personGone bool
	var exp time.Time
	err := q.QueryRow(ctx, `
		select i.off, i.expires_at, r.deleted_at is not null,
		       not exists(select 1 from room_people p where p.room_id = i.room_id and p.account_id = i.account_id and p.removed_at is null)
		from join_requests j join invites i on i.id = j.invite_id join rooms r on r.id = i.room_id
		where j.id = $1 and i.kind = 'chat'`, requestID).Scan(&off, &exp, &roomGone, &personGone)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	switch {
	case roomGone || personGone:
		return map[string]any{"state": "closed"}, nil
	case off:
		return map[string]any{"state": "off"}, nil
	case !exp.After(time.Now()):
		return map[string]any{"state": "expired"}, nil
	}
	return map[string]any{"state": "works", "expires_at": exp.UTC()}, nil
}

// POST /api/v1/join-requests/{id}/cancel: the chat takes its own join request back (signed by the request's key).
// Only while it is pending; the answer is the request's view either way, so the caller sees what it is now: cancelled,
// or already approved (then the member holds this same key and the chat takes it out with DELETE /api/v1/me), rejected
// or expired. Used by the client when the approval self-check fails, so the card does not stay on the dashboard.
func (a *API) postJoinCancel(w http.ResponseWriter, r *http.Request, c *Caller) error {
	ctx := r.Context()
	id := r.PathValue("id")
	if !wire.IsUUID(id) {
		return httpx.NotFound()
	}
	if len(strings.TrimSpace(string(c.Body))) > 0 {
		var b struct{}
		if err := httpx.DecodeStrict(c.Body, &b); err != nil {
			return err
		}
	}
	var key []byte
	err := a.St.Pool.QueryRow(ctx, `select ed25519_pk from join_requests where id = $1`, id).Scan(&key)
	if errors.Is(err, pgx.ErrNoRows) {
		return httpx.NotFound()
	}
	if err != nil {
		return err
	}
	if hex.EncodeToString(key) != c.KeyHex {
		return httpx.Forbidden("This isn't your request.")
	}
	if _, err := a.St.Pool.Exec(ctx, `update join_requests set status = 'expired', decided_at = now()
		where id = $1 and status = 'pending' and expires_at <= now()`, id); err != nil {
		return err
	}
	if _, err := a.St.Pool.Exec(ctx, `update join_requests set status = 'cancelled', decided_at = now()
		where id = $1 and status = 'pending'`, id); err != nil {
		return err
	}
	v, err := a.joinView(ctx, a.St.Pool, id)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, 200, v)
	return nil
}
