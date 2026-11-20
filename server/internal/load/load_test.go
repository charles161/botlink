package load

import (
	"sync"
	"testing"

	"github.com/charles161/botlink/server/internal/metrics"
)

func TestGateCapConcurrent(t *testing.T) {
	m := metrics.NewSet()
	g := New(100, m)
	var wg sync.WaitGroup
	var mu sync.Mutex
	got := 0
	for i := 0; i < 500; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if g.Acquire() {
				mu.Lock()
				got++
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	if got != 100 || g.Open() != 100 || !g.Full() {
		t.Fatalf("acquired %d, open %d, full %v", got, g.Open(), g.Full())
	}
	if m.WaitUtilisation.Value() != 100 || m.OpenWaits.Value() != 100 || m.MaxWaits.Value() != 100 {
		t.Fatalf("gauges %d %d %d", m.WaitUtilisation.Value(), m.OpenWaits.Value(), m.MaxWaits.Value())
	}
	for i := 0; i < 100; i++ {
		g.Release()
	}
	if g.Open() != 0 || g.Full() || m.WaitUtilisation.Value() != 0 {
		t.Fatalf("after release: open %d", g.Open())
	}
}

func TestHighLoadAnswer(t *testing.T) {
	for i := 0; i < 50; i++ {
		e := HighLoad()
		if e.Status != 503 || e.Code != "high_load" || e.RetryAfter < 20 || e.RetryAfter > 40 {
			t.Fatalf("%+v", e)
		}
	}
}
