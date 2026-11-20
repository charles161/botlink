package test

// An event address a person approves (docs/protocol/event-url-approval.md). A routine's trigger answers 200 and
// nothing else, so it cannot echo bot-link's check value. The chat asks with approval: person; nothing is sent to the
// address until the member's person approves it on the dashboard with a passkey. Every test here counts the requests
// the address received: "nothing is sent before approval" is asserted from that count, never from reading code.

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/charles161/botlink/server/internal/config"
	"github.com/charles161/botlink/server/internal/events"
	"github.com/charles161/botlink/server/internal/sweeper"
)

// yesOnly is a routine's trigger: every request gets 200 {} and is recorded, whatever it is.
type yesOnly struct {
	t      testing.TB
	srv    *httptest.Server
	mu     sync.Mutex
	got    []evtMsg
	hdrs   []http.Header
	status int // 0: 200
}

func newYesOnly(t testing.TB) *yesOnly {
	y := &yesOnly{t: t}
	y.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		body, _ := io.ReadAll(req.Body)
		var m map[string]any
		_ = json.Unmarshal(body, &m)
		y.mu.Lock()
		y.got = append(y.got, evtMsg{id: req.Header.Get("webhook-id"), sub: req.Header.Get("X-MCP-Subscription-Id"), body: m, raw: string(body)})
		y.hdrs = append(y.hdrs, req.Header.Clone())
		st := y.status
		y.mu.Unlock()
		if st != 0 {
			w.WriteHeader(st)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte("{}"))
	}))
	t.Cleanup(y.srv.Close)
	return y
}

func (y *yesOnly) n() int {
	y.mu.Lock()
	defer y.mu.Unlock()
	return len(y.got)
}

func (y *yesOnly) all() ([]evtMsg, []http.Header) {
	y.mu.Lock()
	defer y.mu.Unlock()
	return append([]evtMsg(nil), y.got...), append([]http.Header(nil), y.hdrs...)
}

func (y *yesOnly) waitFor(n int) []evtMsg {
	y.t.Helper()
	for end := time.Now().Add(5 * time.Second); time.Now().Before(end); time.Sleep(20 * time.Millisecond) {
		if y.n() >= n {
			g, _ := y.all()
			return g
		}
	}
	y.t.Fatalf("the address got %d requests, wanted %d", y.n(), n)
	return nil
}

// never: the address got no request in a short while (the worker had time to send one).
func (y *yesOnly) never(what string) {
	y.t.Helper()
	time.Sleep(400 * time.Millisecond)
	if n := y.n(); n != 0 {
		g, _ := y.all()
		y.t.Fatalf("%s: the address got %d request(s) before any approval: %+v", what, n, g)
	}
}

func askPerson(a *Agent, c *Copy, url string, extra ...map[string]any) *Resp {
	body := map[string]any{"name": "message.received", "url": url, "approval": "person"}
	for _, e := range extra {
		for k, v := range e {
			body[k] = v
		}
	}
	return a.Do(c, "POST", "/api/v1/me/events/subscriptions", body)
}

func reqOf(r *Resp) map[string]any { m, _ := r.J["request"].(map[string]any); return m }
func reqID(r *Resp) string         { s, _ := reqOf(r)["id"].(string); return s }

func approveEventURL(p *Person, id string) *Resp {
	hc := p.Check("approve_event_url", id)
	return p.approveEventURLWith(id, hc)
}

func (p *Person) approveEventURLWith(id, hc string) *Resp {
	return p.Do("POST", "/app/v1/event-urls/"+id+"/approve", map[string]any{"human_check": map[string]any{"id": hc, "stub": true}})
}

func eventURLsOf(t *testing.T, p *Person) []map[string]any {
	t.Helper()
	ny := p.Do("GET", "/app/v1/needs-you", nil)
	if ny.Status != 200 {
		t.Fatal(ny)
	}
	l, ok := ny.J["event_urls"].([]any)
	if !ok {
		t.Fatalf("needs-you has no event_urls: %s", ny)
	}
	out := []map[string]any{}
	for _, x := range l {
		out = append(out, x.(map[string]any))
	}
	return out
}

func checkUsed(t *testing.T, c *Copy, id string) bool {
	t.Helper()
	return count(t, c, `select count(*) from human_checks where id = $1 and used_at is not null`, id) == 1
}

func sweepEventURLs(t *testing.T, c *Copy) {
	t.Helper()
	conn, err := pgx.Connect(context.Background(), c.Pool.Config().ConnString())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(context.Background())
	if err := sweeper.Sweep(context.Background(), conn); err != nil {
		t.Fatal(err)
	}
}

