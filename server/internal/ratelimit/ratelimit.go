// Package ratelimit implements the fixed-window counters of SPEC §9 in Postgres (rate_counters), so every
// copy shares them. A counter bumped inside a transaction that rolls back is not counted.
package ratelimit

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/charles161/botlink/server/internal/httpx"
)

type Q interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

// Limit is one quota.
type Limit struct {
	Name   string // bucket prefix, e.g. "send:m"
	Window time.Duration
	Max    int
	Code   string // 429 code; default rate_limited
}

var (
	SendMember       = Limit{"send:m", time.Minute, 30, ""}
	SendMemberDay    = Limit{"send:md", 24 * time.Hour, 1000, ""}
	SendRoom         = Limit{"send:r", time.Minute, 300, ""}
	JoinPerKey       = Limit{"join:k", time.Hour, 5, ""}
	JoinPerInvite    = Limit{"join:i", time.Hour, 10, ""}
	InviteFailIP     = Limit{"invfail:ip", time.Hour, 20, ""}
	AskHuman         = Limit{"ask:m", time.Hour, 10, ""}
	Approvals        = Limit{"approve:a", time.Hour, 60, ""}
	PersonInvitesDay = Limit{"pinv:a", 24 * time.Hour, 20, "quota_exceeded"}
	Dashboard        = Limit{"dash:s", time.Minute, 600, ""}
	Selftest         = Limit{"selftest:m", time.Hour, 10, ""} // SPEC §6.4a self-test messages per member
	// Polls: lease + wait + roster + count calls per member (live bug B, 2026-11-06: a client looped lease + roster
	// ~290 times a minute). A healthy chat makes a few a minute; over the limit → 429 too_many_polls + Retry-After.
	Polls = Limit{"poll:m", time.Minute, 240, "too_many_polls"}
	// EventSubs: subscribe / refresh calls per member (each new URL costs one outbound verification POST).
	EventSubs = Limit{"evsub:m", time.Hour, 60, ""}
	// EventURLAsks: asks for an event address the member's person approves (approval: person), per member per hour.
	// Each new one puts an item in front of the person (docs/protocol/event-url-approval.md §1).
	EventURLAsks = Limit{"evask:m", time.Hour, 6, ""}
	// WakeBudget: copies one member can make WAKE one recipient (of another person) per hour (security review 12 Nov
	// 2026: each wake can be a full resume on the recipient's account). Over it the copy is still sent and read on the
	// recipient's next turn; it just wakes nobody (Take, never a 429).
	WakeBudget = Limit{"wake:p", time.Hour, 20, ""}
	// JoinWaits: join-request waits per key per minute (a healthy client holds one 50 s wait at a time).
	JoinWaits = Limit{"jwait:k", time.Minute, 30, ""}
	// BillingEvents: payment gateway event calls per client IP, counted before the body is read (appapi/plans.go).
	BillingEvents = Limit{"billev:ip", time.Minute, 600, ""}
	// New accounts (fix-all blocker 8; auth.SignupLimits, config BOTLINK_SIGNUP_*: Max is set from config). Per source
	// address (IPv6 per /64) and in total. Counted only when an account is made: a refused sign-up rolls back.
	SignupAddrHour = Limit{"signup:ip", time.Hour, 10, "signup_limited"}
	SignupAddrDay  = Limit{"signup:ipd", 24 * time.Hour, 30, "signup_limited"}
	SignupHour     = Limit{"signup:all", time.Hour, 1000, "signup_limited"} // security review finding 5: a launch hour
	SignupDay      = Limit{"signup:alld", 24 * time.Hour, 5000, "signup_limited"}
	// RoomsCreatedDay: new rooms per account per day (fix-all blocker 8). A deleted room keeps its row and signed
	// roster entries, so create-and-delete in a loop otherwise grows the disk at the dashboard rate.
	RoomsCreatedDay = Limit{"room:a", 24 * time.Hour, 30, "quota_exceeded"}
	// Rooms started by a chat (docs/protocol/room-drafts.md §5). DraftsPerIPHour: drafts made per caller address per
	// hour (Max from config BOTLINK_DRAFT_PER_IP_HOUR). InviteLinkMember / InviteLinkRoom: POST /api/v1/me/invite-link.
	DraftsPerIPHour  = Limit{"draft:ip", time.Hour, 30, "too_many_drafts"}
	InviteLinkMember = Limit{"invlink:m", time.Hour, 6, ""}
	InviteLinkRoom   = Limit{"invlink:r", time.Hour, 20, ""}
)

