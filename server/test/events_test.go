package test

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/charles161/botlink/server/internal/config"
	"github.com/charles161/botlink/server/internal/events"
	"github.com/charles161/botlink/server/internal/wire"
)

// bot-link Events (SPEC §6.13): MCP Events webhook mode. A receiver that checks every message the way a real one
// must (Standard Webhooks signature, timestamp), echoes the verification challenge, and records events.

type evtMsg struct {
	id, sub string
	body    map[string]any
	raw     string
}

type evtReceiver struct {
	t       testing.TB
	srv     *httptest.Server
	mu      sync.Mutex
	secrets [][]byte // any of these may sign
	got     []evtMsg
	ctrl    []evtMsg // control messages (verification)
	badSig  int
	status  int  // answer for events (0 = 204)
	noEcho  bool // answer the challenge with 200 but don't echo it
}

func newEvtReceiver(t testing.TB, secret string) *evtReceiver {
	raw, err := events.DecodeSecret(secret)
	if err != nil {
		t.Fatal(err)
	}
	r := &evtReceiver{t: t, secrets: [][]byte{raw}}
	r.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		body, _ := io.ReadAll(req.Body)
		r.mu.Lock()
		defer r.mu.Unlock()
		ok := false
		for _, k := range r.secrets {
			if events.Verify(k, req.Header.Get("webhook-id"), req.Header.Get("webhook-timestamp"), req.Header.Get("webhook-signature"), body, time.Now()) == nil {
				ok = true
			}
		}
		if !ok {
			r.badSig++
			w.WriteHeader(401)
			return
		}
		var m map[string]any
		_ = json.Unmarshal(body, &m)
		msg := evtMsg{id: req.Header.Get("webhook-id"), sub: req.Header.Get("X-MCP-Subscription-Id"), body: m, raw: string(body)}
		if m["type"] == "verification" {
			r.ctrl = append(r.ctrl, msg)
			if r.noEcho {
				_, _ = w.Write([]byte(`{"challenge":"nope"}`))
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"challenge": m["challenge"]})
			return
		}
		if r.status != 0 {
			w.WriteHeader(r.status)
			return
		}
		r.got = append(r.got, msg)
		w.WriteHeader(204)
	}))
	t.Cleanup(r.srv.Close)
	return r
}

func (r *evtReceiver) events() []evtMsg {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]evtMsg(nil), r.got...)
}

func (r *evtReceiver) waitFor(n int) []evtMsg {
	r.t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if g := r.events(); len(g) >= n {
			return g
		}
		time.Sleep(20 * time.Millisecond)
	}
	r.t.Fatalf("wanted %d events, got %d", n, len(r.events()))
	return nil
}

func evReason(r *Resp) string {
	e, _ := r.J["error"].(map[string]any)
	d, _ := e["details"].(map[string]any)
	s, _ := d["reason"].(string)
	return s
}

func newSecret() string { return events.EncodeSecret(wire.RandBytes(32)) }

func noWorkers(c *config.Config) { c.DisablePushWorker = true }

func evLabel(t *testing.T, viewer *Agent, c *Copy, name string) string {
	t.Helper()
	ro := viewer.Do(c, "GET", "/api/v1/me/roster", nil)
	for _, m := range ro.J["members"].([]any) {
		mm := m.(map[string]any)
		if mm["name"] == name {
			return mm["turn_label"].(string)
		}
	}
	t.Fatalf("no member %s in %s", name, ro)
	return ""
}

func subState(t *testing.T, a *Agent, c *Copy, id string) map[string]any {
	t.Helper()
	l := a.Do(c, "GET", "/api/v1/me/events/subscriptions", nil)
	if l.Status != 200 {
		t.Fatal(l)
	}
	for _, s := range l.J["subscriptions"].([]any) {
		if sm := s.(map[string]any); sm["id"] == id {
			return sm
		}
	}
	return nil
}

