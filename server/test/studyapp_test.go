package test

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/charles161/botlink/server/internal/config"
	"github.com/charles161/botlink/server/internal/faults"
	"github.com/charles161/botlink/server/internal/push"
	"github.com/charles161/botlink/server/internal/roster"
	"github.com/charles161/botlink/server/internal/testkit"
	"github.com/charles161/botlink/server/internal/wire"
)

// fakeEnvelope is a well-formed envelope text for rows injected straight into the DB.
var fakeEnvelope = func() string {
	b, _ := json.Marshal(map[string]any{"v": 3, "h": "eyJ2IjozfQ", "ct": "AAAA", "sig": strings.Repeat("ab", 64)})
	return string(b)
}()

// inject commits one message from → to directly in SQL (one transaction: NOTIFY fires at commit).
func inject(t testing.TB, c *Copy, from, to *Agent) string {
	t.Helper()
	id := wire.NewV7().String()
	err := pgx.BeginFunc(context.Background(), c.Pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(context.Background(), `insert into messages (id, room_id, from_member, scope, to_member, request_hash, recipients, expires_at)
			values ($1,$2,$3,'member',$4,$5,1, now() + interval '1 hour')`, id, from.Room, from.ID, to.ID, wire.RandBytes(32)); err != nil {
			return err
		}
		_, err := tx.Exec(context.Background(), `insert into deliveries (message_id, member_id, key_epoch, envelope, expires_at)
			values ($1,$2,(select key_epoch from members where id = $2),$3, now() + interval '1 hour')`, id, to.ID, fakeEnvelope)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	return id
}

// pushReceiver answers verify challenges and records pushes; checks the HMAC.
type pushReceiver struct {
	srv    *httptest.Server
	mu     sync.Mutex
	secret []byte
	got    []map[string]any
	badSig int
}

func newPushReceiver(t testing.TB) *pushReceiver {
	pr := &pushReceiver{}
	pr.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		var m map[string]any
		_ = json.Unmarshal(b, &m)
		if m["type"] == "verify" {
			pr.mu.Lock()
			pr.secret = nil
			pr.mu.Unlock()
			w.Header().Set("Content-Type", "application/json")
			_, _ = fmt.Fprintf(w, `{"challenge":%q}`, m["challenge"])
			return
		}
		pr.mu.Lock()
		defer pr.mu.Unlock()
		if pr.secret != nil {
			sigH := r.Header.Get("X-Botlink-Push-Signature")
			var ts int64
			fmt.Sscanf(sigH, "t=%d,", &ts)
			if push.Signature(pr.secret, ts, b) != sigH {
				pr.badSig++
			}
		}
		pr.got = append(pr.got, m)
	}))
	t.Cleanup(pr.srv.Close)
	return pr
}

func allowLoopback(c *config.Config) { c.PushAllowLoopback = true }

// T1: the send transaction killed after recipient k of n leaves nothing; a retry with the same id stores exactly once.
func TestT1SendAtomic(t *testing.T) {
	resetFaults(t)
	c := StartCopy(t, NewDB(t), "A", allowLoopback)
	adam := NewPerson(t, c, "Adam")
	room := adam.CreateRoom("t1")
	s := adam.Member(c, room, "sender")
	r1 := adam.Member(c, room, "r1")
	r2 := adam.Member(c, room, "r2")
	r3 := adam.Member(c, room, "r3")
	// r2 is always on, so the push outbox is part of the transaction too
	pr := newPushReceiver(t)
	if r := r2.Do(c, "PUT", "/api/v1/me/turn", map[string]any{"turn": "always_on", "url": pr.srv.URL + "/hook"}); r.Status != 200 {
		t.Fatalf("always_on: %s", r)
	}
	id := wire.NewV7().String()
	body := mustJSON(s.SendBody(id, true, []*Agent{r1, r2, r3}, nil))
	for k := 1; k <= 3; k++ {
		kk := k
		faults.Set("send_after_delivery", func(_ context.Context, i int) error {
			if i == kk {
				return faults.ErrInjected
			}
			return nil
		})
		if r := s.Do(c, "POST", "/api/v1/messages", body); r.Status != 500 {
			t.Fatalf("k=%d: want 500, got %s", k, r)
		}
		for _, tbl := range []string{"messages where id = $1", "deliveries where message_id = $1", "push_jobs where message_id = $1"} {
			if n := count(t, c, "select count(*) from "+tbl, id); n != 0 {
				t.Fatalf("k=%d: %d rows left in %s", k, n, tbl)
			}
		}
	}
	faults.Set("send_after_delivery", nil)
	if r := s.Do(c, "POST", "/api/v1/messages", body); r.Status != 201 || r.J["duplicate"] != false {
		t.Fatalf("retry: %s", r)
	}
	if count(t, c, `select count(*) from messages where id = $1`, id) != 1 || count(t, c, `select count(*) from deliveries where message_id = $1`, id) != 3 ||
		count(t, c, `select count(*) from push_jobs where message_id = $1`, id) != 1 {
		t.Fatal("retry did not store exactly 1 message, 3 copies, 1 push job")
	}
}