// The whole path for a routine's trigger: ask → nothing sent, nothing made → the person sees the address and
// approves with a passkey step → the waiting message wakes the address (catch-up), a new one too, signed with the
// secret the chat was given, carrying no text.
func TestEventURLApprovalWakePath(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A", allowLoopback)
	adam := NewPerson(t, c, "Adam")
	room := adam.CreateRoom("routines")
	asker := adam.Member(c, room, "asker")
	routine := adam.Member(c, room, "routine")
	routine.Drain(c)
	y := newYesOnly(t)
	url := y.srv.URL + "/trigger?key=abc"

	// the dashboard hears of it at once (the "What needs you" list reloads on "changed")
	changed := dashChanged(t, adam)

	r := askPerson(routine, c, url)
	if r.Status != 202 {
		t.Fatalf("ask: %s", r)
	}
	rq := reqOf(r)
	id := reqID(r)
	if rq["status"] != "waiting" || rq["url"] != url || rq["name"] != "message.received" || rq["expires_at"] == nil {
		t.Fatalf("request: %s", r)
	}
	if r.Str("approve_url") != c.URL+"/approve-url/"+id {
		t.Fatalf("approve_url: %s", r)
	}
	secret, _ := r.J["secret"].(string)
	raw, err := events.DecodeSecret(secret)
	if err != nil {
		t.Fatalf("a request without a secret returns the one bot-link made: %s", r)
	}
	select {
	case <-changed:
	case <-time.After(3 * time.Second):
		t.Error("the person's dashboard was not told about the request")
	}
	// the same ask again: the same request, no secret again
	again := askPerson(routine, c, url)
	if again.Status != 200 || reqID(again) != id {
		t.Fatalf("ask again: %s", again)
	}
	if _, has := again.J["secret"]; has {
		t.Fatalf("the secret is returned once: %s", again)
	}
	if n := count(t, c, `select count(*) from event_subscriptions`); n != 0 {
		t.Fatalf("%d subscriptions before approval", n)
	}
	// a message now: no event job, nothing sent
	if _, s := asker.Send(c, routine); s.Status != 201 {
		t.Fatal(s)
	}
	if n := count(t, c, `select count(*) from event_jobs`); n != 0 {
		t.Fatalf("%d event jobs before approval", n)
	}
	y.never("ask, ask again, a message")

	// the chat lists its waiting request (never a secret)
	l := routine.Do(c, "GET", "/api/v1/me/events/subscriptions", nil)
	reqs, _ := l.J["requests"].([]any)
	if l.Status != 200 || len(reqs) != 1 || reqs[0].(map[string]any)["id"] != id || reqs[0].(map[string]any)["status"] != "waiting" ||
		strings.Contains(string(l.Body), "whsec_") {
		t.Fatalf("list: %s", l)
	}

	// the person sees it: which chat, which room, the host and the whole address
	cards := eventURLsOf(t, adam)
	if len(cards) != 1 {
		t.Fatalf("cards: %v", cards)
	}
	card := cards[0]
	if card["id"] != id || card["url"] != url || card["host"] != "127.0.0.1" || card["name"] != "message.received" ||
		card["member"].(map[string]any)["name"] != "routine" || card["member"].(map[string]any)["id"] != routine.ID ||
		card["room"].(map[string]any)["id"] != room.ID || card["room"].(map[string]any)["name"] != "routines" || card["urgent_only"] != false {
		t.Fatalf("card: %v", card)
	}
	if strings.Contains(string(mustJSON(card)), "whsec_") {
		t.Fatal("the card carries the secret")
	}

	ap := approveEventURL(adam, id)
	if ap.Status != 200 {
		t.Fatalf("approve: %s", ap)
	}
	sub := ap.J["subscription"].(map[string]any)
	if sub["approved_by"] != "person" || sub["state"] != "on" || sub["url"] != url || sub["id"] != events.SubscriptionID(routine.ID, url, "message.received", false) {
		t.Fatalf("subscription: %s", ap)
	}
	if strings.Contains(string(ap.Body), "whsec_") {
		t.Fatal("the approval answer carries the secret")
	}
	// the message that waited is announced (catch-up), signed with the chat's secret, no text
	got := y.waitFor(1)
	_, hdrs := y.all()
	e := got[0]
	if err := events.Verify(raw, hdrs[0].Get("webhook-id"), hdrs[0].Get("webhook-timestamp"), hdrs[0].Get("webhook-signature"), []byte(e.raw), time.Now()); err != nil {
		t.Fatalf("event signature: %v", err)
	}
	data := e.body["data"].(map[string]any)
	for k := range data {
		switch k {
		case "subscription_id", "member", "room", "message_id", "from", "scope", "quiet", "waiting":
		default:
			t.Fatalf("event data carries %q", k)
		}
	}
	if data["from"].(map[string]any)["name"] != "asker" || data["room"].(map[string]any)["name"] != "routines" {
		t.Fatalf("event: %v", data)
	}
	for k := range hdrs[0] {
		switch strings.ToLower(k) {
		case "webhook-id", "webhook-timestamp", "webhook-signature", "x-mcp-subscription-id", "user-agent", "content-type", "content-length", "accept-encoding":
		default:
			t.Errorf("event header %s", k)
		}
	}
	// a new message: one more event
	if _, s := asker.Send(c, routine); s.Status != 201 {
		t.Fatal(s)
	}
	y.waitFor(2)
	if len(eventURLsOf(t, adam)) != 0 {
		t.Fatal("an approved request still waits on the dashboard")
	}
	l = routine.Do(c, "GET", "/api/v1/me/events/subscriptions", nil)
	subs := l.J["subscriptions"].([]any)
	if len(subs) != 1 || subs[0].(map[string]any)["approved_by"] != "person" {
		t.Fatalf("list after approval: %s", l)
	}
	reqs = l.J["requests"].([]any)
	if len(reqs) != 1 || reqs[0].(map[string]any)["status"] != "approved" {
		t.Fatalf("the chat learns the outcome from its list: %s", l)
	}
	// the person sees their chat's approved address where the page shows how it listens
	d := adam.Do("GET", "/app/v1/members/"+routine.ID+"/event-urls", nil)
	au, _ := d.J["event_urls"].([]any)
	if d.Status != 200 || len(au) != 1 || au[0].(map[string]any)["subscription_id"] != sub["id"] || au[0].(map[string]any)["host"] != "127.0.0.1" ||
		au[0].(map[string]any)["failing"] != false || au[0].(map[string]any)["approved_at"] == nil || au[0].(map[string]any)["url"] != url {
		t.Fatalf("member's approved addresses: %s", d)
	}
}

// dashChanged opens the person's dashboard stream and reports the first "changed".
func dashChanged(t *testing.T, p *Person) <-chan struct{} {
	t.Helper()
	req, _ := http.NewRequest("GET", p.C.URL+"/app/v1/events", nil)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	req = req.WithContext(ctx)
	res, err := p.Client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	ch := make(chan struct{}, 1)
	ready := make(chan struct{})
	go func() {
		defer res.Body.Close()
		sc := bufio.NewScanner(res.Body)
		first := true
		for sc.Scan() {
			if first {
				close(ready)
				first = false
			}
			if strings.HasPrefix(sc.Text(), "event: changed") {
				ch <- struct{}{}
				return
			}
		}
	}()
	select {
	case <-ready:
	case <-time.After(3 * time.Second):
		t.Fatal("dashboard stream did not open")
	}
	return ch
}

