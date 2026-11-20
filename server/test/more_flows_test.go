package test

import (
	"bufio"
	"context"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/charles161/botlink/server/internal/auth"
	"github.com/charles161/botlink/server/internal/config"
	"github.com/charles161/botlink/server/internal/sweeper"
	"github.com/charles161/botlink/server/internal/testkit"
	"github.com/charles161/botlink/server/internal/wire"
)

func newID() string        { return wire.NewV7().String() }
func hexs(b []byte) string { return hex.EncodeToString(b) }

// Leave (agent, own key), remove (dashboard), open polls of a removed member → 410, room delete → room_gone.
func TestLeaveRemoveDelete(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A")
	adam := NewPerson(t, c, "Adam")
	room := adam.CreateRoom("rm")
	a := adam.Member(c, room, "leaver")
	b := adam.Member(c, room, "removed")
	k := adam.Member(c, room, "keeper")
	s := adam.Member(c, room, "sender")
	// queued copy to a, then a leaves with its own key
	id, _ := s.Send(c, a)
	adam.Sync(room)
	leave := room.Log.Build("member_remove", a.Key, map[string]any{"member": a.ID})
	if r := a.Do(c, "DELETE", "/api/v1/me", map[string]any{"roster_entry": leave}); r.Status != 200 {
		t.Fatalf("leave: %s", r)
	}
	if count(t, c, `select count(*) from deliveries where message_id = $1 and state = 'expired' and envelope is null`, id) != 1 {
		t.Fatal("leaver's queued copy not dropped")
	}
	if r := a.Do(c, "GET", "/api/v1/me", nil); r.Status != 410 || r.Code() != "gone" {
		t.Fatalf("after leave: %s", r)
	}
	// b holds an open poll; Adam removes b from the dashboard → the poll ends with 410
	b.Drain(c)
	got := make(chan *Resp, 1)
	go func() { got <- b.Lease(c, 30) }()
	time.Sleep(200 * time.Millisecond)
	adam.Sync(room)
	rm := room.Log.Build("member_remove", adam.Dev, map[string]any{"member": b.ID})
	if r := adam.Do("POST", "/app/v1/rooms/"+room.ID+"/roster", map[string]any{"roster_entry": rm}); r.Status != 200 {
		t.Fatalf("remove: %s", r)
	}
	select {
	case r := <-got:
		if r.Status != 410 || r.Code() != "gone" {
			t.Fatalf("removed member's poll: %s", r)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("removed member's poll still open")
	}
	// stale signer at an old head → roster_conflict
	old := room.Log.BuildAt(1, nil, "member_remove", adam.Dev, map[string]any{"member": k.ID})
	if r := adam.Do("POST", "/app/v1/rooms/"+room.ID+"/roster", map[string]any{"roster_entry": old}); r.Code() != "roster_conflict" {
		t.Fatalf("stale entry: %s", r)
	}
	// keepers get roster_changed
	lr := k.Lease(c, 0)
	found := false
	for _, n := range lr.J["notices"].([]any) {
		if n.(map[string]any)["kind"] == "roster_changed" {
			found = true
		}
	}
	if !found {
		t.Fatal("no roster_changed notice")
	}
	// only device_remove/person_remove/member_remove go through the dashboard roster route
	adam.Sync(room)
	bad := room.Log.Build("device_add", adam.Dev, map[string]any{"account": adam.AccountID, "device": testkit.RandHex32(), "label": "x"})
	if r := adam.Do("POST", "/app/v1/rooms/"+room.ID+"/roster", map[string]any{"roster_entry": bad}); r.Status != 400 {
		t.Fatalf("device_add via roster route: %s", r)
	}
	// owner deletes the room → agents get room_gone
	if r := adam.Do("DELETE", "/app/v1/rooms/"+room.ID, nil); r.Status != 200 {
		t.Fatal(r)
	}
	if r := k.Do(c, "GET", "/api/v1/me", nil); r.Status != 410 || r.Code() != "room_gone" {
		t.Fatalf("after delete: %s", r)
	}
	if r := adam.Do("GET", "/app/v1/rooms/"+room.ID, nil); r.Status != 404 {
		t.Fatal(r)
	}
}

// Person invite: owner invites Priya → she accepts (single use) → owner approves (person_add) → Priya
// approves her own chat with her own device; the owner can't approve Priya's chat.
func TestPersonInviteFlow(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A")
	adam := NewPerson(t, c, "Adam")
	priya := NewPerson(t, c, "Priya Sharma")
	eve := NewPerson(t, c, "Eve")
	room := adam.CreateRoom("lumen")
	pid := newID()
	pi := adam.Do("POST", "/app/v1/rooms/"+room.ID+"/person-invites", map[string]any{"id": pid})
	if pi.Status != 201 {
		t.Fatal(pi)
	}
	if again := adam.Do("POST", "/app/v1/rooms/"+room.ID+"/person-invites", map[string]any{"id": pid}); again.Status != 200 {
		t.Fatal(again)
	}
	if r := priya.Do("POST", "/app/v1/rooms/"+room.ID+"/person-invites", map[string]any{"id": newID()}); r.Status != 404 {
		t.Fatalf("non-owner creating person invite: %s", r)
	}
	code := pi.Str("url")[strings.LastIndex(pi.Str("url"), "/")+1:]
	if r := priya.Do("GET", "/app/v1/person-invites/"+code, nil); r.Status != 200 || r.J["owner_name"] != "Adam" {
		t.Fatal(r)
	}
	acc := priya.Do("POST", "/app/v1/person-invites/"+code+"/accept", map[string]any{"device_id": priya.DevID})
	if acc.Status != 201 || acc.Str("device_fingerprint") != wire.DeviceFP(priya.Dev.Pub) {
		t.Fatal(acc)
	}
	// single use: Eve gets the same generic error as unknown
	if r := eve.Do("POST", "/app/v1/person-invites/"+code+"/accept", map[string]any{"device_id": eve.DevID}); r.Code() != "invite_invalid" {
		t.Fatalf("second accept: %s", r)
	}
	ny := adam.Do("GET", "/app/v1/needs-you", nil)
	prs := ny.J["person_requests"].([]any)
	if len(prs) != 1 || prs[0].(map[string]any)["email"] != priya.Email {
		t.Fatalf("needs-you: %s", ny)
	}
	reqID := acc.Str("id")
	adam.Sync(room)
	hc := adam.Check("approve_person", reqID)
	entry := room.Log.Build("person_add", adam.Dev, map[string]any{"account": priya.AccountID, "name": "Priya Sharma", "device": priya.Dev.Hex()})
	if r := adam.Do("POST", "/app/v1/person-requests/"+reqID+"/approve", map[string]any{"human_check": map[string]any{"id": hc, "stub": true}, "roster_entry": entry}); r.Status != 200 {
		t.Fatalf("person approve: %s", r)
	}
	room.Log.Push(entry)
	if r := adam.Do("POST", "/app/v1/person-requests/"+reqID+"/reject", nil); r.Code() != "already_decided" {
		t.Fatal(r)
	}
	// Priya: room visible, her device certified, her own chat invite
	pr := &Room{ID: room.ID, Name: room.Name, Log: testkit.NewLog(room.ID)}
	if r := priya.Do("GET", "/app/v1/rooms/"+room.ID+"?device_id="+priya.DevID, nil); r.Status != 200 || r.J["my_device_certified"] != true || r.J["my_role"] != "person" {
		t.Fatalf("priya room: %s", r)
	}
	pc := priya.Member(c, pr, "pchat")
	_ = pc
	// Adam can't see Priya's join requests (only the invite's person approves)
	a2 := NewAgentKeys(t, "sneaky")
	if r := a2.Join(c, priya.Invite(pr)); r.Status != 201 {
		t.Fatal(r)
	}
	hcA := adam.Check("approve_join", a2.ReqID)
	adam.Sync(room)
	e2 := room.Log.Build("member_add", adam.Dev, map[string]any{"member": newID(), "account": priya.AccountID, "name": "sneaky", "app": "claude-code", "ed": a2.Key.Hex(), "x": hexs(a2.X)})
	if r := adam.Do("POST", "/app/v1/join-requests/"+a2.ReqID+"/approve", map[string]any{"human_check": map[string]any{"id": hcA, "stub": true}, "roster_entry": e2}); r.Status != 404 {
		t.Fatalf("owner approving someone else's chat: %s", r)
	}
	// Priya leaves the room (person_remove signed by her own device): her chat goes with her
	priya.Sync(pr)
	leave := pr.Log.Build("person_remove", priya.Dev, map[string]any{"account": priya.AccountID})
	if r := priya.Do("POST", "/app/v1/rooms/"+room.ID+"/roster", map[string]any{"roster_entry": leave}); r.Status != 200 {
		t.Fatalf("leave room: %s", r)
	}
	if count(t, c, `select count(*) from members where room_id = $1 and account_id = $2 and removed_at is null`, room.ID, priya.AccountID) != 0 ||
		count(t, c, `select count(*) from join_requests where id = $1 and status = 'cancelled'`, a2.ReqID) != 1 {
		t.Fatal("person removal effects missing")
	}
	if r := adam.Do("GET", "/app/v1/rooms/"+room.ID+"/activity", nil); !strings.Contains(string(r.Body), "person_left") || strings.Contains(string(r.Body), "envelope") {
		t.Fatalf("activity: %s", r)
	}
}

// A new browser for a person already in rooms → new_device attention; certify from the first browser.
func TestDeviceCertify(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A")
	adam := NewPerson(t, c, "Adam")
	r1 := adam.CreateRoom("one")
	r2 := adam.CreateRoom("two")
	// second browser: same account, new device key
	b2 := adam.On(c)
	b2.Dev = testkit.NewKey()
	b2.DevID = newID()
	if r := b2.Do("POST", "/app/v1/devices", map[string]any{"id": b2.DevID, "ed25519_pk": b2.Dev.Hex(), "label": "Chrome on Pixel"}); r.Status != 201 || r.J["pending_rooms"].(float64) != 2 {
		t.Fatal(r)
	}
	ny := adam.Do("GET", "/app/v1/needs-you", nil)
	att := ny.J["attention"].([]any)
	if len(att) != 1 || att[0].(map[string]any)["kind"] != "new_device" {
		t.Fatalf("attention: %s", ny)
	}
	pend := adam.Do("GET", "/app/v1/devices/"+b2.DevID+"/pending-rooms", nil)
	if len(pend.J["rooms"].([]any)) != 2 {
		t.Fatal(pend)
	}
	// the new browser can't sign yet
	b2.Sync(r1)
	if r := b2.Do("POST", "/app/v1/rooms/"+r1.ID+"/roster", map[string]any{"roster_entry": r1.Log.Build("device_remove", b2.Dev, map[string]any{"account": adam.AccountID, "device": adam.Dev.Hex()})}); r.Code() != "not_signer" {
		t.Fatalf("uncertified browser signing: %s", r)
	}
	var entries []map[string]any
	for _, rm := range []*Room{r1, r2} {
		adam.Sync(rm)
		entries = append(entries, map[string]any{"room_id": rm.ID, "roster_entry": rm.Log.Build("device_add", adam.Dev, map[string]any{"account": adam.AccountID, "device": b2.Dev.Hex(), "label": "Chrome on Pixel"})})
	}
	// all-or-nothing: make r2's entry stale by appending something first → 409 naming r2, nothing applied
	stale := []map[string]any{entries[0], {"room_id": r2.ID, "roster_entry": r2.Log.BuildAt(0, nil, "device_add", adam.Dev, map[string]any{"account": adam.AccountID, "device": b2.Dev.Hex(), "label": "x"})}}
	hc := adam.Check("approve_device", b2.DevID)
	r := adam.Do("POST", "/app/v1/devices/"+b2.DevID+"/certify", map[string]any{"human_check": map[string]any{"id": hc, "stub": true}, "entries": stale})
	if r.Status != 400 && r.Code() != "roster_conflict" {
		t.Fatalf("stale certify: %s", r)
	}
	if count(t, c, `select count(*) from room_signers where ed25519_pk = $1`, []byte(b2.Dev.Pub)) != 0 {
		t.Fatal("partial certify applied")
	}
	// the same human check is reusable after a rolled-back approve
	if r := adam.Do("POST", "/app/v1/devices/"+b2.DevID+"/certify", map[string]any{"human_check": map[string]any{"id": hc, "stub": true}, "entries": entries}); r.Status != 200 {
		t.Fatalf("certify: %s", r)
	}
	if d := b2.Do("GET", "/app/v1/me?device_id="+b2.DevID, nil); d.J["device"].(map[string]any)["certified_rooms"].(float64) != 2 {
		t.Fatal(d)
	}
	if len(adam.Do("GET", "/app/v1/needs-you", nil).J["attention"].([]any)) != 0 {
		t.Fatal("new_device attention not resolved")
	}
	// the human check is single use
	if r := adam.Do("POST", "/app/v1/devices/"+b2.DevID+"/certify", map[string]any{"human_check": map[string]any{"id": hc, "stub": true}, "entries": []any{}}); r.Code() != "human_check_failed" {
		t.Fatalf("reused human check: %s", r)
	}
}

// Always-on: verify challenge, push secret once, content-free signed pushes, retries.
func TestAlwaysOnPush(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A", allowLoopback)
	adam := NewPerson(t, c, "Adam")
	room := adam.CreateRoom("push")
	s := adam.Member(c, room, "s")
	svc := adam.Member(c, room, "svc")
	pr := newPushReceiver(t)
	tr := svc.Do(c, "PUT", "/api/v1/me/turn", map[string]any{"turn": "always_on", "url": pr.srv.URL + "/in"})
	if tr.Status != 200 || len(tr.Str("push_secret")) != 64 {
		t.Fatal(tr)
	}
	sec, _ := hex.DecodeString(tr.Str("push_secret"))
	pr.mu.Lock()
	pr.secret = sec
	pr.mu.Unlock()
	if me := svc.Do(c, "GET", "/api/v1/me", nil); strings.Contains(string(me.Body), tr.Str("push_secret")) || me.Str("turn") != "always_on" {
		t.Fatal("secret shown again or turn not set")
	}
	if ro := s.Do(c, "GET", "/api/v1/me/roster", nil); !strings.Contains(string(ro.Body), `"always on"`) {
		t.Fatalf("turn label: %s", ro)
	}
	id, _ := s.Send(c, svc)
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		pr.mu.Lock()
		n := len(pr.got)
		pr.mu.Unlock()
		if n > 0 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	pr.mu.Lock()
	defer pr.mu.Unlock()
	if len(pr.got) != 1 || pr.badSig != 0 {
		t.Fatalf("pushes %d, bad sigs %d", len(pr.got), pr.badSig)
	}
	p := pr.got[0]
	if p["type"] != "message" || p["member_id"] != svc.ID || p["message_ids"].([]any)[0] != id {
		t.Fatalf("push body %v", p)
	}
	for k := range p {
		if k != "v" && k != "type" && k != "member_id" && k != "room_id" && k != "message_ids" && k != "push_id" && k != "attempt" && k != "at" {
			t.Fatalf("push carries %q", k)
		}
	}
	// a receiver that fails → retried with backoff, then failed after 6 tries
	fail := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var m map[string]any
		_ = json.NewDecoder(r.Body).Decode(&m)
		if m["type"] == "verify" {
			_, _ = w.Write([]byte(`{"challenge":"` + m["challenge"].(string) + `"}`))
			return
		}
		w.WriteHeader(500)
	}))
	defer fail.Close()
	if r := svc.Do(c, "PUT", "/api/v1/me/turn", map[string]any{"turn": "always_on", "url": fail.URL}); r.Status != 200 {
		t.Fatal(r)
	}
	id2, _ := s.Send(c, svc)
	for try := 1; try <= 6; try++ {
		exec(t, c, `update push_jobs set next_attempt_at = now() where message_id = $1 and not done`, id2)
		if _, err := c.S.Worker.Once(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	var tries int
	var done, failed bool
	if err := c.Pool.QueryRow(context.Background(), `select tries, done, failed from push_jobs where message_id = $1`, id2).Scan(&tries, &done, &failed); err != nil {
		t.Fatal(err)
	}
	if tries != 6 || !done || !failed {
		t.Fatalf("tries %d done %v failed %v", tries, done, failed)
	}
	if count(t, c, `select count(*) from deliveries where message_id = $1 and state = 'queued'`, id2) != 1 {
		t.Fatal("a failed push must leave the message waiting")
	}
	// back to wake
	if r := svc.Do(c, "PUT", "/api/v1/me/turn", map[string]any{"turn": "wake"}); r.Status != 200 {
		t.Fatal(r)
	}
}

// Sweeper: expired copies → expired + expired_unread notice to the sender; join requests expire; purge.
func TestSweeper(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A")
	adam := NewPerson(t, c, "Adam")
	room := adam.CreateRoom("sweep")
	s := adam.Member(c, room, "s")
	r := adam.Member(c, room, "r")
	s.Drain(c)
	id := inject(t, c, s, r)
	shown := inject(t, c, s, r)
	exec(t, c, `update deliveries set expires_at = now() - interval '1 second' where message_id = $1`, id)
	exec(t, c, `update deliveries set state = 'shown', shown_at = now(), purge_after = now() - interval '1 second' where message_id = $1`, shown)
	pending := NewAgentKeys(t, "late")
	pending.Join(c, adam.Invite(room))
	exec(t, c, `update join_requests set expires_at = now() - interval '1 second' where id = $1`, pending.ReqID)
	sw := &sweeper.Sweeper{Pool: c.Pool}
	ran, err := sw.Once(context.Background())
	if err != nil || !ran {
		t.Fatalf("sweep ran=%v err=%v", ran, err)
	}
	if count(t, c, `select count(*) from deliveries where message_id = $1 and state = 'expired' and envelope is null`, id) != 1 ||
		count(t, c, `select count(*) from deliveries where message_id = $1 and envelope is null`, shown) != 1 ||
		count(t, c, `select count(*) from join_requests where id = $1 and status = 'expired'`, pending.ReqID) != 1 {
		t.Fatal("sweep effects missing")
	}
	lr := s.Lease(c, 0)
	if !strings.Contains(string(lr.Body), `"expired_unread"`) || !strings.Contains(string(lr.Body), id) {
		t.Fatalf("no expired_unread notice: %s", lr)
	}
	if w := pending.Do(c, "POST", "/api/v1/join-requests/"+pending.ReqID+"/wait", map[string]any{"wait_s": 0}); w.Str("status") != "expired" {
		t.Fatal(w)
	}
	// only one copy sweeps at a time: hold the lock elsewhere → Once doesn't run
	conn, _ := c.Pool.Acquire(context.Background())
	defer conn.Release()
	conn.Exec(context.Background(), `select pg_advisory_lock(hashtext('botlink-sweeper'))`)
	if ran, _ := sw.Once(context.Background()); ran {
		t.Fatal("second sweeper ran while the lock was held")
	}
	conn.Exec(context.Background(), `select pg_advisory_unlock(hashtext('botlink-sweeper'))`)
}

// Send-side errors: recipients_changed (stale fingerprint, missing recipient), no_recipients, rate
// limit, mailbox_full, superseded polls, wait/lease while not holder, handover + card + ask_human.
func TestSendErrorsAndMisc(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A")
	adam := NewPerson(t, c, "Adam")
	room := adam.CreateRoom("misc")
	s := adam.Member(c, room, "s")
	// alone in the room → no_recipients for a room send
	if r := s.Do(c, "POST", "/api/v1/messages", map[string]any{"id": newID(), "room_id": room.ID, "scope": "room", "in_reply_to": nil,
		"envelopes": []any{map[string]any{"to_member": newID(), "to_fp": "0000-0000-0000-0000", "envelope": s.Envelope(newID(), "room", newID(), "0000-0000-0000-0000", nil, time.Now().Unix()+600)}}}); r.Code() != "no_recipients" && r.Status != 400 {
		t.Fatal(r)
	}
	r1 := adam.Member(c, room, "r1")
	r2 := adam.Member(c, room, "r2")
	// room send missing r2 → recipients_changed with the current list
	id := newID()
	resp := s.Do(c, "POST", "/api/v1/messages", s.SendBody(id, true, []*Agent{r1}, nil))
	if resp.Code() != "recipients_changed" {
		t.Fatal(resp)
	}
	det := resp.J["error"].(map[string]any)["details"].(map[string]any)
	if len(det["recipients"].([]any)) != 2 {
		t.Fatalf("details: %v", det)
	}
	// same id re-sealed for both → stored (nothing was stored the first time)
	if r := s.Do(c, "POST", "/api/v1/messages", s.SendBody(id, true, []*Agent{r1, r2}, nil)); r.Status != 201 {
		t.Fatal(r)
	}
	// stale fingerprint
	stale := *r1
	stale.X = wire.RandBytes(32)
	if _, r := s.Send(c, &stale); r.Code() != "recipients_changed" {
		t.Fatal(r)
	}
	// wrong from_fp / bad signature / mismatched header → 400
	body := s.SendBody(newID(), false, []*Agent{r1}, nil)
	env := body["envelopes"].([]map[string]any)[0]["envelope"].(map[string]any)
	env["sig"] = strings.Repeat("00", 64)
	if r := s.Do(c, "POST", "/api/v1/messages", body); r.Status != 400 {
		t.Fatal(r)
	}
	// rate limit: 30/min per sender (counts committed sends)
	exec(t, c, `delete from rate_counters`)
	var last *Resp
	for i := 0; i < 31; i++ {
		_, last = s.Send(c, r1)
	}
	if last.Status != 429 || last.Code() != "rate_limited" || last.Header.Get("Retry-After") == "" {
		t.Fatalf("31st send: %s", last)
	}
	// mailbox_full at 1000 queued
	exec(t, c, `delete from rate_counters`)
	exec(t, c, `insert into messages (id, room_id, from_member, scope, to_member, request_hash, recipients, expires_at)
		select gen_random_uuid(), $1, $2, 'member', $3, decode(md5(g::text) || md5(g::text), 'hex'), 1, now() + interval '1 hour' from generate_series(1, 1000) g`, room.ID, r1.ID, r2.ID)
	exec(t, c, `insert into deliveries (message_id, member_id, key_epoch, envelope, expires_at)
		select id, $2, 1, $3, now() + interval '1 hour' from messages where from_member = $1 and to_member = $2`, r1.ID, r2.ID, fakeEnvelope)
	if _, r := s.Send(c, r2); r.Code() != "mailbox_full" {
		t.Fatal(r)
	}
	// superseded: a third open lease poll on one copy ends the oldest
	r1.Drain(c)
	exec(t, c, `update deliveries set state = 'shown', shown_at = now() where member_id = $1 and state = 'queued'`, r1.ID)
	var wg sync.WaitGroup
	res := make([]*Resp, 3)
	for i := range 3 {
		wg.Add(1)
		go func() { defer wg.Done(); res[i] = r1.Lease(c, 3) }()
		time.Sleep(150 * time.Millisecond)
	}
	wg.Wait()
	if res[0].Code() != "superseded" || res[1].Status != 200 || res[2].Status != 200 {
		t.Fatalf("superseded: %s / %s / %s", res[0], res[1], res[2])
	}
	// not holder: every member route needs the holder's session (r2, founder: a key is bound to its chat)
	other := *r1
	other.Session = "someone-else"
	for _, x := range []*Resp{other.Lease(c, 0), other.Do(c, "GET", "/api/v1/me/inbox/count", nil), other.Do(c, "GET", "/api/v1/me/inbox/recent", nil), other.Do(c, "POST", "/api/v1/me/wait", map[string]any{"wait_s": 0})} {
		if x.Code() != "not_holder" {
			t.Fatalf("not holder: %s", x)
		}
	}
	if w := r1.Do(c, "POST", "/api/v1/me/wait", map[string]any{"wait_s": 0}); w.Status != 200 || w.J["holder_session"] != r1.Session {
		t.Fatal(w)
	}
	// handover note (sealed to self) shows up in /me and claim
	note := r1.Envelope(newID(), "self", r1.ID, r1.FP(), nil, time.Now().Unix()+3600)
	if r := r1.Do(c, "PUT", "/api/v1/me/handover", map[string]any{"envelope": note}); r.Status != 200 {
		t.Fatal(r)
	}
	if r := other.Do(c, "PUT", "/api/v1/me/handover", map[string]any{"envelope": note}); r.Code() != "not_holder" {
		t.Fatal(r)
	}
	notSelf := r1.Envelope(newID(), "member", r2.ID, r2.FP(), nil, time.Now().Unix()+3600)
	if r := r1.Do(c, "PUT", "/api/v1/me/handover", map[string]any{"envelope": notSelf}); r.Status != 400 {
		t.Fatal(r)
	}
	// H1: another chat never takes the member with its key alone (it needs the person's approval)
	if cl := other.Do(c, "POST", "/api/v1/me/claim", map[string]any{"session_id": "someone-else"}); cl.Code() != "claim_needs_approval" {
		t.Fatalf("bare claim: %s", cl)
	}
	// the holder's own claim (same chat, e.g. after a restart) returns the handover note and what waits
	if cl := r1.Do(c, "POST", "/api/v1/me/claim", map[string]any{"session_id": r1.Session}); cl.J["handover"] == nil || cl.J["waiting"] == nil {
		t.Fatalf("claim: %s", cl)
	}
	other.Session = r1.Session
	// card + ask_human (deduped, 10/hour)
	if r := other.Do(c, "PUT", "/api/v1/me/card", map[string]any{"job": "new job", "machine": "laptop"}); r.Str("job") != "new job" {
		t.Fatal(r)
	}
	for i := 0; i < 10; i++ {
		if r := other.Do(c, "POST", "/api/v1/me/ask-human", map[string]any{"reason": "needs_ok"}); r.Status != 200 {
			t.Fatal(r)
		}
	}
	if r := other.Do(c, "POST", "/api/v1/me/ask-human", map[string]any{"reason": "needs_ok"}); r.Status != 429 {
		t.Fatal(r)
	}
	if n := count(t, c, `select count(*) from attention where subject_id = $1 and kind = 'needs_you' and resolved_at is null`, r1.ID); n != 1 {
		t.Fatalf("needs_you items: %d", n)
	}
	// join request idempotency and name collisions
	x := NewAgentKeys(t, "r1")
	jb := map[string]any{"id": newID(), "kind": "join", "invite": adam.Invite(room), "name": "r1", "app": "codex", "turn": "on_turn",
		"ed25519_pk": x.Key.Hex(), "x25519_pk": hexs(x.X)}
	if r := x.Do(c, "POST", "/api/v1/join-requests", jb); r.Code() != "name_taken" || r.J["error"].(map[string]any)["details"].(map[string]any)["suggestion"] != "r1-2" {
		t.Fatal(r)
	}
	jb["name"] = "fresh"
	if r := x.Do(c, "POST", "/api/v1/join-requests", jb); r.Status != 201 {
		t.Fatal(r)
	}
	if r := x.Do(c, "POST", "/api/v1/join-requests", jb); r.Status != 200 {
		t.Fatalf("idempotent join: %s", r)
	}
	jb["job"] = "different"
	if r := x.Do(c, "POST", "/api/v1/join-requests", jb); r.Code() != "id_conflict" {
		t.Fatal(r)
	}
	// reject → the chat learns it
	if r := adam.Do("POST", "/app/v1/join-requests/"+jb["id"].(string)+"/reject", nil); r.Status != 200 {
		t.Fatal(r)
	}
	if w := x.Do(c, "POST", "/api/v1/join-requests/"+jb["id"].(string)+"/wait", map[string]any{"wait_s": 0}); w.Str("status") != "rejected" {
		t.Fatal(w)
	}
	// someone else's key can't wait on it
	y := NewAgentKeys(t, "y")
	if r := y.Do(c, "POST", "/api/v1/join-requests/"+jb["id"].(string)+"/wait", map[string]any{"wait_s": 0}); r.Status != 403 {
		t.Fatal(r)
	}
	// invite off → invite_invalid; renew → new code, count reset
	adam.Do("POST", "/app/v1/rooms/"+room.ID+"/chat-invite", map[string]any{"action": "off"})
	if r := y.Join(c, adam.Invite(room)); r.Code() != "invite_invalid" {
		t.Fatal(r)
	}
	rn := adam.Do("POST", "/app/v1/rooms/"+room.ID+"/chat-invite", map[string]any{"action": "renew"})
	if rn.J["use_count"].(float64) != 0 || rn.J["off"] != false {
		t.Fatal(rn)
	}
}

// SSE: the dashboard gets "changed" when something for the person changes.
func TestEventsSSE(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A")
	adam := NewPerson(t, c, "Adam")
	room := adam.CreateRoom("sse")
	req, _ := http.NewRequest("GET", c.URL+"/app/v1/events", nil)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req = req.WithContext(ctx)
	res, err := adam.Client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.Header.Get("Content-Type") != "text/event-stream" {
		t.Fatal(res.Header)
	}
	events := make(chan string, 10)
	go func() {
		sc := bufio.NewScanner(res.Body)
		for sc.Scan() {
			if strings.HasPrefix(sc.Text(), "event: ") {
				events <- sc.Text()
			}
		}
	}()
	time.Sleep(100 * time.Millisecond)
	NewAgentKeys(t, "bell").Join(c, adam.Invite(room))
	select {
	case e := <-events:
		if e != "event: changed" {
			t.Fatal(e)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("no SSE event for a new join request")
	}
}

// OAuth (fake GitHub + Google): PKCE round trip, verified email required, linking by email.
func TestOAuth(t *testing.T) {
	type tok struct{ verifier, challenge string }
	var mu sync.Mutex
	codes := map[string]tok{}
	verified := true
	fake := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/token":
			_ = r.ParseForm()
			mu.Lock()
			tk := codes[r.Form.Get("code")]
			mu.Unlock()
			if tk.challenge == "" || pkce(r.Form.Get("code_verifier")) != tk.challenge || r.Form.Get("client_secret") != "sec" {
				w.WriteHeader(400)
				_, _ = w.Write([]byte(`{"error":"invalid_grant"}`))
				return
			}
			_, _ = w.Write([]byte(`{"access_token":"at-1","token_type":"bearer"}`))
		case "/user":
			_, _ = w.Write([]byte(`{"id":4242,"login":"adamgh","name":"Adam GH","avatar_url":"https://avatars.githubusercontent.com/u/1"}`))
		case "/user/emails":
			_, _ = w.Write([]byte(`[{"email":"adam@acme.dev","primary":true,"verified":` + map[bool]string{true: "true", false: "false"}[verified] + `}]`))
		case "/userinfo":
			_, _ = w.Write([]byte(`{"sub":"g-1","email":"Adam@acme.dev","email_verified":true,"name":"Adam G"}`))
		}
	}))
	defer fake.Close()
	c := StartCopy(t, NewDB(t), "A", func(cfg *config.Config) {
		cfg.GitHubClientID, cfg.GitHubSecret, cfg.GoogleClientID, cfg.GoogleSecret = "id", "sec", "gid", "sec"
	})
	setFakeEndpoints(c, fake.URL)
	if r := doRaw(t, mustReq("GET", c.URL+"/app/v1/auth/providers")); len(r.J["providers"].([]any)) != 3 {
		t.Fatal(r)
	}
	login := func(provider string) (*http.Response, *http.Client) {
		jar := newJar()
		cl := &http.Client{Jar: jar, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
		res, err := cl.Get(c.URL + "/app/v1/auth/" + provider + "/start?return_to=/rooms/x")
		if err != nil || res.StatusCode != 302 {
			t.Fatalf("start: %v %v", err, res)
		}
		loc, _ := url.Parse(res.Header.Get("Location"))
		q := loc.Query()
		if q.Get("code_challenge_method") != "S256" || q.Get("redirect_uri") != c.URL+"/app/v1/auth/"+provider+"/callback" {
			t.Fatalf("auth url %s", loc)
		}
		code := "code-" + newID()
		mu.Lock()
		codes[code] = tok{challenge: q.Get("code_challenge")}
		mu.Unlock()
		res, err = cl.Get(c.URL + "/app/v1/auth/" + provider + "/callback?code=" + code + "&state=" + url.QueryEscape(q.Get("state")))
		if err != nil {
			t.Fatal(err)
		}
		return res, cl
	}
	res, cl := login("github")
	if res.StatusCode != 302 || res.Header.Get("Location") != "/rooms/x" {
		t.Fatalf("callback: %d %s", res.StatusCode, res.Header.Get("Location"))
	}
	me, _ := cl.Get(c.URL + "/app/v1/me")
	var m map[string]any
	_ = json.NewDecoder(me.Body).Decode(&m)
	me.Body.Close()
	acct := m["account"].(map[string]any)
	if acct["email"] != "adam@acme.dev" {
		t.Fatal(m)
	}
	// Google with the same email links to the same account
	res, cl2 := login("google")
	me2, _ := cl2.Get(c.URL + "/app/v1/me")
	var m2 map[string]any
	_ = json.NewDecoder(me2.Body).Decode(&m2)
	me2.Body.Close()
	if res.StatusCode != 302 || m2["account"].(map[string]any)["id"] != acct["id"] {
		t.Fatalf("google did not link: %v", m2)
	}
	if count(t, c, `select count(*) from identities where account_id = $1`, acct["id"]) != 2 {
		t.Fatal("identities not linked")
	}
	// unverified email → 400 page, no session
	verified = false
	res, _ = login("github")
	if res.StatusCode != 400 {
		t.Fatalf("unverified: %d", res.StatusCode)
	}
	// replayed state → refused
	res2, err := http.Get(c.URL + "/app/v1/auth/github/callback?code=x&state=bogus")
	if err != nil || res2.StatusCode != 400 {
		t.Fatal("bogus state accepted")
	}
	res2.Body.Close()
}

func pkce(v string) string { return auth.PKCEChallenge(v) }

func newJar() http.CookieJar { j, _ := cookiejar.New(nil); return j }

func setFakeEndpoints(c *Copy, base string) {
	gh := c.S.App.Providers["github"].(*auth.GitHub)
	gh.AuthURLBase, gh.TokenURL, gh.APIBase = base+"/authorize", base+"/token", base
	g := c.S.App.Providers["google"].(*auth.Google)
	g.AuthURLBase, g.TokenURL, g.UserInfoURL = base+"/authorize", base+"/token", base+"/userinfo"
}