// T2: same id twice (and ×10 concurrently) → one message; first 201, others 200 duplicate.
func TestT2Idempotent(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A")
	adam := NewPerson(t, c, "Adam")
	room := adam.CreateRoom("t2")
	s := adam.Member(c, room, "sender")
	r := adam.Member(c, room, "rcpt")
	id := wire.NewV7().String()
	body := mustJSON(s.SendBody(id, false, []*Agent{r}, nil))
	if x := s.Do(c, "POST", "/api/v1/messages", body); x.Status != 201 {
		t.Fatal(x)
	}
	if x := s.Do(c, "POST", "/api/v1/messages", body); x.Status != 200 || x.J["duplicate"] != true || x.Str("id") != id {
		t.Fatal(x)
	}
	// same id, different bytes → id_conflict
	if x := s.Do(c, "POST", "/api/v1/messages", s.SendBody(id, false, []*Agent{r}, nil)); x.Code() != "id_conflict" {
		t.Fatal(x)
	}
	// ×10 concurrently with a fresh id
	id2 := wire.NewV7().String()
	body2 := mustJSON(s.SendBody(id2, false, []*Agent{r}, nil))
	var wg sync.WaitGroup
	codes := make([]int, 10)
	dups := make([]any, 10)
	for i := range 10 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			x := s.Do(c, "POST", "/api/v1/messages", body2)
			codes[i], dups[i] = x.Status, x.J["duplicate"]
		}()
	}
	wg.Wait()
	created := 0
	for i, code := range codes {
		switch {
		case code == 201:
			created++
		case code == 200 && dups[i] == true:
		default:
			t.Fatalf("concurrent send %d: %d", i, code)
		}
	}
	if created != 1 || count(t, c, `select count(*) from messages where id = $1`, id2) != 1 || count(t, c, `select count(*) from deliveries where message_id = $1`, id2) != 1 {
		t.Fatalf("created %d", created)
	}
}

// T3: a message committed between Hold and the lease query, and between the lease query and select:
// no poll reaches its timeout; every poll returns the message in < 1 s. ×1000.
func TestT3SubscribeRace(t *testing.T) {
	resetFaults(t)
	c := StartCopy(t, NewDB(t), "A")
	adam := NewPerson(t, c, "Adam")
	room := adam.CreateRoom("t3")
	s := adam.Member(c, room, "sender")
	r := adam.Member(c, room, "rcpt")
	n := 1000
	if testing.Short() {
		n = 100
	}
	r.Drain(c)
	var want atomic.Value
	var fired atomic.Bool
	hook := func(point string) faults.Hook {
		return func(ctx context.Context, _ int) error {
			if fired.CompareAndSwap(false, true) {
				want.Store(inject(t, c, s, r))
			}
			return nil
		}
	}
	slow := 0
	for i := 0; i < n; i++ {
		point := "lease_after_hold"
		if i%2 == 1 {
			point = "lease_after_query"
		}
		faults.Reset()
		fired.Store(false)
		faults.Set(point, hook(point))
		if i%100 == 0 { // a stress test, not a loop: stay under the per-member poll budget (ratelimit.Polls)
			exec(t, c, `delete from rate_counters where bucket like 'poll:m:%'`)
		}
		start := time.Now()
		lr := r.Lease(c, 50)
		el := time.Since(start)
		ds := deliveries(lr)
		if lr.Status != 200 || len(ds) != 1 || ds[0]["message_id"] != want.Load() {
			t.Fatalf("iteration %d (%s): %s", i, point, lr)
		}
		if el > time.Second {
			t.Fatalf("iteration %d (%s): took %v", i, point, el)
		}
		if el > 250*time.Millisecond {
			slow++
		}
	}
	faults.Reset()
	t.Logf("T3: %d/%d polls returned the message in < 1 s (%d over 250 ms)", n, n, slow)
}