// The whole wake path: subscribe (challenge handshake), a message → one signed, content-free event → the chat reads
// it → the room sees "wakes on its own".
func TestEventsWakePath(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A", allowLoopback)
	adam := NewPerson(t, c, "Adam")
	room := adam.CreateRoom("events")
	s := adam.Member(c, room, "s")
	svc := adam.Member(c, room, "svc")
	svc.Drain(c)
	secret := newSecret()
	rc := newEvtReceiver(t, secret)

	if l := evLabel(t, s, c, "svc"); l != "answers on its next turn" {
		t.Fatalf("label before: %s", l)
	}
	sub := svc.Do(c, "POST", "/api/v1/me/events/subscriptions", map[string]any{"name": "message.received", "url": rc.srv.URL + "/hook", "secret": secret})
	if sub.Status != 201 || sub.J["refreshed"] != false {
		t.Fatal(sub)
	}
	if _, has := sub.J["secret"]; has {
		t.Fatal("the caller's own secret must not be echoed")
	}
	sv := sub.J["subscription"].(map[string]any)
	subID := sv["id"].(string)
	if sv["state"] != "on" || !strings.HasPrefix(subID, "sub_") {
		t.Fatal(sub)
	}
	rc.mu.Lock()
	if len(rc.ctrl) != 1 || !strings.HasPrefix(rc.ctrl[0].id, "msg_verification_") || rc.ctrl[0].sub != subID || rc.badSig != 0 {
		t.Fatalf("verification: %+v bad %d", rc.ctrl, rc.badSig)
	}
	rc.mu.Unlock()
	// a subscription alone proves nothing: the label changes only once a wake was observed
	if l := evLabel(t, s, c, "svc"); l != "answers on its next turn" {
		t.Fatalf("label after subscribe: %s", l)
	}

	id, r := s.Send(c, svc)
	if r.Status != 201 {
		t.Fatal(r)
	}
	got := rc.waitFor(1)
	e := got[0]
	if e.sub != subID || e.body["name"] != "message.received" || e.body["eventId"] != e.id {
		t.Fatalf("event %+v", e)
	}
	if _, err := time.Parse(time.RFC3339, e.body["timestamp"].(string)); err != nil {
		t.Fatal(err)
	}
	for k := range e.body {
		if k != "eventId" && k != "name" && k != "timestamp" && k != "data" {
			t.Fatalf("event carries %q", k)
		}
	}
	data := e.body["data"].(map[string]any)
	for k := range data {
		switch k {
		case "subscription_id", "member", "room", "message_id", "from", "scope", "quiet", "waiting":
		default:
			t.Fatalf("event data carries %q", k)
		}
	}
	if data["message_id"] != id || data["member"].(map[string]any)["name"] != "svc" || data["from"].(map[string]any)["name"] != "s" ||
		data["room"].(map[string]any)["name"] != "events" || data["waiting"].(float64) != 1 || data["scope"] != "member" {
		t.Fatalf("event data %v", data)
	}
	// never the sealed text (the envelope's ciphertext isn't in the event either)
	if strings.Contains(e.raw, "ct") && strings.Contains(e.raw, "envelope") {
		t.Fatalf("event leaks the envelope: %s", e.raw)
	}

	// the chat reads it → observed idle wake → "wakes on its own"
	deadline := time.Now().Add(3 * time.Second)
	for count(t, c, `select count(*) from deliveries where message_id = $1 and wakes > 0`, id) == 0 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	lr := svc.Lease(c, 0)
	if len(deliveries(lr)) != 1 {
		t.Fatal(lr)
	}
	if a := svc.Do(c, "POST", "/api/v1/me/inbox/ack", map[string]any{"items": []map[string]any{{"message_id": id, "action": "shown"}}}); a.Status != 200 {
		t.Fatal(a)
	}
	if l := evLabel(t, s, c, "svc"); l != "wakes on its own" {
		t.Fatalf("label after an observed wake: %s", l)
	}
	if st := subState(t, svc, c, subID); st["state"] != "on" || st["last_ok_at"] == nil || strings.Contains(string(mustJSON(st)), "whsec_") {
		t.Fatalf("list: %v", st)
	}

	// unsubscribe: nothing more arrives, and the label falls back
	if d := svc.Do(c, "DELETE", "/api/v1/me/events/subscriptions/"+subID, nil); d.Status != 200 || d.J["removed"] != true {
		t.Fatal(d)
	}
	if d := svc.Do(c, "DELETE", "/api/v1/me/events/subscriptions/"+subID, nil); d.Status != 200 || d.J["removed"] != false {
		t.Fatal(d)
	}
	if _, r := s.Send(c, svc); r.Status != 201 {
		t.Fatal(r)
	}
	time.Sleep(300 * time.Millisecond)
	if n := len(rc.events()); n != 1 {
		t.Fatalf("events after unsubscribe: %d", n)
	}
	// (once its own turn is over: a chat that just made a call keeps its label for 3 minutes, critical fix L5)
	exec(t, c, `update members set last_seen_at = now() - interval '10 minutes', last_poll_at = now() - interval '10 minutes' where id = $1`, svc.ID)
	if l := evLabel(t, s, c, "svc"); l == "wakes on its own" {
		t.Fatalf("label after unsubscribe: %s", l)
	}
}

// Subscribing is refused unless the endpoint echoes the signed challenge; private addresses are refused outright.
func TestEventsVerificationAndGuards(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A", allowLoopback)
	adam := NewPerson(t, c, "Adam")
	room := adam.CreateRoom("guard")
	a := adam.Member(c, room, "a")
	b := adam.Member(c, room, "b")
	secret := newSecret()
	rc := newEvtReceiver(t, secret)
	post := func(who *Agent, body map[string]any) *Resp {
		return who.Do(c, "POST", "/api/v1/me/events/subscriptions", body)
	}
	// an endpoint that answers 200 without the challenge
	rc.noEcho = true
	if r := post(a, map[string]any{"name": "message.received", "url": rc.srv.URL, "secret": secret}); r.Code() != "event_verify_failed" || evReason(r) != "challenge_failed" {
		t.Fatal(r)
	}
	// an endpoint that can't check the signature (wrong secret on its side) answers 401
	rc.noEcho = false
	if r := post(a, map[string]any{"name": "message.received", "url": rc.srv.URL, "secret": newSecret()}); r.Code() != "event_verify_failed" || evReason(r) != "http_4xx" {
		t.Fatal(r)
	}
	if n := count(t, c, `select count(*) from event_subscriptions`); n != 0 {
		t.Fatalf("%d subscriptions after failed checks", n)
	}
	// bad input
	for _, bad := range []map[string]any{
		{"name": "message.sent", "url": rc.srv.URL, "secret": secret},
		{"name": "message.received", "url": rc.srv.URL, "secret": "hunter2"},
		{"name": "message.received", "url": rc.srv.URL, "secret": "whsec_c2hvcnQ="},
		{"name": "message.received", "url": rc.srv.URL, "secret": secret, "ttl_s": 10},
		{"name": "roster.changed", "url": rc.srv.URL, "secret": secret, "urgent_only": true},
		{"name": "message.received", "secret": secret},
		{"name": "message.received", "url": rc.srv.URL, "secret": secret, "extra": 1},
	} {
		if r := post(a, bad); r.Status != 400 {
			t.Fatalf("%v → %s", bad, r)
		}
	}
	for _, u := range []string{"ftp://example.com/x", "http://10.0.0.5/hook", "http://169.254.169.254/latest", "http://[fd00::1]/x", "https://user:pw@127.0.0.1/x",
		"http://[::1%25lo]:9/x", "http://[fe80::1%25eth0]/x", "http://[fd00::1%25eth0]/x", "HTTP://127.0.0.1:9/x", "HTTPS://example.com/x"} {
		if r := post(a, map[string]any{"name": "message.received", "url": u, "secret": secret}); r.Code() != "event_url_blocked" {
			t.Fatalf("%s → %s", u, r)
		}
	}
	// a name that doesn't resolve is "couldn't reach", not "not allowed"
	if r := post(a, map[string]any{"name": "message.received", "url": "http://no-such-host.invalid/x", "secret": secret}); r.Code() != "event_verify_failed" || evReason(r) != "connection" {
		t.Fatal(r)
	}
	// a secret without base64 padding is the same secret
	if r := post(a, map[string]any{"name": "message.received", "url": "http://10.0.0.5/x", "secret": strings.TrimRight(secret, "=")}); r.Code() != "event_url_blocked" {
		t.Fatal(r)
	}
	// bot-link makes the secret when the caller sends none: shown once, never listed
	r := post(a, map[string]any{"name": "roster.changed", "url": rc.srv.URL + "/made"})
	if r.Code() != "event_verify_failed" { // the receiver doesn't know that secret yet → 401 → refused (nothing stored)
		t.Fatal(r)
	}
	ok := post(a, map[string]any{"name": "message.received", "url": rc.srv.URL, "secret": secret})
	if ok.Status != 201 {
		t.Fatal(ok)
	}
	id := ok.J["subscription"].(map[string]any)["id"].(string)
	// another chat (session) of the same key can't manage or see it; another member can't remove it
	other := "sess-other"
	if r := doRaw(t, a.Req(c, "GET", "/api/v1/me/events/subscriptions", nil, &SignOpts{Session: &other})); r.Code() != "not_holder" {
		t.Fatal(r)
	}
	if r := b.Do(c, "DELETE", "/api/v1/me/events/subscriptions/"+id, nil); r.Status != 200 || r.J["removed"] != false {
		t.Fatal(r)
	}
	if subState(t, a, c, id) == nil || len(b.Do(c, "GET", "/api/v1/me/events/subscriptions", nil).J["subscriptions"].([]any)) != 0 {
		t.Fatal("subscriptions leak across members")
	}
	// the cap: 6 per member
	for i := 0; i < 5; i++ {
		if r := post(a, map[string]any{"name": "message.received", "url": rc.srv.URL + "/n" + string(rune('a'+i)), "secret": secret}); r.Status != 201 {
			t.Fatal(r)
		}
	}
	if r := post(a, map[string]any{"name": "message.received", "url": rc.srv.URL + "/seventh", "secret": secret}); r.Code() != "too_many_subscriptions" {
		t.Fatal(r)
	}
	// a refresh of an existing one is still fine at the cap
	if r := post(a, map[string]any{"name": "message.received", "url": rc.srv.URL, "secret": secret}); r.Status != 200 || r.J["refreshed"] != true {
		t.Fatal(r)
	}
}

