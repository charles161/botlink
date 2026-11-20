// Package analytics sends a few product events to PostHog from the server, and nothing else.
//
// Off unless BOTLINK_POSTHOG_KEY and BOTLINK_ANALYTICS_HASH_KEY are both set (config). Then:
//   - ids leave the server only as a keyed hash (HMAC-SHA256 with the hash key, first 128 bits, hex): ID();
//   - an event is one of a fixed list of names, and each property is one of a fixed list of keys, each with a fixed
//     type: a hashed id, a value from a fixed list (the app, the kind of join, ...), a boolean or a count. Anything
//     else (a string that is not on its list, an unknown key, a nested value) drops the WHOLE event. So message text,
//     sealed copies, names of rooms, members or people, email addresses or domains, IP addresses, folders and machine
//     names cannot be sent, by construction (analytics_test.go tries);
//   - every event carries $geoip_disable: true (PostHog skips GeoIP for it) and $process_person_profile: false (no
//     person profile). No client IP is sent: the request to PostHog comes from the server.
//   - Capture never blocks and never fails a request: a bounded in-memory queue, a background sender that batches to
//     <host>/batch/ with a short timeout, and drops on any failure (counted, logged without values).
//
// PostHog's server-side batch API: POST <host>/batch/ with {"api_key", "historical_migration": false, "batch": [{"event",
// "distinct_id", "timestamp", "properties"}]} (https://posthog.com/docs/api/capture, read 2026-11-12). $geoip_disable:
// https://posthog.com/docs/privacy/data-collection ("To skip it for a single event, set the $geoip_disable property to
// true on that event"). $process_person_profile: https://posthog.com/docs/api/capture (anonymous events).
package analytics

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Event is a product event name. Only the names below are ever sent.
type Event string

const (
	AccountCreated Event = "account_created"
	RoomCreated    Event = "room_created"
	InviteMade     Event = "invite_made"    // a person invite (one person inviting another into a room)
	JoinRequested  Event = "join_requested" // kind chat (a chat asks to join) or person (a person used an invite)
	JoinApproved   Event = "join_approved"
	JoinRejected   Event = "join_rejected"
	FirstMessage   Event = "first_message" // the first conversation message in a room
	MessageSent    Event = "message_sent"  // counts only
	WakeTestPassed Event = "wake_test_passed"
	WakeTestFailed Event = "wake_test_failed"
	MemberRemoved  Event = "member_removed"
	LimitReached   Event = "limit_reached" // a plan or quota limit (props: limit, count); at most once per account, limit, day
	PlanChanged    Event = "plan_changed"  // a payment event moved the account's plan (props: plan, the new plan's id)
)

var events = map[Event]bool{
	AccountCreated: true, RoomCreated: true, InviteMade: true, JoinRequested: true, JoinApproved: true, JoinRejected: true,
	FirstMessage: true, MessageSent: true, WakeTestPassed: true, WakeTestFailed: true, MemberRemoved: true, LimitReached: true,
	PlanChanged: true,
}

// Props are an event's properties. Allowed keys and their types are in schema; anything else drops the event.
type Props map[string]any

type kind int

const (
	kHash kind = iota + 1 // an ID from Client.ID
	kBool
	kCount // a non-negative integer up to 1e6
	kEnum  // a string from the key's list
)

type rule struct {
	k    kind
	enum map[string]bool
}

func enum(vals ...string) rule {
	m := map[string]bool{}
	for _, v := range vals {
		m[v] = true
	}
	return rule{k: kEnum, enum: m}
}

// Limits is the list of limit names limit_reached may carry. Extend it where a new limit is enforced.
var Limits = []string{"rooms", "members", "people", "messages", "invites", "approvals", "seats"}

var schema = map[string]rule{
	"room":       {k: kHash},
	"member":     {k: kHash},
	"app":        enum("claude-code", "codex", "cursor", "other"), // members.app: the fixed list; app_name is never sent
	"kind":       enum("chat", "person"),
	"scope":      enum("member", "room"),
	"limit":      enum(Limits...),
	"plan":       enum("free", "pro", "team"), // plan_changed: the plan's id (plans table), never a price or a payment id
	"recipients": {k: kCount},
	"count":      {k: kCount},
	"quiet":      {k: kBool},
	"intro":      {k: kBool},
	"left":       {k: kBool}, // member_removed: the chat left by itself (false: a person removed it)
}

