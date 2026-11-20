package test

import (
	"bufio"
	"context"
	"fmt"
	"net"
	"net/http"
	"os"
	osexec "os/exec"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/charles161/botlink/server/internal/wake"
)

// PLAN §5.4 / T4. Two copies on one database. R polls on B in a loop; S sends 20 messages on A 300 ms
// apart; after message 10 B's LISTEN connection is terminated. Pass: 20/20 received exactly once;
// commit→return ≤ 1 s except messages committed while B's listener was down (≤ 3 s); B's /readyz goes
// 503 then 200; B's botlink_listen_reconnects_total = 1. Run with lease and with wait (watch-style).
//
// Default: both copies in this process (separate pools, separate LISTEN connections). With
// BOTLINK_TWOCOPY_BIN set (make twocopy): two real processes on :8811 and :8812.
func TestTwoCopyLease(t *testing.T) { twoCopy(t, "lease") }
func TestTwoCopyWait(t *testing.T)  { twoCopy(t, "wait") }

type copyPair struct {
	a, b        *Copy
	reconnectsB func() int
	listenerApp string
}

func twoCopy(t *testing.T, mode string) {
	db := NewDB(t)
	var p copyPair
	if bin := os.Getenv("BOTLINK_TWOCOPY_BIN"); bin != "" {
		p = processPair(t, bin, db)
	} else {
		// hold B disconnected ~0.7-1 s so the message sent 300 ms after the kill commits inside the gap
		// and can only arrive through RingAll on reconnect (not through a NOTIFY, which is lost)
		old := wake.InitialBackoff
		wake.InitialBackoff = 1400 * time.Millisecond
		t.Cleanup(func() { wake.InitialBackoff = old })
		a := StartCopy(t, db, "A")
		b := StartCopy(t, db, "B")
		p = copyPair{a: a, b: b, listenerApp: b.S.Bus.AppName(),
			reconnectsB: func() int { return int(b.S.M.ListenReconnects.Value()) }}
	}
	adam := NewPerson(t, p.a, "Adam")
	room := adam.CreateRoom("twocopy")
	s := adam.Member(p.a, room, "sender")
	r := adam.Member(p.a, room, "receiver")
	r.Drain(p.b)

	const total = 20
	var mu sync.Mutex
	sentAt := map[string]time.Time{}
	recvAt := map[string]time.Time{}
	recvN := map[string]int{}
	var downFrom, downTo atomic.Int64 // unix nanos of B's listener outage (from terminate to readyz 200)

	stop := make(chan struct{})
	pollDone := make(chan struct{})
	go func() { // receiver on B
		defer close(pollDone)
		for {
			select {
			case <-stop:
				return
			default:
			}
			var ds []map[string]any
			var lr *Resp
			if mode == "wait" {
				w := r.Do(p.b, "POST", "/api/v1/me/wait", map[string]any{"wait_s": 5})
				if w.Status != 200 {
					t.Errorf("wait: %s", w)
					return
				}
				if w.J["count"].(float64) == 0 {
					continue
				}
				lr = r.Do(p.b, "POST", "/api/v1/me/inbox/lease", map[string]any{"wait_s": 0})
			} else {
				lr = r.Do(p.b, "POST", "/api/v1/me/inbox/lease", map[string]any{"wait_s": 5})
			}
			if lr.Status != 200 {
				t.Errorf("lease: %s", lr)
				return
			}
			now := time.Now()
			ds = deliveries(lr)
			r.AckNotices(p.b, lr)
			var items []map[string]any
			mu.Lock()
			for _, d := range ds {
				id := d["message_id"].(string)
				recvN[id]++
				if _, ok := recvAt[id]; !ok {
					recvAt[id] = now
				}
				items = append(items, map[string]any{"message_id": id, "action": "shown"})
			}
			mu.Unlock()
			if len(items) > 0 {
				r.Do(p.b, "POST", "/api/v1/me/inbox/ack", map[string]any{"items": items})
			}
		}
	}()
	time.Sleep(300 * time.Millisecond) // the poll is open on B

	var saw503, saw200After atomic.Bool
	readyDone := make(chan struct{})
	for i := 1; i <= total; i++ {
		start := time.Now()
		id, sr := s.Send(p.a, r)
		if sr.Status != 201 {
			t.Fatalf("send %d: %s", i, sr)
		}
		mu.Lock()
		sentAt[id] = start
		mu.Unlock()
		if i == 10 {
			downFrom.Store(time.Now().UnixNano())
			n := count(t, p.a, `select count(pg_terminate_backend(pid)) from pg_stat_activity where application_name = $1`, p.listenerApp)
			if n != 1 {
				t.Fatalf("terminated %d listener connections of %s", n, p.listenerApp)
			}
			go func() { // watch B's readiness: 503 while down, then 200
				defer close(readyDone)
				deadline := time.Now().Add(10 * time.Second)
				for time.Now().Before(deadline) {
					res, err := http.Get(p.b.URL + "/readyz")
					if err == nil {
						res.Body.Close()
						if res.StatusCode == 503 {
							saw503.Store(true)
						} else if res.StatusCode == 200 && saw503.Load() {
							saw200After.Store(true)
							downTo.Store(time.Now().UnixNano())
							return
						}
					}
					time.Sleep(5 * time.Millisecond)
				}
			}()
		}
		time.Sleep(300 * time.Millisecond)
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		n := len(recvAt)
		mu.Unlock()
		if n == total {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	close(stop)
	<-pollDone
	<-readyDone

	mu.Lock()
	defer mu.Unlock()
	if len(recvAt) != total {
		t.Fatalf("received %d/%d", len(recvAt), total)
	}
	var worst, worstGap time.Duration
	gapMsgs := 0
	for id, sent := range sentAt {
		if recvN[id] != 1 {
			t.Errorf("message %s received %d times", id, recvN[id])
		}
		lat := recvAt[id].Sub(sent)
		inGap := sent.UnixNano() >= downFrom.Load() && sent.UnixNano() <= downTo.Load()
		if inGap {
			gapMsgs++
			if lat > worstGap {
				worstGap = lat
			}
			if lat > 3*time.Second {
				t.Errorf("message sent during the outage took %v (> 3 s)", lat)
			}
		} else {
			if lat > worst {
				worst = lat
			}
			if lat > time.Second {
				t.Errorf("message took %v (> 1 s)", lat)
			}
		}
	}
	if !saw503.Load() || !saw200After.Load() {
		t.Errorf("readyz: saw 503 = %v, then 200 = %v", saw503.Load(), saw200After.Load())
	}
	if n := p.reconnectsB(); n != 1 {
		t.Errorf("B reconnects = %d, want 1", n)
	}
	if os.Getenv("BOTLINK_TWOCOPY_BIN") == "" && gapMsgs == 0 {
		t.Error("no message was committed while B's listener was down; the RingAll path was not exercised")
	}
	t.Logf("two-copy (%s): %d/%d received exactly once; worst latency %v (normal), %v (%d committed during the outage, %v long); reconnects=%d",
		mode, len(recvAt), total, worst, worstGap, gapMsgs, time.Duration(downTo.Load()-downFrom.Load()), p.reconnectsB())
}

// processPair starts two real server processes on :8811 and :8812 (metrics :9811/:9812).
func processPair(t *testing.T, bin, db string) copyPair {
	for _, port := range []string{"8811", "8812", "9811", "9812"} {
		if l, err := net.Listen("tcp", "127.0.0.1:"+port); err != nil {
			t.Skipf("port %s busy; process mode needs 8811/8812/9811/9812 free", port)
		} else {
			l.Close()
		}
	}
	copyID := fmt.Sprintf("B-%d", os.Getpid())
	start := func(id, port, mport string) *Copy {
		origin := "http://127.0.0.1:" + port
		cmd := osexec.Command(bin)
		cmd.Env = append(os.Environ(), "BOTLINK_ENV=dev", "BOTLINK_DEV_LOGIN=1", "BOTLINK_HUMAN_CHECK=stub",
			"BOTLINK_ADDR=127.0.0.1:"+port, "BOTLINK_COPY_ID="+id, "BOTLINK_METRICS_ADDR=127.0.0.1:"+mport,
			"BOTLINK_DATABASE_URL="+db, "BOTLINK_APP_ORIGIN="+origin)
		out, _ := cmd.StdoutPipe()
		cmd.Stderr = cmd.Stdout
		if err := cmd.Start(); err != nil {
			t.Fatal(err)
		}
		go func() { // drain logs
			sc := bufio.NewScanner(out)
			for sc.Scan() {
			}
		}()
		t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() }) // our own PID only
		deadline := time.Now().Add(15 * time.Second)
		for time.Now().Before(deadline) {
			if res, err := http.Get("http://127.0.0.1:" + port + "/readyz"); err == nil {
				res.Body.Close()
				if res.StatusCode == 200 {
					break
				}
			}
			time.Sleep(50 * time.Millisecond)
		}
		pool, err := pgxpool.New(context.Background(), db)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(pool.Close)
		// one origin for both surfaces: http://127.0.0.1:port
		return &Copy{t: t, Pool: pool, URL: "http://127.0.0.1:" + port, Host: "127.0.0.1:" + port, ID: id}
	}
	a := start(fmt.Sprintf("A-%d", os.Getpid()), "8811", "9811")
	b := start(copyID, "8812", "9812")
	return copyPair{a: a, b: b, listenerApp: "botlink-listen-" + copyID, reconnectsB: func() int {
		res, err := http.Get("http://127.0.0.1:9812/")
		if err != nil {
			return -1
		}
		defer res.Body.Close()
		sc := bufio.NewScanner(res.Body)
		for sc.Scan() {
			if strings.HasPrefix(sc.Text(), "botlink_listen_reconnects_total ") {
				var n int
				fmt.Sscanf(strings.TrimPrefix(sc.Text(), "botlink_listen_reconnects_total "), "%d", &n)
				return n
			}
		}
		return -1
	}}
}
