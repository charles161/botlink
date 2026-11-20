// Package sweeper runs SPEC §6.11 expiry once per minute per cluster: each copy tries a session advisory
// lock on a dedicated connection; the holder runs idempotent UPDATE/DELETEs (a double run is harmless).
package sweeper

import (
	"context"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/charles161/botlink/server/internal/plans"
)

const lockSQL = `select pg_try_advisory_lock(hashtext('botlink-sweeper'))`
const unlockSQL = `select pg_advisory_unlock(hashtext('botlink-sweeper'))`

type Sweeper struct {
	Pool  *pgxpool.Pool
	Every time.Duration
	// OnTotal (optional) gets the server-wide stored bytes after each fold (metrics botlink_storage_total_bytes).
	OnTotal func(int64)
}

func (s *Sweeper) Run(ctx context.Context) {
	every := s.Every
	if every == 0 {
		every = time.Minute
	}
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		if _, err := s.Once(ctx); err != nil && ctx.Err() == nil {
			slog.Warn("sweeper run failed", "err", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// Once runs one sweep if this copy wins the lock. Returns whether it ran.
func (s *Sweeper) Once(ctx context.Context) (bool, error) {
	conn, err := s.Pool.Acquire(ctx)
	if err != nil {
		return false, err
	}
	defer conn.Release()
	var got bool
	if err := conn.QueryRow(ctx, lockSQL).Scan(&got); err != nil {
		return false, err
	}
	if !got { // another copy sweeps; this one still refreshes its storage gauges
		if s.OnTotal != nil {
			if n, err := plans.StorageUsedTotal(ctx, conn); err == nil {
				s.OnTotal(n)
			}
		}
		return false, nil
	}
	defer conn.Exec(context.Background(), unlockSQL) //nolint:errcheck
	return true, sweep(ctx, conn.Conn(), s.OnTotal)
}

// Sweep runs every expiry statement. Exported for tests.
func Sweep(ctx context.Context, conn *pgx.Conn) error { return sweep(ctx, conn, nil) }

func sweep(ctx context.Context, conn *pgx.Conn, onTotal func(int64)) error {
	// expired copies → expired; one expired_unread notice per sender (never shown)
	if err := pgx.BeginFunc(ctx, conn, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `
			with x as (
				update deliveries set state = 'expired', envelope = null, lease_until = null, stuck_reason = null
				where state in ('queued','stuck','needs_resend') and expires_at < now()
				returning message_id, member_id
			), g as (
				select m.from_member, x.member_id, array_agg(x.message_id::text order by x.message_id) ids
				from x join messages m on m.id = x.message_id and m.scope <> 'self' and not m.intro group by m.from_member, x.member_id
			)
			insert into notices (member_id, kind, data)
			select g.from_member, 'expired_unread', jsonb_build_object('to_member', g.member_id::text, 'to_name', t.name, 'message_ids', g.ids)
			from g join members f on f.id = g.from_member and f.removed_at is null
			join members t on t.id = g.member_id`)
		return err
	}); err != nil {
		return err
	}
	stmts := []string{
		// presence (dashboard/admin "seen polling"): ends 90 s after the last inbox / wait / presence call (the flip NOTIFYs the dashboard)
		`update members set presence_live = false where presence_live and (last_seen_at is null or last_seen_at < now() - interval '90 seconds')`,
		`update deliveries set envelope = null where purge_after < now() and envelope is not null and state in ('shown','done')`,
		`update join_requests set status = 'expired', decided_at = now() where status = 'pending' and expires_at < now()`,
		`update person_requests set status = 'expired', decided_at = now() where status = 'pending' and expires_at < now()`,
		// room drafts (docs/protocol/room-drafts.md §1): expired, closed and (once past their expiry, so the chat's wait
		// can still read it) rejected ones go; a confirmed one stays 24 hours so the wait reads the result
		`delete from room_drafts where status = 'closed' or (status <> 'confirmed' and expires_at < now())
			or (status = 'confirmed' and decided_at < now() - interval '24 hours')`,
		`delete from messages where created_at < now() - interval '30 days'`,
		`delete from request_nonces where seen_at < now() - interval '5 minutes'`,
		// bot-link Events (§6.13): delivered / failed events after 2 days; subscriptions a week after they expired
		`delete from event_jobs where done and created_at < now() - interval '2 days'`,
		`delete from event_subscriptions where expires_at < now() - interval '7 days'`,
		// a removed member's, or an earlier chat's (the member moved), never fire again
		`delete from event_subscriptions s using members m where m.id = s.member_id and (m.removed_at is not null or s.key_epoch <> m.key_epoch)`,
		// event addresses a person approves (docs/protocol/event-url-approval.md): nobody approved it in its 24 hours,
		// or it was decided a day ago (the chat has read the outcome by then), or its chat moved or was removed
		`delete from event_url_requests where (status = 'waiting' and expires_at < now()) or (status <> 'waiting' and decided_at < now() - interval '24 hours')`,
		`delete from event_url_requests q using members m where m.id = q.member_id and (m.removed_at is not null or q.key_epoch <> m.key_epoch)`,
		`delete from event_url_refusals where until < now()`,
		`delete from rate_counters where window_start < now() - interval '2 days'`,
		`delete from oauth_states where expires_at < now()`,
		`delete from human_checks where expires_at < now()`,
		`delete from web_sessions where expires_at < now()`,
		`delete from notices where acked_at < now() - interval '7 days'`,
		`delete from attention where resolved_at < now() - interval '30 days'`,
	}
	for _, q := range stmts {
		if _, err := conn.Exec(ctx, q); err != nil {
			return err
		}
	}
	// stored bytes per account (migrations 0046, 0047): fold the deltas the triggers wrote into the totals
	return foldStorage(ctx, conn, onTotal)
}

func foldStorage(ctx context.Context, conn *pgx.Conn, onTotal func(int64)) error {
	total, err := plans.CompactStorage(ctx, conn)
	if err == nil && onTotal != nil {
		onTotal(total)
	}
	return err
}
