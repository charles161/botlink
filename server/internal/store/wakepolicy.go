package store

import (
	"context"
	"time"
)

// Wake policy (lane F, SPEC §6.9 "Held while away"): a member's client declares "other people's chats do not wake
// me, except these members". Stored per member and key epoch: a chat that takes the member over with a new key is
// not bound by what the previous chat declared until it declares again.

// SetWakePolicy records (hold = true) or drops (hold = false) the member's policy. Idempotent. `since` stays when the
// same key declares again, so a client can tell which copies the server already reported. -> since (zero when dropped)
func SetWakePolicy(ctx context.Context, q Q, member string, keyEpoch int, hold bool, except []string) (time.Time, error) {
	if !hold {
		_, err := q.Exec(ctx, `delete from wake_policies where member_id = $1`, member)
		return time.Time{}, err
	}
	if except == nil {
		except = []string{}
	}
	var since time.Time
	err := q.QueryRow(ctx, `insert into wake_policies (member_id, key_epoch, except_members) values ($1, $2, $3::uuid[])
		on conflict (member_id) do update set except_members = excluded.except_members, updated_at = now(),
			key_epoch = excluded.key_epoch,
			since = case when wake_policies.key_epoch = excluded.key_epoch then wake_policies.since else now() end
		returning since`, member, keyEpoch, except).Scan(&since)
	return since.UTC(), err
}

// HoldsOthers: does the recipient's declared policy keep this sender (another person's chat) from waking it? An
// answer to a message the recipient itself sent within the hour still wakes it: the chat may be staying in its turn
// for that answer (`send --wait-s`).
func HoldsOthers(ctx context.Context, q Q, recipient string, keyEpoch int, sender string, inReplyTo *string) (bool, error) {
	var held bool
	err := q.QueryRow(ctx, `select exists(select 1 from wake_policies p where p.member_id = $1 and p.key_epoch = $2
			and not ($3::uuid = any(p.except_members)))
		and not exists(select 1 from messages m where $4::uuid is not null and m.id = $4::uuid and m.from_member = $1
			and m.created_at > now() - interval '1 hour')`, recipient, keyEpoch, sender, inReplyTo).Scan(&held)
	return held, err
}

// HeldRecipients: the recipients a stored message did not wake because they hold other people's messages (what the
// send response says; a replayed send gets the same list). Quiet messages (an fyi) are never listed.
func HeldRecipients(ctx context.Context, q Q, messageID string) ([]string, error) {
	rows, err := q.Query(ctx, `select d.member_id::text from deliveries d join messages m on m.id = d.message_id
		where d.message_id = $1 and d.wake_held and not m.quiet order by d.member_id`, messageID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// HeldAttention: the recipient's person gets the same dashboard item a client raises with `ask-human {needs_ok}`
// ("<member> has a question for you"), with no message text (the server has none). Deduped while open. Not for a
// sender that person muted: a muted member's messages are never brought to them.
func HeldAttention(ctx context.Context, q Q, account, room, recipient, sender string) error {
	var muted bool
	if err := q.QueryRow(ctx, `select exists(select 1 from mutes where account_id = $1 and member_id = $2)`, account, sender).Scan(&muted); err != nil || muted {
		return err
	}
	return UpsertAttention(ctx, q, account, &room, "needs_you", recipient, map[string]any{"reason": "needs_ok"})
}
