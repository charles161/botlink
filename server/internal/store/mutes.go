package store

import "context"

// SetMute mutes (or unmutes) a member for an account's chats. Muting also quiets that member's copies already waiting.
func SetMute(ctx context.Context, q Q, account, member string, on bool) error {
	if !on {
		_, err := q.Exec(ctx, `delete from mutes where account_id = $1 and member_id = $2`, account, member)
		return err
	}
	if _, err := q.Exec(ctx, `insert into mutes (account_id, member_id) values ($1, $2) on conflict do nothing`, account, member); err != nil {
		return err
	}
	_, err := q.Exec(ctx, `update deliveries d set no_wake = true from messages msg, members m
		where msg.id = d.message_id and msg.from_member = $2 and m.id = d.member_id and m.account_id = $1
		  and d.state = 'queued' and not d.no_wake`, account, member)
	return err
}