// T5: two lease pollers for one member + 100 messages → each leased by exactly one poller; wait never leases.
func TestT5DisjointLeases(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A")
	adam := NewPerson(t, c, "Adam")
	room := adam.CreateRoom("t5")
	s := adam.Member(c, room, "sender")
	r := adam.Member(c, room, "rcpt")
	all := map[string]bool{}
	for range 100 {
		all[inject(t, c, s, r)] = true
	}
	var mu sync.Mutex
	seen := map[string]int{}
	var wg sync.WaitGroup
	for p := range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				lr := r.Do(c, "POST", "/api/v1/me/inbox/lease", map[string]any{"wait_s": 0, "max": 7})
				ds := deliveries(lr)
				if lr.Status != 200 {
					t.Errorf("poller %d: %s", p, lr)
					return
				}
				if len(ds) == 0 && len(lr.J["notices"].([]any)) == 0 {
					return
				}
				var ns []int64
				for _, n := range lr.J["notices"].([]any) {
					ns = append(ns, int64(n.(map[string]any)["id"].(float64)))
				}
				if len(ns) > 0 {
					r.Do(c, "POST", "/api/v1/me/inbox/ack", map[string]any{"notice_ids": ns})
				}
				mu.Lock()
				for _, d := range ds {
					seen[d["message_id"].(string)]++
				}
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	if len(seen) != 100 {
		t.Fatalf("leased %d distinct of 100", len(seen))
	}
	for id, n := range seen {
		if n != 1 || !all[id] {
			t.Fatalf("message %s leased %d times", id, n)
		}
	}
	// wait counts but never leases: a lease right after wait gets all of them
	for range 5 {
		inject(t, c, s, r)
	}
	w := r.Do(c, "POST", "/api/v1/me/wait", map[string]any{"wait_s": 0})
	if w.J["count"].(float64) != 5 {
		t.Fatalf("wait: %s", w)
	}
	if lr := r.Do(c, "POST", "/api/v1/me/inbox/lease", map[string]any{"wait_s": 0}); len(deliveries(lr)) != 5 {
		t.Fatalf("lease after wait: %s", lr)
	}
}

