package analytics

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

const testHashKey = "0123456789abcdef0123456789abcdef-test-only"

// fake is a PostHog stand-in that records every /batch/ body.
type fake struct {
	mu     sync.Mutex
	bodies [][]byte
	paths  []string
	delay  time.Duration
}

func (f *fake) handler(w http.ResponseWriter, r *http.Request) {
	b, _ := io.ReadAll(r.Body)
	f.mu.Lock()
	f.bodies = append(f.bodies, b)
	f.paths = append(f.paths, r.Method+" "+r.URL.Path+" "+r.Header.Get("Content-Type"))
	f.mu.Unlock()
	if f.delay > 0 {
		select {
		case <-time.After(f.delay):
		case <-r.Context().Done():
		}
	}
	w.WriteHeader(200)
	_, _ = w.Write([]byte(`{"status":1}`))
}

func (f *fake) events(t *testing.T) []map[string]any {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []map[string]any
	for _, b := range f.bodies {
		var p struct {
			APIKey     string           `json:"api_key"`
			Historical *bool            `json:"historical_migration"`
			Batch      []map[string]any `json:"batch"`
		}
		if err := json.Unmarshal(b, &p); err != nil {
			t.Fatalf("batch body is not JSON: %s", b)
		}
		if p.APIKey != "phc_test" || p.Historical == nil || *p.Historical {
			t.Fatalf("batch envelope: %s", b)
		}
		out = append(out, p.Batch...)
	}
	return out
}

func (f *fake) raw() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	var s []string
	for _, b := range f.bodies {
		s = append(s, string(b))
	}
	return strings.Join(s, "\n")
}

func start(t *testing.T, f *fake, mods ...func(*Config)) *Client {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(f.handler))
	t.Cleanup(srv.Close)
	cfg := Config{Key: "phc_test", Host: srv.URL, HashKey: testHashKey}
	for _, m := range mods {
		m(&cfg)
	}
	c := New(cfg)
	if c == nil {
		t.Fatal("analytics off with a key and a hash key")
	}
	t.Cleanup(func() { c.Close(context.Background()) })
	return c
}

func closeNow(t *testing.T, c *Client) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c.Close(ctx)
}

func TestOffUnlessConfigured(t *testing.T) {
	for _, cfg := range []Config{{}, {Key: "phc_x"}, {HashKey: testHashKey}, {Key: "phc_x", HashKey: "short"}} {
		if c := New(cfg); c != nil {
			t.Errorf("analytics on with %+v", cfg)
		}
	}
	var c *Client // off: every call is a safe no-op
	if c.Enabled() || c.Capture(RoomCreated, c.ID("x"), nil) {
		t.Fatal("nil client captured")
	}
	if !c.ID("x").zero() {
		t.Fatal("nil client hashed an id")
	}
	c.Close(context.Background())
}

func TestPayloadShape(t *testing.T) {
	f := &fake{}
	c := start(t, f)
	room := "01933b6e-0000-7000-8000-00000000abcd"
	acct := "01933b6e-0000-7000-8000-00000000ef01"
	if !c.Capture(RoomCreated, c.ID(acct), Props{"room": c.ID(room)}) {
		t.Fatal("room_created refused")
	}
	if !c.Capture(MessageSent, c.ID(acct), Props{"room": c.ID(room), "scope": "member", "recipients": 3, "quiet": false, "app": "codex"}) {
		t.Fatal("message_sent refused")
	}
	closeNow(t, c)
	if len(f.paths) != 1 || f.paths[0] != "POST /batch/ application/json" {
		t.Fatalf("requests: %v", f.paths)
	}
	ev := f.events(t)
	if len(ev) != 2 {
		t.Fatalf("events: %v", ev)
	}
	e := ev[1]
	if e["event"] != "message_sent" {
		t.Errorf("event name: %v", e["event"])
	}
	id, _ := e["distinct_id"].(string)
	if len(id) != 32 || id != c.ID(acct).String() || strings.Contains(id, "ef01") {
		t.Errorf("distinct_id: %q", id)
	}
	if ts, _ := e["timestamp"].(string); ts == "" {
		t.Error("no timestamp")
	} else if _, err := time.Parse(time.RFC3339Nano, ts); err != nil {
		t.Errorf("timestamp %q: %v", ts, err)
	}
	p := e["properties"].(map[string]any)
	want := map[string]any{"room": c.ID(room).String(), "scope": "member", "recipients": 3.0, "quiet": false, "app": "codex",
		"$geoip_disable": true, "$process_person_profile": false, "$lib": "botlink-server"}
	for k, v := range want {
		if p[k] != v {
			t.Errorf("properties[%s] = %v, want %v", k, p[k], v)
		}
	}
	for k := range p {
		if _, ok := want[k]; !ok {
			t.Errorf("unexpected property %s", k)
		}
	}
	for k := range e {
		switch k {
		case "event", "distinct_id", "timestamp", "properties", "uuid":
		default:
			t.Errorf("unexpected event field %s", k)
		}
	}
	if strings.Contains(f.raw(), room) || strings.Contains(f.raw(), acct) {
		t.Error("a raw id left the server")
	}
}