// The rules of a request: name, the push guard at request time, the caps, withdraw.
func TestEventURLRequestRules(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A", allowLoopback)
	adam := NewPerson(t, c, "Adam")
	room := adam.CreateRoom("rules")
	a := adam.Member(c, room, "a")
	b := adam.Member(c, room, "b")
	y := newYesOnly(t)
	for _, bad := range []map[string]any{
		{"name": "roster.changed", "url": y.srv.URL, "approval": "person"}, // the card describes messages only
		{"name": "message.received", "url": y.srv.URL, "approval": "yes"},
		{"name": "message.received", "url": y.srv.URL, "approval": true},
	} {
		if r := a.Do(c, "POST", "/api/v1/me/events/subscriptions", bad); r.Status != 400 {
			t.Fatalf("%v → %s", bad, r)
		}
	}
	for _, u := range []string{"https://exämple.com/hook", "https://xn--80ak6aa92e.com/hook", "https://0x01010101/hook", "https://hooks.example.com./hook"} {
		exec(t, c, `delete from rate_counters`) // each refused ask counts (TestEventURLRefusedAsksCount)
		if r := askPerson(a, c, u); r.Code() != "event_url_blocked" || !strings.Contains(string(r.Body), "plain host") {
			t.Fatalf("%s: %s", u, r)
		}
	}
	for _, u := range []string{"http://10.0.0.5/hook", "http://169.254.169.254/latest", "https://user:pw@127.0.0.1/x", "http://[::1%25lo]:9/x", "ftp://example.com/x"} {
		if r := askPerson(a, c, u); r.Code() != "event_url_blocked" {
			t.Fatalf("%s → %s", u, r)
		}
	}
	if n := count(t, c, `select count(*) from event_url_requests`); n != 0 {
		t.Fatalf("%d requests after refused asks", n)
	}
	exec(t, c, `delete from rate_counters`) // the refused asks counted (each is an ask); start the caps afresh
	// 2 waiting per member
	r1, r2 := askPerson(a, c, y.srv.URL+"/1"), askPerson(a, c, y.srv.URL+"/2")
	if r1.Status != 202 || r2.Status != 202 {
		t.Fatalf("%s / %s", r1, r2)
	}
	if r := askPerson(a, c, y.srv.URL+"/3"); r.Status != 409 || r.Code() != "too_many_requests_waiting" {
		t.Fatalf("third waiting: %s", r)
	}
	// urgent_only is part of the key: another request, still capped
	if r := askPerson(a, c, y.srv.URL+"/1", map[string]any{"urgent_only": true}); r.Code() != "too_many_requests_waiting" {
		t.Fatalf("urgent variant: %s", r)
	}
	// withdraw: idempotent, own requests only
	if d := b.Do(c, "DELETE", "/api/v1/me/events/requests/"+reqID(r1), nil); d.Status != 200 || d.J["removed"] != false {
		t.Fatalf("another member withdraws: %s", d)
	}
	if d := a.Do(c, "DELETE", "/api/v1/me/events/requests/"+reqID(r1), nil); d.Status != 200 || d.J["removed"] != true {
		t.Fatalf("withdraw: %s", d)
	}
	if d := a.Do(c, "DELETE", "/api/v1/me/events/requests/"+reqID(r1), nil); d.Status != 200 || d.J["removed"] != false {
		t.Fatalf("withdraw again: %s", d)
	}
	if r := approveEventURL(adam, reqID(r1)); r.Status != 404 {
		t.Fatalf("approve a withdrawn request: %s", r)
	}
	// 6 asks per member per hour (a repeat counts)
	for i := 0; i < 6; i++ {
		if r := askPerson(b, c, y.srv.URL+"/b"); r.Status != 202 && r.Status != 200 {
			t.Fatalf("ask %d: %s", i+1, r)
		}
	}
	if r := askPerson(b, c, y.srv.URL+"/b"); r.Status != 429 {
		t.Fatalf("seventh ask in the hour: %s", r)
	}
	// 10 waiting per account: a and b hold 2 (a: /2 + one more), make 3 more members with 2 each, then one more
	if r := askPerson(a, c, y.srv.URL+"/4"); r.Status != 202 {
		t.Fatal(r)
	}
	for i := 0; i < 4; i++ {
		m := adam.Member(c, room, fmt.Sprintf("m%d", i))
		for k := 0; k < 2; k++ {
			r := askPerson(m, c, fmt.Sprintf("%s/m%d-%d", y.srv.URL, i, k))
			if i == 3 && k == 1 {
				if r.Status != 409 || r.Code() != "too_many_requests_waiting" {
					t.Fatalf("11th waiting in the account: %s", r)
				}
				continue
			}
			if r.Status != 202 {
				t.Fatalf("m%d ask %d: %s", i, k, r)
			}
		}
	}
	if n := count(t, c, `select count(*) from event_url_requests where status = 'waiting'`); n != 10 {
		t.Fatalf("%d waiting", n)
	}
	y.never("asks")
}

