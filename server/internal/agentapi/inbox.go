package agentapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/charles161/botlink/server/internal/faults"
	"github.com/charles161/botlink/server/internal/httpx"
	"github.com/charles161/botlink/server/internal/load"
	"github.com/charles161/botlink/server/internal/store"
	"github.com/charles161/botlink/server/internal/wake"
	"github.com/charles161/botlink/server/internal/wire"
)

// RecheckEvery is the long-poll safety tick (covers an expired lease or a missed NOTIFY).
var RecheckEvery = 15 * time.Second

const leaseSeconds = 120

type delivery struct {
	Seq        int64           `json:"seq"`
	MessageID  string          `json:"message_id"`
	FromMember string          `json:"from_member"`
	Scope      string          `json:"scope"`
	InReplyTo  *string         `json:"in_reply_to"`
	CreatedAt  time.Time       `json:"created_at"`
	ExpiresAt  time.Time       `json:"expires_at"`
	Attempt    int             `json:"attempt"`
	Envelope   json.RawMessage `json:"envelope"`
	// WakeHeld (lane F, SPEC §6.9 "Held while away"): on a leased copy, true when it did not wake the chat because the
	// member holds other people's messages; its sender and the person's dashboard were told already.
	WakeHeld *bool `json:"wake_held,omitempty"`
}

type notice struct {
	ID        int64          `json:"id"`
	Kind      string         `json:"kind"`
	Data      map[string]any `json:"data"`
	CreatedAt time.Time      `json:"created_at"`
}

// holderState re-reads holder/removed state inside a poll (another chat may have claimed meanwhile).
func (a *API) holderState(ctx context.Context, c *Caller, needHolder bool) (*string, error) {
	var holder *string
	var epoch int64
	var removed, roomDeleted, sameKey bool
	err := a.St.Pool.QueryRow(ctx, `select m.holder_session, m.holder_epoch, m.removed_at is not null, r.deleted_at is not null,
			m.ed25519_pk = $2
		from members m join rooms r on r.id = m.room_id where m.id = $1`, c.M.ID, c.M.Ed).Scan(&holder, &epoch, &removed, &roomDeleted, &sameKey)
	if err != nil {
		return nil, err
	}
	if roomDeleted {
		return nil, roomGone()
	}
	if removed {
		return nil, gone()
	}
	if !sameKey { // rekeyed (moved machines) while polling: the old key stops working
		return nil, httpx.E(401, "unknown_key", "This key isn't a member of any room.")
	}
	if needHolder && holder != nil && *holder != c.Session {
		return nil, notHolder(epoch)
	}
	return holder, nil
}

// longPoll holds the bell FIRST, then loops: check → (bell | 15 s tick | deadline | client gone | superseded).
func (a *API) longPoll(r *http.Request, c *Caller, kind string, waitS int, check func(ctx context.Context, woke bool) (bool, error)) error {
	ctx := r.Context()
	if waitS > 0 { // a long wait holds a slot of this copy's cap; a quick look (wait_s 0) never does
		release, err := a.holdSlot(ctx)
		if err != nil {
			return err
		}
		defer release()
	}
	poll, done := a.Polls.Open(c.M.ID, kind)
	defer done()
	bell := a.Bus.Hold(wake.Inbox+":"+c.M.ID, wake.Session+":"+c.M.ID)
	defer bell.Release()
	if err := faults.Point(ctx, "lease_after_hold", 0); err != nil {
		return err
	}
	deadline := time.NewTimer(time.Duration(waitS) * time.Second)
	defer deadline.Stop()
	tick := time.NewTicker(RecheckEvery)
	defer tick.Stop()
	woke := false
	for {
		select {
		case <-poll.Superseded:
			return httpx.E(409, "superseded", "A newer poll for this member replaced this one.")
		default:
		}
		ok, err := check(ctx, woke)
		if err != nil || ok {
			return err
		}
		if waitS == 0 {
			return errEmpty
		}
		if err := faults.Point(ctx, "lease_after_query", 0); err != nil {
			return err
		}
		select {
		case <-bell.C:
			woke = true
		case <-tick.C:
			woke = false
		case <-deadline.C:
			return errEmpty
		case <-httpx.Draining(ctx): // this copy is shutting down: answer "nothing yet" now; the client polls again
			return errEmpty
		case <-ctx.Done():
			return ctx.Err()
		case <-poll.Superseded:
			return httpx.E(409, "superseded", "A newer poll for this member replaced this one.")
		}
	}
}