// A copy of the server without the loopback switch (as in production) refuses loopback URLs.
func TestEventsLoopbackBlockedByDefault(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A")
	adam := NewPerson(t, c, "Adam")
	room := adam.CreateRoom("prod")
	a := adam.Member(c, room, "a")
	rc := newEvtReceiver(t, newSecret())
	if r := a.Do(c, "POST", "/api/v1/me/events/subscriptions", map[string]any{"name": "message.received", "url": rc.srv.URL}); r.Code() != "event_url_blocked" {
		t.Fatal(r)
	}
	rc.mu.Lock()
	defer rc.mu.Unlock()
	if len(rc.ctrl)+len(rc.got)+rc.badSig != 0 {
		t.Fatal("a blocked URL was contacted")
	}
}

// A test server's operator can name hosts whose endpoints skip the handshake (BOTLINK_EVENTS_NO_CHALLENGE_HOSTS, dev
// only): a trigger that can only answer 2xx is subscribed without being asked for the challenge, the answer says
// "unchecked", and events arrive. Every other host on the same server is still challenged.
func TestEventsNoChallengeHosts(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A", allowLoopback, func(cfg *config.Config) { cfg.EventsNoChallengeHosts = []string{"127.0.0.1"} })
	adam := NewPerson(t, c, "Adam")
	room := adam.CreateRoom("trigger")
	s := adam.Member(c, room, "s")
	svc := adam.Member(c, room, "svc")
	svc.Drain(c)
	secret := newSecret()
	rc := newEvtReceiver(t, secret)
	rc.noEcho = true // it would fail the handshake
	sub := svc.Do(c, "POST", "/api/v1/me/events/subscriptions", map[string]any{"name": "message.received", "url": rc.srv.URL + "/hook", "secret": secret})
	if sub.Status != 201 || sub.J["unchecked"] != true {
		t.Fatal(sub)
	}
	rc.mu.Lock()
	if len(rc.ctrl) != 0 {
		t.Fatalf("a no-challenge host was sent %d control messages", len(rc.ctrl))
	}
	rc.mu.Unlock()
	if _, r := s.Send(c, svc); r.Status != 201 {
		t.Fatal(r)
	}
	if ev := rc.waitFor(1); ev[0].body["name"] != "message.received" {
		t.Fatalf("%+v", ev)
	}
	// the same endpoint under a host name that is not on the list is challenged as always
	other := strings.Replace(rc.srv.URL, "127.0.0.1", "localhost", 1)
	if r := svc.Do(c, "POST", "/api/v1/me/events/subscriptions", map[string]any{"name": "message.received", "url": other + "/hook", "secret": secret}); r.Code() != "event_verify_failed" {
		t.Fatal(r)
	}
	// the list holds exact names only (and the server refuses to start with it outside dev: config.Load)
	if got := config.ParseHosts(" Hooks.Example.com , *.x.ai, a/b, , y.example:443"); len(got) != 1 || got[0] != "hooks.example.com" {
		t.Fatalf("%v", got)
	}
}