// The heart of it: whatever a call site passes, a forbidden field never leaves the server. The whole event is dropped.
func TestForbiddenFieldsCannotBeSent(t *testing.T) {
	f := &fake{}
	c := start(t, f)
	who := c.ID("acct")
	secret := "bob@acme.dev"
	tries := []struct {
		name  string
		ev    Event
		props Props
	}{
		{"email", RoomCreated, Props{"email": secret}},
		{"domain", RoomCreated, Props{"domain": "acme.dev"}},
		{"room name", RoomCreated, Props{"room_name": "secret-launch"}},
		{"member name", JoinApproved, Props{"name": "bugfix"}},
		{"person", JoinApproved, Props{"person": "Bob Smith"}},
		{"text", MessageSent, Props{"text": "the deploy key is hunter2"}},
		{"ciphertext", MessageSent, Props{"envelope": "eyJ2IjoxfQ"}},
		{"ip", AccountCreated, Props{"$ip": "203.0.113.9"}},
		{"ip plain", AccountCreated, Props{"ip": "203.0.113.9"}},
		{"folder", JoinRequested, Props{"folder": "~/code/bobs-private-repo"}},
		{"machine", JoinRequested, Props{"machine": "bobs-macbook"}},
		{"geoip back on", RoomCreated, Props{"$geoip_disable": false}},
		{"person profile on", RoomCreated, Props{"$process_person_profile": true}},
		{"raw id as room", RoomCreated, Props{"room": "01933b6e-0000-7000-8000-00000000abcd"}},
		{"text in an allowed enum", JoinRequested, Props{"app": secret}},
		{"app name outside the list", JoinRequested, Props{"app": "opencode"}},
		{"text in a bool", MessageSent, Props{"quiet": "yes"}},
		{"text in a count", MessageSent, Props{"recipients": secret}},
		{"negative count", MessageSent, Props{"recipients": -1}},
		{"nested", MessageSent, Props{"recipients": map[string]any{"email": secret}}},
		{"list", MessageSent, Props{"room": []any{secret}}},
		{"unknown event", Event("email_" + secret), nil},
		{"empty event", Event(""), nil},
		{"zero id", RoomCreated, nil}, // who = ID{} below
		{"limit with text", LimitReached, Props{"limit": secret}},
		{"plan with text", PlanChanged, Props{"plan": secret}},
		{"plan outside the list", PlanChanged, Props{"plan": "enterprise"}},
		{"plan with an email", PlanChanged, Props{"plan": "pro", "email": secret}},
		{"plan with money", PlanChanged, Props{"plan": "pro", "usd_cents": 1500}},
		{"limit with a room name", LimitReached, Props{"limit": "rooms", "room_name": "secret-launch"}},
	}
	for _, tr := range tries {
		id := who
		if tr.name == "zero id" {
			id = ID{}
		}
		if c.Capture(tr.ev, id, tr.props) {
			t.Errorf("%s: accepted", tr.name)
		}
	}
	// and a good one, so we know the pipe works
	if !c.Capture(RoomCreated, who, Props{"room": c.ID("r")}) {
		t.Fatal("good event refused")
	}
	if !c.Capture(LimitReached, who, Props{"limit": "members", "count": 6}) || !c.Capture(PlanChanged, who, Props{"plan": "pro"}) {
		t.Fatal("good plan events refused")
	}
	closeNow(t, c)
	ev := f.events(t)
	if len(ev) != 3 || ev[0]["event"] != "room_created" || ev[1]["event"] != "limit_reached" || ev[2]["event"] != "plan_changed" {
		t.Fatalf("sent: %v", ev)
	}
	raw := f.raw()
	for _, bad := range []string{secret, "acme.dev", "secret-launch", "bugfix", "Bob Smith", "hunter2", "eyJ2IjoxfQ", "203.0.113.9",
		"bobs-private-repo", "bobs-macbook", "opencode", "00000000abcd"} {
		if strings.Contains(raw, bad) {
			t.Errorf("%q left the server: %s", bad, raw)
		}
	}
	if c.Dropped() != uint64(len(tries)) {
		t.Errorf("dropped = %d, want %d", c.Dropped(), len(tries))
	}
}

