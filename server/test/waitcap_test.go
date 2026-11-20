package test

// Open-wait cap (scale prep 2026-11-12, commit 2cab158 on branch scale-prep, picked by the fix-all LIMITS lane): a
// per-copy cap on open waits. At the cap a new wait gets a calm 503 high_load with Retry-After, /readyz says full (a
// load balancer steers new traffic away), responses say X-Botlink-Load: high; a quick look (wait_s 0) and reading
// messages still work. The test is item 4 of scale-prep's server/test/scale_test.go, unchanged.

import (
	"context"
	"io"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/charles161/botlink/server/internal/config"
)

func TestScaleWaitCapHighLoad(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A", func(cfg *config.Config) { cfg.MaxWaits = 1 })
	adam := NewPerson(t, c, "Adam")
	room := adam.CreateRoom("cap")
	lead := adam.Member(c, room, "lead")
	tester := adam.Member(c, room, "tester")
	lead.Drain(c)
	tester.Drain(c)
	ready := func() (int, string) {
		res, err := http.Get(c.URL + "/readyz")
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		b, _ := io.ReadAll(res.Body)
		return res.StatusCode, string(b)
	}
	if st, _ := ready(); st != 200 {
		t.Fatalf("readyz before: %d", st)
	}
	done := make(chan *Resp, 1)
	go func() { done <- tester.Do(c, "POST", "/api/v1/me/wait", map[string]any{"wait_s": 3}) }()
	deadline := time.Now().Add(2 * time.Second)
	for c.S.Load.Open() < 1 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if c.S.M.OpenWaits.Value() != 1 || c.S.M.WaitUtilisation.Value() != 100 || c.S.M.MaxWaits.Value() != 1 {
		t.Fatalf("gauges: open %d util %d max %d", c.S.M.OpenWaits.Value(), c.S.M.WaitUtilisation.Value(), c.S.M.MaxWaits.Value())
	}
	r := lead.Do(c, "POST", "/api/v1/me/wait", map[string]any{"wait_s": 10})
	if r.Status != 503 || r.Code() != "high_load" {
		t.Fatalf("wait at the cap: %s", r)
	}
	ra, _ := strconv.Atoi(r.Header.Get("Retry-After"))
	if ra < 20 || ra > 40 {
		t.Fatalf("Retry-After %q, want 20..40", r.Header.Get("Retry-After"))
	}
	if r.Header.Get("X-Botlink-Load") != "high" {
		t.Fatalf("X-Botlink-Load %q", r.Header.Get("X-Botlink-Load"))
	}
	if msg := r.J["error"].(map[string]any)["message"].(string); !strings.Contains(msg, "busier than usual") {
		t.Fatalf("message: %q", msg)
	}
	if lr := lead.Do(c, "POST", "/api/v1/me/inbox/lease", map[string]any{"wait_s": 5}); lr.Status != 503 || lr.Code() != "high_load" {
		t.Fatalf("long lease at the cap: %s", lr)
	}
	// a quick look and reading messages are never turned away
	if w := lead.Do(c, "POST", "/api/v1/me/wait", map[string]any{"wait_s": 0}); w.Status != 200 {
		t.Fatalf("wait_s 0 at the cap: %s", w)
	}
	if lr := lead.Lease(c, 0); lr.Status != 200 {
		t.Fatalf("lease wait_s 0 at the cap: %s", lr)
	}
	if st, body := ready(); st != 503 || !strings.Contains(body, "full") {
		t.Fatalf("readyz at the cap: %d %s", st, body)
	}
	if _, n := c.S.Errors.Recent(); n != 0 {
		t.Fatalf("high_load answers recorded as server errors: %d", n)
	}
	<-done
	deadline = time.Now().Add(2 * time.Second)
	for c.S.Load.Open() > 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if st, _ := ready(); st != 200 {
		t.Fatalf("readyz after: %d", st)
	}
	if w := lead.Do(c, "POST", "/api/v1/me/wait", map[string]any{"wait_s": 1}); w.Status != 200 || w.Header.Get("X-Botlink-Load") != "" {
		t.Fatalf("wait after: %s %q", w, w.Header.Get("X-Botlink-Load"))
	}
}

// The join wait takes a slot of the same cap (join.go, merged with the session move of 9253018): at the cap a long
// join wait is turned away with high_load, but the pending request has already moved to the chat's current session;
// a quick look (wait_s 0) still answers.
func TestWaitCapJoinWait(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A", func(cfg *config.Config) { cfg.MaxWaits = 1 })
	adam := NewPerson(t, c, "Adam")
	room := adam.CreateRoom("capjoin")
	tester := adam.Member(c, room, "tester")
	tester.Drain(c)
	bug := NewAgentKeys(t, "bugfix")
	if jr := bug.Join(c, adam.Invite(room)); jr.Status != 201 {
		t.Fatalf("join: %s", jr)
	}
	done := make(chan *Resp, 1)
	go func() { done <- tester.Do(c, "POST", "/api/v1/me/wait", map[string]any{"wait_s": 3}) }()
	deadline := time.Now().Add(2 * time.Second)
	for c.S.Load.Open() < 1 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	r := bug.Do(c, "POST", "/api/v1/join-requests/"+bug.ReqID+"/wait", map[string]any{"wait_s": 10, "session_id": "sess-moved-1"})
	if r.Status != 503 || r.Code() != "high_load" {
		t.Fatalf("join wait at the cap: %s", r)
	}
	var got string
	if err := c.Pool.QueryRow(context.Background(), `select coalesce(session_id, '') from join_requests where id = $1`, bug.ReqID).Scan(&got); err != nil || got != "sess-moved-1" {
		t.Fatalf("session not moved before the cap answered: %q", got)
	}
	if w := bug.Do(c, "POST", "/api/v1/join-requests/"+bug.ReqID+"/wait", map[string]any{"wait_s": 0}); w.Status != 200 || w.Str("status") != "pending" {
		t.Fatalf("quick look at the cap: %s", w)
	}
	<-done
}