var errEmpty = errors.New("empty")

// holdSlot takes one slot of this copy's cap on open waits, or answers 503 high_load at the cap.
func (a *API) holdSlot(ctx context.Context) (func(), error) {
	if a.Load == nil {
		return func() {}, nil
	}
	if !a.Load.Acquire() {
		httpx.SetHighLoad(ctx)
		return nil, load.HighLoad()
	}
	return a.Load.Release, nil
}

// full: at the cap, turn a long wait away before any database work.
func (a *API) full(ctx context.Context, waitS int) error {
	if waitS > 0 && a.Load != nil && a.Load.Full() {
		httpx.SetHighLoad(ctx)
		return load.HighLoad()
	}
	return nil
}

// POST /api/v1/me/inbox/lease
func (a *API) postLease(w http.ResponseWriter, r *http.Request, c *Caller) error {
	if err := requireHolder(c); err != nil {
		return err
	}
	var b struct {
		WaitS *int `json:"wait_s"`
		Max   *int `json:"max"`
		// UrgentOnly: return nothing until a copy that isn't quiet waits (then every waiting copy, quiet ones too):
		// Claude Code's idle waiter, so an FYI never wakes a chat on its own (SPEC §6.6).
		UrgentOnly *bool `json:"urgent_only"`
		// Unstick (r3, listen lab 2026-11-06): the chat itself asked for its inbox (the inbox tool / CLI, not a hook or a
		// wake): copies that went stuck because a wake path failed ('wakes') or a client kept leasing without showing
		// them ('attempts') are queued again first, with fresh counters, so they're shown now instead of vanishing.
		// Poison copies (undecryptable / bad_signature) stay stuck.
		Unstick *bool `json:"unstick"`
	}
	if len(strings.TrimSpace(string(c.Body))) > 0 {
		if err := httpx.DecodeStrict(c.Body, &b); err != nil {
			return err
		}
	}
	urgentOnly := b.UrgentOnly != nil && *b.UrgentOnly
	waitS, max := 0, 50
	if b.WaitS != nil {
		waitS = *b.WaitS
	}
	if b.Max != nil {
		max = *b.Max
	}
	if waitS < 0 || waitS > 50 || max < 1 || max > 50 {
		return httpx.BadRequest("wait_s must be 0..50 and max 1..50.")
	}
	if err := a.full(r.Context(), waitS); err != nil {
		return err
	}
	if _, err := a.St.Pool.Exec(r.Context(), `update members set last_poll_at = now(), last_seen_at = now(), presence_live = true where id = $1`, c.M.ID); err != nil {
		return err
	}
	unstuck := 0
	if b.Unstick != nil && *b.Unstick {
		n, err := a.unstick(r.Context(), c)
		if err != nil {
			return err
		}
		unstuck = n
	}
	var ds []delivery
	var ns []notice
	err := a.longPoll(r, c, "lease", waitS, func(ctx context.Context, woke bool) (bool, error) {
		if _, err := a.holderState(ctx, c, true); err != nil {
			return false, err
		}
		var err error
		if urgentOnly {
			var urgent bool
			if err := a.St.Pool.QueryRow(ctx, `select exists (select 1 from deliveries d join messages m on m.id = d.message_id
				where d.member_id = $1 and d.state = 'queued' and (d.lease_until is null or d.lease_until < now())
				and d.expires_at > now() and not m.quiet and not m.intro and not d.no_wake and (d.not_before is null or d.not_before <= now()))`, c.M.ID).Scan(&urgent); err != nil {
				return false, err
			}
			if !urgent {
				return false, nil
			}
		}
		ds, ns, err = a.leaseOnce(ctx, c.M.ID, max, woke)
		if err != nil {
			return false, err
		}
		return len(ds) > 0 || len(ns) > 0, nil
	})
	if err != nil && err != errEmpty {
		if errors.Is(err, context.Canceled) {
			return nil
		}
		return err
	}
	if ds == nil {
		ds = []delivery{}
	}
	if ns == nil {
		ns = []notice{}
	}
	// unstuck: how many copies this read took back from "stuck" (their wake path had failed 5 times). The client
	// must not count such a read as a wake (SPEC §6.9, 2026-11-11).
	httpx.WriteJSON(w, 200, map[string]any{"deliveries": ds, "notices": ns, "lease_s": leaseSeconds, "retry_ms": a.Cfg.RetryMS, "unstuck": unstuck})
	return nil
}

