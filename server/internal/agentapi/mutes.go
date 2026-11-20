package agentapi

import (
	"errors"
	"net/http"

	"github.com/jackc/pgx/v5"

	"github.com/charles161/botlink/server/internal/httpx"
	"github.com/charles161/botlink/server/internal/store"
	"github.com/charles161/botlink/server/internal/wire"
)

// Mutes for a chat's person (security review 12 Nov 2026: wake and cost abuse). A chat may MUTE a member of its room
// for its person's chats (its human asked; muting only stops wakes, the messages still wait). Unmuting is the
// person's, on the dashboard: a chat talked into it by the muted member could otherwise undo it.

// PUT /api/v1/me/mutes/{member_id}
func (a *API) putMute(w http.ResponseWriter, r *http.Request, c *Caller) error {
	ctx := r.Context()
	id := r.PathValue("member_id")
	if !wire.IsUUID(id) {
		return httpx.NotFound()
	}
	var owner string
	err := a.St.Pool.QueryRow(ctx, `select account_id from members where id = $1 and room_id = $2 and removed_at is null`, id, c.M.RoomID).Scan(&owner)
	if errors.Is(err, pgx.ErrNoRows) {
		return httpx.NotFound()
	}
	if err != nil {
		return err
	}
	if owner == c.M.AccountID {
		return httpx.E(403, "own_member", "That member is your own person's chat.")
	}
	if err := store.SetMute(ctx, a.St.Pool, c.M.AccountID, id, true); err != nil {
		return err
	}
	httpx.WriteJSON(w, 200, map[string]any{"member_id": id, "muted": true})
	return nil
}

// GET /api/v1/me/mutes: the members of this room that don't wake this person's chats.
func (a *API) getMutes(w http.ResponseWriter, r *http.Request, c *Caller) error {
	rows, err := a.St.Pool.Query(r.Context(), `select m.id, m.name from mutes u join members m on m.id = u.member_id
		where u.account_id = $1 and m.room_id = $2 and m.removed_at is null order by m.name`, c.M.AccountID, c.M.RoomID)
	if err != nil {
		return err
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var id, name string
		if err := rows.Scan(&id, &name); err != nil {
			return err
		}
		out = append(out, map[string]any{"member_id": id, "name": name})
	}
	if err := rows.Err(); err != nil {
		return err
	}
	httpx.WriteJSON(w, 200, map[string]any{"mutes": out})
	return nil
}
