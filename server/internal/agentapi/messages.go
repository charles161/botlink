package agentapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"sort"

	"github.com/jackc/pgx/v5"

	"github.com/charles161/botlink/server/internal/envelope"
	"github.com/charles161/botlink/server/internal/faults"
	"github.com/charles161/botlink/server/internal/httpx"
	"github.com/charles161/botlink/server/internal/plans"
	"github.com/charles161/botlink/server/internal/ratelimit"
	"github.com/charles161/botlink/server/internal/store"
	"github.com/charles161/botlink/server/internal/wire"
)

type sendEnvelope struct {
	ToMember string          `json:"to_member"`
	ToFP     string          `json:"to_fp"`
	Envelope json.RawMessage `json:"envelope"`
}

type sendRequest struct {
	ID        string         `json:"id"`
	RoomID    string         `json:"room_id"`
	Scope     string         `json:"scope"`
	ToMember  *string        `json:"to_member"`
	InReplyTo *string        `json:"in_reply_to"`
	Envelopes []sendEnvelope `json:"envelopes"`
	// Quiet: needs no answer (intent fyi). Plaintext metadata the server acts on (SPEC §6.5): quiet copies never wake
	// an idle chat or block a turn on their own; they ride along with the next batch.
	Quiet *bool `json:"quiet"`
	// Intro: the join hello the client sends by itself (SPEC §6.4a, r3): never wakes anyone, never an expired_unread
	// notice; it rides along with each recipient's next batch.
	Intro *bool `json:"intro"`
}

type recipient struct {
	ID       string
	FP       string
	KeyEpoch int
	Turn     string
	Account  string
}

const maxExpiry = 7 * 24 * 3600