// T6: room broadcast to 3; X replies → only X's copy done; the other two keep their bodies.
// T7: a non-recipient replying to someone else's message changes nothing.
func TestT6T7ReplyOwnCopyOnly(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A")
	adam := NewPerson(t, c, "Adam")
	room := adam.CreateRoom("t6")
	s := adam.Member(c, room, "sender")
	x := adam.Member(c, room, "x")
	y := adam.Member(c, room, "y")
	z := adam.Member(c, room, "z")
	// z leaves → broadcast reaches x, y and... we want 3 recipients: add w
	w := adam.Member(c, room, "w")
	_ = z
	id := wire.NewV7().String()
	if r := s.Do(c, "POST", "/api/v1/messages", s.SendBody(id, true, []*Agent{x, y, z, w}, nil)); r.Status != 201 {
		t.Fatal(r)
	}
	// y has shown it
	y.Lease(c, 0)
	y.Do(c, "POST", "/api/v1/me/inbox/ack", map[string]any{"items": []map[string]any{{"message_id": id, "action": "shown"}}})
	in := id
	if r := x.Do(c, "POST", "/api/v1/messages", x.SendBody(wire.NewV7().String(), false, []*Agent{s}, &in)); r.Status != 201 {
		t.Fatal(r)
	}
	type st struct {
		state string
		body  bool
	}
	get := func() map[string]st {
		rows, _ := c.Pool.Query(context.Background(), `select member_id, state, envelope is not null from deliveries where message_id = $1`, id)
		defer rows.Close()
		out := map[string]st{}
		for rows.Next() {
			var m, s string
			var b bool
			_ = rows.Scan(&m, &s, &b)
			out[m] = st{s, b}
		}
		return out
	}
	g := get()
	if g[x.ID] != (st{"done", false}) || g[y.ID] != (st{"shown", true}) || g[z.ID] != (st{"queued", true}) || g[w.ID] != (st{"queued", true}) {
		t.Fatalf("T6 states: %+v", g)
	}
	// T7: s is not a recipient of its own message; w replies to x's reply (w is not a recipient of it) → 0 rows change
	before := get()
	if r := w.Do(c, "POST", "/api/v1/messages", w.SendBody(wire.NewV7().String(), false, []*Agent{x}, &in)); r.Status != 201 {
		t.Fatal(r)
	}
	// forged in_reply_to pointing at a message w never received
	other := wire.NewV7().String()
	if r := s.Do(c, "POST", "/api/v1/messages", s.SendBody(other, false, []*Agent{y}, nil)); r.Status != 201 {
		t.Fatal(r)
	}
	forged := other
	if r := z.Do(c, "POST", "/api/v1/messages", z.SendBody(wire.NewV7().String(), false, []*Agent{s}, &forged)); r.Status != 201 {
		t.Fatal(r)
	}
	after := get()
	before[w.ID] = st{"done", false} // w replied to `id` itself, which it did receive: its own copy is done
	for m, b := range before {
		if after[m] != b {
			t.Fatalf("T7: copy of %s changed %+v → %+v", m, b, after[m])
		}
	}
	if count(t, c, `select count(*) from deliveries where message_id = $1 and state = 'queued'`, other) != 1 {
		t.Fatal("T7: forged in_reply_to changed y's copy")
	}
}

// T8 (server part): keys swapped in the DB before approve → the approve card shows a different
// fingerprint than the chat printed, the signed roster carries the swapped key, the chat's own key is
// never a member (self-check fails, requests get unknown_key).
func TestT8KeySwap(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A")
	adam := NewPerson(t, c, "Adam")
	room := adam.CreateRoom("t8")
	a := NewAgentKeys(t, "victim")
	jr := a.Join(c, adam.Invite(room))
	printed := jr.Str("fingerprint")
	evil := testkit.NewKey()
	evilX := wire.RandBytes(32)
	exec(t, c, `update join_requests set ed25519_pk = $2, x25519_pk = $3 where id = $1`, a.ReqID, []byte(evil.Pub), evilX)
	ny := adam.Do("GET", "/app/v1/needs-you", nil)
	card := ny.J["join_requests"].([]any)[0].(map[string]any)
	ed, _ := hex.DecodeString(card["ed25519_pk"].(string))
	x, _ := hex.DecodeString(card["x25519_pk"].(string))
	if wire.MemberFP(ed, x) == printed {
		t.Fatal("card fingerprint matches the chat's although keys were swapped")
	}
	if r := adam.Approve(room, a); r.Status != 200 {
		t.Fatal(r)
	}
	var ws []roster.Wire
	_ = json.Unmarshal(mustJSON(adam.Do("GET", "/app/v1/rooms/"+room.ID+"/roster", nil).J["entries"]), &ws)
	st, err := roster.Replay(room.ID, ws)
	if err != nil {
		t.Fatal(err)
	}
	if m := st.Members[a.ID]; m == nil || m.Ed == a.Key.Hex() {
		t.Fatal("self-check would pass")
	}
	if r := a.Do(c, "GET", "/api/v1/me", nil); r.Code() != "unknown_key" {
		t.Fatalf("chat key should be unknown: %s", r)
	}
}