// What never wakes: a hello (intro), a quiet message for an urgent_only subscription, a message the chat already
// read, a moved member's old subscription. A refresh that replaces the secret signs with both for a while.
func TestEventsFilteringAndRefresh(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A", allowLoopback, noWorkers)
	ctx := context.Background()
	adam := NewPerson(t, c, "Adam")
	room := adam.CreateRoom("filter")
	s := adam.Member(c, room, "s")
	svc := adam.Member(c, room, "svc")
	svc.Drain(c)
	secret := newSecret()
	rc := newEvtReceiver(t, secret)
	sub := svc.Do(c, "POST", "/api/v1/me/events/subscriptions", map[string]any{"name": "message.received", "url": rc.srv.URL, "secret": secret, "urgent_only": true})
	if sub.Status != 201 {
		t.Fatal(sub)
	}
	subID := sub.J["subscription"].(map[string]any)["id"].(string)
	jobs := func() int { return count(t, c, `select count(*) from event_jobs`) }
	send := func(mod func(b map[string]any)) string {
		id := wire.NewV7().String()
		b := s.SendBody(id, false, []*Agent{svc}, nil)
		if mod != nil {
			mod(b)
		}
		if r := s.Do(c, "POST", "/api/v1/messages", b); r.Status != 201 {
			t.Fatal(r)
		}
		return id
	}
	send(func(b map[string]any) { b["quiet"] = true })
	send(func(b map[string]any) { b["intro"] = true; b["quiet"] = true })
	if jobs() != 0 {
		t.Fatalf("quiet / intro made %d jobs for an urgent_only subscription", jobs())
	}
	// read before the worker gets to it → skipped, no webhook
	id := send(nil)
	if jobs() != 1 {
		t.Fatalf("jobs %d", jobs())
	}
	lr := svc.Lease(c, 0)
	var items []map[string]any
	for _, d := range deliveries(lr) {
		items = append(items, map[string]any{"message_id": d["message_id"], "action": "shown"})
	}
	if a := svc.Do(c, "POST", "/api/v1/me/inbox/ack", map[string]any{"items": items}); a.Status != 200 {
		t.Fatal(a)
	}
	if n, err := c.S.Events.Once(ctx); err != nil || n != 1 {
		t.Fatal(n, err)
	}
	if len(rc.events()) != 0 || count(t, c, `select count(*) from event_jobs where done and not failed and message_id = $1`, id) != 1 {
		t.Fatal("a message the chat already read must not wake it")
	}
	// a copy the chat is reading right now (held, not yet acked): no wake now, looked at again when the hold ends
	idHeld := send(nil)
	if lr := svc.Lease(c, 0); len(deliveries(lr)) != 1 {
		t.Fatal(lr)
	}
	if n, err := c.S.Events.Once(ctx); err != nil || n != 1 {
		t.Fatal(n, err)
	}
	if len(rc.events()) != 0 || count(t, c, `select count(*) from event_jobs where message_id = $1 and not done and tries = 0 and next_attempt_at > now() + interval '60 seconds'`, idHeld) != 1 {
		t.Fatal("a held copy must defer its event, not send or drop it")
	}
	// the read never finished (the app died): the hold ends, the copy waits again, and now the event goes out
	exec(t, c, `update deliveries set lease_until = now() - interval '1 second' where message_id = $1`, idHeld)
	exec(t, c, `update event_jobs set next_attempt_at = now() where message_id = $1`, idHeld)
	if n, err := c.S.Events.Once(ctx); err != nil || n != 1 {
		t.Fatal(n, err)
	}
	if got := rc.events(); len(got) != 1 || got[0].body["data"].(map[string]any)["message_id"] != idHeld {
		t.Fatalf("after the hold ended: %d events", len(got))
	}
	rc.mu.Lock()
	rc.got = nil
	rc.mu.Unlock()
	if a := svc.Do(c, "POST", "/api/v1/me/inbox/ack", map[string]any{"items": []map[string]any{{"message_id": idHeld, "action": "shown"}}}); a.Status != 200 {
		t.Fatal(a)
	}
	// refresh with a new secret: the receiver still knows only the old one, and the event still verifies
	secret2 := newSecret()
	rf := svc.Do(c, "POST", "/api/v1/me/events/subscriptions", map[string]any{"name": "message.received", "url": rc.srv.URL, "secret": secret2, "urgent_only": true})
	if rf.Status != 200 || rf.J["refreshed"] != true || rf.J["subscription"].(map[string]any)["id"] != subID {
		t.Fatal(rf)
	}
	rc.mu.Lock()
	nctrl := len(rc.ctrl)
	rc.mu.Unlock()
	if nctrl != 1 {
		t.Fatalf("a refresh of a verified URL sent %d verifications", nctrl)
	}
	send(nil)
	if n, err := c.S.Events.Once(ctx); err != nil || n != 1 {
		t.Fatal(n, err)
	}
	if got := rc.events(); len(got) != 1 || rc.badSig != 0 {
		t.Fatalf("after refresh: %d events, %d bad signatures", len(got), rc.badSig)
	}
	// past the grace window only the new secret signs
	exec(t, c, `update event_subscriptions set prev_until = now() - interval '1 second'`)
	send(nil)
	if n, err := c.S.Events.Once(ctx); err != nil || n != 1 {
		t.Fatal(n, err)
	}
	if rc.badSig != 1 {
		t.Fatalf("the old secret still signs after the grace window (bad %d)", rc.badSig)
	}
	// the member moved to another chat (key epoch changed): the old chat's subscription is dead
	exec(t, c, `update event_jobs set done = true`)
	exec(t, c, `update members set key_epoch = key_epoch + 1 where id = $1`, svc.ID)
	before := jobs()
	send(nil)
	if jobs() != before {
		t.Fatal("a moved member's old subscription still gets events")
	}
	if l := svc.Do(c, "GET", "/api/v1/me/events/subscriptions", nil); len(l.J["subscriptions"].([]any)) != 0 {
		t.Fatalf("the new chat sees the old chat's subscriptions: %s", l)
	}
}