// ID is a keyed hash of an internal id. Only Client.ID makes one, so a raw id or any other text cannot pass as an ID.
type ID struct{ h string }

func (i ID) zero() bool                   { return i.h == "" }
func (i ID) String() string               { return i.h }
func (i ID) MarshalJSON() ([]byte, error) { return json.Marshal(i.h) }

// Config: Key is the PostHog project key (public by design), Host its ingestion host, HashKey the server-side secret for
// ID (at least 32 bytes). Zero values for the rest pick the defaults.
type Config struct {
	Key, Host, HashKey string
	Timeout            time.Duration // per batch request (default 3 s)
	QueueSize          int           // events held in memory (default 1000); more are dropped
	BatchSize          int           // events per request (default 100)
	FlushEvery         time.Duration // send at least this often (default 5 s)
}

type item struct {
	Event      string         `json:"event"`
	DistinctID string         `json:"distinct_id"`
	Timestamp  string         `json:"timestamp"`
	UUID       string         `json:"uuid"`
	Properties map[string]any `json:"properties"`
}

// Client sends events. A nil *Client is off: every method is a safe no-op.
type Client struct {
	cfg  Config
	hkey []byte
	url  string
	http *http.Client

	q         chan item
	stop      chan struct{}
	done      chan struct{}
	closeOnce sync.Once
	closed    atomic.Bool
	flushCtx  atomic.Pointer[context.Context]
	later     chan struct{} // bounds the background look-ups of Later

	sent, dropped, failed atomic.Uint64
}

// New returns nil (analytics off) unless both the project key and a hash key of 32+ bytes are set.
func New(cfg Config) *Client {
	if cfg.Key == "" || len(cfg.HashKey) < 32 {
		return nil
	}
	if cfg.Host == "" {
		cfg.Host = "https://eu.i.posthog.com"
	}
	if cfg.Timeout <= 0 {
		cfg.Timeout = 3 * time.Second
	}
	if cfg.QueueSize <= 0 {
		cfg.QueueSize = 1000
	}
	if cfg.BatchSize <= 0 {
		cfg.BatchSize = 100
	}
	if cfg.FlushEvery <= 0 {
		cfg.FlushEvery = 5 * time.Second
	}
	c := &Client{
		cfg: cfg, hkey: []byte(cfg.HashKey), url: strings.TrimRight(cfg.Host, "/") + "/batch/",
		http: &http.Client{Timeout: cfg.Timeout, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }},
		q:    make(chan item, cfg.QueueSize), stop: make(chan struct{}), done: make(chan struct{}),
		later: make(chan struct{}, 16),
	}
	go c.run()
	return c
}

// Enabled reports whether events are sent at all (call sites skip extra work when off).
func (c *Client) Enabled() bool { return c != nil && !c.closed.Load() }

// ID hashes an internal id (account, room, member) with the server's key. Empty input or an off client: the zero ID,
// which Capture refuses.
func (c *Client) ID(raw string) ID {
	if c == nil || raw == "" {
		return ID{}
	}
	m := hmac.New(sha256.New, c.hkey)
	m.Write([]byte("botlink-analytics-v1|" + raw))
	return ID{hex.EncodeToString(m.Sum(nil)[:16])}
}

// Dropped counts events refused (bad name, id or property) or lost (queue full, after Close).
func (c *Client) Dropped() uint64 { return c.dropped.Load() }

// Failed counts batches PostHog did not accept (network error, timeout, non-2xx). Their events are gone.
func (c *Client) Failed() uint64 { return c.failed.Load() }

// Sent counts events in batches PostHog accepted.
func (c *Client) Sent() uint64 { return c.sent.Load() }

func (c *Client) drop(ev Event, why string) bool {
	c.dropped.Add(1)
	slog.Debug("analytics event dropped", "event_ok", events[ev], "why", why) // never the values
	return false
}

