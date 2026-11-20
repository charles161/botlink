package appapi

import (
	"context"
	"errors"
	"net/http"

	"github.com/jackc/pgx/v5"

	"github.com/charles161/botlink/server/internal/auth"
	"github.com/charles161/botlink/server/internal/httpx"
	"github.com/charles161/botlink/server/internal/store"
	"github.com/charles161/botlink/server/internal/wire"
)

// Security review item 11 (self-heal). A join request goes to the person whose chat invite it used. When a chat used
// another person's invite (Charles's link pasted into Victor's chat), the card sits on Charles's dashboard and
// approving it would make Victor's chat "Charles's chat". When a different person of the same room opens that
// request's approve link, they are offered to take it over: the request is then theirs to approve or reject.
//
// Who may take it over: a person of the request's room (not removed) other than the one it is addressed to, while
// the request is a pending join (not a move), and only once per request. Everyone else gets the generic not-found,
// the same as for an unknown id: the approve link carries only the request id.

const readdressWhere = `j.id = $1 and j.kind = 'join' and j.status = 'pending' and j.expires_at > now()
	and j.for_account_id <> $2 and j.readdressed_from is null
	and exists(select 1 from room_people p where p.room_id = j.room_id and p.account_id = $2 and p.removed_at is null)
	and exists(select 1 from rooms r where r.id = j.room_id and r.deleted_at is null)`

func readdressOffer(ctx context.Context, q store.Q, id, account string) (map[string]any, error) {
	var room, roomName, name, app, machine, folder, owner string
	var appName *string
	err := q.QueryRow(ctx, `select j.room_id, r.name, j.name, j.app, j.app_name, j.machine, j.folder, a.display_name
		from join_requests j join rooms r on r.id = j.room_id join accounts a on a.id = j.for_account_id
		where `+readdressWhere, id, account).Scan(&room, &roomName, &name, &app, &appName, &machine, &folder, &owner)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, httpx.NotFound()
	}
	if err != nil {
		return nil, err
	}
	return map[string]any{"id": id, "room_id": room, "room_name": roomName, "name": name, "app": app, "app_name": appName,
		"machine": machine, "folder": folder, "invite_owner_name": owner}, nil
}

// GET /app/v1/join-requests/{id}/readdress: may I make this request mine? {"offer": {...}} or {"offer": null}: the same
// answer for an unknown id, someone else's request and one that can't be taken over (the approve page asks for every
// link it doesn't know, so a "no" is not an error).
func (a *API) getReaddress(w http.ResponseWriter, r *http.Request, s *auth.Session) error {
	id := r.PathValue("id")
	var offer any
	if wire.IsUUID(id) {
		v, err := readdressOffer(r.Context(), a.St.Pool, id, s.AccountID)
		var he *httpx.Error
		switch {
		case err == nil:
			offer = v
		case errors.As(err, &he) && he.Status == 404:
		default:
			return err
		}
	}
	httpx.WriteJSON(w, 200, map[string]any{"offer": offer})
	return nil
}

// POST /app/v1/join-requests/{id}/readdress: the request becomes mine (its card moves to my dashboard). Nothing is
// approved here: approving still needs the human check and a signed entry, like any join.
func (a *API) postReaddress(w http.ResponseWriter, r *http.Request, s *auth.Session) error {
	ctx := r.Context()
	id := r.PathValue("id")
	if !wire.IsUUID(id) {
		return httpx.NotFound()
	}
	err := a.St.Tx(ctx, func(tx pgx.Tx) error {
		var from string
		err := tx.QueryRow(ctx, `update join_requests j set for_account_id = $2, readdressed_from = j.for_account_id
			where `+readdressWhere+` returning j.readdressed_from`, id, s.AccountID).Scan(&from)
		if errors.Is(err, pgx.ErrNoRows) {
			return httpx.NotFound()
		}
		if store.IsUniqueViolation(err, "join_requests_pending_code") {
			// one of my own waiting requests shows the same 6 characters: rare; the chat can ask again
			return httpx.E(409, "code_in_use", "Another request of yours shows the same code. Ask the chat to join again with your own invite.")
		}
		if err != nil {
			return err
		}
		// the status trigger does not fire on this update: both dashboards and the chat's open wait look again
		_, err = tx.Exec(ctx, `select pg_notify('bl_dash', $1::text), pg_notify('bl_dash', $2::text), pg_notify('bl_join', $3::text)`,
			from, s.AccountID, id)
		return err
	})
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, 200, map[string]any{"ok": true, "id": id})
	return nil
}
