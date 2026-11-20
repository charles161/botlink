package appapi

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/charles161/botlink/server/internal/auth"
	"github.com/charles161/botlink/server/internal/httpx"
	"github.com/charles161/botlink/server/internal/store"
	"github.com/charles161/botlink/server/internal/wire"
)

// Wake controls (security review 12 Nov 2026: wake and cost abuse; review points 7 and 9). They only stop WAKES:
// every message still waits and is read on the chat's next turn. See db/migrations/0012_wake_controls.sql.

func wakesPaused(ctx context.Context, q store.Q, account string) (*time.Time, error) {
	var at *time.Time
	err := q.QueryRow(ctx, `select wakes_paused_at from accounts where id = $1`, account).Scan(&at)
	return at, err
}

// POST /app/v1/me/pause {"paused": bool}: "Pause all my chats". Pausing also quiets what already waits.
func (a *API) postPause(w http.ResponseWriter, r *http.Request, s *auth.Session) error {
	ctx := r.Context()
	body, err := httpx.ReadBody(r)
	if err != nil {
		return err
	}
	var b struct {
		Paused *bool `json:"paused"`
	}
	if err := httpx.DecodeStrict(body, &b); err != nil {
		return err
	}
	if b.Paused == nil {
		return httpx.BadRequest("paused (true or false) is required.")
	}
	err = a.St.Tx(ctx, func(tx pgx.Tx) error {
		if *b.Paused {
			if _, err := tx.Exec(ctx, `update accounts set wakes_paused_at = coalesce(wakes_paused_at, now()) where id = $1`, s.AccountID); err != nil {
				return err
			}
			_, err := tx.Exec(ctx, `update deliveries d set no_wake = true from members m
				where m.id = d.member_id and m.account_id = $1 and d.state = 'queued' and not d.no_wake`, s.AccountID)
			return err
		}
		_, err := tx.Exec(ctx, `update accounts set wakes_paused_at = null where id = $1`, s.AccountID)
		return err
	})
	if err != nil {
		return err
	}
	at, err := wakesPaused(ctx, a.St.Pool, s.AccountID)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, 200, map[string]any{"paused": at != nil, "paused_at": utcPtr(at)})
	return nil
}

// POST /app/v1/members/{id}/mute {"muted": bool}: my chats are (not) woken by this member. A person of the member's
// room, for a member that isn't theirs; anyone else gets 404.
func (a *API) postMute(w http.ResponseWriter, r *http.Request, s *auth.Session) error {
	ctx := r.Context()
	id := r.PathValue("id")
	if !wire.IsUUID(id) {
		return httpx.NotFound()
	}
	body, err := httpx.ReadBody(r)
	if err != nil {
		return err
	}
	var b struct {
		Muted *bool `json:"muted"`
	}
	if err := httpx.DecodeStrict(body, &b); err != nil {
		return err
	}
	if b.Muted == nil {
		return httpx.BadRequest("muted (true or false) is required.")
	}
	var owner string
	err = a.St.Pool.QueryRow(ctx, `select m.account_id from members m join room_people p on p.room_id = m.room_id
		and p.account_id = $2 and p.removed_at is null where m.id = $1 and m.removed_at is null`, id, s.AccountID).Scan(&owner)
	if errors.Is(err, pgx.ErrNoRows) {
		return httpx.NotFound()
	}
	if err != nil {
		return err
	}
	if owner == s.AccountID {
		return httpx.E(403, "own_member", "That's your own chat. Remove it or pause your chats instead.")
	}
	if err := store.SetMute(ctx, a.St.Pool, s.AccountID, id, *b.Muted); err != nil {
		return err
	}
	httpx.WriteJSON(w, 200, map[string]any{"member_id": id, "muted": *b.Muted})
	return nil
}

// mutedByMe: the members of a room this account muted.
func mutedByMe(ctx context.Context, q store.Q, roomID, account string) (map[string]bool, error) {
	rows, err := q.Query(ctx, `select u.member_id from mutes u join members m on m.id = u.member_id
		where u.account_id = $1 and m.room_id = $2`, account, roomID)
	if err != nil {
		return nil, err
	}
	ids, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return nil, err
	}
	out := make(map[string]bool, len(ids))
	for _, id := range ids {
		out[id] = true
	}
	return out, nil
}