// Who can see and decide: only the member's person; another person in the room neither sees nor approves nor rejects
// it, and a refused approval spends the check. A chat has no route to approve. Expired and rejected requests send
// nothing, ever.
func TestEventURLWhoDecides(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A", allowLoopback)
	adam := NewPerson(t, c, "Adam")
	bea := NewPerson(t, c, "Bea")
	room := adam.CreateRoom("decide")
	addPerson(t, adam, bea, room)
	routine := adam.Member(c, room, "routine")
	beabot := bea.Member(c, ownRoom(bea, room), "beabot")
	y := newYesOnly(t)
	r := askPerson(routine, c, y.srv.URL+"/t")
	if r.Status != 202 {
		t.Fatal(r)
	}
	id := reqID(r)
	// Bea (another person of the room, the room's... not the member's person) sees nothing
	if l := eventURLsOf(t, bea); len(l) != 0 {
		t.Fatalf("Bea sees %v", l)
	}
	hc := bea.Check("approve_event_url", id)
	if ap := bea.approveEventURLWith(id, hc); ap.Status != 404 || ap.Code() != "not_found" {
		t.Fatalf("Bea approves: %s", ap)
	}
	if !checkUsed(t, c, hc) {
		t.Fatal("a refused approval left its check unused")
	}
	if rj := bea.Do("POST", "/app/v1/event-urls/"+id+"/reject", nil); rj.Status != 404 {
		t.Fatalf("Bea rejects: %s", rj)
	}
	// the chat (and any member key) has no route that approves
	for _, p := range []string{"/api/v1/event-urls/" + id + "/approve", "/api/v1/me/events/requests/" + id + "/approve"} {
		res, err := httpClient.Do(routine.Req(c, "POST", p, map[string]any{}, nil))
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if res.StatusCode != 404 && res.StatusCode != 405 {
			t.Fatalf("agent %s: %d", p, res.StatusCode)
		}
	}
	// the app route with a member's signature and no cookie: not signed in
	if ar := doRaw(t, routine.Req(c, "POST", "/app/v1/event-urls/"+id+"/approve", map[string]any{"human_check": map[string]any{"id": hc, "stub": true}}, nil)); ar.Status != 401 && ar.Status != 403 {
		t.Fatalf("agent on the app route: %s", ar)
	}
	_ = beabot
	// the check is bound: a check for another request, for a join, or used twice never approves
	r2 := askPerson(routine, c, y.srv.URL+"/t2")
	other := adam.Check("approve_event_url", reqID(r2))
	if ap := adam.approveEventURLWith(id, other); ap.Status != 403 || ap.Code() != "human_check_failed" {
		t.Fatalf("a check for another request: %s", ap)
	}
	joinCheck := adam.Check("approve_join", id)
	if ap := adam.approveEventURLWith(id, joinCheck); ap.Status != 403 || ap.Code() != "human_check_failed" {
		t.Fatalf("a join's check: %s", ap)
	}
	// an approve_event_url check never approves a join
	w := NewAgentKeys(t, "waiter")
	if jr := w.Join(c, adam.Invite(room)); jr.Status != 201 {
		t.Fatal(jr)
	}
	urlCheck := adam.Check("approve_event_url", w.ReqID)
	adam.Sync(room)
	e := room.Log.Build("member_add", adam.Dev, map[string]any{"member": newID(), "account": adam.AccountID, "name": "waiter", "app": "other", "ed": w.Key.Hex(), "x": fmt.Sprintf("%x", w.X)})
	if jr := adam.Do("POST", "/app/v1/join-requests/"+w.ReqID+"/approve", map[string]any{"human_check": map[string]any{"id": urlCheck, "stub": true}, "roster_entry": e}); jr.Status != 403 || jr.Code() != "human_check_failed" {
		t.Fatalf("an event address check approves a join: %s", jr)
	}
	hc1 := adam.Check("approve_event_url", id)
	if ap := adam.approveEventURLWith(id, hc1); ap.Status != 200 {
		t.Fatalf("approve: %s", ap)
	}
	if ap := adam.approveEventURLWith(id, hc1); ap.Status != 403 && ap.Status != 404 {
		t.Fatalf("the same check twice: %s", ap)
	}
	if n := count(t, c, `select count(*) from event_subscriptions`); n != 1 {
		t.Fatalf("%d subscriptions", n)
	}
	exec(t, c, `delete from event_subscriptions`)
	y.mu.Lock()
	y.got, y.hdrs = nil, nil
	y.mu.Unlock()

	// rejected: nothing sent, can't be approved afterwards
	if rj := adam.Do("POST", "/app/v1/event-urls/"+reqID(r2)+"/reject", nil); rj.Status != 204 {
		t.Fatalf("reject: %s", rj)
	}
	if rj := adam.Do("POST", "/app/v1/event-urls/"+reqID(r2)+"/reject", nil); rj.Status != 404 {
		t.Fatalf("reject again: %s", rj)
	}
	if ap := approveEventURL(adam, reqID(r2)); ap.Status != 404 {
		t.Fatalf("approve after reject: %s", ap)
	}
	// expired: off the dashboard, can't be approved, the sweeper deletes it
	r3 := askPerson(routine, c, y.srv.URL+"/t3")
	if r3.Status != 202 {
		t.Fatal(r3)
	}
	exec(t, c, `update event_url_requests set expires_at = now() - interval '1 second' where id = $1`, reqID(r3))
	if l := eventURLsOf(t, adam); len(l) != 0 {
		t.Fatalf("an expired request on the dashboard: %v", l)
	}
	hcx := adam.Check("approve_event_url", reqID(r3))
	if ap := adam.approveEventURLWith(reqID(r3), hcx); ap.Status != 404 {
		t.Fatalf("approve an expired request: %s", ap)
	}
	if !checkUsed(t, c, hcx) {
		t.Fatal("the check of a refused (expired) approval is unused")
	}
	sweepEventURLs(t, c)
	if n := count(t, c, `select count(*) from event_url_requests where id = $1`, reqID(r3)); n != 0 {
		t.Fatal("the sweeper kept an expired request")
	}
	if _, s := beabot.Send(c, routine); s.Status != 201 {
		t.Fatal(s)
	}
	y.never("rejected and expired requests")
}

// The address is checked by the push guard again at approval: one that now points somewhere blocked is refused and
// nothing is approved (here the server stops admitting loopback, as if the name now resolved to a private address).
func TestEventURLGuardAtApproval(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A", allowLoopback)
	adam := NewPerson(t, c, "Adam")
	room := adam.CreateRoom("guard")
	routine := adam.Member(c, room, "routine")
	y := newYesOnly(t)
	r := askPerson(routine, c, y.srv.URL+"/t")
	if r.Status != 202 {
		t.Fatal(r)
	}
	c.S.Pusher.AllowLoopback = false
	t.Cleanup(func() { c.S.Pusher.AllowLoopback = true })
	hc := adam.Check("approve_event_url", reqID(r))
	if ap := adam.approveEventURLWith(reqID(r), hc); ap.Status != 422 || ap.Code() != "event_url_blocked" {
		t.Fatalf("approve a blocked address: %s", ap)
	}
	if !checkUsed(t, c, hc) {
		t.Fatal("the check of a refused approval is unused")
	}
	if n := count(t, c, `select count(*) from event_subscriptions`); n != 0 {
		t.Fatalf("%d subscriptions after a refused approval", n)
	}
	if n := count(t, c, `select count(*) from event_url_requests where status = 'waiting'`); n != 1 {
		t.Fatal("a refused approval decided the request")
	}
	y.never("a blocked approval")
}

