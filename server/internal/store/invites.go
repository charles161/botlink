package store

import (
	"context"
	"errors"

	"github.com/charles161/botlink/server/internal/wire"
)

// ChatInviteURL is a chat invite's link (SPEC §6.3): the dashboard's chat-invite card and the agent API's invite-link
// both build it here, so a chat and its person see the same URL.
func ChatInviteURL(appOrigin, roomName, code string) string {
	return appOrigin + "/i/" + roomName + "-" + code
}

// EnsureChatInvite creates the account's chat invite for the room if missing (one per person per room, 24 h) and
// returns its id. An existing one is left as it is: never renewed, never turned on.
func EnsureChatInvite(ctx context.Context, q Q, roomID, account string) (string, error) {
	for i := 0; i < 20; i++ {
		var id string
		err := q.QueryRow(ctx, `insert into invites (id, room_id, kind, account_id, code, expires_at)
			values ($1,$2,'chat',$3,$4, now() + interval '24 hours')
			on conflict (room_id, account_id) where kind = 'chat' do update set room_id = invites.room_id returning id`,
			wire.NewV7(), roomID, account, wire.RandCode(10)).Scan(&id)
		if err == nil {
			return id, nil
		}
		if !IsUniqueViolation(err, "invites_code_key") {
			return "", err
		}
	}
	return "", errors.New("could not pick a unique invite code")
}