// T9: replayed nonce → 401 replayed; 61 s old (or ahead) timestamp → 401 stale_timestamp with server_time.
func TestT9Replay(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A")
	adam := NewPerson(t, c, "Adam")
	room := adam.CreateRoom("t9")
	a := adam.Member(c, room, "a")
	nonce := hex.EncodeToString(wire.RandBytes(16))
	for _, path := range []string{"/api/v1/me/inbox/ack", "/api/v1/me/inbox/lease"} {
		body := map[string]any{}
		if strings.HasSuffix(path, "ack") {
			body = map[string]any{"items": []any{}}
		}
		n := hex.EncodeToString(wire.RandBytes(16))
		if r := doRaw(t, a.Req(c, "POST", path, body, &SignOpts{Nonce: n})); r.Status != 200 {
			t.Fatal(r)
		}
		if r := doRaw(t, a.Req(c, "POST", path, body, &SignOpts{Nonce: n})); r.Status != 401 || r.Code() != "replayed" {
			t.Fatalf("%s replay: %s", path, r)
		}
	}
	for _, off := range []int64{-61, 62} { // 61 s old (spec); ahead: +62 avoids a sub-second race between the test clock and Postgres
		r := doRaw(t, a.Req(c, "POST", "/api/v1/me/inbox/lease", map[string]any{}, &SignOpts{Time: time.Now().Unix() + off, Nonce: nonce}))
		e, _ := r.J["error"].(map[string]any)
		if r.Status != 401 || r.Code() != "stale_timestamp" || e["server_time"] == nil {
			t.Fatalf("offset %d: %s", off, r)
		}
	}
	// a stale request must not burn its nonce: the same nonce with a good time still works
	if r := doRaw(t, a.Req(c, "POST", "/api/v1/me/inbox/lease", map[string]any{}, &SignOpts{Nonce: nonce})); r.Status != 200 {
		t.Fatalf("nonce burnt by a rejected request: %s", r)
	}
	// a bad signature doesn't burn it either
	bad := a.Req(c, "POST", "/api/v1/me/inbox/lease", map[string]any{}, nil)
	bad.Header.Set("X-Botlink-Signature", strings.Repeat("0", 128))
	if r := doRaw(t, bad); r.Code() != "bad_signature" {
		t.Fatal(r)
	}
}

// T10: approving one join request on copy A and copy B concurrently ×50 → exactly one member and one
// roster entry per request; the loser gets 409 already_decided.
func TestT10ConcurrentApprove(t *testing.T) {
	db := NewDB(t)
	ca := StartCopy(t, db, "A")
	cb := StartCopy(t, db, "B")
	adam := NewPerson(t, ca, "Adam")
	adamB := adam.On(cb)
	room := adam.CreateRoom("t10")
	n := 50
	if testing.Short() {
		n = 10
	}
	for i := 0; i < n; i++ {
		if i > 0 && i%15 == 0 { // stay under 20 members: remove old ones
			exec(t, ca, `update members set removed_at = now() where room_id = $1 and removed_at is null`, room.ID)
		}
		exec(t, ca, `delete from rate_counters`) // 10 joins per invite per hour; this test needs 50
		a := NewAgentKeys(t, fmt.Sprintf("m%d", i))
		if r := a.Join(ca, adam.Invite(room)); r.Status != 201 {
			t.Fatal(r)
		}
		adam.Sync(room)
		ny := adam.Do("GET", "/app/v1/needs-you", nil)
		var card map[string]any
		for _, j := range ny.J["join_requests"].([]any) {
			if j.(map[string]any)["id"] == a.ReqID {
				card = j.(map[string]any)
			}
		}
		entry := room.Log.Build("member_add", adam.Dev, map[string]any{"member": card["member_id"], "account": adam.AccountID, "name": card["name"],
			"app": card["app"], "ed": card["ed25519_pk"], "x": card["x25519_pk"]})
		hcA, hcB := adam.Check("approve_join", a.ReqID), adamB.Check("approve_join", a.ReqID)
		var wg sync.WaitGroup
		res := make([]*Resp, 2)
		for k, p := range []*Person{adam, adamB} {
			hc := []string{hcA, hcB}[k]
			wg.Add(1)
			go func() {
				defer wg.Done()
				res[k] = p.Do("POST", "/app/v1/join-requests/"+a.ReqID+"/approve", map[string]any{"human_check": map[string]any{"id": hc, "stub": true}, "roster_entry": entry})
			}()
		}
		wg.Wait()
		codes := []int{res[0].Status, res[1].Status}
		sort.Ints(codes)
		if codes[0] != 200 || codes[1] != 409 {
			t.Fatalf("iteration %d: %s / %s", i, res[0], res[1])
		}
		loser := res[0]
		if loser.Status == 200 {
			loser = res[1]
		}
		if loser.Code() != "already_decided" {
			t.Fatalf("loser: %s", loser)
		}
		if count(t, ca, `select count(*) from members where id = $1`, card["member_id"]) != 1 ||
			count(t, ca, `select count(*) from roster_entries where room_id = $1 and op = 'member_add' and encode(entry, 'escape') like '%' || $2 || '%'`, room.ID, card["member_id"]) != 1 {
			t.Fatalf("iteration %d: not exactly one member / entry", i)
		}
	}
}