// An endpoint that keeps failing: retries with the same webhook-id, then the subscription turns off, the room sees
// "listener down", and subscribing again turns it back on. The message itself always stays in the inbox.
func TestEventsFailuresTurnOff(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A", allowLoopback, noWorkers)
	ctx := context.Background()
	adam := NewPerson(t, c, "Adam")
	room := adam.CreateRoom("fail")
	s := adam.Member(c, room, "s")
	svc := adam.Member(c, room, "svc")
	svc.Drain(c)
	secret := newSecret()
	rc := newEvtReceiver(t, secret)
	sub := svc.Do(c, "POST", "/api/v1/me/events/subscriptions", map[string]any{"name": "message.received", "url": rc.srv.URL, "secret": secret})
	if sub.Status != 201 {
		t.Fatal(sub)
	}
	subID := sub.J["subscription"].(map[string]any)["id"].(string)
	rc.mu.Lock()
	rc.status = 500
	rc.mu.Unlock()
	// an observed idle wake first, so the label below is about the endpoint, not about "never proven"
	exec(t, c, `update members set wake_verified_at = now() where id = $1`, svc.ID)
	exec(t, c, `update members set last_seen_at = now() - interval '10 minutes', last_poll_at = now() - interval '10 minutes' where id = $1`, svc.ID)
	if l := evLabel(t, s, c, "svc"); l != "wakes on its own" {
		t.Fatalf("label with a healthy subscription: %s", l)
	}
	var ids []string
	for i := 0; i < events.MaxFails; i++ {
		id, r := s.Send(c, svc)
		if r.Status != 201 {
			t.Fatal(r)
		}
		ids = append(ids, id)
		for try := 1; try <= events.MaxTries; try++ {
			exec(t, c, `update event_jobs set next_attempt_at = now() where message_id = $1 and not done`, id)
			if _, err := c.S.Events.Once(ctx); err != nil {
				t.Fatal(err)
			}
			if i == 0 && try == 1 {
				// the endpoint just started failing: still inside the 3 minutes a blip gets
				if l := evLabel(t, s, c, "svc"); l != "wakes on its own" {
					t.Fatalf("label right after the first failure: %s", l)
				}
				// it has been failing for 4 minutes (a laptop asleep, a tunnel gone): the room must say so now, long
				// before 3 events have run out of tries and the subscription turns off
				exec(t, c, `update event_subscriptions set failed_since = now() - interval '4 minutes' where id = $1`, subID)
				if l := evLabel(t, s, c, "svc"); l != "listener down" {
					t.Fatalf("label with an endpoint failing for 4 minutes: %s", l)
				}
				if st := subState(t, svc, c, subID); st["state"] != "on" {
					t.Fatalf("not off yet: %v", st)
				}
			}
		}
		if count(t, c, `select count(*) from event_jobs where message_id = $1 and done and failed and tries = $2 and last_error = 'http_5xx'`, id, events.MaxTries) != 1 {
			t.Fatalf("event %d not failed after %d tries", i, events.MaxTries)
		}
	}
	st := subState(t, svc, c, subID)
	if st["state"] != "off" || st["last_error"] != "http_5xx" || st["failed_since"] == nil {
		t.Fatalf("subscription after failures: %v", st)
	}
	if l := evLabel(t, s, c, "svc"); l != "listener down" {
		t.Fatalf("label: %s", l)
	}
	if count(t, c, `select count(*) from deliveries where message_id = any($1::uuid[]) and state = 'queued'`, ids) != len(ids) {
		t.Fatal("failed events must leave the messages waiting")
	}
	// off: no new jobs
	before := count(t, c, `select count(*) from event_jobs`)
	idOff, r := s.Send(c, svc)
	if r.Status != 201 {
		t.Fatal(r)
	}
	if count(t, c, `select count(*) from event_jobs`) != before {
		t.Fatal("an off subscription still gets jobs")
	}
	// a renewal while the endpoint is still dead proves nothing: it is refused (the endpoint must pass the check
	// again), the subscription stays off and the room keeps saying "listener down". Without this a receiver that
	// is alive behind a dead tunnel would wipe the failure state every 10 minutes.
	rc.mu.Lock()
	rc.noEcho = true
	rc.mu.Unlock()
	if r := svc.Do(c, "POST", "/api/v1/me/events/subscriptions", map[string]any{"name": "message.received", "url": rc.srv.URL, "secret": secret}); r.Code() != "event_verify_failed" {
		t.Fatalf("refresh of a failing subscription with a dead endpoint: %s", r)
	}
	if st := subState(t, svc, c, subID); st["state"] != "off" || st["failed_since"] == nil {
		t.Fatalf("a failed refresh changed the state: %v", st)
	}
	if l := evLabel(t, s, c, "svc"); l != "listener down" {
		t.Fatalf("label after a failed refresh: %s", l)
	}
	// nor does the other variant of the same dead URL slip in unchallenged (the URL is what is failing)
	if r := svc.Do(c, "POST", "/api/v1/me/events/subscriptions", map[string]any{"name": "message.received", "url": rc.srv.URL, "secret": secret, "urgent_only": true}); r.Code() != "event_verify_failed" {
		t.Fatalf("another variant on a failing URL: %s", r)
	}
	rc.mu.Lock()
	rc.noEcho = false
	nctrl := len(rc.ctrl)
	rc.mu.Unlock()
	// subscribing again with the endpoint back turns it on (after passing the check again), without a secret keeps
	// the endpoint's secret, and catches up: ONE event for what came while it was off (4 messages wait)
	rc.mu.Lock()
	rc.status = 0
	rc.mu.Unlock()
	re := svc.Do(c, "POST", "/api/v1/me/events/subscriptions", map[string]any{"name": "message.received", "url": rc.srv.URL})
	if re.Status != 200 || re.J["subscription"].(map[string]any)["state"] != "on" {
		t.Fatal(re)
	}
	if _, has := re.J["secret"]; has {
		t.Fatal("a refresh without a secret must keep the existing one, not make a new one")
	}
	if count(t, c, `select count(*) from event_subscriptions where id = $1 and prev_secret is null`, subID) != 1 {
		t.Fatal("the secret changed on a refresh that gave none")
	}
	rc.mu.Lock()
	if len(rc.ctrl) != nctrl+1 {
		t.Fatalf("re-enabling a failing subscription must pass the check again (%d verifications)", len(rc.ctrl)-nctrl)
	}
	rc.mu.Unlock()
	if n, err := c.S.Events.Once(ctx); err != nil || n != 1 {
		t.Fatal(n, err)
	}
	if got := rc.events(); len(got) != 1 || got[0].body["data"].(map[string]any)["message_id"] != idOff || got[0].body["data"].(map[string]any)["waiting"].(float64) != 4 || rc.badSig != 0 {
		t.Fatalf("catch-up after re-enable: %d events, %d bad signatures", len(got), rc.badSig)
	}
	if n, _ := c.S.Events.Once(ctx); n != 0 {
		t.Fatal("catch-up must be one event")
	}
	// a second refresh announces nothing again (that copy's event was accepted)
	if r := svc.Do(c, "POST", "/api/v1/me/events/subscriptions", map[string]any{"name": "message.received", "url": rc.srv.URL, "secret": secret}); r.Status != 200 {
		t.Fatal(r)
	}
	if n, _ := c.S.Events.Once(ctx); n != 0 {
		t.Fatal("a refresh re-announced a copy whose event was accepted")
	}
	rc.mu.Lock()
	rc.got = nil
	rc.mu.Unlock()
	// 410 ends the retries for that one event at once
	rc.mu.Lock()
	rc.status = 410
	rc.mu.Unlock()
	id, _ := s.Send(c, svc)
	if _, err := c.S.Events.Once(ctx); err != nil {
		t.Fatal(err)
	}
	if count(t, c, `select count(*) from event_jobs where message_id = $1 and done and failed and tries = 1`, id) != 1 {
		t.Fatal("410 must end the retries")
	}
	if st := subState(t, svc, c, subID); st["state"] != "on" || st["fails"].(float64) != 1 {
		t.Fatalf("one 410 turned the subscription off: %v", st)
	}
	// back to healthy
	rc.mu.Lock()
	rc.status = 0
	rc.mu.Unlock()
	id2, _ := s.Send(c, svc)
	if _, err := c.S.Events.Once(ctx); err != nil {
		t.Fatal(err)
	}
	got := rc.events()
	if len(got) != 1 || got[0].body["data"].(map[string]any)["message_id"] != id2 {
		t.Fatalf("events after recovery: %d", len(got))
	}
	if st := subState(t, svc, c, subID); st["fails"].(float64) != 0 || st["last_error"] != nil {
		t.Fatalf("a success must clear the failure state: %v", st)
	}
}