// All lists every quota (the admin area counts windows that hit each one).
var All = []Limit{SendMember, SendMemberDay, SendRoom, JoinPerKey, JoinPerInvite, InviteFailIP, AskHuman, Approvals,
	PersonInvitesDay, Dashboard, Selftest, Polls, EventSubs, EventURLAsks, WakeBudget, JoinWaits, BillingEvents,
	SignupAddrHour, SignupAddrDay, SignupHour, SignupDay, RoomsCreatedDay, DraftsPerIPHour, InviteLinkMember, InviteLinkRoom}

// BucketSuffix is the ":<window>" every bucket of this limit ends with.
func (l Limit) BucketSuffix() string { return ":" + l.Window.String() }

func (l Limit) bucket(key string) string { return fmt.Sprintf("%s:%s:%s", l.Name, key, l.Window) }

func interval(d time.Duration) string { return fmt.Sprintf("%d seconds", int(d.Seconds())) }

// Hit counts one event; over the limit → 429 with Retry-After until the window ends.
func Hit(ctx context.Context, q Q, l Limit, key string) error {
	var n int
	var retry float64
	err := q.QueryRow(ctx, `
		insert into rate_counters (bucket, window_start, count)
		values ($1, date_bin($2::interval, now(), timestamptz 'epoch'), 1)
		on conflict (bucket, window_start) do update set count = rate_counters.count + 1
		returning count, extract(epoch from (window_start + $2::interval - now()))::float8`,
		l.bucket(key), interval(l.Window)).Scan(&n, &retry)
	if err != nil {
		return err
	}
	if n > l.Max {
		httpx.SetRateLimited(ctx, l.Name)
		return httpx.RateLimited(l.Code, int(retry)+1)
	}
	return nil
}

// HitAt is Hit on the caller's clock (now picks the window; injectable in tests) instead of Postgres now(). Use it
// for long windows only, where copies' clocks agreeing to the second does not matter.
func HitAt(ctx context.Context, q Q, l Limit, key string, now time.Time) error {
	var n int
	var retry float64
	err := q.QueryRow(ctx, `
		insert into rate_counters (bucket, window_start, count)
		values ($1, date_bin($2::interval, $3::timestamptz, timestamptz 'epoch'), 1)
		on conflict (bucket, window_start) do update set count = rate_counters.count + 1
		returning count, extract(epoch from (window_start + $2::interval - $3::timestamptz))::float8`,
		l.bucket(key), interval(l.Window), now).Scan(&n, &retry)
	if err != nil {
		return err
	}
	if n > l.Max {
		httpx.SetRateLimited(ctx, l.Name)
		return httpx.RateLimited(l.Code, int(retry)+1)
	}
	return nil
}

// Take counts one event and reports whether it went over the limit, with no error and no 429 (a budget, not a wall).
func Take(ctx context.Context, q Q, l Limit, key string) (bool, error) {
	var n int
	err := q.QueryRow(ctx, `
		insert into rate_counters (bucket, window_start, count)
		values ($1, date_bin($2::interval, now(), timestamptz 'epoch'), 1)
		on conflict (bucket, window_start) do update set count = rate_counters.count + 1
		returning count`, l.bucket(key), interval(l.Window)).Scan(&n)
	if err != nil {
		return false, err
	}
	return n > l.Max, nil
}

// Over reports whether the current window is already at/over the limit, without counting.
func Over(ctx context.Context, q Q, l Limit, key string) (bool, int, error) {
	var n int
	var retry float64
	err := q.QueryRow(ctx, `
		select count, extract(epoch from (window_start + $2::interval - now()))::float8 from rate_counters
		where bucket = $1 and window_start = date_bin($2::interval, now(), timestamptz 'epoch')`,
		l.bucket(key), interval(l.Window)).Scan(&n, &retry)
	if err == pgx.ErrNoRows {
		return false, 0, nil
	}
	if err != nil {
		return false, 0, err
	}
	return n >= l.Max, int(retry) + 1, nil
}

// Count adds one without checking (e.g. a failed invite lookup).
func Count(ctx context.Context, q Q, l Limit, key string) error {
	_, err := q.Exec(ctx, `
		insert into rate_counters (bucket, window_start, count)
		values ($1, date_bin($2::interval, now(), timestamptz 'epoch'), 1)
		on conflict (bucket, window_start) do update set count = rate_counters.count + 1`,
		l.bucket(key), interval(l.Window))
	return err
}