// An approved address never proved itself: once it fails, a refresh does not make it healthy (the chat asks again and
// the person approves again). A healthy one refreshes without approval; a lapsed one asks again. An approval covers
// its own key only: another variant on the same address still has to pass the check.
func TestEventURLFailingNeedsNewApproval(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A", allowLoopback)
	adam := NewPerson(t, c, "Adam")
	room := adam.CreateRoom("fail")
	asker := adam.Member(c, room, "asker")
	routine := adam.Member(c, room, "routine")
	routine.Drain(c)
	y := newYesOnly(t)
	url := y.srv.URL + "/t"
	r := askPerson(routine, c, url)
	secret := r.Str("secret")
	if ap := approveEventURL(adam, reqID(r)); ap.Status != 200 {
		t.Fatal(ap)
	}
	subID := events.SubscriptionID(routine.ID, url, "message.received", false)
	// healthy: a refresh (with or without approval: person) is a refresh, nothing sent to the address for it
	before := y.n()
	if rf := askPerson(routine, c, url); rf.Status != 200 || rf.J["refreshed"] != true || rf.J["subscription"].(map[string]any)["approved_by"] != "person" {
		t.Fatalf("refresh with approval: %s", rf)
	}
	if rf := routine.Do(c, "POST", "/api/v1/me/events/subscriptions", map[string]any{"name": "message.received", "url": url, "secret": secret}); rf.Status != 200 {
		t.Fatalf("plain refresh of a healthy approved address: %s", rf)
	}
	if y.n() != before {
		t.Fatal("a refresh sent something to the address")
	}
	if n := count(t, c, `select count(*) from event_url_requests where status = 'waiting'`); n != 0 {
		t.Fatal("a healthy refresh made a request")
	}
	// another variant on the approved address: the check is sent and fails (an approval is not a proof)
	if rv := routine.Do(c, "POST", "/api/v1/me/events/subscriptions", map[string]any{"name": "message.received", "url": url, "urgent_only": true, "secret": secret}); rv.Code() != "event_verify_failed" {
		t.Fatalf("another variant on an approved address: %s", rv)
	}
	// failing
	exec(t, c, `update event_subscriptions set failed_since = now() - interval '5 minutes', fails = 3, disabled_at = now(), last_error = 'http_5xx' where id = $1`, subID)
	if d := adam.Do("GET", "/app/v1/members/"+routine.ID+"/event-urls", nil); d.J["event_urls"].([]any)[0].(map[string]any)["failing"] != true {
		t.Fatalf("the person is not told it fails: %s", d)
	}
	if rf := routine.Do(c, "POST", "/api/v1/me/events/subscriptions", map[string]any{"name": "message.received", "url": url, "secret": secret}); rf.Code() != "event_verify_failed" {
		t.Fatalf("plain refresh of a failing approved address: %s", rf)
	}
	again := askPerson(routine, c, url)
	if again.Status != 202 {
		t.Fatalf("ask on a failing approved address: %s", again)
	}
	st := subState(t, routine, c, subID)
	if st["state"] != "off" || st["failed_since"] == nil {
		t.Fatalf("a refused refresh changed the failure state: %v", st)
	}
	if ap := approveEventURL(adam, reqID(again)); ap.Status != 200 {
		t.Fatal(ap)
	}
	st = subState(t, routine, c, subID)
	if st["state"] != "on" || st["failed_since"] != nil || st["fails"].(float64) != 0 {
		t.Fatalf("approved again: %v", st)
	}
	// the secret survives (the chat gave none and the subscription had one)
	if count(t, c, `select count(*) from event_subscriptions where id = $1 and prev_secret is null`, subID) != 1 {
		t.Fatal("a new approval replaced the secret")
	}
	// lapsed: a new request
	exec(t, c, `update event_subscriptions set expires_at = now() - interval '1 second' where id = $1`, subID)
	if rl := askPerson(routine, c, url); rl.Status != 202 {
		t.Fatalf("ask on a lapsed approved address: %s", rl)
	}
	_ = asker
}

// The person stops an approved address: the subscription goes, events stop. Nobody else can stop it.
func TestEventURLStop(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A", allowLoopback)
	adam := NewPerson(t, c, "Adam")
	bea := NewPerson(t, c, "Bea")
	room := adam.CreateRoom("stop")
	addPerson(t, adam, bea, room)
	asker := adam.Member(c, room, "asker")
	routine := adam.Member(c, room, "routine")
	routine.Drain(c)
	y := newYesOnly(t)
	url := y.srv.URL + "/t"
	if ap := approveEventURL(adam, reqID(askPerson(routine, c, url))); ap.Status != 200 {
		t.Fatal(ap)
	}
	subID := events.SubscriptionID(routine.ID, url, "message.received", false)
	if _, s := asker.Send(c, routine); s.Status != 201 {
		t.Fatal(s)
	}
	y.waitFor(1)
	stop := "/app/v1/members/" + routine.ID + "/event-urls/" + subID + "/stop"
	if r := bea.Do("POST", stop, nil); r.Status != 404 {
		t.Fatalf("Bea stops it: %s", r)
	}
	if d := bea.Do("GET", "/app/v1/members/"+routine.ID+"/event-urls", nil); d.Status != 404 || d.Code() != "not_found" {
		t.Fatalf("Bea sees Adam's chat's addresses: %s", d)
	}
	if r := adam.Do("POST", stop, nil); r.Status != 204 {
		t.Fatalf("stop: %s", r)
	}
	if r := adam.Do("POST", stop, nil); r.Status != 204 {
		t.Fatalf("stop again: %s", r)
	}
	if n := count(t, c, `select count(*) from event_subscriptions`); n != 0 {
		t.Fatal("stopped, still there")
	}
	n := y.n()
	if _, s := asker.Send(c, routine); s.Status != 201 {
		t.Fatal(s)
	}
	time.Sleep(400 * time.Millisecond)
	if y.n() != n {
		t.Fatal("events after stop")
	}
	// the chat's refresh after stop asks again
	if r := askPerson(routine, c, url); r.Status != 202 {
		t.Fatalf("refresh after stop: %s", r)
	}
	// a subscription the address proved itself is not one Stop is for
	secret := newSecret()
	rc := newEvtReceiver(t, secret)
	s := routine.Do(c, "POST", "/api/v1/me/events/subscriptions", map[string]any{"name": "message.received", "url": rc.srv.URL, "secret": secret})
	if s.Status != 201 {
		t.Fatalf("proven subscribe: %s", s)
	}
	proven := s.J["subscription"].(map[string]any)["id"].(string)
	if r := adam.Do("POST", "/app/v1/members/"+routine.ID+"/event-urls/"+proven+"/stop", nil); r.Status != 404 {
		t.Fatalf("Stop of a proven subscription: %s", r)
	}
	if count(t, c, `select count(*) from event_subscriptions where id = $1`, proven) != 1 {
		t.Fatal("Stop removed a subscription the address proved itself")
	}
}