// roster.changed fires for a join; the wake test (self-test) arrives as an event from "bot-link", only when due.
func TestEventsRosterAndSelftest(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A", allowLoopback, noWorkers)
	ctx := context.Background()
	adam := NewPerson(t, c, "Adam")
	room := adam.CreateRoom("roster")
	a := adam.Member(c, room, "a")
	a.Drain(c)
	secret := newSecret()
	rc := newEvtReceiver(t, secret)
	for _, name := range []string{"roster.changed", "message.received"} {
		if r := a.Do(c, "POST", "/api/v1/me/events/subscriptions", map[string]any{"name": name, "url": rc.srv.URL, "secret": secret}); r.Status != 201 {
			t.Fatal(r)
		}
	}
	rc.mu.Lock()
	if len(rc.ctrl) != 1 {
		t.Fatalf("one URL verified %d times", len(rc.ctrl))
	}
	rc.mu.Unlock()
	adam.Member(c, room, "b") // a join
	if _, err := c.S.Events.Once(ctx); err != nil {
		t.Fatal(err)
	}
	got := rc.events()
	if len(got) != 1 || got[0].body["name"] != "roster.changed" || got[0].body["data"].(map[string]any)["head_seq"] == nil {
		t.Fatalf("roster event: %+v", got)
	}
	// a second change while a's note about the first is still unread: another event (the open note is updated)
	adam.Member(c, room, "c2")
	if _, err := c.S.Events.Once(ctx); err != nil {
		t.Fatal(err)
	}
	if got := rc.events(); len(got) != 2 || got[1].body["name"] != "roster.changed" {
		t.Fatalf("second roster event: %d", len(got))
	}
	// the wake test, held back 2 s
	id := wire.NewV7().String()
	st := a.Do(c, "POST", "/api/v1/me/selftest", map[string]any{"id": id, "envelope": a.Envelope(id, "self", a.ID, a.FP(), nil, time.Now().Unix()+3600), "delay_s": 2})
	if st.Status != 201 {
		t.Fatal(st)
	}
	if n, _ := c.S.Events.Once(ctx); n != 0 {
		t.Fatal("the wake test's event went out before it was due")
	}
	time.Sleep(2100 * time.Millisecond)
	if n, err := c.S.Events.Once(ctx); err != nil || n != 1 {
		t.Fatal(n, err)
	}
	got = rc.events()
	d := got[len(got)-1].body["data"].(map[string]any)
	if len(got) != 3 || d["self_test"] != true || d["from"].(map[string]any)["name"] != "bot-link" || d["scope"] != "self" {
		t.Fatalf("self-test event: %v", d)
	}
}

// Several subscriptions on one member: every one gets the event, and the copy's wake counter stays at 1, so accepted
// events can never push a healthy message to "stuck" (5 wakes, SPEC §6.6).
func TestEventsManySubscriptionsNeverStuck(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A", allowLoopback, noWorkers)
	ctx := context.Background()
	adam := NewPerson(t, c, "Adam")
	room := adam.CreateRoom("many")
	s := adam.Member(c, room, "s")
	svc := adam.Member(c, room, "svc")
	svc.Drain(c)
	secret := newSecret()
	rc := newEvtReceiver(t, secret)
	for i := 0; i < 6; i++ {
		if r := svc.Do(c, "POST", "/api/v1/me/events/subscriptions", map[string]any{"name": "message.received", "url": rc.srv.URL + "/u" + string(rune('a'+i)), "secret": secret}); r.Status != 201 {
			t.Fatal(r)
		}
	}
	id, r := s.Send(c, svc)
	if r.Status != 201 {
		t.Fatal(r)
	}
	// each subscription has its own slot, at most 4 of one person's per batch: 4, then 2
	for i, want := range []int{4, 2, 0} {
		if n, err := c.S.Events.Once(ctx); err != nil || n != want {
			t.Fatal(i, n, err)
		}
	}
	if len(rc.events()) != 6 {
		t.Fatalf("%d events for 6 subscriptions", len(rc.events()))
	}
	if count(t, c, `select wakes from deliveries where message_id = $1`, id) != 1 {
		t.Fatal("6 accepted events must count one wake")
	}
	lr := svc.Lease(c, 0)
	if len(deliveries(lr)) != 1 || count(t, c, `select count(*) from deliveries where message_id = $1 and state = 'stuck'`, id) != 0 {
		t.Fatalf("the message must still be readable, not stuck: %s", lr)
	}
}