// POST /api/v1/messages: one transaction, idempotent by id (SPEC §6.5).
func (a *API) postMessage(w http.ResponseWriter, r *http.Request, c *Caller) error {
	ctx := r.Context()
	var req sendRequest
	if err := httpx.DecodeStrict(c.Body, &req); err != nil {
		return err
	}
	switch {
	case !wire.IsUUID(req.ID) || !wire.IsUUID(req.RoomID):
		return httpx.BadRequest("id and room_id must be lowercase uuids.")
	case req.Scope != "member" && req.Scope != "room":
		return httpx.BadRequest("scope must be member or room.")
	case (req.Scope == "member") != (req.ToMember != nil):
		return httpx.BadRequest("to_member is required for scope member and not allowed for scope room.")
	case req.ToMember != nil && !wire.IsUUID(*req.ToMember):
		return httpx.BadRequest("to_member must be a uuid.")
	case req.InReplyTo != nil && !wire.IsUUID(*req.InReplyTo):
		return httpx.BadRequest("in_reply_to must be a uuid or null.")
	case len(req.Envelopes) < 1 || len(req.Envelopes) > 19:
		return httpx.BadRequest("Send 1 to 19 envelopes.")
	}
	if req.RoomID != c.M.RoomID {
		return httpx.E(403, "not_member", "You're not a member of that room.")
	}
	if req.ToMember != nil && *req.ToMember == c.M.ID {
		return httpx.BadRequest("You can't send a message to yourself.")
	}
	// parse and check every envelope before opening the transaction
	envs := map[string]*envelope.Envelope{}
	fps := map[string]string{}
	var expiresAt int64
	for i, se := range req.Envelopes {
		if !wire.IsUUID(se.ToMember) || !wire.IsFingerprint(se.ToFP) {
			return httpx.BadRequest("Each envelope needs to_member (uuid) and to_fp (fingerprint).")
		}
		if _, dup := envs[se.ToMember]; dup {
			return httpx.BadRequest("Two envelopes for the same member.")
		}
		env, err := envelope.Parse(se.Envelope)
		if err != nil {
			return err
		}
		if err := env.VerifySig(c.M.Ed); err != nil {
			return err
		}
		h := env.Header
		switch {
		case h.ID != req.ID || h.Room != req.RoomID || h.From != c.M.ID || h.Scope != req.Scope:
			return httpx.BadRequest("Envelope header doesn't match the request (id, room, from, scope).")
		case !sameNullable(h.InReplyTo, req.InReplyTo):
			return httpx.BadRequest("Envelope header in_reply_to doesn't match the request.")
		case h.To != se.ToMember || h.ToFP != se.ToFP:
			return httpx.BadRequest("Envelope header to/to_fp doesn't match its entry.")
		case h.FromFP != c.M.FP():
			return httpx.BadRequest("Envelope header from_fp isn't your current fingerprint.")
		}
		if i == 0 {
			expiresAt = h.ExpiresAt
		} else if h.ExpiresAt != expiresAt {
			return httpx.BadRequest("All envelopes of a message must have the same expires_at.")
		}
		envs[se.ToMember] = env
		fps[se.ToMember] = se.ToFP
	}
	reqHash := wire.SHA256(c.Body)
	status := 201
	var nRecipients int
	notWoken := []string{} // recipients not woken because they hold other people's messages (lane F; never a mute)
	err := a.St.Tx(ctx, func(tx pgx.Tx) error {
		dup, n, err := checkExisting(ctx, tx, req.ID, c.M.ID, reqHash)
		if err != nil || dup {
			if dup {
				status, nRecipients = 200, n
			}
			return err
		}
		for _, l := range []struct {
			lim ratelimit.Limit
			key string
		}{{ratelimit.SendMember, c.M.ID}, {ratelimit.SendMemberDay, c.M.ID}, {ratelimit.SendRoom, c.M.RoomID}} {
			if err := ratelimit.Hit(ctx, tx, l.lim, l.key); err != nil {
				return err
			}
		}
		now, err := store.DBNow(ctx, tx)
		if err != nil {
			return err
		}
		if expiresAt < now+60 || expiresAt > now+maxExpiry+300 {
			return httpx.BadRequest("expires_at must be between 1 minute and 7 days from now.")
		}
		if expiresAt > now+maxExpiry {
			expiresAt = now + maxExpiry
		}
		// a free account's unread copies keep their bytes for BOTLINK_FREE_COPY_HOURS at most (security review finding 3)
		if h := int64(a.Cfg.Plans.FreeCopyHours); h > 0 && expiresAt > now+h*3600 {
			paid, err := plans.OnPaidPlan(ctx, tx, a.Cfg.Plans, c.M.AccountID)
			if err != nil {
				return err
			}
			if !paid {
				expiresAt = now + h*3600
			}
		}
		lastMsg := countsAsLastMessage(req.Intro != nil && *req.Intro)
		if lastMsg {
			if err := lockRoomForLastMessage(ctx, tx, req.RoomID); err != nil {
				return err
			}
		}
		// recipients at transaction time; FOR SHARE blocks a concurrent rekey/removal until commit
		q := `select id, ed25519_pk, x25519_pk, key_epoch, turn, account_id from members
			where room_id = $1 and removed_at is null and id <> $2 order by id for share`
		args := []any{req.RoomID, c.M.ID}
		rows, err := tx.Query(ctx, q, args...)
		if err != nil {
			return err
		}
		var all []recipient
		for rows.Next() {
			var rc recipient
			var ed, x []byte
			if err := rows.Scan(&rc.ID, &ed, &x, &rc.KeyEpoch, &rc.Turn, &rc.Account); err != nil {
				rows.Close()
				return err
			}
			rc.FP = wire.MemberFP(ed, x)
			all = append(all, rc)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		var recips []recipient
		if req.Scope == "member" {
			for _, rc := range all {
				if rc.ID == *req.ToMember {
					recips = append(recips, rc)
				}
			}
		} else {
			recips = all
		}
		if len(recips) == 0 {
			if req.Scope == "room" {
				return httpx.E(422, "no_recipients", "There's nobody else in this room yet.")
			}
			return recipientsChanged(ctx, tx, req.RoomID, all)
		}
		if len(recips) != len(envs) {
			return recipientsChanged(ctx, tx, req.RoomID, all)
		}
		for _, rc := range recips {
			if envs[rc.ID] == nil || fps[rc.ID] != rc.FP {
				return recipientsChanged(ctx, tx, req.RoomID, all)
			}
		}
		// recipient queue cap
		ids := make([]string, len(recips))
		for i, rc := range recips {
			ids[i] = rc.ID
		}
		var full bool
		if err := tx.QueryRow(ctx, `select exists(select 1 from deliveries where member_id = any($1::uuid[]) and state = 'queued'
			group by member_id having count(*) >= 1000)`, ids).Scan(&full); err != nil {
			return err
		}
		if full {
			return httpx.RateLimited("mailbox_full", 60)
		}
		// stored bytes, charged to the sender's account (blocker 8): the safety ceiling in every mode, then the plan
		var add int64
		for _, rc := range recips {
			add += plans.CopyBytes(len(envs[rc.ID].Raw))
		}
		total, err := plans.CheckStorage(ctx, tx, a.St.Pool, a.Cfg.Plans, c.M.AccountID, add)
		if a.M != nil && total > 0 {
			lim := int64(a.Cfg.Plans.StorageTotal()) * plans.MiB
			a.M.SetStorage(total, plans.StoragePct(total, lim), plans.StorageLevelNum(total, lim))
		}
		if err != nil {
			return err
		}
		quiet := req.Quiet != nil && *req.Quiet
		intro := req.Intro != nil && *req.Intro
		tag, err := tx.Exec(ctx, `insert into messages (id, room_id, from_member, scope, to_member, in_reply_to, request_hash, recipients, expires_at, quiet, intro)
			values ($1,$2,$3,$4,$5,$6,$7,$8, to_timestamp($9), $10, $11) on conflict (id) do nothing`,
			req.ID, req.RoomID, c.M.ID, req.Scope, req.ToMember, req.InReplyTo, reqHash, len(recips), expiresAt, quiet, intro)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 { // a concurrent same-id send committed first
			dup, n, err := checkExisting(ctx, tx, req.ID, c.M.ID, reqHash)
			if err != nil {
				return err
			}
			if !dup {
				return errors.New("message id vanished between insert and re-check")
			}
			status, nRecipients = 200, n
			return nil
		}
		if lastMsg {
			if err := setLastMessage(ctx, tx, req.RoomID); err != nil {
				return err
			}
		}
		sort.Slice(recips, func(i, j int) bool { return recips[i].ID < recips[j].ID })
		for i, rc := range recips {
			noWake, held, err := quietFor(ctx, tx, c.M.ID, c.M.AccountID, rc, intro, req.InReplyTo)
			if err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, `insert into deliveries (message_id, member_id, key_epoch, envelope, expires_at, no_wake, wake_held)
				values ($1,$2,$3,$4, to_timestamp($5), $6, $7)`, req.ID, rc.ID, rc.KeyEpoch, string(envs[rc.ID].Raw), expiresAt, noWake, held); err != nil {
				return err
			}
			if held {
				if !quiet {
					notWoken = append(notWoken, rc.ID)
				}
				if err := heldForSender(ctx, tx, req.RoomID, c.M.ID, rc, quiet); err != nil {
					return err
				}
			}
			if err := faults.Point(ctx, "send_after_delivery", i+1); err != nil {
				return err
			}
			if rc.Turn == "always_on" && !noWake {
				if _, err := tx.Exec(ctx, `insert into push_jobs (member_id, message_id) values ($1,$2)`, rc.ID, req.ID); err != nil {
					return err
				}
			}
		}
		if req.InReplyTo != nil {
			// only the replier's OWN copy; a forged in_reply_to matches 0 rows
			if _, err := tx.Exec(ctx, `update deliveries set state = 'done', done_at = now(), envelope = null, lease_until = null, purge_after = null
				where message_id = $1 and member_id = $2 and state in ('queued','shown')`, *req.InReplyTo, c.M.ID); err != nil {
				return err
			}
		}
		nRecipients = len(recips)
		return nil
	})
	if err != nil {
		if errors.Is(err, faults.ErrInjected) {
			return httpx.Internal(err)
		}
		return err
	}
	if status == 200 { // a replay gets the answer the first send got
		if notWoken, err = store.HeldRecipients(ctx, a.St.Pool, req.ID); err != nil {
			return err
		}
	}
	if status == 201 {
		a.An.AfterSend(a.St.Pool, c.M.AccountID, req.RoomID, req.Scope, c.M.App, nRecipients, req.Quiet != nil && *req.Quiet, req.Intro != nil && *req.Intro)
	}
	httpx.WriteJSON(w, status, map[string]any{"id": req.ID, "recipients": nRecipients, "duplicate": status == 200, "not_woken": notWoken})
	return nil
}