// T11 (server part): wakes counted by wait; after 5 wakes the copy is stuck with exactly one attention item.
func TestT11WakesToStuck(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A")
	adam := NewPerson(t, c, "Adam")
	room := adam.CreateRoom("t11")
	s := adam.Member(c, room, "sender")
	r := adam.Member(c, room, "sleeper")
	id := inject(t, c, s, r)
	for i := 1; i <= 5; i++ {
		if w := r.Do(c, "POST", "/api/v1/me/wait", map[string]any{"wait_s": 0}); w.J["count"].(float64) != 1 {
			t.Fatalf("wake %d: %s", i, w)
		}
	}
	if w := r.Do(c, "POST", "/api/v1/me/wait", map[string]any{"wait_s": 0}); w.J["count"].(float64) != 0 {
		t.Fatalf("6th wait should see nothing: %s", w)
	}
	if count(t, c, `select count(*) from deliveries where message_id = $1 and state = 'stuck' and stuck_reason = 'wakes'`, id) != 1 ||
		count(t, c, `select count(*) from attention where subject_id = $1 and kind = 'stuck' and resolved_at is null`, r.ID) != 1 {
		t.Fatal("not stuck with one attention item")
	}
	r.Do(c, "POST", "/api/v1/me/wait", map[string]any{"wait_s": 0})
	if count(t, c, `select count(*) from attention where subject_id = $1`, r.ID) != 1 {
		t.Fatal("attention not deduped")
	}
}

// T12: always-on URLs to private / loopback / metadata / ULA / private-resolving names / redirects are blocked.
func TestT12SSRF(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A") // loopback NOT allowed
	adam := NewPerson(t, c, "Adam")
	room := adam.CreateRoom("t12")
	a := adam.Member(c, room, "svc")
	for _, u := range []string{"http://127.0.0.1:9/x", "https://10.1.2.3/x", "http://169.254.169.254/latest/meta-data", "https://[fd00::1]/x",
		"https://[::1]/x", "http://localhost:9/x", "https://100.64.0.1/x", "https://[::ffff:127.0.0.1]/x", "ftp://example.com/x", "https://0.0.0.0/x"} {
		if r := a.Do(c, "PUT", "/api/v1/me/turn", map[string]any{"turn": "always_on", "url": u}); r.Status != 422 || r.Code() != "push_url_blocked" {
			t.Fatalf("%s: %s", u, r)
		}
	}
	// a redirect is never followed (302 → verify fails) and its target is never contacted
	var targetHits atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { targetHits.Add(1) }))
	defer target.Close()
	redir := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusFound)
	}))
	defer redir.Close()
	c2 := StartCopy(t, NewDB(t), "B", allowLoopback)
	bob := NewPerson(t, c2, "Bob")
	room2 := bob.CreateRoom("t12b")
	b := bob.Member(c2, room2, "svc")
	sender := bob.Member(c2, room2, "sender")
	if r := b.Do(c2, "PUT", "/api/v1/me/turn", map[string]any{"turn": "always_on", "url": redir.URL}); r.Status != 422 || r.Code() != "push_verify_failed" {
		t.Fatalf("redirect: %s", r)
	}
	if targetHits.Load() != 0 {
		t.Fatal("redirect target was contacted")
	}
	// even with loopback allowed, private ranges stay blocked
	if r := b.Do(c2, "PUT", "/api/v1/me/turn", map[string]any{"turn": "always_on", "url": "http://10.0.0.1/x"}); r.Code() != "push_url_blocked" {
		t.Fatal(r)
	}
	// push jobs to a URL that became private fail without connecting
	pr := newPushReceiver(t)
	if r := b.Do(c2, "PUT", "/api/v1/me/turn", map[string]any{"turn": "always_on", "url": pr.srv.URL + "/p"}); r.Status != 200 {
		t.Fatal(r)
	}
	exec(t, c2, `update members set push_url = 'http://169.254.169.254/x' where id = $1`, b.ID)
	id, _ := sender.Send(c2, b)
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if count(t, c2, `select count(*) from push_jobs where message_id = $1 and last_error = 'url blocked'`, id) == 1 {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if count(t, c2, `select count(*) from push_jobs where message_id = $1 and last_error = 'url blocked'`, id) != 1 {
		t.Fatal("push job to a blocked url not recorded as blocked")
	}
	if len(pr.got) != 0 {
		t.Fatal("receiver got a push")
	}
}

