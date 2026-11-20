package agentapi

import (
	"context"
	"net/http"
	"sort"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/charles161/botlink/server/internal/httpx"
	"github.com/charles161/botlink/server/internal/store"
	"github.com/charles161/botlink/server/internal/wire"
)

// Held while away (lane F, SPEC §6.9). The client holds another person's message while no human is with the chat
// (SPEC §7.3a); waking the chat for it cost the recipient a model turn and showed it nothing. A member's client
// declares "other people's chats do not wake me, except these members" (the ones its human let through while away);
// quietFor then makes such a copy no_wake. What the wake used to do happens here instead, without any text: the
// sender learns from the send response which recipients were not woken (never because of a mute), and the
// recipient's person gets the dashboard item. Members that never declared it (old clients) are woken as before.

const maxWakeExcept = 200

// PUT /api/v1/me/wake-policy {hold_others, except}: idempotent; the client sends it after join, after an update and
// whenever its human changes a setting. Members of other rooms or no longer in the room are dropped from `except`.
func (a *API) putWakePolicy(w http.ResponseWriter, r *http.Request, c *Caller) error {
	ctx := r.Context()
	var b struct {
		HoldOthers *bool    `json:"hold_others"`
		Except     []string `json:"except"`
	}
	if err := httpx.DecodeStrict(c.Body, &b); err != nil {
		return err
	}
	if b.HoldOthers == nil {
		return httpx.BadRequest("hold_others (true or false) is required.")
	}
	if len(b.Except) > maxWakeExcept {
		return httpx.BadRequest("except lists at most 200 members.")
	}
	seen := map[string]bool{}
	for _, id := range b.Except {
		if !wire.IsUUID(id) {
			return httpx.BadRequest("except must list member ids (lowercase uuids).")
		}
		seen[id] = true
	}
	ids := make([]string, 0, len(seen))
	for id := range seen {
		ids = append(ids, id)
	}
	var except []string
	var since time.Time
	err := a.St.Tx(ctx, func(tx pgx.Tx) error {
		except = []string{}
		if len(ids) > 0 {
			rows, err := tx.Query(ctx, `select id::text from members where id = any($1::uuid[]) and room_id = $2 and removed_at is null and id <> $3`, ids, c.M.RoomID, c.M.ID)
			if err != nil {
				return err
			}
			for rows.Next() {
				var id string
				if err := rows.Scan(&id); err != nil {
					rows.Close()
					return err
				}
				except = append(except, id)
			}
			rows.Close()
			if err := rows.Err(); err != nil {
				return err
			}
		}
		sort.Strings(except)
		var err error
		since, err = store.SetWakePolicy(ctx, tx, c.M.ID, c.M.KeyEpoch, *b.HoldOthers, except)
		return err
	})
	if err != nil {
		return err
	}
	out := map[string]any{"hold_others": *b.HoldOthers, "except": except}
	if *b.HoldOthers {
		out["since"] = since
	}
	httpx.WriteJSON(w, 200, out)
	return nil
}

// heldForSender: after a copy was stored as held (the recipient holds other people's messages), its person gets the
// dashboard item, unless the message is an fyi (it asks nothing) or the person muted the sender.
func heldForSender(ctx context.Context, tx pgx.Tx, room, from string, rc recipient, quietMsg bool) error {
	if quietMsg {
		return nil
	}
	return store.HeldAttention(ctx, tx, rc.Account, room, rc.ID, from)
}
