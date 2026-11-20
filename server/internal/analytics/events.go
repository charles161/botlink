package analytics

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
)

// Querier is a pool or a transaction.
type Querier interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// IsNewAccount, called inside the sign-in transaction after auth.Login: whether this transaction created the account
// (its created_at is this transaction's now()). Any error: false. Costs one query, so call it only when Enabled.
func IsNewAccount(ctx context.Context, q Querier, accountID string) bool {
	var created bool
	if err := q.QueryRow(ctx, `select created_at = now() from accounts where id = $1`, accountID).Scan(&created); err != nil {
		return false
	}
	return created
}

// Later runs f in the background with a 3 s deadline, after the request has its answer. Never blocks: when analytics
// is off, closed, or 16 look-ups are already running, f is skipped.
func (c *Client) Later(f func(ctx context.Context)) {
	if !c.Enabled() {
		return
	}
	select {
	case c.later <- struct{}{}:
	default:
		c.dropped.Add(1)
		return
	}
	go func() {
		defer func() { <-c.later }()
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		f(ctx)
	}()
}

// AfterSend records message_sent (counts only) and, for the first conversation message in a room, first_message
// (room_week_senders, migration 0020, holds one count per room, week and person).
func (c *Client) AfterSend(q Querier, accountID, roomID, scope, app string, recipients int, quiet, intro bool) {
	if !c.Enabled() {
		return
	}
	who, room := c.ID(accountID), c.ID(roomID)
	c.Capture(MessageSent, who, Props{"room": room, "scope": scope, "app": app, "recipients": recipients, "quiet": quiet, "intro": intro})
	if intro {
		return
	}
	c.Later(func(ctx context.Context) {
		var first bool
		if err := q.QueryRow(ctx, `select coalesce(sum(messages), 0) = 1 from room_week_senders where room_id = $1`, roomID).Scan(&first); err == nil && first {
			c.Capture(FirstMessage, who, Props{"room": room, "app": app})
		}
	})
}

// AfterAck records a wake test's result as the client reported it on ack (SPEC §6.14): woken false is a failed test;
// woken true with this member's self-test among the copies shown is a passed one. Other acks say nothing.
func (c *Client) AfterAck(q Querier, accountID, memberID, app string, woken *bool, shown []string) {
	if !c.Enabled() || woken == nil {
		return
	}
	who := c.ID(accountID)
	if !*woken {
		c.Capture(WakeTestFailed, who, Props{"member": c.ID(memberID), "app": app})
		return
	}
	if len(shown) == 0 {
		return
	}
	c.Later(func(ctx context.Context) {
		var self bool
		if err := q.QueryRow(ctx, `select exists(select 1 from messages where id = any($1::uuid[]) and scope = 'self' and from_member = $2)`,
			shown, memberID).Scan(&self); err == nil && self {
			c.Capture(WakeTestPassed, who, Props{"member": c.ID(memberID), "app": app})
		}
	})
}
