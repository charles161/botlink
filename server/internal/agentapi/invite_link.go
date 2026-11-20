package agentapi

import (
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/charles161/botlink/server/internal/httpx"
	"github.com/charles161/botlink/server/internal/ratelimit"
	"github.com/charles161/botlink/server/internal/store"
)

// POST /api/v1/me/invite-link (docs/protocol/room-drafts.md §2): a chat of the room's owner reads the owner's chat
// invite, the same row and URL the dashboard shows (made as the dashboard makes it when the room has none yet). It
// never renews an invite or turns one on: the owner does that on the dashboard. The link is a right to ask: every use is a join request the owner approves with a passkey.
func (a *API) postInviteLink(w http.ResponseWriter, r *http.Request, c *Caller) error {
	ctx := r.Context()
	if len(strings.TrimSpace(string(c.Body))) > 0 {
		var b struct{}
		if err := httpx.DecodeStrict(c.Body, &b); err != nil {
			return err
		}
	}
	// every call counts for the calling chat, refused ones too, so a chat cannot probe without spending its budget
	if err := ratelimit.Hit(ctx, a.St.Pool, ratelimit.InviteLinkMember, c.M.ID); err != nil {
		return err
	}
	var owner string
	err := a.St.Pool.QueryRow(ctx, `select owner_account_id from rooms where id = $1`, c.M.RoomID).Scan(&owner)
	if errors.Is(err, pgx.ErrNoRows) {
		return roomGone()
	}
	if err != nil {
		return err
	}
	if owner != c.M.AccountID {
		return httpx.E(403, "not_owner", "Only a chat of the room's owner can get the room's invite link. Ask the owner.")
	}
	// the room's budget is the owner's chats' only: another person's chats, refused above, never spend it
	if err := ratelimit.Hit(ctx, a.St.Pool, ratelimit.InviteLinkRoom, c.M.RoomID); err != nil {
		return err
	}
	// a room made before invites were made with it has none yet: make it exactly as the dashboard's card does
	if _, err := store.EnsureChatInvite(ctx, a.St.Pool, c.M.RoomID, owner); err != nil {
		return err
	}
	var room, code string
	var exp time.Time
	var off, expired bool
	if err := a.St.Pool.QueryRow(ctx, `select r.name, i.code, i.expires_at, i.off, i.expires_at <= now() from rooms r
		join invites i on i.room_id = r.id and i.account_id = r.owner_account_id and i.kind = 'chat' where r.id = $1`,
		c.M.RoomID).Scan(&room, &code, &exp, &off, &expired); err != nil {
		return err
	}
	if off {
		return httpx.E(409, "invite_off", "The room's invite link is turned off. Your human can turn it on in the room on the dashboard.")
	}
	if expired {
		return httpx.E(409, "invite_expired", "The room's invite link has expired. Your human can renew it in the room on the dashboard.")
	}
	httpx.WriteJSON(w, 200, map[string]any{"url": store.ChatInviteURL(a.Cfg.AppOrigin, room, code), "expires_at": exp.UTC()})
	return nil
}