// Catch-up: a message that was already waiting when the chat subscribed (or re-armed a one-shot receiver) wakes it
// at once; without this the chat would sleep until the NEXT message.
func TestEventsCatchUpAtSubscribe(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A", allowLoopback, noWorkers)
	ctx := context.Background()
	adam := NewPerson(t, c, "Adam")
	room := adam.CreateRoom("catchup")
	s := adam.Member(c, room, "s")
	svc := adam.Member(c, room, "svc")
	svc.Drain(c)
	secret := newSecret()
	rc := newEvtReceiver(t, secret)
	// two messages and a hello arrive while nothing is subscribed
	s.Send(c, svc)
	id2, _ := s.Send(c, svc)
	hello := s.SendBody(wire.NewV7().String(), false, []*Agent{svc}, nil)
	hello["intro"], hello["quiet"] = true, true
	if r := s.Do(c, "POST", "/api/v1/messages", hello); r.Status != 201 {
		t.Fatal(r)
	}
	body := map[string]any{"name": "message.received", "url": rc.srv.URL, "secret": secret}
	sub := svc.Do(c, "POST", "/api/v1/me/events/subscriptions", body)
	if sub.Status != 201 {
		t.Fatal(sub)
	}
	subID := sub.J["subscription"].(map[string]any)["id"].(string)
	if n, err := c.S.Events.Once(ctx); err != nil || n != 1 {
		t.Fatal(n, err)
	}
	got := rc.events()
	if len(got) != 1 || got[0].body["data"].(map[string]any)["message_id"] != id2 || got[0].body["data"].(map[string]any)["waiting"].(float64) != 3 {
		t.Fatalf("catch-up: %+v", got)
	}
	// a one-shot receiver: it unsubscribes after the wake; a message lands before it re-arms; re-arming catches it
	if d := svc.Do(c, "DELETE", "/api/v1/me/events/subscriptions/"+subID, nil); d.Status != 200 {
		t.Fatal(d)
	}
	svc.Lease(c, 0) // (the woken chat read its inbox)
	exec(t, c, `update deliveries set state = 'shown', shown_at = now(), lease_until = null where member_id = $1 and state = 'queued'`, svc.ID)
	id3, _ := s.Send(c, svc)
	if count(t, c, `select count(*) from event_jobs where not done`) != 0 {
		t.Fatal("nothing is subscribed: no job")
	}
	if r := svc.Do(c, "POST", "/api/v1/me/events/subscriptions", body); r.Status != 201 {
		t.Fatal(r)
	}
	if n, err := c.S.Events.Once(ctx); err != nil || n != 1 {
		t.Fatal(n, err)
	}
	got = rc.events()
	if len(got) != 2 || got[1].body["data"].(map[string]any)["message_id"] != id3 || got[1].body["data"].(map[string]any)["waiting"].(float64) != 1 {
		t.Fatalf("re-arm catch-up: %d events", len(got))
	}
	// only a hello waits: no catch-up (hellos never wake anybody)
	if d := svc.Do(c, "DELETE", "/api/v1/me/events/subscriptions/"+subID, nil); d.Status != 200 {
		t.Fatal(d)
	}
	exec(t, c, `update deliveries set state = 'shown', shown_at = now() where member_id = $1 and message_id = $2`, svc.ID, id3)
	hello2 := s.SendBody(wire.NewV7().String(), false, []*Agent{svc}, nil)
	hello2["intro"], hello2["quiet"] = true, true
	if r := s.Do(c, "POST", "/api/v1/messages", hello2); r.Status != 201 {
		t.Fatal(r)
	}
	if r := svc.Do(c, "POST", "/api/v1/me/events/subscriptions", body); r.Status != 201 {
		t.Fatal(r)
	}
	if n, _ := c.S.Events.Once(ctx); n != 0 || len(rc.events()) != 2 {
		t.Fatal("a hello alone must not wake")
	}
	// an event that was dropped unsent (the subscription was off when it came due) announced nothing: re-enabling
	// must still catch up for that copy
	id5, _ := s.Send(c, svc)
	exec(t, c, `update event_subscriptions set disabled_at = now(), failed_since = now() where member_id = $1`, svc.ID)
	if n, err := c.S.Events.Once(ctx); err != nil || n != 1 || len(rc.events()) != 2 {
		t.Fatal("an off subscription's job must be dropped unsent", n, err)
	}
	if r := svc.Do(c, "POST", "/api/v1/me/events/subscriptions", body); r.Status != 200 {
		t.Fatal(r)
	}
	if n, err := c.S.Events.Once(ctx); err != nil || n != 1 {
		t.Fatal(n, err)
	}
	if got := rc.events(); len(got) != 3 || got[2].body["data"].(map[string]any)["message_id"] != id5 {
		t.Fatalf("catch-up after a dropped event: %d events", len(got))
	}
}

// Fairness: one person's backlog (or slow endpoint) takes one slot per batch, so another person's event never waits
// behind it.
func TestEventsOnePersonCannotStarveAnother(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A", allowLoopback, noWorkers)
	ctx := context.Background()
	secret := newSecret()
	rc := newEvtReceiver(t, secret)
	adam := NewPerson(t, c, "Adam")
	roomA := adam.CreateRoom("busy")
	sA := adam.Member(c, roomA, "s")
	svcA := adam.Member(c, roomA, "svc")
	bea := NewPerson(t, c, "Bea")
	roomB := bea.CreateRoom("quiet")
	sB := bea.Member(c, roomB, "s")
	svcB := bea.Member(c, roomB, "svc")
	for _, m := range []*Agent{svcA, svcB} {
		m.Drain(c)
		if r := m.Do(c, "POST", "/api/v1/me/events/subscriptions", map[string]any{"name": "message.received", "url": rc.srv.URL + "/" + m.ID, "secret": secret}); r.Status != 201 {
			t.Fatal(r)
		}
	}
	for i := 0; i < 5; i++ { // Adam's backlog first (lower job ids)
		if _, r := sA.Send(c, svcA); r.Status != 201 {
			t.Fatal(r)
		}
	}
	idB, r := sB.Send(c, svcB)
	if r.Status != 201 {
		t.Fatal(r)
	}
	if n, err := c.S.Events.Once(ctx); err != nil || n != 2 {
		t.Fatal(n, err)
	}
	got := rc.events()
	seenB := false
	for _, e := range got {
		if e.body["data"].(map[string]any)["message_id"] == idB {
			seenB = true
		}
	}
	if len(got) != 2 || !seenB {
		t.Fatalf("the first batch must carry one event per person (Bea's included): %d events, Bea's %v", len(got), seenB)
	}
	// a person's own dead endpoint doesn't hold up their healthy member: Adam's second member (its own subscription)
	// gets its event in the same batch as the backlog of the first
	svcA2 := adam.Member(c, roomA, "svc2")
	svcA2.Drain(c)
	svcA.Drain(c)
	exec(t, c, `update event_jobs set done = true where not done`)
	if r := svcA2.Do(c, "POST", "/api/v1/me/events/subscriptions", map[string]any{"name": "message.received", "url": rc.srv.URL + "/" + svcA2.ID, "secret": secret}); r.Status != 201 {
		t.Fatal(r)
	}
	for i := 0; i < 3; i++ {
		if _, r := sA.Send(c, svcA); r.Status != 201 {
			t.Fatal(r)
		}
	}
	id2, r2 := sA.Send(c, svcA2)
	if r2.Status != 201 {
		t.Fatal(r2)
	}
	rc.mu.Lock()
	rc.got = nil
	rc.mu.Unlock()
	if n, err := c.S.Events.Once(ctx); err != nil || n != 2 {
		t.Fatal(n, err)
	}
	seen2 := false
	for _, e := range rc.events() {
		if e.body["data"].(map[string]any)["message_id"] == id2 {
			seen2 = true
		}
	}
	if !seen2 {
		t.Fatal("a person's backlog on one member held up their other member's event")
	}
}