// check validates one property against the schema and returns the value to send.
func check(k string, v any) (any, bool) {
	r, ok := schema[k]
	if !ok {
		return nil, false
	}
	switch r.k {
	case kHash:
		id, ok := v.(ID)
		return id.h, ok && !id.zero()
	case kBool:
		b, ok := v.(bool)
		return b, ok
	case kCount:
		var n int64
		switch x := v.(type) {
		case int:
			n = int64(x)
		case int32:
			n = int64(x)
		case int64:
			n = x
		default:
			return nil, false
		}
		return n, n >= 0 && n <= 1_000_000
	case kEnum:
		s, ok := v.(string)
		return s, ok && r.enum[s]
	}
	return nil, false
}

// Capture queues one event and returns at once. It returns false (and sends nothing) when analytics is off, the event
// or a property is not allowed, the id is not an ID, or the queue is full.
func (c *Client) Capture(ev Event, who ID, props Props) bool {
	if c == nil {
		return false
	}
	if c.closed.Load() {
		return c.drop(ev, "closed")
	}
	if !events[ev] {
		return c.drop(ev, "event")
	}
	if who.zero() {
		return c.drop(ev, "id")
	}
	p := make(map[string]any, len(props)+3)
	for k, v := range props {
		val, ok := check(k, v)
		if !ok {
			return c.drop(ev, "property")
		}
		p[k] = val
	}
	p["$geoip_disable"] = true
	p["$process_person_profile"] = false
	p["$lib"] = "botlink-server"
	it := item{Event: string(ev), DistinctID: who.h, Timestamp: time.Now().UTC().Format(time.RFC3339Nano), UUID: uuid4(), Properties: p}
	select {
	case c.q <- it:
		return true
	default:
		return c.drop(ev, "queue full")
	}
}

func uuid4() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

func (c *Client) run() {
	defer close(c.done)
	t := time.NewTicker(c.cfg.FlushEvery)
	defer t.Stop()
	batch := make([]item, 0, c.cfg.BatchSize)
	flush := func(ctx context.Context) {
		if len(batch) > 0 {
			c.send(ctx, batch)
			batch = batch[:0]
		}
	}
	for {
		select {
		case it := <-c.q:
			batch = append(batch, it)
			if len(batch) >= c.cfg.BatchSize {
				flush(context.Background())
			}
		case <-t.C:
			flush(context.Background())
		case <-c.stop:
			ctx := context.Background()
			if p := c.flushCtx.Load(); p != nil {
				ctx = *p
			}
			for {
				select {
				case it := <-c.q:
					batch = append(batch, it)
					if len(batch) >= c.cfg.BatchSize {
						flush(ctx)
					}
					continue
				default:
				}
				break
			}
			flush(ctx)
			return
		}
	}
}

func (c *Client) send(ctx context.Context, batch []item) {
	if ctx.Err() != nil {
		c.failed.Add(1)
		c.dropped.Add(uint64(len(batch)))
		return
	}
	body, err := json.Marshal(map[string]any{"api_key": c.cfg.Key, "historical_migration": false, "batch": batch})
	if err != nil {
		c.failed.Add(1)
		return
	}
	ctx, cancel := context.WithTimeout(ctx, c.cfg.Timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.url, bytes.NewReader(body))
	if err != nil {
		c.failed.Add(1)
		return
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := c.http.Do(req)
	if err != nil {
		c.failed.Add(1)
		c.dropped.Add(uint64(len(batch)))
		slog.Info("analytics batch dropped", "events", len(batch), "why", "network") // the error text can hold the URL
		return
	}
	res.Body.Close()
	if res.StatusCode/100 != 2 {
		c.failed.Add(1)
		c.dropped.Add(uint64(len(batch)))
		slog.Info("analytics batch dropped", "events", len(batch), "status", res.StatusCode)
		return
	}
	c.sent.Add(uint64(len(batch)))
}

// Close stops taking events, sends what is queued within ctx, and returns by ctx's deadline at the latest. Idempotent.
func (c *Client) Close(ctx context.Context) {
	if c == nil {
		return
	}
	c.closeOnce.Do(func() {
		c.closed.Store(true)
		c.flushCtx.Store(&ctx)
		close(c.stop)
	})
	select {
	case <-c.done:
	case <-ctx.Done():
	}
}
