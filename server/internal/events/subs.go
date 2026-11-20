package events

import (
	"context"
	"net/netip"
	"net/url"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// An event address the member's person approves (docs/protocol/event-url-approval.md): the chat asks with
// approval: person; nothing is sent to the address until the person approves it with a passkey.
const (
	RequestTTL           = 24 * time.Hour // a request nobody approved is deleted after this
	MaxWaitingPerMember  = 2
	MaxWaitingPerAccount = 10
	MaxSubscriptions     = 6 // per member, approved or proven
	ApprovedByPerson     = "person"
)

// ApproveURL is the dashboard page of a request (app host).
func ApproveURL(appOrigin, id string) string { return appOrigin + "/approve-url/" + id }

// Host is the address's host as the card shows it large, the way a browser's URL parser gives `hostname`: lower case,
// no port, an IPv6 literal in brackets. Only plain hosts (PlainHost) reach a card, so the dashboard's own parse of the
// URL gives the same string.
func Host(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	h := strings.ToLower(u.Hostname())
	if strings.Contains(h, ":") {
		return "[" + h + "]"
	}
	return h
}

// RefusalTime: after the member's person stops an approved address or turns a request down, how long a plain subscribe
// of that member sends that address nothing, not even the check.
const RefusalTime = 24 * time.Hour

// URLKey is an address as a refusal names it: the scheme and host in lower case and the path, without the query or
// fragment (a routine's trigger often carries its key in the query; another key must not get past a Stop).
func URLKey(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return raw
	}
	return strings.ToLower(u.Scheme) + "://" + strings.ToLower(u.Host) + u.EscapedPath()
}

// PlainHost: the host of an address a person approves is one they can read as written and a browser parses the same
// way: an IP address written out in full (what netip.ParseAddr accepts as written), or a name of ASCII letters, digits
// and dashes in non-empty labels, with no punycode label (xn--: a browser decodes it into another script, a look-alike
// such as xn--80ak6aa92e.com for "apple.com"), no trailing dot, and a last label that is not a number (a browser turns
// 16843009, 0x01010101 or 1.1.257 into an address; Go keeps them as names). No user before an @ either.
func PlainHost(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil || u.User != nil || u.Host == "" {
		return false
	}
	h := u.Hostname()
	if strings.HasPrefix(u.Host, "[") {
		ip, err := netip.ParseAddr(h)
		return err == nil && ip.Is6() && ip.Zone() == ""
	}
	if ip, err := netip.ParseAddr(h); err == nil {
		return ip.Is4()
	}
	labels := strings.Split(strings.ToLower(h), ".")
	for _, l := range labels {
		if l == "" || strings.HasPrefix(l, "xn--") || strings.Trim(l, "abcdefghijklmnopqrstuvwxyz0123456789-") != "" {
			return false
		}
	}
	last := labels[len(labels)-1]
	if strings.Trim(last, "0123456789") == "" {
		return false // all digits (decimal or octal to a browser)
	}
	if strings.HasPrefix(last, "0x") && strings.Trim(last[2:], "0123456789abcdef") == "" {
		return false // hex to a browser
	}
	return true
}

// Sub is one subscription as the API shows it (never its secret).
type Sub struct {
	ID          string
	URL         string
	Name        string
	UrgentOnly  bool
	Created     time.Time
	Refreshed   time.Time
	Expires     time.Time
	LastOK      *time.Time
	LastError   *string
	FailedSince *time.Time
	Fails       int
	Disabled    *time.Time
	ApprovedBy  *string
	ApprovedAt  *time.Time
}

// SubCols are the columns ScanSub reads, of event_subscriptions aliased s.
const SubCols = `s.id, s.url, s.name, s.urgent_only, s.created_at, s.refreshed_at, s.expires_at, s.last_ok_at, s.last_error, s.failed_since, s.fails, s.disabled_at, s.approved_by, s.approved_at`

func ScanSub(row pgx.Row) (*Sub, error) {
	s := &Sub{}
	err := row.Scan(&s.ID, &s.URL, &s.Name, &s.UrgentOnly, &s.Created, &s.Refreshed, &s.Expires, &s.LastOK, &s.LastError, &s.FailedSince, &s.Fails, &s.Disabled, &s.ApprovedBy, &s.ApprovedAt)
	return s, err
}

// View never includes a secret. state: "on" | "off" (events kept failing; the next subscribe turns it on again) |
// "expired". refresh_before is when to subscribe again (MCP Events `refreshBefore`). approved_by: "person" when the
// member's person approved the address (it never echoed the check), else null.
func (s *Sub) View(now time.Time) map[string]any {
	state := "on"
	switch {
	case !s.Expires.After(now):
		state = "expired"
	case s.Disabled != nil:
		state = "off"
	}
	// always UTC ("…Z"): MCP Events clients parse refreshBefore as an ISO date-time without an offset
	utc := func(t *time.Time) any {
		if t == nil {
			return nil
		}
		return t.UTC()
	}
	return map[string]any{"id": s.ID, "url": s.URL, "name": s.Name, "urgent_only": s.UrgentOnly, "state": state,
		"created_at": s.Created.UTC(), "refreshed_at": s.Refreshed.UTC(), "refresh_before": s.Expires.UTC(), "last_ok_at": utc(s.LastOK),
		"last_error": s.LastError, "failed_since": utc(s.FailedSince), "fails": s.Fails, "approved_by": s.ApprovedBy, "approved_at": utc(s.ApprovedAt)}
}

type execer interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

// QueueCatchUp queues one message.received event for the member's newest waiting copy, in the transaction that made
// or refreshed subscription subID (SPEC §6.13 catch-up): events are made when a copy arrives, so a copy that came
// while nothing was subscribed (before this subscription, while it was off, between two `--once` receivers, before a
// person approved the address) or whose event failed for good would never wake the chat. The event says "N are
// waiting"; when that copy's event was already accepted, or is still on its way, nothing is announced again.
func QueueCatchUp(ctx context.Context, tx execer, subID, memberID string, urgentOnly bool) error {
	_, err := tx.Exec(ctx, `insert into event_jobs (subscription_id, type, message_id, next_attempt_at)
		select $1, 'message.received', n.message_id, coalesce(n.not_before, now())
		from (select d.message_id, d.not_before from deliveries d join messages msg on msg.id = d.message_id
		      where d.member_id = $2 and d.state = 'queued' and d.expires_at > now() and not msg.intro and not d.no_wake and not ($3::bool and msg.quiet)
		      order by d.seq desc limit 1) n
		-- announced = still on its way, or accepted by the endpoint. A job that was dropped unsent (the subscription
		-- was off or had lapsed when it came due) or that ran out of tries announced nothing.
		where not exists (select 1 from event_jobs j where j.subscription_id = $1 and j.message_id = n.message_id
		                  and (not j.done or (not j.failed and j.tries > 0 and j.last_error is null)))`,
		subID, memberID, urgentOnly)
	return err
}
