package test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/charles161/botlink/server/internal/config"
	"github.com/charles161/botlink/server/internal/wire"
)

// fakePostHog records every event the server sends to <host>/batch/.
type fakePostHog struct {
	mu     sync.Mutex
	raw    []string
	events []map[string]any
}

func (f *fakePostHog) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	b, _ := io.ReadAll(r.Body)
	var p struct {
		Batch []map[string]any `json:"batch"`
	}
	_ = json.Unmarshal(b, &p)
	f.mu.Lock()
	f.raw = append(f.raw, string(b))
	if r.URL.Path == "/batch/" {
		f.events = append(f.events, p.Batch...)
	}
	f.mu.Unlock()
	w.WriteHeader(200)
}

func (f *fakePostHog) names() map[string]int {
	f.mu.Lock()
	defer f.mu.Unlock()
	m := map[string]int{}
	for _, e := range f.events {
		m[e["event"].(string)]++
	}
	return m
}

// Every product event fires from its call site, once, with hashed ids only; nothing a person typed or is called leaves.
func TestAnalyticsEventsFromCallSites(t *testing.T) {
	fake := &fakePostHog{}
	ph := httptest.NewServer(fake)
	defer ph.Close()
	c := StartCopy(t, NewDB(t), "A", func(cfg *config.Config) {
		cfg.PostHogKey, cfg.PostHogHost, cfg.AnalyticsHashKey = "phc_test", ph.URL, "test-only-hash-key-0123456789abcdef0123"
	})
	if c.S.Analytics == nil {
		t.Fatal("analytics off")
	}
	adam := NewPerson(t, c, "Adam")          // account_created
	newPersonEmail(t, c, "Adam", adam.Email) // the same person signing in again in another browser: no event
	room := adam.CreateRoom("acme")          // room_created
	bug := adam.Member(c, room, "bugfix")    // join_requested + join_approved (chat)
	eve := NewPerson(t, c, "Eve")            // account_created
	addPerson(t, adam, eve, room)            // invite_made, join_requested + join_approved (person)
	ebot := eve.Member(c, room, "evebot")    // join_requested + join_approved (chat)

	if _, r := bug.Send(c, ebot); r.Status != 201 { // message_sent + first_message
		t.Fatalf("send: %s", r)
	}
	if _, r := ebot.Send(c, bug); r.Status != 201 { // message_sent only
		t.Fatalf("reply: %s", r)
	}

	// a rejected join
	stray := NewAgentKeys(t, "stray")
	if r := stray.Join(c, adam.Invite(room)); r.Status != 201 { // join_requested
		t.Fatalf("join: %s", r)
	}
	if r := adam.Do("POST", "/app/v1/join-requests/"+stray.ReqID+"/reject", nil); r.Status != 200 { // join_rejected
		t.Fatalf("reject: %s", r)
	}

	// wake tests: a self-test read by a woken run passes; the client's woken:false is a failed one
	ebot.Drain(c)
	id := wire.NewV7().String()
	if r := ebot.Do(c, "POST", "/api/v1/me/selftest", map[string]any{"id": id, "envelope": ebot.Envelope(id, "self", ebot.ID, ebot.FP(), nil, time.Now().Unix()+3600)}); r.Status != 201 {
		t.Fatalf("selftest: %s", r)
	}
	ebot.Lease(c, 0)
	if a := ebot.Do(c, "POST", "/api/v1/me/inbox/ack", map[string]any{"items": []any{map[string]any{"message_id": id, "action": "shown"}}, "woken": true}); a.Status != 200 {
		t.Fatalf("ack: %s", a)
	}
	if a := bug.Do(c, "POST", "/api/v1/me/inbox/ack", map[string]any{"items": []any{}, "woken": false}); a.Status != 200 {
		t.Fatalf("ack woken false: %s", a)
	}

	// a person removes a member
	adam.Sync(room)
	rm := room.Log.Build("member_remove", adam.Dev, map[string]any{"member": bug.ID})
	if r := adam.Do("POST", "/app/v1/rooms/"+room.ID+"/roster", map[string]any{"roster_entry": rm}); r.Status != 200 { // member_removed
		t.Fatalf("remove: %s", r)
	}

	// background look-ups (first message, wake test) finish within moments; then flush
	time.Sleep(500 * time.Millisecond)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c.S.Analytics.Close(ctx)

	want := map[string]int{"account_created": 2, "room_created": 1, "invite_made": 1, "join_requested": 4, "join_approved": 3,
		"join_rejected": 1, "message_sent": 2, "first_message": 1, "wake_test_passed": 1, "wake_test_failed": 1, "member_removed": 1}
	got := fake.names()
	for k, n := range want {
		if got[k] != n {
			t.Errorf("%s: %d events, want %d", k, got[k], n)
		}
	}
	for k := range got {
		if _, ok := want[k]; !ok {
			t.Errorf("unexpected event %s", k)
		}
	}
	raw := strings.Join(fake.raw, "\n")
	hex32 := regexp.MustCompile(`^[0-9a-f]{32}$`)
	for _, e := range fake.events {
		if !hex32.MatchString(e["distinct_id"].(string)) {
			t.Errorf("distinct_id %v", e["distinct_id"])
		}
		p := e["properties"].(map[string]any)
		if p["$geoip_disable"] != true || p["$process_person_profile"] != false {
			t.Errorf("%s: geoip / person profile not off: %v", e["event"], p)
		}
	}
	for _, bad := range []string{adam.Email, eve.Email, adam.AccountID, eve.AccountID, room.ID, "acme", bug.ID, ebot.ID, "bugfix",
		"evebot", "Adam", "Eve", "box", "~/acme", "127.0.0.1", "test job"} {
		if strings.Contains(raw, bad) {
			t.Errorf("%q left the server", bad)
		}
	}
}
