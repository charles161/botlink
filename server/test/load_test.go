package test

import (
	"context"
	"encoding/hex"
	"fmt"
	"math/rand/v2"
	"net/http"
	"os"
	"runtime"
	"sort"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/charles161/botlink/server/internal/metrics"
	"github.com/charles161/botlink/server/internal/wire"
)

// PLAN §5.7 load sanity (opt-in: BOTLINK_LOAD_SECONDS=120). 500+ open lease polls on one copy + 20
// sends/s: p99 commit→return < 300 ms, goroutines back to baseline, RSS < 300 MB (whole test process,
// so client side included).
func TestLoadSanity(t *testing.T) {
	secs, _ := strconv.Atoi(os.Getenv("BOTLINK_LOAD_SECONDS"))
	if secs <= 0 {
		t.Skip("set BOTLINK_LOAD_SECONDS to run")
	}
	httpClient = &http.Client{Timeout: 70 * time.Second, Transport: &http.Transport{MaxIdleConnsPerHost: 2000, MaxConnsPerHost: 0}}
	c := StartCopy(t, NewDB(t), "A")
	adam := NewPerson(t, c, "Adam")
	const rooms, recipPerRoom, sendPerRoom = 8, 63, 7
	type roomSet struct {
		recips, senders []*Agent
	}
	var all []roomSet
	mk := func(roomID, name string) *Agent {
		a := NewAgentKeys(t, name)
		a.ID, a.Room = newID(), roomID
		exec(t, c, `insert into members (id, room_id, account_id, name, app, turn, ed25519_pk, x25519_pk, holder_session, holder_epoch)
			values ($1,$2,$3,$4,'other','listening',$5,$6,$7,1)`, a.ID, roomID, adam.AccountID, name, []byte(a.Key.Pub), a.X, a.Session)
		return a
	}
	for i := 0; i < rooms; i++ {
		room := adam.CreateRoom(fmt.Sprintf("load-%d", i))
		var rs roomSet
		for j := 0; j < recipPerRoom; j++ {
			rs.recips = append(rs.recips, mk(room.ID, fmt.Sprintf("r%d", j)))
		}
		for j := 0; j < sendPerRoom; j++ {
			rs.senders = append(rs.senders, mk(room.ID, fmt.Sprintf("s%d", j)))
		}
		all = append(all, rs)
	}
	runtime.GC()
	time.Sleep(200 * time.Millisecond)
	baseline := runtime.NumGoroutine()

	ctx, cancel := context.WithCancel(context.Background())
	var mu sync.Mutex
	sentAt := map[string]time.Time{}
	var lat []time.Duration
	recvN := map[string]int{}
	var pollErrs atomic.Int64
	var wg sync.WaitGroup
	polls := 0
	for _, rs := range all {
		for _, r := range rs.recips {
			polls++
			wg.Add(1)
			go func() {
				defer wg.Done()
				for ctx.Err() == nil {
					req := r.Req(c, "POST", "/api/v1/me/inbox/lease", map[string]any{"wait_s": 50}, nil).WithContext(ctx)
					res := doLoad(req)
					if res == nil {
						if ctx.Err() == nil {
							pollErrs.Add(1)
							time.Sleep(100 * time.Millisecond)
						}
						continue
					}
					now := time.Now()
					var items []map[string]any
					mu.Lock()
					for _, d := range res.J["deliveries"].([]any) {
						id := d.(map[string]any)["message_id"].(string)
						recvN[id]++
						if s, ok := sentAt[id]; ok && recvN[id] == 1 {
							lat = append(lat, now.Sub(s))
						}
						items = append(items, map[string]any{"message_id": id, "action": "shown"})
					}
					mu.Unlock()
					var ns []int64
					for _, n := range res.J["notices"].([]any) {
						ns = append(ns, int64(n.(map[string]any)["id"].(float64)))
					}
					if len(items) > 0 || len(ns) > 0 {
						doLoad(r.Req(c, "POST", "/api/v1/me/inbox/ack", map[string]any{"items": items, "notice_ids": ns}, nil))
					}
				}
			}()
		}
	}
	time.Sleep(3 * time.Second) // polls open
	openPolls := c.S.M.OpenPolls.Value("lease")
	var senders []*Agent
	var targets [][]*Agent
	for _, rs := range all {
		for _, s := range rs.senders {
			senders = append(senders, s)
			targets = append(targets, rs.recips)
		}
	}
	tick := time.NewTicker(50 * time.Millisecond) // 20/s
	end := time.After(time.Duration(secs) * time.Second)
	sent, sendErr := 0, 0
	var peakRSS int64
loop:
	for i := 0; ; i++ {
		select {
		case <-end:
			break loop
		case <-tick.C:
		}
		k := i % len(senders)
		s, to := senders[k], targets[k][rand.IntN(len(targets[k]))]
		id := wire.NewV7().String()
		start := time.Now()
		mu.Lock()
		sentAt[id] = start
		mu.Unlock()
		go func() {
			res := doLoad(s.Req(c, "POST", "/api/v1/messages", s.SendBody(id, false, []*Agent{to}, nil), nil))
			if res == nil || res.Status != 201 {
				mu.Lock()
				sendErr++
				delete(sentAt, id)
				mu.Unlock()
			}
		}()
		sent++
		if rss := metrics.ProcessRSS(); rss > peakRSS {
			peakRSS = rss
		}
	}
	tick.Stop()
	time.Sleep(3 * time.Second) // drain
	cancel()
	wg.Wait()
	c.TS.CloseClientConnections()
	httpClient.CloseIdleConnections()
	time.Sleep(2 * time.Second)
	runtime.GC()
	after := runtime.NumGoroutine()

	mu.Lock()
	defer mu.Unlock()
	sort.Slice(lat, func(i, j int) bool { return lat[i] < lat[j] })
	pct := func(p float64) time.Duration {
		if len(lat) == 0 {
			return 0
		}
		return lat[int(float64(len(lat)-1)*p)]
	}
	dups := 0
	for _, n := range recvN {
		if n > 1 {
			dups++
		}
	}
	t.Logf("load: %d open polls, %d sends (%d failed), %d received, %d duplicates, poll errors %d; latency p50 %v p95 %v p99 %v max %v; goroutines baseline %d after %d; peak RSS %d MB",
		openPolls, sent, sendErr, len(lat), dups, pollErrs.Load(), pct(.5), pct(.95), pct(.99), pct(1), baseline, after, peakRSS>>20)
	if openPolls < 500 {
		t.Errorf("only %d polls open", openPolls)
	}
	if len(lat) != sent-sendErr || dups != 0 || sendErr != 0 {
		t.Errorf("lost or duplicated messages")
	}
	if pct(.99) > 300*time.Millisecond {
		t.Errorf("p99 %v ≥ 300 ms", pct(.99))
	}
	if after > baseline+25 {
		t.Errorf("goroutines %d → %d (leak?)", baseline, after)
	}
	if peakRSS > 300<<20 {
		t.Errorf("RSS %d MB", peakRSS>>20)
	}
	_ = hex.EncodeToString
}

// doLoad sends a request without contract validation (speed); nil on transport error.
func doLoad(req *http.Request) *Resp {
	res, err := httpClient.Do(req)
	if err != nil {
		return nil
	}
	defer res.Body.Close()
	r := &Resp{Status: res.StatusCode}
	var buf [1 << 16]byte
	n := 0
	for {
		m, err := res.Body.Read(buf[n:])
		n += m
		if err != nil || n == len(buf) {
			break
		}
	}
	r.Body = append([]byte(nil), buf[:n]...)
	_ = jsonUnmarshal(r.Body, &r.J)
	return r
}