// quietFor: does this copy wake nobody? (security review 12 Nov 2026: wake and cost abuse.) Yes when the recipient's
// person paused all their chats, muted this sender, or this sender already used its wake budget for this recipient in
// the hour. The copy still waits; the chat reads it on its next turn. A person's own chats are never budgeted against
// each other (one person's chats working together); a hello (intro) never wakes anyone anyway.
// held (lane F, SPEC §6.9 "Held while away"): the recipient declared that other people's chats don't wake it and this
// sender is not one it let through. Decided from the policy alone, so a muted sender is told exactly what an unmuted
// one would be: the send response never shows a mute.
func quietFor(ctx context.Context, tx pgx.Tx, from, fromAccount string, rc recipient, intro bool, inReplyTo *string) (noWake, held bool, err error) {
	if intro {
		return false, false, nil
	}
	var quiet bool
	if err := tx.QueryRow(ctx, `select exists(select 1 from accounts where id = $1 and wakes_paused_at is not null)
		or exists(select 1 from mutes where account_id = $1 and member_id = $2)`, rc.Account, from).Scan(&quiet); err != nil {
		return false, false, err
	}
	if rc.Account == fromAccount {
		return quiet, false, nil
	}
	if held, err = store.HoldsOthers(ctx, tx, rc.ID, rc.KeyEpoch, from, inReplyTo); err != nil || held {
		return held, held, err
	}
	if quiet {
		return true, false, nil
	}
	over, err := ratelimit.Take(ctx, tx, ratelimit.WakeBudget, from+">"+rc.ID)
	return over, false, err
}