// unstick re-queues the caller's own stuck copies whose wake path failed or that were leased without being shown (not
// poison), resolves the person's "stuck" attention when none are left, and runs under the holder check.
func (a *API) unstick(ctx context.Context, c *Caller) (int, error) {
	n := 0
	err := a.St.Tx(ctx, func(tx pgx.Tx) error {
		n = 0
		if _, err := a.holderState(ctx, c, true); err != nil {
			return err
		}
		tag, err := tx.Exec(ctx, `update deliveries set state = 'queued', attempts = 0, wakes = 0, stuck_reason = null, lease_until = null
			where member_id = $1 and state = 'stuck' and stuck_reason in ('wakes','attempts') and envelope is not null and expires_at > now()`, c.M.ID)
		if err != nil || tag.RowsAffected() == 0 {
			return err
		}
		n = int(tag.RowsAffected())
		_, err = tx.Exec(ctx, `update attention set resolved_at = now() where subject_id = $1 and kind = 'stuck' and resolved_at is null
			and not exists (select 1 from deliveries where member_id = $1 and state = 'stuck')`, c.M.ID)
		return err
	})
	return n, err
}

func (a *API) leaseOnce(ctx context.Context, memberID string, max int, woke bool) ([]delivery, []notice, error) {
	var ds []delivery
	var ns []notice
	err := a.St.Tx(ctx, func(tx pgx.Tx) error {
		if _, err := a.St.MarkStuck(ctx, tx, memberID); err != nil {
			return err
		}
		rows, err := tx.Query(ctx, `
			with pick as (
				select seq, lease_until is not null as expired from deliveries
				where member_id = $1 and state = 'queued' and (lease_until is null or lease_until < now()) and expires_at > now()
				  and (not_before is null or not_before <= now())
				order by seq limit $2 for update skip locked
			), upd as (
				update deliveries d set lease_until = now() + interval '120 seconds', attempts = d.attempts + 1
				from pick where d.seq = pick.seq and d.state = 'queued' and (d.lease_until is null or d.lease_until < now())
				returning d.seq, d.message_id, d.envelope, d.attempts, d.expires_at, pick.expired, d.wake_held
			)
			select upd.seq, upd.message_id, upd.envelope, upd.attempts, upd.expires_at, upd.expired, upd.wake_held,
			       m.from_member, m.scope, m.in_reply_to, m.created_at, extract(epoch from now() - m.created_at)::float8
			from upd join messages m on m.id = upd.message_id order by upd.seq`, memberID, max)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var d delivery
			var env string
			var expired, held bool
			var lag float64
			d.WakeHeld = &held
			if err := rows.Scan(&d.Seq, &d.MessageID, &env, &d.Attempt, &d.ExpiresAt, &expired, d.WakeHeld, &d.FromMember, &d.Scope,
				&d.InReplyTo, &d.CreatedAt, &lag); err != nil {
				return err
			}
			d.Envelope = json.RawMessage(env)
			d.CreatedAt, d.ExpiresAt = d.CreatedAt.UTC(), d.ExpiresAt.UTC()
			ds = append(ds, d)
			if a.M != nil {
				a.M.DeliveryLag.Observe(lag, "leased")
				if woke {
					a.M.WakeLatency.Observe(lag)
				}
				if expired {
					a.M.LeaseExpired.Inc()
				}
			}
		}
		if err := rows.Err(); err != nil {
			return err
		}
		ns, err = openNotices(ctx, tx, memberID)
		return err
	})
	return ds, ns, err
}