// T13: lease, never ack, 5 times → stuck(attempts) + attention; unstick → queued with counters reset.
func TestT13LeaseToStuck(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A")
	adam := NewPerson(t, c, "Adam")
	room := adam.CreateRoom("t13")
	s := adam.Member(c, room, "sender")
	r := adam.Member(c, room, "flaky")
	id := inject(t, c, s, r)
	for i := 1; i <= 5; i++ {
		lr := r.Lease(c, 0)
		ds := deliveries(lr)
		if len(ds) != 1 || ds[0]["attempt"].(float64) != float64(i) {
			t.Fatalf("lease %d: %s", i, lr)
		}
		exec(t, c, `update deliveries set lease_until = now() - interval '1 second' where message_id = $1`, id) // lease expires
	}
	if lr := r.Lease(c, 0); len(deliveries(lr)) != 0 {
		t.Fatalf("6th lease returned it: %s", lr)
	}
	if count(t, c, `select count(*) from deliveries where message_id = $1 and state = 'stuck' and stuck_reason = 'attempts'`, id) != 1 {
		t.Fatal("not stuck")
	}
	ny := adam.Do("GET", "/app/v1/needs-you", nil)
	att := ny.J["attention"].([]any)
	if len(att) != 1 || att[0].(map[string]any)["kind"] != "stuck" || att[0].(map[string]any)["member_name"] != "flaky" {
		t.Fatalf("attention: %s", ny)
	}
	if u := adam.Do("POST", "/app/v1/members/"+r.ID+"/unstick", nil); u.J["requeued"].(float64) != 1 {
		t.Fatalf("unstick: %s", u)
	}
	if count(t, c, `select count(*) from deliveries where message_id = $1 and state = 'queued' and attempts = 0 and wakes = 0`, id) != 1 {
		t.Fatal("not requeued with counters reset")
	}
	if len(adam.Do("GET", "/app/v1/needs-you", nil).J["attention"].([]any)) != 0 {
		t.Fatal("attention not resolved")
	}
	if lr := r.Lease(c, 0); len(deliveries(lr)) != 1 {
		t.Fatal("not leasable after unstick")
	}
}

// T14: claim on the same machine while the old session holds a 50 s lease poll → old poll 409
// not_holder in < 1 s; the old session's next ack → 409 not_holder.
func TestT14ClaimEndsOldPoll(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A")
	adam := NewPerson(t, c, "Adam")
	room := adam.CreateRoom("t14")
	d := adam.Member(c, room, "deployer")
	d.Drain(c)
	got := make(chan *Resp, 1)
	go func() { got <- d.Lease(c, 50) }()
	time.Sleep(300 * time.Millisecond)
	start := time.Now()
	newer := MoveApproved(c, adam, room, d, "sess-new") // H1: a move to another chat is approved by the person
	select {
	case r := <-got:
		if (r.Code() != "not_holder" && r.Code() != "unknown_key") || time.Since(start) > 5*time.Second {
			t.Fatalf("old poll: %s after %v", r, time.Since(start))
		}
	case <-time.After(8 * time.Second):
		t.Fatal("old poll still open")
	}
	if r := d.Do(c, "POST", "/api/v1/me/inbox/ack", map[string]any{"items": []any{}}); r.Code() != "unknown_key" {
		t.Fatalf("old ack: %s", r)
	}
	// claiming what you already hold is a no-op
	cl := newer.Do(c, "POST", "/api/v1/me/claim", map[string]any{"session_id": "sess-new"})
	if r := newer.Do(c, "POST", "/api/v1/me/claim", map[string]any{"session_id": "sess-new"}); cl.Status != 200 || r.Status != 200 || r.J["holder_epoch"] != cl.J["holder_epoch"] || cl.J["previous_session"] != "sess-new" {
		t.Fatal(cl, r)
	}
	// stale expected epoch → holder_changed
	e := int64(cl.J["holder_epoch"].(float64)) - 1
	third := *newer
	third.Session = "sess-third"
	if r := third.Do(c, "POST", "/api/v1/me/claim", map[string]any{"session_id": "sess-third", "expected_holder_epoch": e}); r.Code() != "holder_changed" {
		t.Fatal(r)
	}
}

