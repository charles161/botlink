package test

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/charles161/botlink/server/internal/roster"
	"github.com/charles161/botlink/server/internal/wire"
)

// M1 + M2 server side: room → invite → join → approve → roster verifies → send → lease → ack → recent.
func TestFlowJoinSendReceive(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A")
	adam := NewPerson(t, c, "Adam")
	room := adam.CreateRoom("acme")

	// idempotent create: same id + same genesis → 200
	r := adam.Do("POST", "/app/v1/rooms", map[string]any{"id": room.ID, "name": "acme", "genesis": room.Log.Entries[0]})
	if r.Status != 200 {
		t.Fatalf("duplicate create: %s", r)
	}

	inv := adam.Invite(room)
	if !strings.Contains(inv, "/i/acme-") {
		t.Fatalf("invite url %s", inv)
	}
	// agent preview (unsigned)
	code := inv[strings.LastIndex(inv, "/")+1:]
	if r := doRaw(t, mustReq("GET", c.URL+"/api/v1/invites/"+code)); r.Status != 200 || r.J["member_count"] != float64(0) || r.J["inviter_name"] != nil {
		t.Fatalf("invite preview: %s", r)
	}
	// markdown + html invite pages
	md := mustReq("GET", c.URL+"/i/"+code)
	md.Header.Set("Accept", "text/markdown")
	if r := doRaw(t, md); r.Status != 200 || !strings.Contains(string(r.Body), "/dl/botlink.tgz join ") {
		t.Fatalf("invite md: %s", r)
	}

	bug := NewAgentKeys(t, "bugfix")
	jr := bug.Join(c, inv)
	if jr.Status != 201 || jr.Str("status") != "pending" || jr.Str("fingerprint") != bug.FP() {
		t.Fatalf("join: %s", jr)
	}
	// wait returns pending on timeout
	if w := bug.Do(c, "POST", "/api/v1/join-requests/"+bug.ReqID+"/wait", map[string]any{"wait_s": 0}); w.Str("status") != "pending" {
		t.Fatalf("wait: %s", w)
	}
	// a long wait returns as soon as Adam approves
	done := make(chan *Resp, 1)
	go func() {
		done <- bug.Do(c, "POST", "/api/v1/join-requests/"+bug.ReqID+"/wait", map[string]any{"wait_s": 20})
	}()
	time.Sleep(200 * time.Millisecond)
	start := time.Now()
	if r := adam.Approve(room, bug); r.Status != 200 {
		t.Fatalf("approve: %s", r)
	}
	w := <-done
	if w.Str("status") != "approved" || w.Str("member_id") != bug.ID || time.Since(start) > 2*time.Second {
		t.Fatalf("wait after approve: %s after %v", w, time.Since(start))
	}
	// second approve → already_decided
	hc := adam.Check("approve_join", bug.ReqID)
	adam.Sync(room)
	if r := adam.Do("POST", "/app/v1/join-requests/"+bug.ReqID+"/approve", map[string]any{"human_check": map[string]any{"id": hc, "stub": true},
		"roster_entry": room.Log.Build("member_add", adam.Dev, map[string]any{"member": bug.ID, "account": adam.AccountID, "name": "bugfix", "app": "claude-code", "ed": bug.Key.Hex(), "x": "00"})}); r.Code() != "already_decided" {
		t.Fatalf("double approve: %s", r)
	}

	// the agent verifies the roster and finds its own member_add signed by Adam's device (self-check)
	ro := bug.Do(c, "GET", "/api/v1/me/roster", nil)
	var ws []roster.Wire
	_ = json.Unmarshal(mustJSON(ro.J["entries"]), &ws)
	st, err := roster.Replay(room.ID, ws)
	if err != nil {
		t.Fatal(err)
	}
	m := st.Members[bug.ID]
	if m == nil || m.Ed != bug.Key.Hex() || !st.IsDeviceOf(adam.Dev.Hex(), adam.AccountID) {
		t.Fatal("self-check failed")
	}
	if me := bug.Do(c, "GET", "/api/v1/me", nil); me.Str("fingerprint") != bug.FP() || me.J["holder_session"] != bug.Session {
		t.Fatalf("me: %s", me)
	}

	// a second chat; then send both ways
	dep := adam.Member(c, room, "deployer")
	msgID, sr := bug.Send(c, dep)
	if sr.Status != 201 || sr.J["recipients"].(float64) != 1 {
		t.Fatalf("send: %s", sr)
	}
	// stale roster notice for bugfix (deployer joined) → lease returns it
	lr := dep.Lease(c, 0)
	ds := deliveries(lr)
	if len(ds) != 1 || ds[0]["message_id"] != msgID || ds[0]["from_member"] != bug.ID || ds[0]["attempt"].(float64) != 1 {
		t.Fatalf("lease: %s", lr)
	}
	// leased rows are invisible to a second poll
	if l2 := dep.Lease(c, 0); len(deliveries(l2)) != 0 {
		t.Fatalf("leased row visible again: %s", l2)
	}
	ack := dep.Do(c, "POST", "/api/v1/me/inbox/ack", map[string]any{"items": []map[string]any{{"message_id": msgID, "action": "shown"}}})
	if ack.Status != 200 || ack.J["items"].([]any)[0].(map[string]any)["state"] != "shown" {
		t.Fatalf("ack: %s", ack)
	}
	rec := dep.Do(c, "GET", "/api/v1/me/inbox/recent?after_seq=0&limit=5", nil)
	if len(deliveries(rec)) != 1 {
		t.Fatalf("recent: %s", rec)
	}
	// reply marks only deployer's own copy done
	reply := wire.NewV7().String()
	in := msgID
	if r := dep.Do(c, "POST", "/api/v1/messages", dep.SendBody(reply, false, []*Agent{bug}, &in)); r.Status != 201 {
		t.Fatalf("reply: %s", r)
	}
	if n := count(t, c, `select count(*) from deliveries where message_id = $1 and member_id = $2 and state = 'done'`, msgID, dep.ID); n != 1 {
		t.Fatal("reply did not mark the replier's own copy done")
	}
	// count + notices
	if r := bug.Do(c, "GET", "/api/v1/me/inbox/count", nil); r.J["queued"].(float64) != 1 {
		t.Fatalf("count: %s", r)
	}
	// dashboard views
	if r := adam.Do("GET", "/app/v1/rooms/"+room.ID+"?device_id="+adam.DevID, nil); r.Status != 200 || r.J["my_device_certified"] != true ||
		len(r.J["members"].([]any)) != 2 {
		t.Fatalf("room detail: %s", r)
	}
	if r := adam.Do("GET", "/app/v1/rooms/"+room.ID+"/activity", nil); r.Status != 200 || len(r.J["items"].([]any)) < 4 {
		t.Fatalf("activity: %s", r)
	}
	for _, p := range []string{"/app/v1/rooms", "/app/v1/devices", "/app/v1/needs-you", "/app/v1/me?device_id=" + adam.DevID,
		"/app/v1/rooms/" + room.ID + "/roster", "/app/v1/auth/providers", "/app/v1/devices/" + adam.DevID + "/pending-rooms"} {
		if r := adam.Do("GET", p, nil); r.Status != 200 {
			t.Fatalf("GET %s: %s", p, r)
		}
	}
}

func mustReq(method, u string) *http.Request {
	r, err := http.NewRequest(method, u, nil)
	if err != nil {
		panic(err)
	}
	return r
}