func sameNullable(a, b *string) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

// checkExisting: same sender and same body hash → duplicate; anything else with that id → 409 id_conflict.
func checkExisting(ctx context.Context, q store.Q, id, from string, hash []byte) (bool, int, error) {
	var oldFrom string
	var oldHash []byte
	var n int
	err := q.QueryRow(ctx, `select from_member, request_hash, recipients from messages where id = $1`, id).Scan(&oldFrom, &oldHash, &n)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, 0, nil
	}
	if err != nil {
		return false, 0, err
	}
	if oldFrom == from && bytes.Equal(oldHash, hash) {
		return true, n, nil
	}
	return false, 0, httpx.E(409, "id_conflict", "A different message already used this id.")
}

func recipientsChanged(ctx context.Context, q store.Q, roomID string, all []recipient) error {
	var head int
	if err := q.QueryRow(ctx, `select roster_head_seq from rooms where id = $1`, roomID).Scan(&head); err != nil {
		return err
	}
	list := make([]map[string]any, 0, len(all))
	for _, rc := range all {
		list = append(list, map[string]any{"member_id": rc.ID, "fingerprint": rc.FP})
	}
	return httpx.E(409, "recipients_changed", "The member list changed. Refresh it and seal the message again.").
		With("head_seq", head).With("recipients", list)
}