func openNotices(ctx context.Context, q store.Q, memberID string) ([]notice, error) {
	rows, err := q.Query(ctx, `select id, kind, data, created_at from notices where member_id = $1 and acked_at is null order by id limit 20`, memberID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ns []notice
	for rows.Next() {
		var n notice
		if err := rows.Scan(&n.ID, &n.Kind, &n.Data, &n.CreatedAt); err != nil {
			return nil, err
		}
		n.CreatedAt = n.CreatedAt.UTC()
		if n.Data == nil {
			n.Data = map[string]any{}
		}
		ns = append(ns, n)
	}
	return ns, rows.Err()
}

// POST /api/v1/me/wait: non-leasing long-poll for watch / listen. Holder not required.
func (a *API) postWait(w http.ResponseWriter, r *http.Request, c *Caller) error {
	var b struct {
		WaitS *int `json:"wait_s"`
		// UrgentOnly: count (and wake for) only copies that aren't quiet (SPEC §6.9): an FYI never wakes an idle chat.
		UrgentOnly *bool `json:"urgent_only"`
		// Peek: count without counting a wake (a listener re-checks before it runs its command: a wake counts only
		// when readable messages still wait).
		Peek *bool `json:"peek"`
	}
	if len(strings.TrimSpace(string(c.Body))) > 0 {
		if err := httpx.DecodeStrict(c.Body, &b); err != nil {
			return err
		}
	}
	waitS := 50
	if b.WaitS != nil {
		waitS = *b.WaitS
	}
	if waitS < 0 || waitS > 50 {
		return httpx.BadRequest("wait_s must be 0..50.")
	}
	if err := a.full(r.Context(), waitS); err != nil {
		return err
	}
	urgentOnly, peek := b.UrgentOnly != nil && *b.UrgentOnly, b.Peek != nil && *b.Peek
	if _, err := a.St.Pool.Exec(r.Context(), `update members set last_wait_at = now(), last_seen_at = now(), presence_live = true where id = $1`, c.M.ID); err != nil {
		return err
	}
	count := 0
	var holder *string
	err := a.longPoll(r, c, "wait", waitS, func(ctx context.Context, _ bool) (bool, error) {
		var err error
		if holder, err = a.holderState(ctx, c, false); err != nil {
			return false, err
		}
		err = a.St.Tx(ctx, func(tx pgx.Tx) error {
			if _, err := a.St.MarkStuck(ctx, tx, c.M.ID); err != nil {
				return err
			}
			if peek {
				return tx.QueryRow(ctx, `select count(*) from deliveries d join messages m on m.id = d.message_id
					where d.member_id = $1 and d.state = 'queued' and (d.lease_until is null or d.lease_until < now())
					and d.expires_at > now() and (not $2::bool or not m.quiet) and not m.intro and not d.no_wake and (d.not_before is null or d.not_before <= now())`, c.M.ID, urgentOnly).Scan(&count)
			}
			return tx.QueryRow(ctx, `with w as (update deliveries d set wakes = d.wakes + 1 from messages m
				where m.id = d.message_id and d.member_id = $1 and d.state = 'queued' and (d.lease_until is null or d.lease_until < now())
				and d.expires_at > now() and (not $2::bool or not m.quiet) and not m.intro and not d.no_wake and (d.not_before is null or d.not_before <= now())
				returning 1) select count(*) from w`, c.M.ID, urgentOnly).Scan(&count)
		})
		return count > 0, err
	})
	if err != nil && err != errEmpty {
		if errors.Is(err, context.Canceled) {
			return nil
		}
		return err
	}
	httpx.WriteJSON(w, 200, map[string]any{"count": count, "holder_session": holder, "retry_ms": a.Cfg.RetryMS})
	return nil
}

type ackItem struct {
	MessageID string  `json:"message_id"`
	Action    string  `json:"action"`
	Reason    *string `json:"reason"`
}

// POST /api/v1/me/inbox/ack: shown | release | reject own copies; ack notices. Idempotent.
func (a *API) postAck(w http.ResponseWriter, r *http.Request, c *Caller) error {
	ctx := r.Context()
	if err := requireHolder(c); err != nil {
		return err
	}
	var b struct {
		Items     []ackItem `json:"items"`
		NoticeIDs []int64   `json:"notice_ids"`
		// Woken (SPEC §6.9, tightened 2026-11-11). true: the client says this read shows that an IDLE chat is reached
		// (a run something outside the chat started: watch, a listener's command, a hook's idle waiter, an event; or
		// the second of two wake tests for a wait the chat left running): members.wake_verified_at is set.
		// false: a wake test FAILED (it showed up only on a turn): wake_verified_at is cleared.
		// absent: an ordinary read; says nothing either way.
		Woken *bool `json:"woken"`
	}
	if err := httpx.DecodeStrict(c.Body, &b); err != nil {
		return err
	}
	if len(b.Items) > 50 || len(b.NoticeIDs) > 50 {
		return httpx.BadRequest("At most 50 items and 50 notice ids.")
	}
	for _, it := range b.Items {
		if !wire.IsUUID(it.MessageID) {
			return httpx.BadRequest("message_id must be a uuid.")
		}
		switch it.Action {
		case "shown", "release":
			if it.Reason != nil {
				return httpx.BadRequest("reason is only for reject.")
			}
		case "reject":
			if it.Reason == nil || (*it.Reason != "undecryptable" && *it.Reason != "bad_signature") {
				return httpx.BadRequest("reject needs reason undecryptable or bad_signature.")
			}
		default:
			return httpx.BadRequest("action must be shown, release or reject.")
		}
	}
	results := make([]map[string]any, 0, len(b.Items))
	err := a.St.Tx(ctx, func(tx pgx.Tx) error {
		results = results[:0]
		// the holder may have changed since auth: re-check under the member row lock
		var holder *string
		var epoch int64
		if err := tx.QueryRow(ctx, `select holder_session, holder_epoch from members where id = $1 for share`, c.M.ID).Scan(&holder, &epoch); err != nil {
			return err
		}
		if holder != nil && *holder != c.Session {
			return notHolder(epoch)
		}
		// a wake test FAILED (the client's verdict): whatever was shown before, an idle chat is not reached now
		if b.Woken != nil && !*b.Woken {
			if _, err := tx.Exec(ctx, `update members set wake_verified_at = null where id = $1`, c.M.ID); err != nil {
				return err
			}
		}
		for _, it := range b.Items {
			switch it.Action {
			case "shown":
				var lag *float64
				if err := tx.QueryRow(ctx, `with u as (update deliveries d set state = 'shown', shown_at = now(), lease_until = null,
						purge_after = now() + interval '24 hours'
					where d.member_id = $1 and d.message_id = $2 and d.state = 'queued' returning d.message_id)
					select extract(epoch from now() - m.created_at)::float8 from u join messages m on m.id = u.message_id`,
					c.M.ID, it.MessageID).Scan(&lag); err != nil && !errors.Is(err, pgx.ErrNoRows) {
					return err
				}
				if lag != nil && a.M != nil {
					a.M.DeliveryLag.Observe(*lag, "shown")
				}
				// an observed idle wake (SPEC §6.9): the client says so (woken: true, see above), or the server saw it
				// itself: bot-link Events (§6.13) delivered this copy's event to the member's own endpoint (the worker
				// counted the wake) within the last 3 minutes and the copy is shown within 3 minutes of the message.
				//
				// Until 2026-11-11 a third way counted: "shown within 3 minutes of a wait that had seen the copy". The
				// server cannot tell a listener's wait from a wait the chat started itself, nor who started the turn
				// that read: a bot whose background wait ended without giving it a turn, and whose person then typed,
				// was shown as "wakes on its own" (eval wake/label-after-a-person-reads). A copy a human turn shows
				// never counts; only the client knows what woke it, and it says so with woken: true.
				if lag != nil {
					if _, err := tx.Exec(ctx, `update members set wake_verified_at = now() where id = $1 and ($2::bool or (
						exists (select 1 from event_jobs j
							join event_subscriptions es on es.id = j.subscription_id
							where j.message_id = $3 and j.done and not j.failed and j.tries > 0
							  and es.member_id = $1 and es.key_epoch = members.key_epoch and es.disabled_at is null
							  and es.expires_at > now() and es.last_ok_at > now() - interval '180 seconds') and exists (
						select 1 from deliveries where member_id = $1 and message_id = $3 and wakes > 0 and $4::float8 < 180)))`,
						c.M.ID, b.Woken != nil && *b.Woken, it.MessageID, *lag); err != nil {
						return err
					}
				}
			case "release":
				if _, err := tx.Exec(ctx, `update deliveries set lease_until = null where member_id = $1 and message_id = $2 and state = 'queued'`,
					c.M.ID, it.MessageID); err != nil {
					return err
				}
			case "reject":
				var from string
				err := tx.QueryRow(ctx, `with u as (update deliveries set state = 'stuck', stuck_reason = $3, lease_until = null
						where member_id = $1 and message_id = $2 and state = 'queued' returning message_id)
					select m.from_member from u join messages m on m.id = u.message_id`, c.M.ID, it.MessageID, *it.Reason).Scan(&from)
				if err == nil {
					if a.M != nil {
						a.M.Stuck.Inc()
					}
					if err := a.St.StuckAttention(ctx, tx, c.M.ID, *it.Reason); err != nil {
						return err
					}
					if _, err := tx.Exec(ctx, `insert into notices (member_id, kind, data) values ($1, 'rejected_by_recipient',
						jsonb_build_object('to_member', $2::text, 'to_name', $3::text, 'message_id', $4::text, 'reason', $5::text))`,
						from, c.M.ID, c.M.Name, it.MessageID, *it.Reason); err != nil {
						return err
					}
				} else if !errors.Is(err, pgx.ErrNoRows) {
					return err
				}
			}
			var state string
			err := tx.QueryRow(ctx, `select state from deliveries where member_id = $1 and message_id = $2`, c.M.ID, it.MessageID).Scan(&state)
			if errors.Is(err, pgx.ErrNoRows) {
				state = "unknown"
			} else if err != nil {
				return err
			}
			results = append(results, map[string]any{"message_id": it.MessageID, "state": state})
		}
		if len(b.NoticeIDs) > 0 {
			if _, err := tx.Exec(ctx, `update notices set acked_at = now() where member_id = $1 and id = any($2) and acked_at is null`,
				c.M.ID, b.NoticeIDs); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return err
	}
	if a.An.Enabled() && b.Woken != nil {
		var shown []string
		for _, it := range b.Items {
			if it.Action == "shown" {
				shown = append(shown, it.MessageID)
			}
		}
		a.An.AfterAck(a.St.Pool, c.M.AccountID, c.M.ID, c.M.App, b.Woken, shown)
	}
	httpx.WriteJSON(w, 200, map[string]any{"items": results})
	return nil
}

// GET /api/v1/me/inbox/recent: shown/done copies whose sealed body is still stored. Holder only.
func (a *API) getRecent(w http.ResponseWriter, r *http.Request, c *Caller) error {
	if err := store.Seen(r.Context(), a.St.Pool, c.M.ID); err != nil {
		return err
	}
	if err := requireHolder(c); err != nil {
		return err
	}
	q := r.URL.Query()
	after, limit := int64(0), 20
	if s := q.Get("after_seq"); s != "" {
		v, err := strconv.ParseInt(s, 10, 64)
		if err != nil || v < 0 {
			return httpx.BadRequest("after_seq must be a non-negative integer.")
		}
		after = v
	}
	if s := q.Get("limit"); s != "" {
		v, err := strconv.Atoi(s)
		if err != nil || v < 1 || v > 50 {
			return httpx.BadRequest("limit must be 1..50.")
		}
		limit = v
	}
	rows, err := a.St.Pool.Query(r.Context(), `
		select d.seq, d.message_id, d.envelope, d.attempts, d.expires_at, m.from_member, m.scope, m.in_reply_to, m.created_at
		from deliveries d join messages m on m.id = d.message_id
		where d.member_id = $1 and d.state in ('shown','done') and d.envelope is not null and d.seq > $2
		order by d.seq limit $3`, c.M.ID, after, limit)
	if err != nil {
		return err
	}
	defer rows.Close()
	ds := []delivery{}
	for rows.Next() {
		var d delivery
		var env string
		if err := rows.Scan(&d.Seq, &d.MessageID, &env, &d.Attempt, &d.ExpiresAt, &d.FromMember, &d.Scope, &d.InReplyTo, &d.CreatedAt); err != nil {
			return err
		}
		d.Envelope = json.RawMessage(env)
		d.CreatedAt, d.ExpiresAt = d.CreatedAt.UTC(), d.ExpiresAt.UTC()
		ds = append(ds, d)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	httpx.WriteJSON(w, 200, map[string]any{"deliveries": ds})
	return nil
}

// GET /api/v1/me/inbox/count: no lease, no wake counted. Holder only.
func (a *API) getCount(w http.ResponseWriter, r *http.Request, c *Caller) error {
	if err := store.Seen(r.Context(), a.St.Pool, c.M.ID); err != nil {
		return err
	}
	if err := requireHolder(c); err != nil {
		return err
	}
	var queued, urgent, notices, stuck, available int
	var newest, newestUrgent *int64
	if err := a.St.Pool.QueryRow(r.Context(), `select
		(select count(*) from deliveries d where member_id = $1 and state = 'queued' and expires_at > now() and (d.not_before is null or d.not_before <= now())),
		(select count(*) from deliveries d join messages m on m.id = d.message_id
			where d.member_id = $1 and d.state = 'queued' and d.expires_at > now() and not m.quiet and not m.intro and not d.no_wake and (d.not_before is null or d.not_before <= now())),
		(select count(*) from notices where member_id = $1 and acked_at is null),
		(select count(*) from deliveries where member_id = $1 and state = 'stuck' and stuck_reason in ('wakes','attempts') and envelope is not null and expires_at > now()),
		(select count(*) from deliveries d where member_id = $1 and state = 'queued' and expires_at > now() and (d.not_before is null or d.not_before <= now())
			and (d.lease_until is null or d.lease_until < now())),
		(select max(d.seq) from deliveries d join messages m on m.id = d.message_id where d.member_id = $1 and d.state = 'queued'
			and d.expires_at > now() and not m.intro and not d.no_wake and (d.not_before is null or d.not_before <= now())
			and (d.lease_until is null or d.lease_until < now())),
		(select max(d.seq) from deliveries d join messages m on m.id = d.message_id where d.member_id = $1 and d.state = 'queued'
			and d.expires_at > now() and not m.intro and not m.quiet and not d.no_wake and (d.not_before is null or d.not_before <= now())
			and (d.lease_until is null or d.lease_until < now()))`,
		c.M.ID).Scan(&queued, &urgent, &notices, &stuck, &available, &newest, &newestUrgent); err != nil {
		return err
	}
	// urgent: the ones that aren't quiet (a Stop hook nudges only for these; FYIs wait for the next turn) and may wake
	// (security review: a muted sender, a paused person or a spent wake budget makes a copy that wakes nobody)
	// stuck (r3): copies a failed wake path left stuck; the inbox tool (unstick) still shows them
	// available: what an inbox read would get right now (queued and not being shown by another call of this
	// chat at this moment), so a chat's "N waiting" matches what its inbox returns
	// newest_seq (bot-link Events poll, §6.13): the newest waiting copy's number (hellos aside), so a poller can tell
	// "the same messages still unread" from "one was read and a new one came" when the count is the same
	httpx.WriteJSON(w, 200, map[string]any{"queued": queued, "urgent": urgent, "notices": notices, "stuck": stuck, "available": available,
		"newest_seq": newest, "newest_urgent_seq": newestUrgent})
	return nil
}

// POST /api/v1/me/presence: "this chat is listening" (its own loop, SPEC §6.9). Holder not required. Every inbox /
// wait / lease call counts the same; the label flips back to "answers when …" 90 s after the last one.
func (a *API) postPresence(w http.ResponseWriter, r *http.Request, c *Caller) error {
	ctx := r.Context()
	if len(strings.TrimSpace(string(c.Body))) > 0 {
		var b struct{}
		if err := httpx.DecodeStrict(c.Body, &b); err != nil {
			return err
		}
	}
	if err := store.Seen(ctx, a.St.Pool, c.M.ID); err != nil {
		return err
	}
	ms, err := store.ActiveMembers(ctx, a.St.Pool, c.M.RoomID)
	if err != nil {
		return err
	}
	label := ""
	for _, m := range ms {
		if m.ID == c.M.ID {
			label = m.TurnLabel
		}
	}
	httpx.WriteJSON(w, 200, map[string]any{"turn_label": label, "listening_for_s": store.PresenceWindowS})
	return nil
}
