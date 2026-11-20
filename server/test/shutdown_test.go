package test

import (
	"bufio"
	"context"
	"net/http"
	"strings"
	"testing"
	"time"
)

// Week-1 item: a restart must not cut open waits. Shutdown first tells every long-poll (me/wait, inbox lease, join
// wait) and dashboard event stream to end now, each with its normal answer ("nothing yet" / still pending / stream
// closed), so http.Server.Shutdown finishes at once instead of hitting its deadline ("context deadline exceeded").
func TestGracefulShutdownEndsWaits(t *testing.T) {
	c, adam, room, lead, tester := r2Room(t)
	newbie := NewAgentKeys(t, "newbie")
	if r := newbie.Join(c, adam.Invite(room)); r.Status != 201 {
		t.Fatal(r)
	}
	type res struct {
		name string
		r    *Resp
		d    time.Duration
	}
	out := make(chan res, 4)
	hold := func(name string, f func() *Resp) {
		go func() { s := time.Now(); r := f(); out <- res{name, r, time.Since(s)} }()
	}
	hold("wait", func() *Resp { return tester.Do(c, "POST", "/api/v1/me/wait", map[string]any{"wait_s": 50}) })
	hold("lease", func() *Resp { return lead.Do(c, "POST", "/api/v1/me/inbox/lease", map[string]any{"wait_s": 50}) })
	hold("join", func() *Resp {
		return newbie.Do(c, "POST", "/api/v1/join-requests/"+newbie.ReqID+"/wait", map[string]any{"wait_s": 50})
	})
	// the dashboard's event stream
	req, _ := http.NewRequest("GET", c.URL+"/app/v1/events", nil)
	sse, err := adam.Client.Do(req)
	if err != nil || sse.StatusCode != 200 {
		t.Fatalf("events: %v %v", err, sse)
	}
	sseDone := make(chan struct{})
	go func() {
		sc := bufio.NewScanner(sse.Body)
		for sc.Scan() {
		}
		close(sseDone)
	}()
	time.Sleep(700 * time.Millisecond) // all four are holding

	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	start := time.Now()
	if err := c.S.Shutdown(ctx, c.TS.Config); err != nil {
		t.Fatalf("shutdown: %v after %s", err, time.Since(start))
	}
	if d := time.Since(start); d > 3*time.Second {
		t.Fatalf("shutdown took %s: the waits were not ended", d)
	}
	for i := 0; i < 3; i++ {
		select {
		case r := <-out:
			if r.r.Status != 200 {
				t.Fatalf("%s ended with %s", r.name, r.r)
			}
			switch r.name {
			case "wait":
				if r.r.J["count"] != float64(0) {
					t.Fatalf("wait: %s", r.r)
				}
			case "join":
				if r.r.Str("status") != "pending" {
					t.Fatalf("join wait: %s", r.r)
				}
			case "lease":
				if !strings.Contains(string(r.r.Body), "{") {
					t.Fatalf("lease: %s", r.r)
				}
			}
		case <-time.After(3 * time.Second):
			t.Fatal("a wait was still open after shutdown")
		}
	}
	select {
	case <-sseDone:
	case <-time.After(3 * time.Second):
		t.Fatal("the event stream was still open after shutdown")
	}
}