// Load sanity for the events worker (opt-in: BOTLINK_EVENTS_LOAD=1; real worker loop). Six people, three members
// each, every member subscribed. One person's endpoint is a tarpit (answers after 4 s). Measures what the others
// feel: how long until the FIRST event for each of their subscriptions (the wake) and until all their events.
func TestEventsLoadSanity(t *testing.T) {
	if os.Getenv("BOTLINK_EVENTS_LOAD") == "" {
		t.Skip("set BOTLINK_EVENTS_LOAD=1 to run")
	}
	c := StartCopy(t, NewDB(t), "A", allowLoopback)
	secret := newSecret()
	key, _ := events.DecodeSecret(secret)
	var mu sync.Mutex
	arrived := map[string]time.Time{} // message id → when its event reached a healthy endpoint
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		if events.Verify(key, r.Header.Get("webhook-id"), r.Header.Get("webhook-timestamp"), r.Header.Get("webhook-signature"), body, time.Now()) != nil {
			w.WriteHeader(401)
			return
		}
		var m map[string]any
		_ = json.Unmarshal(body, &m)
		if m["type"] == "verification" {
			_ = json.NewEncoder(w).Encode(map[string]any{"challenge": m["challenge"]})
			return
		}
		if strings.HasPrefix(r.URL.Path, "/slow/") {
			time.Sleep(4 * time.Second)
			w.WriteHeader(204)
			return
		}
		mu.Lock()
		if id, _ := m["data"].(map[string]any)["message_id"].(string); id != "" {
			if _, seen := arrived[id]; !seen {
				arrived[id] = time.Now()
			}
		}
		mu.Unlock()
		w.WriteHeader(204)
	}))
	defer srv.Close()
	const people, members, rounds = 6, 3, 5
	type target struct {
		from, to *Agent
		slow     bool
	}
	var targets []target
	for p := 0; p < people; p++ {
		person := NewPerson(t, c, fmt.Sprintf("P%d", p))
		room := person.CreateRoom(fmt.Sprintf("load%d", p))
		s := person.Member(c, room, "s")
		for i := 0; i < members; i++ {
			m := person.Member(c, room, fmt.Sprintf("m%d", i))
			m.Drain(c)
			path := "/ok/"
			if p == 0 {
				path = "/slow/"
			}
			if r := m.Do(c, "POST", "/api/v1/me/events/subscriptions", map[string]any{"name": "message.received", "url": srv.URL + path + m.ID, "secret": secret}); r.Status != 201 {
				t.Fatal(r)
			}
			targets = append(targets, target{s, m, p == 0})
		}
	}
	sent := map[string]time.Time{}
	sub := map[string]string{} // message id → recipient
	start := time.Now()
	for round := 0; round < rounds; round++ {
		for _, tg := range targets {
			id, r := tg.from.Send(c, tg.to)
			if r.Status != 201 {
				t.Fatal(r)
			}
			if !tg.slow {
				sent[id], sub[id] = time.Now(), tg.to.ID
			}
		}
	}
	want := len(sent)
	deadline := time.Now().Add(120 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		n := len(arrived)
		mu.Unlock()
		if n >= want {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	mu.Lock()
	defer mu.Unlock()
	first := map[string]time.Duration{} // per healthy subscription: its first event's latency
	var worst time.Duration
	for id, at := range arrived {
		lat := at.Sub(sent[id])
		if lat > worst {
			worst = lat
		}
		if f, ok := first[sub[id]]; !ok || lat < f {
			first[sub[id]] = lat
		}
	}
	var worstFirst time.Duration
	for _, f := range first {
		if f > worstFirst {
			worstFirst = f
		}
	}
	t.Logf("events load: %d people x %d members, %d rounds; 1 person's endpoint takes 4 s. Healthy events delivered %d/%d in %s; worst first-wake per subscription %s; worst event %s",
		people, members, rounds, len(arrived), want, time.Since(start).Round(100*time.Millisecond), worstFirst.Round(10*time.Millisecond), worst.Round(10*time.Millisecond))
	if len(arrived) != want {
		t.Fatalf("only %d of %d healthy events arrived in 120 s", len(arrived), want)
	}
	if worstFirst > 6*time.Second {
		t.Fatalf("a healthy subscription waited %s for its first wake behind someone else's slow endpoint", worstFirst)
	}
}

// The running loop's slots (the default workers, not Once): one person with six subscribed members and an endpoint
// that takes 300 ms. Never more than 4 of that person's events are going out at once, never two for one
// subscription at once, and all of them arrive.
func TestEventsSlotsPerPersonAndPerSubscription(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A", allowLoopback)
	secret := newSecret()
	key, _ := events.DecodeSecret(secret)
	var mu sync.Mutex
	inFlight, peak, got := 0, 0, 0
	perSub, peakSub := map[string]int{}, 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		if events.Verify(key, r.Header.Get("webhook-id"), r.Header.Get("webhook-timestamp"), r.Header.Get("webhook-signature"), body, time.Now()) != nil {
			w.WriteHeader(401)
			return
		}
		var m map[string]any
		_ = json.Unmarshal(body, &m)
		if m["type"] == "verification" {
			_ = json.NewEncoder(w).Encode(map[string]any{"challenge": m["challenge"]})
			return
		}
		sub := r.Header.Get("X-MCP-Subscription-Id")
		mu.Lock()
		inFlight++
		perSub[sub]++
		if inFlight > peak {
			peak = inFlight
		}
		if perSub[sub] > peakSub {
			peakSub = perSub[sub]
		}
		mu.Unlock()
		time.Sleep(300 * time.Millisecond)
		mu.Lock()
		inFlight--
		perSub[sub]--
		got++
		mu.Unlock()
		w.WriteHeader(204)
	}))
	defer srv.Close()
	adam := NewPerson(t, c, "Adam")
	room := adam.CreateRoom("slots")
	s := adam.Member(c, room, "s")
	var ms []*Agent
	for i := 0; i < 6; i++ {
		m := adam.Member(c, room, fmt.Sprintf("m%d", i))
		m.Drain(c)
		if r := m.Do(c, "POST", "/api/v1/me/events/subscriptions", map[string]any{"name": "message.received", "url": srv.URL + "/" + m.ID, "secret": secret}); r.Status != 201 {
			t.Fatal(r)
		}
		ms = append(ms, m)
	}
	const rounds = 3
	for round := 0; round < rounds; round++ {
		for _, m := range ms {
			if _, r := s.Send(c, m); r.Status != 201 {
				t.Fatal(r)
			}
		}
	}
	want := rounds * len(ms)
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		n := got
		mu.Unlock()
		if n >= want {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	mu.Lock()
	defer mu.Unlock()
	if got != want {
		t.Fatalf("%d of %d events arrived", got, want)
	}
	if peak > events.PersonSlots || peak < 2 {
		t.Fatalf("one person's events in flight at once: peak %d (must be 2..%d)", peak, events.PersonSlots)
	}
	if peakSub != 1 {
		t.Fatalf("two events for one subscription were going out at once (peak %d)", peakSub)
	}
}