func TestIDIsKeyedHash(t *testing.T) {
	a := New(Config{Key: "phc_x", Host: "https://eu.i.posthog.com", HashKey: testHashKey})
	b := New(Config{Key: "phc_x", Host: "https://eu.i.posthog.com", HashKey: testHashKey + "-other"})
	defer a.Close(context.Background())
	defer b.Close(context.Background())
	x := "01933b6e-0000-7000-8000-000000000001"
	if a.ID(x) != a.ID(x) || a.ID(x) == a.ID(x+"2") {
		t.Fatal("not a stable function of the id")
	}
	if a.ID(x) == b.ID(x) {
		t.Fatal("not keyed")
	}
	if s := a.ID(x).String(); len(s) != 32 || strings.Contains(s, "0001") {
		t.Fatalf("hash: %s", s)
	}
	if !a.ID("").zero() {
		t.Fatal("an empty id hashed")
	}
}

// A slow endpoint never slows a caller: while the sender sits in a 2 s request to an endpoint that takes 10 s, Capture
// still returns at once (the bound below is loose for a loaded test box; a blocking Capture would wait seconds per
// call), extra events are dropped when the queue is full, and Close gives up at its deadline.
func TestSlowEndpointNeverBlocks(t *testing.T) {
	f := &fake{delay: 10 * time.Second}
	c := start(t, f, func(c *Config) {
		c.Timeout = 2 * time.Second
		c.QueueSize = 64
		c.BatchSize = 8
		c.FlushEvery = 10 * time.Millisecond
	})
	who := c.ID("a")
	t0 := time.Now()
	for i := 0; i < 5000; i++ {
		c.Capture(MessageSent, who, Props{"recipients": 1})
	}
	if d := time.Since(t0); d > 1500*time.Millisecond {
		t.Fatalf("5000 captures took %s", d)
	}
	if c.Dropped() == 0 {
		t.Fatal("a full queue dropped nothing")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 700*time.Millisecond)
	defer cancel()
	t0 = time.Now()
	c.Close(ctx)
	if d := time.Since(t0); d > 1500*time.Millisecond {
		t.Fatalf("Close took %s past its deadline", d)
	}
}

func TestDeadEndpointDropsQuietly(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := ln.Addr().String()
	ln.Close() // nothing listens here now
	c := New(Config{Key: "phc_test", Host: "http://" + addr, HashKey: testHashKey, Timeout: 200 * time.Millisecond, FlushEvery: 10 * time.Millisecond})
	t0 := time.Now()
	for i := 0; i < 100; i++ {
		if !c.Capture(RoomCreated, c.ID("a"), nil) {
			t.Fatal("refused while the queue has room")
		}
	}
	if d := time.Since(t0); d > time.Second {
		t.Fatalf("100 captures took %s", d)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	c.Close(ctx)
	if c.Failed() == 0 {
		t.Fatal("no failed batch recorded")
	}
	if c.Capture(RoomCreated, c.ID("a"), nil) {
		t.Fatal("captured after Close")
	}
}

func TestCloseFlushesQueued(t *testing.T) {
	f := &fake{}
	c := start(t, f, func(c *Config) { c.FlushEvery = time.Hour; c.BatchSize = 1000 })
	for i := 0; i < 7; i++ {
		c.Capture(JoinRequested, c.ID("a"), Props{"kind": "chat", "app": "claude-code"})
	}
	closeNow(t, c)
	if n := len(f.events(t)); n != 7 {
		t.Fatalf("flushed %d of 7", n)
	}
	c.Close(context.Background()) // twice is fine
}