// After the person pressed Stop, or turned a request down, bot-link sends that address nothing for 24 hours, not even
// the check a plain subscribe sends (security review of fix-eventurl, 17 Nov 2026: three plain subscribes after Stop
// gave a routine's trigger three more requests). Asking the person again stays possible: it sends nothing.
func TestEventURLStoppedOrTurnedDownGetsNoCheck(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A", allowLoopback, noWait)
	adam := NewPerson(t, c, "Adam")
	room := adam.CreateRoom("stopped")
	routine := adam.Member(c, room, "routine")
	y := newYesOnly(t)
	url := y.srv.URL + "/t?key=abc"
	r := askPerson(routine, c, url)
	secret := r.Str("secret")
	if ap := approveEventURL(adam, reqID(r)); ap.Status != 200 {
		t.Fatal(ap)
	}
	sub := events.SubscriptionID(routine.ID, url, "message.received", false)
	if st := adam.Do("POST", "/app/v1/members/"+routine.ID+"/event-urls/"+sub+"/stop", nil); st.Status != 204 {
		t.Fatal(st)
	}
	before := y.n()
	plain := func(u string, extra map[string]any) *Resp {
		body := map[string]any{"name": "message.received", "url": u, "secret": secret}
		for k, v := range extra {
			body[k] = v
		}
		return routine.Do(c, "POST", "/api/v1/me/events/subscriptions", body)
	}
	for i, tc := range []struct {
		u     string
		extra map[string]any
	}{
		{url, nil}, {url, nil}, {url, map[string]any{"urgent_only": true}}, {url, map[string]any{"name": "roster.changed"}},
		{y.srv.URL + "/t?key=other", nil}, {y.srv.URL + "/t", nil},
	} {
		got := plain(tc.u, tc.extra)
		if got.Status != 409 || got.Code() != "stopped_by_person" {
			t.Fatalf("plain subscribe %d (%s %v) after Stop: %s", i, tc.u, tc.extra, got)
		}
	}
	if n := y.n(); n != before {
		t.Fatalf("after Stop the address got %d more request(s)", n-before)
	}
	// asking the person again sends nothing and is allowed
	again := askPerson(routine, c, url)
	if again.Status != 202 {
		t.Fatalf("ask after Stop: %s", again)
	}
	// turned down: the same
	if rj := adam.Do("POST", "/app/v1/event-urls/"+reqID(again)+"/reject", nil); rj.Status != 204 {
		t.Fatal(rj)
	}
	exec(t, c, `delete from event_url_refusals where reason = 'stopped'`)
	if got := plain(url, nil); got.Code() != "stopped_by_person" {
		t.Fatalf("plain subscribe after a turn-down: %s", got)
	}
	if n := y.n(); n != before {
		t.Fatalf("after a turn-down the address got %d more request(s)", n-before)
	}
	// export carries the refusal; 24 hours later the check goes out again (and fails: it can only say yes)
	ex := adam.Do("GET", "/app/v1/me/export", nil)
	if l, _ := ex.J["wake"].(map[string]any)["event_url_refusals"].([]any); len(l) != 1 || l[0].(map[string]any)["reason"] != "rejected" {
		t.Fatalf("export: %s", ex)
	}
	exec(t, c, `update event_url_refusals set until = now() - interval '1 second'`)
	if got := plain(url, nil); got.Code() != "event_verify_failed" || y.n() != before+1 {
		t.Fatalf("plain subscribe 24 hours later: %s (%d requests)", got, y.n()-before)
	}
	sweepEventURLs(t, c)
	if n := count(t, c, `select count(*) from event_url_refusals`); n != 0 {
		t.Fatalf("the sweeper kept %d lapsed refusal(s)", n)
	}
	// a new approval lifts it
	exec(t, c, `delete from rate_counters`)
	r3 := askPerson(routine, c, url)
	if rj := adam.Do("POST", "/app/v1/event-urls/"+reqID(r3)+"/reject", nil); rj.Status != 204 {
		t.Fatal(rj)
	}
	r4 := askPerson(routine, c, url)
	if ap := approveEventURL(adam, reqID(r4)); ap.Status != 200 {
		t.Fatal(ap)
	}
	if n := count(t, c, `select count(*) from event_url_refusals`); n != 0 {
		t.Fatal("an approval left the refusal in place")
	}
	// account delete clears it
	if rj := adam.Do("POST", "/app/v1/members/"+routine.ID+"/event-urls/"+sub+"/stop", nil); rj.Status != 204 {
		t.Fatal(rj)
	}
	askDelete(t, adam)
	adam.Sync(room)
	if d := adam.Do("POST", "/app/v1/me/delete", deleteBody(adam.Email, adam.Check("account_delete", ""))); d.Status != 200 {
		t.Fatalf("delete: %s", d)
	}
	if n := count(t, c, `select count(*) from event_url_refusals`); n != 0 {
		t.Fatalf("%d refusal(s) left after account delete", n)
	}
}

// A refused ask is still an ask: it counts toward the 6 an hour, whatever refused it (security review: a host refused
// before counting, and a member already at 6 subscriptions, were not counted).
func TestEventURLRefusedAsksCount(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A", allowLoopback)
	adam := NewPerson(t, c, "Adam")
	room := adam.CreateRoom("count")
	a := adam.Member(c, room, "a")
	y := newYesOnly(t)
	for i, u := range []string{"https://exämple.com/x", "https://xn--80ak6aa92e.com/x", "https://16843009/x", "https://1.1.1.1./x", "http://10.0.0.5/x"} {
		if r := askPerson(a, c, u); r.Code() != "event_url_blocked" {
			t.Fatalf("ask %d %s: %s", i, u, r)
		}
	}
	exec(t, c, `insert into event_subscriptions (id, member_id, key_epoch, url, name, secret, expires_at, verified_at)
		select 'sub_' || lpad(to_hex(g), 24, '0'), $1, 1, 'https://hooks.example/' || g, 'message.received', $2, now() + interval '1 day', now()
		from generate_series(1, 6) g`, a.ID, make([]byte, 32))
	if r := askPerson(a, c, y.srv.URL+"/six"); r.Code() != "too_many_subscriptions" {
		t.Fatalf("ask at 6 subscriptions: %s", r)
	}
	exec(t, c, `delete from event_subscriptions`)
	if r := askPerson(a, c, y.srv.URL+"/seventh"); r.Status != 429 {
		t.Fatalf("the seventh ask in the hour (six refused): %s", r)
	}
}

