// Package load caps how many long-polls (open waits) one server copy holds (scale prep, 2026-11-12). The owner's
// rule: a copy never runs above 70 % of what it was measured to hold. At the cap a new wait is turned away with
// 503 high_load + Retry-After (the client backs off and says one calm line), /readyz answers 503 "full" so a load
// balancer sends new traffic to another copy, and responses carry X-Botlink-Load: high (the dashboard's banner).
package load

import (
	"log/slog"
	"math/rand/v2"
	"sync"
	"sync/atomic"

	"github.com/charles161/botlink/server/internal/httpx"
	"github.com/charles161/botlink/server/internal/metrics"
)

// DefaultMaxWaits: 70 % of the 12,000 waits one copy held cleanly on the 8-core load-test box (deploy/loadtest).
const DefaultMaxWaits = 8400

// RetryAfterS is the base Retry-After for a wait turned away at the cap (the reply jitters it ±10 s).
const RetryAfterS = 30

type Gate struct {
	max  int64
	open atomic.Int64
	m    *metrics.Set
	mu   sync.Mutex // guards the log hysteresis below
	warn bool       // logged "60 %"; re-armed under 50 %
	full bool       // logged "full"; re-armed under 95 %
}

func New(max int, m *metrics.Set) *Gate {
	if max <= 0 {
		max = DefaultMaxWaits
	}
	g := &Gate{max: int64(max), m: m}
	if m != nil {
		m.MaxWaits.Set(int64(max))
	}
	return g
}

func (g *Gate) Max() int64  { return g.max }
func (g *Gate) Open() int64 { return g.open.Load() }

// Full: at the cap (readiness says "full"; responses say X-Botlink-Load: high).
func (g *Gate) Full() bool { return g.open.Load() >= g.max }

// Acquire takes one wait slot; false at the cap. Every true must be followed by exactly one Release.
func (g *Gate) Acquire() bool {
	n := g.open.Add(1)
	if n > g.max {
		g.open.Add(-1)
		g.changed(n - 1)
		return false
	}
	g.changed(n)
	return true
}

func (g *Gate) Release() { g.changed(g.open.Add(-1)) }

func (g *Gate) changed(n int64) {
	pct := n * 100 / g.max
	if g.m != nil {
		g.m.OpenWaits.Set(n)
		g.m.WaitUtilisation.Set(pct)
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	switch {
	case pct >= 60 && !g.warn:
		g.warn = true
		slog.Warn("load: open waits crossed 60% of this copy's cap", "open", n, "max", g.max)
	case pct < 50 && g.warn:
		g.warn = false
		slog.Info("load: open waits back under 50% of this copy's cap", "open", n, "max", g.max)
	}
	switch {
	case n >= g.max && !g.full:
		g.full = true
		slog.Warn("load: this copy is full; new waits get 503 high_load and /readyz says full", "open", n, "max", g.max)
	case n < g.max*95/100 && g.full:
		g.full = false
		slog.Info("load: this copy has room again", "open", n, "max", g.max)
	}
}

// HighLoad is the answer to a wait turned away at the cap: calm, machine-readable, with a jittered Retry-After so
// the clients turned away together don't all come back together.
func HighLoad() *httpx.Error {
	return &httpx.Error{Status: 503, Code: "high_load", RetryAfter: RetryAfterS - 10 + rand.IntN(21),
		Message: "bot-link is busier than usual. Your messages are safe and will arrive; try again shortly."}
}