// T15: new-machine claim approved with 3 queued messages from 2 senders → 3 needs_resend, one notice
// per sender, the old key stops working, the new machine receives re-sent messages.
func TestT15NewMachine(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A")
	adam := NewPerson(t, c, "Adam")
	room := adam.CreateRoom("t15")
	s1 := adam.Member(c, room, "s1")
	s2 := adam.Member(c, room, "s2")
	d := adam.Member(c, room, "deployer")
	var ids []string
	for _, s := range []*Agent{s1, s1, s2} {
		id, r := s.Send(c, d)
		if r.Status != 201 {
			t.Fatal(r)
		}
		ids = append(ids, id)
	}
	// new machine: new keys, claim request with the person's invite
	nd := NewAgentKeys(t, "deployer")
	nd.ReqID = wire.NewV7().String()
	jr := nd.Do(c, "POST", "/api/v1/join-requests", map[string]any{"id": nd.ReqID, "kind": "claim", "invite": adam.Invite(room), "name": "deployer",
		"app": "codex", "machine": "laptop-2", "folder": "~/acme", "turn": "wake", "session_id": nd.Session,
		"ed25519_pk": nd.Key.Hex(), "x25519_pk": hex.EncodeToString(nd.X)})
	if jr.Status != 201 || jr.Str("kind") != "claim" {
		t.Fatal(jr)
	}
	if r := adam.Approve(room, nd); r.Status != 200 || r.Str("id") != d.ID {
		t.Fatalf("approve claim: %s", r)
	}
	if n := count(t, c, `select count(*) from deliveries where member_id = $1 and state = 'needs_resend' and envelope is null`, d.ID); n != 3 {
		t.Fatalf("needs_resend = %d", n)
	}
	for _, s := range []*Agent{s1, s2} {
		lr := s.Lease(c, 0)
		var found []any
		for _, n := range lr.J["notices"].([]any) {
			if n.(map[string]any)["kind"] == "needs_resend" {
				found = append(found, n)
			}
		}
		if len(found) != 1 {
			t.Fatalf("%s: %d needs_resend notices: %s", s.Name, len(found), lr)
		}
		mids := found[0].(map[string]any)["data"].(map[string]any)["message_ids"].([]any)
		if (s == s1 && len(mids) != 2) || (s == s2 && len(mids) != 1) {
			t.Fatalf("%s notice ids %v", s.Name, mids)
		}
	}
	if r := d.Do(c, "GET", "/api/v1/me", nil); r.Code() != "unknown_key" {
		t.Fatalf("old key still works: %s", r)
	}
	nd.ID, nd.Room = d.ID, room.ID
	// senders re-send (new ids) sealed to the new key
	for _, s := range []*Agent{s1, s1, s2} {
		if _, r := s.Send(c, nd); r.Status != 201 {
			t.Fatalf("resend: %s", r)
		}
	}
	if lr := nd.Lease(c, 0); len(deliveries(lr)) != 3 {
		t.Fatalf("new machine got %s", lr)
	}
	// the old fingerprint is refused
	if _, r := s1.Send(c, d); r.Code() != "recipients_changed" {
		t.Fatalf("send to old key: %s", r)
	}
}