// A request made by an earlier chat of the member (it moved) is no longer approvable.
func TestEventURLMovedMember(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A", allowLoopback)
	adam := NewPerson(t, c, "Adam")
	room := adam.CreateRoom("moved")
	routine := adam.Member(c, room, "routine")
	y := newYesOnly(t)
	r := askPerson(routine, c, y.srv.URL+"/t")
	exec(t, c, `update members set key_epoch = key_epoch + 1 where id = $1`, routine.ID)
	if l := eventURLsOf(t, adam); len(l) != 0 {
		t.Fatalf("a moved member's request on the dashboard: %v", l)
	}
	if ap := approveEventURL(adam, reqID(r)); ap.Status != 404 {
		t.Fatalf("approve a moved member's request: %s", ap)
	}
	y.never("a moved member")
}

// Export carries the requests (never the secret); delete removes them.
func TestEventURLExportAndDelete(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A", allowLoopback, noWait)
	dana := NewPerson(t, c, "Dana")
	room := dana.CreateRoom("solo")
	routine := dana.Member(c, room, "routine")
	y := newYesOnly(t)
	r := askPerson(routine, c, y.srv.URL+"/t?key=hunter2")
	if r.Status != 202 {
		t.Fatal(r)
	}
	ex := dana.Do("GET", "/app/v1/me/export", nil)
	wake, _ := ex.J["wake"].(map[string]any)
	l, _ := wake["event_url_requests"].([]any)
	if ex.Status != 200 || len(l) != 1 || l[0].(map[string]any)["id"] != reqID(r) || l[0].(map[string]any)["url"] != y.srv.URL+"/t?key=hunter2" {
		t.Fatalf("export: %s", ex)
	}
	if _, has := l[0].(map[string]any)["secret"]; has {
		t.Fatal("export carries the secret")
	}
	askDelete(t, dana)
	if d := dana.Do("POST", "/app/v1/me/delete", deleteBody(dana.Email, dana.Check("account_delete", ""))); d.Status != 200 {
		t.Fatalf("delete: %s", d)
	}
	if n := count(t, c, `select count(*) from event_url_requests`); n != 0 {
		t.Fatalf("%d requests left after delete", n)
	}
}

// Races, against real Postgres. Approve twice at once: one subscription. Approve against reject, expiry, the member's
// removal or move, and the account's delete: one side wins whole, never a 500, never a deadlock, and nothing is
// approved for a request that stopped waiting.
func TestEventURLRaces(t *testing.T) {
	db := NewDB(t)
	ca := StartCopy(t, db, "A", allowLoopback)
	cb := StartCopy(t, db, "B", allowLoopback)
	adam := NewPerson(t, ca, "Adam")
	adamB := adam.On(cb)
	y := newYesOnly(t)
	deadlocks := pgDeadlocks()
	rounds := 5
	if testing.Short() {
		rounds = 2
	}
	clean := func() {
		exec(t, ca, `delete from event_url_refusals`)
		exec(t, ca, `delete from event_subscriptions`)
		exec(t, ca, `delete from event_url_requests`)
		exec(t, ca, `delete from rate_counters`)
	}
	both := func(f, g func() *Resp) (*Resp, *Resp) {
		var wg sync.WaitGroup
		var x, z *Resp
		wg.Add(2)
		go func() { defer wg.Done(); x = f() }()
		go func() { defer wg.Done(); z = g() }()
		wg.Wait()
		return x, z
	}
	room := adam.CreateRoom("races")
	m := adam.Member(ca, room, "routine")
	for i := 0; i < rounds; i++ {
		// approve twice at once (two copies, two checks)
		clean()
		id := reqID(askPerson(m, ca, fmt.Sprintf("%s/r%d", y.srv.URL, i)))
		h1, h2 := adam.Check("approve_event_url", id), adamB.Check("approve_event_url", id)
		x, z := both(func() *Resp { return adam.approveEventURLWith(id, h1) }, func() *Resp { return adamB.approveEventURLWith(id, h2) })
		t.Logf("round %d approve twice: %d / %d", i, x.Status, z.Status)
		if !((x.Status == 200 && z.Status == 404) || (x.Status == 404 && z.Status == 200)) {
			t.Fatalf("round %d approve twice: %s / %s", i, x, z)
		}
		if n := count(t, ca, `select count(*) from event_subscriptions`); n != 1 {
			t.Fatalf("round %d: %d subscriptions", i, n)
		}
		if !checkUsed(t, ca, h1) || !checkUsed(t, ca, h2) {
			t.Fatalf("round %d: a check left unused", i)
		}
		// Stop against the chat's refresh that relies on the approval: never a 500, and nothing is left afterwards
		subURL := fmt.Sprintf("%s/r%d", y.srv.URL, i)
		subID := events.SubscriptionID(m.ID, subURL, "message.received", false)
		x, z = both(func() *Resp { return adam.Do("POST", "/app/v1/members/"+m.ID+"/event-urls/"+subID+"/stop", nil) },
			func() *Resp { return askPerson(m, cb, subURL) })
		t.Logf("round %d stop vs refresh: stop %d, refresh %d %s", i, x.Status, z.Status, z.Code())
		if x.Status != 204 || z.Status >= 500 {
			t.Fatalf("round %d stop vs refresh: %s / %s", i, x, z)
		}
		if n := count(t, ca, `select count(*) from event_subscriptions`); n != 0 {
			t.Fatalf("round %d: %d subscription(s) after Stop", i, n)
		}
		// approve against reject
		clean()
		id = reqID(askPerson(m, ca, fmt.Sprintf("%s/j%d", y.srv.URL, i)))
		h1 = adam.Check("approve_event_url", id)
		x, z = both(func() *Resp { return adam.approveEventURLWith(id, h1) }, func() *Resp { return adamB.Do("POST", "/app/v1/event-urls/"+id+"/reject", nil) })
		subs := count(t, ca, `select count(*) from event_subscriptions`)
		t.Logf("round %d approve vs reject: approve %d, reject %d, %d subscription(s)", i, x.Status, z.Status, subs)
		switch {
		case x.Status == 200 && z.Status == 404:
			if subs != 1 {
				t.Fatalf("round %d approve won, %d subscriptions", i, subs)
			}
		case x.Status == 404 && z.Status == 204:
			if subs != 0 {
				t.Fatalf("round %d reject won, %d subscriptions", i, subs)
			}
		default:
			t.Fatalf("round %d approve vs reject: %s / %s", i, x, z)
		}
	}
	if d := pgDeadlocks(); deadlocks >= 0 && d > deadlocks {
		t.Fatalf("%d deadlock(s) in the Postgres log", d-deadlocks)
	}
}

