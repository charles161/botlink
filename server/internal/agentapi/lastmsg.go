package agentapi

import (
	"context"

	"github.com/jackc/pgx/v5"
)

// rooms.last_message_at (migration 0054): when the server accepted the newest conversation message of the room, shown
// on the rooms home as "Last message 5 min ago". A conversation message is one a member sends to others (scope member
// or room) that is not the join hello (intro): the messages room_week_senders counts (0020). Self-tests
// (postSelftest, scope self) and server notices (the notices table) are not messages and never come here.

// countsAsLastMessage: does this send move the room's last message time?
func countsAsLastMessage(intro bool) bool { return !intro }

// lockRoomForLastMessage takes the rooms row before the send locks member rows FOR SHARE. A member-list change locks
// the rooms row (store.AppendEntry's roster_head_seq CAS) and then member rows (store.RemoveMember); locking in the same
// order means the two queue instead of deadlocking. Sends to one room already queue on that room's rate counter
// (ratelimit.SendRoom, the first write of the send), so this adds no wait between sends.
func lockRoomForLastMessage(ctx context.Context, tx pgx.Tx, roomID string) error {
	_, err := tx.Exec(ctx, `select 1 from rooms where id = $1 for no key update`, roomID)
	return err
}

// setLastMessage records the accepted message's time (the transaction's now(), the message's created_at). It only moves
// forward: a send whose transaction started earlier but commits after a later one leaves the later time.
func setLastMessage(ctx context.Context, tx pgx.Tx, roomID string) error {
	_, err := tx.Exec(ctx, `update rooms set last_message_at = now() where id = $1 and (last_message_at is null or last_message_at < now())`, roomID)
	return err
}