// The approval and what takes the request away, queued in a chosen order behind the room row (store.LockRoom): the
// member's removal, a move (new keys), the request running out, the account's delete.
func TestEventURLApprovalLockOrder(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A", allowLoopback, noWait)
	adam := NewPerson(t, c, "Adam")
	y := newYesOnly(t)
	deadlocks := pgDeadlocks()
	n := 0
	for _, removerFirst := range []bool{true, false} {
		n++
		room := adam.CreateRoom(fmt.Sprintf("lockrm%d", n))
		m := adam.Member(c, room, "routine")
		id := reqID(askPerson(m, c, fmt.Sprintf("%s/rm%d", y.srv.URL, n)))
		hc := adam.Check("approve_event_url", id)
		adam.Sync(room)
		rm := room.Log.Build("member_remove", adam.Dev, map[string]any{"member": m.ID})
		approve := func() *Resp { return adam.approveEventURLWith(id, hc) }
		remove := func() *Resp {
			return adam.Do("POST", "/app/v1/rooms/"+room.ID+"/roster", map[string]any{"roster_entry": rm})
		}
		hold := holdRoom(t, c, room.ID)
		first, second := approve, remove
		if removerFirst {
			first, second = remove, approve
		}
		fch := async(first)
		waitLockWaiters(t, c, 1, "the first side")
		sch := async(second)
		waitLockWaiters(t, c, 2, "the second side")
		_ = hold.Rollback(context.Background())
		f, s := <-fch, <-sch
		ar, rr := s, f
		if !removerFirst {
			ar, rr = f, s
		}
		t.Logf("removerFirst=%v: approve %d %s, remove %d", removerFirst, ar.Status, ar.Code(), rr.Status)
		if rr.Status != 200 {
			t.Fatalf("removerFirst=%v remove: %s", removerFirst, rr)
		}
		if removerFirst && ar.Status != 404 {
			t.Fatalf("approve after the removal: %s", ar)
		}
		if !removerFirst && ar.Status != 200 {
			t.Fatalf("approve before the removal: %s", ar)
		}
		sweepEventURLs(t, c)
		if k := count(t, c, `select count(*) from event_subscriptions where member_id = $1`, m.ID); k != 0 {
			t.Fatalf("removerFirst=%v: a removed member keeps %d subscription(s)", removerFirst, k)
		}
	}
	// a move (the member's keys change under the room row) and the request running out: the approval re-reads both
	for _, what := range []string{"move", "expire"} {
		n++
		room := adam.CreateRoom(fmt.Sprintf("lock%s", what))
		m := adam.Member(c, room, "routine")
		id := reqID(askPerson(m, c, fmt.Sprintf("%s/%s", y.srv.URL, what)))
		hc := adam.Check("approve_event_url", id)
		hold := holdRoom(t, c, room.ID)
		ach := async(func() *Resp { return adam.approveEventURLWith(id, hc) })
		waitLockWaiters(t, c, 1, "the approval")
		var err error
		if what == "move" {
			_, err = hold.Exec(context.Background(), `update members set key_epoch = key_epoch + 1 where id = $1`, m.ID)
		} else {
			_, err = hold.Exec(context.Background(), `update event_url_requests set expires_at = now() - interval '1 second' where id = $1`, id)
		}
		if err != nil {
			t.Fatal(err)
		}
		if err := hold.Commit(context.Background()); err != nil {
			t.Fatal(err)
		}
		if ar := <-ach; ar.Status != 404 {
			t.Fatalf("%s under the approval: %s", what, ar)
		}
		if !checkUsed(t, c, hc) {
			t.Fatalf("%s: the refused approval's check is unused", what)
		}
		if k := count(t, c, `select count(*) from event_subscriptions where member_id = $1`, m.ID); k != 0 {
			t.Fatalf("%s: %d subscription(s)", what, k)
		}
	}
	// the account's delete, both orders
	for _, deleteFirst := range []bool{true, false} {
		dana := NewPerson(t, c, fmt.Sprintf("Dana%v", deleteFirst))
		room := dana.CreateRoom("dsolo")
		m := dana.Member(c, room, "routine")
		id := reqID(askPerson(m, c, fmt.Sprintf("%s/del%v", y.srv.URL, deleteFirst)))
		hc := dana.Check("approve_event_url", id)
		askDelete(t, dana)
		dc := dana.Check("account_delete", "")
		approve := func() *Resp { return dana.approveEventURLWith(id, hc) }
		del := func() *Resp { return dana.Do("POST", "/app/v1/me/delete", deleteBody(dana.Email, dc)) }
		hold := holdRoom(t, c, room.ID)
		first, second := approve, del
		if deleteFirst {
			first, second = del, approve
		}
		fch := async(first)
		waitLockWaiters(t, c, 1, "the first side")
		sch := async(second)
		waitLockWaiters(t, c, 2, "the second side")
		_ = hold.Rollback(context.Background())
		f, s := <-fch, <-sch
		ar, dr := s, f
		if !deleteFirst {
			ar, dr = f, s
		}
		t.Logf("deleteFirst=%v: approve %d %s, delete %d", deleteFirst, ar.Status, ar.Code(), dr.Status)
		if dr.Status != 200 {
			t.Fatalf("deleteFirst=%v delete: %s", deleteFirst, dr)
		}
		if ar.Status >= 500 || (deleteFirst && ar.Status == 200) {
			t.Fatalf("deleteFirst=%v approve: %s", deleteFirst, ar)
		}
		for _, q := range []string{`select count(*) from event_subscriptions where member_id = $1`, `select count(*) from event_url_requests where member_id = $1`} {
			if k := count(t, c, q, m.ID); k != 0 {
				t.Fatalf("deleteFirst=%v: %d left: %s", deleteFirst, k, q)
			}
		}
	}
	if d := pgDeadlocks(); deadlocks >= 0 && d > deadlocks {
		t.Fatalf("%d deadlock(s) in the Postgres log", d-deadlocks)
	}
	_ = config.Config{}
}
