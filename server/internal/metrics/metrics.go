// Package metrics is a tiny Prometheus text-format registry (counters, gauges, histograms with labels).
// One Registry per server copy, so two copies in one test process don't share numbers.
package metrics

import (
	"fmt"
	"math"
	"net/http"
	"os"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
)

type Registry struct {
	mu      sync.Mutex
	metrics []metric
	byName  map[string]metric
}

type metric interface {
	name() string
	write(sb *strings.Builder)
}

func New() *Registry { return &Registry{byName: map[string]metric{}} }

func (r *Registry) add(m metric) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.metrics = append(r.metrics, m)
	r.byName[m.name()] = m
}

func labelKey(labels []string, values []string) string {
	if len(labels) == 0 {
		return ""
	}
	parts := make([]string, len(labels))
	for i, l := range labels {
		v := strings.NewReplacer(`\`, `\\`, `"`, `\"`, "\n", `\n`).Replace(values[i])
		parts[i] = fmt.Sprintf(`%s="%s"`, l, v)
	}
	return "{" + strings.Join(parts, ",") + "}"
}

// ── counter

type Counter struct {
	n      string
	help   string
	labels []string
	mu     sync.Mutex
	vals   map[string]*atomic.Uint64
}

func (r *Registry) Counter(name, help string, labels ...string) *Counter {
	c := &Counter{n: name, help: help, labels: labels, vals: map[string]*atomic.Uint64{}}
	r.add(c)
	return c
}

func (c *Counter) name() string { return c.n }

func (c *Counter) Add(n uint64, values ...string) {
	k := labelKey(c.labels, values)
	c.mu.Lock()
	v := c.vals[k]
	if v == nil {
		v = &atomic.Uint64{}
		c.vals[k] = v
	}
	c.mu.Unlock()
	v.Add(n)
}

func (c *Counter) Inc(values ...string) { c.Add(1, values...) }

// Labels returns, per series, the label values in declaration order with the value.
func (c *Counter) Labels() []LabeledValue {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([]LabeledValue, 0, len(c.vals))
	for k, v := range c.vals {
		out = append(out, LabeledValue{Labels: parseLabelKey(k), Value: v.Load()})
	}
	sort.Slice(out, func(i, j int) bool { return strings.Join(out[i].Labels, "\x00") < strings.Join(out[j].Labels, "\x00") })
	return out
}

// LabeledValue is one counter series.
type LabeledValue struct {
	Labels []string
	Value  uint64
}

// parseLabelKey reverses labelKey: `{a="x",b="y"}` → ["x", "y"].
func parseLabelKey(k string) []string {
	var out []string
	for i := 0; i < len(k); i++ {
		if k[i] != '"' {
			continue
		}
		var sb strings.Builder
		for i++; i < len(k) && k[i] != '"'; i++ {
			if k[i] == '\\' && i+1 < len(k) {
				i++
				if k[i] == 'n' {
					sb.WriteByte('\n')
					continue
				}
			}
			sb.WriteByte(k[i])
		}
		out = append(out, sb.String())
	}
	return out
}

// Value returns the current value for the given label values (tests).
func (c *Counter) Value(values ...string) uint64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	if v := c.vals[labelKey(c.labels, values)]; v != nil {
		return v.Load()
	}
	return 0
}

func (c *Counter) write(sb *strings.Builder) {
	fmt.Fprintf(sb, "# HELP %s %s\n# TYPE %s counter\n", c.n, c.help, c.n)
	c.mu.Lock()
	keys := make([]string, 0, len(c.vals))
	for k := range c.vals {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	if len(keys) == 0 && len(c.labels) == 0 {
		fmt.Fprintf(sb, "%s 0\n", c.n)
	}
	for _, k := range keys {
		fmt.Fprintf(sb, "%s%s %d\n", c.n, k, c.vals[k].Load())
	}
	c.mu.Unlock()
}

// ── gauge

type Gauge struct {
	n      string
	help   string
	labels []string
	mu     sync.Mutex
	vals   map[string]*atomic.Int64
}

func (r *Registry) Gauge(name, help string, labels ...string) *Gauge {
	g := &Gauge{n: name, help: help, labels: labels, vals: map[string]*atomic.Int64{}}
	r.add(g)
	return g
}

func (g *Gauge) name() string { return g.n }

func (g *Gauge) Add(d int64, values ...string) {
	k := labelKey(g.labels, values)
	g.mu.Lock()
	v := g.vals[k]
	if v == nil {
		v = &atomic.Int64{}
		g.vals[k] = v
	}
	g.mu.Unlock()
	v.Add(d)
}

// Set replaces the value for the given label values.
func (g *Gauge) Set(v int64, values ...string) {
	k := labelKey(g.labels, values)
	g.mu.Lock()
	x := g.vals[k]
	if x == nil {
		x = &atomic.Int64{}
		g.vals[k] = x
	}
	g.mu.Unlock()
	x.Store(v)
}

func (g *Gauge) Value(values ...string) int64 {
	g.mu.Lock()
	defer g.mu.Unlock()
	if v := g.vals[labelKey(g.labels, values)]; v != nil {
		return v.Load()
	}
	return 0
}

func (g *Gauge) write(sb *strings.Builder) {
	fmt.Fprintf(sb, "# HELP %s %s\n# TYPE %s gauge\n", g.n, g.help, g.n)
	g.mu.Lock()
	keys := make([]string, 0, len(g.vals))
	for k := range g.vals {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		fmt.Fprintf(sb, "%s%s %d\n", g.n, k, g.vals[k].Load())
	}
	g.mu.Unlock()
}

// ── histogram

type Histogram struct {
	n       string
	help    string
	labels  []string
	buckets []float64
	mu      sync.Mutex
	series  map[string]*hseries
}

type hseries struct {
	counts []uint64
	sum    float64
	count  uint64
}

var DefaultBuckets = []float64{0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120}

func (r *Registry) Histogram(name, help string, buckets []float64, labels ...string) *Histogram {
	if buckets == nil {
		buckets = DefaultBuckets
	}
	h := &Histogram{n: name, help: help, labels: labels, buckets: buckets, series: map[string]*hseries{}}
	r.add(h)
	return h
}

func (h *Histogram) name() string { return h.n }

func (h *Histogram) Observe(v float64, values ...string) {
	if math.IsNaN(v) {
		return
	}
	k := labelKey(h.labels, values)
	h.mu.Lock()
	defer h.mu.Unlock()
	s := h.series[k]
	if s == nil {
		s = &hseries{counts: make([]uint64, len(h.buckets))}
		h.series[k] = s
	}
	for i, b := range h.buckets {
		if v <= b {
			s.counts[i]++
		}
	}
	s.sum += v
	s.count++
}

func (h *Histogram) Count(values ...string) uint64 {
	h.mu.Lock()
	defer h.mu.Unlock()
	if s := h.series[labelKey(h.labels, values)]; s != nil {
		return s.count
	}
	return 0
}

func (h *Histogram) write(sb *strings.Builder) {
	fmt.Fprintf(sb, "# HELP %s %s\n# TYPE %s histogram\n", h.n, h.help, h.n)
	h.mu.Lock()
	defer h.mu.Unlock()
	keys := make([]string, 0, len(h.series))
	for k := range h.series {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		s := h.series[k]
		inner := strings.TrimSuffix(strings.TrimPrefix(k, "{"), "}")
		sep := ""
		if inner != "" {
			sep = ","
		}
		for i, b := range h.buckets {
			fmt.Fprintf(sb, "%s_bucket{%s%sle=\"%g\"} %d\n", h.n, inner, sep, b, s.counts[i])
		}
		fmt.Fprintf(sb, "%s_bucket{%s%sle=\"+Inf\"} %d\n", h.n, inner, sep, s.count)
		fmt.Fprintf(sb, "%s_sum%s %g\n%s_count%s %d\n", h.n, k, s.sum, h.n, k, s.count)
	}
}

// Handler serves the text exposition format.
func (r *Registry) Handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		var sb strings.Builder
		r.mu.Lock()
		ms := append([]metric(nil), r.metrics...)
		r.mu.Unlock()
		for _, m := range ms {
			m.write(&sb)
		}
		var mem runtime.MemStats
		runtime.ReadMemStats(&mem)
		fmt.Fprintf(&sb, "# HELP go_goroutines Goroutines.\n# TYPE go_goroutines gauge\ngo_goroutines %d\n", runtime.NumGoroutine())
		fmt.Fprintf(&sb, "# HELP go_memstats_heap_inuse_bytes Heap in use.\n# TYPE go_memstats_heap_inuse_bytes gauge\ngo_memstats_heap_inuse_bytes %d\n", mem.HeapInuse)
		if rss := ProcessRSS(); rss > 0 {
			fmt.Fprintf(&sb, "# HELP process_resident_memory_bytes Resident memory.\n# TYPE process_resident_memory_bytes gauge\nprocess_resident_memory_bytes %d\n", rss)
		}
		w.Header().Set("Content-Type", "text/plain; version=0.0.4")
		_, _ = w.Write([]byte(sb.String()))
	})
}

// Set is the server's named metrics (SPEC §12).
type Set struct {
	Reg              *Registry
	DeliveryLag      *Histogram // stage=leased|shown
	WakeLatency      *Histogram
	LeaseExpired     *Counter
	Stuck            *Counter
	Push             *Counter // result
	Events           *Counter // result (bot-link Events webhooks)
	OpenPolls        *Gauge   // kind
	ListenReconnects *Counter
	HTTPRequests     *Counter // route, code
	RateLimited      *Counter // limit (ratelimit.Limit.Name)
	OpenWaits        *Gauge   // long-polls holding a slot of this copy's cap (load.Gate)
	MaxWaits         *Gauge   // this copy's cap (BOTLINK_MAX_WAITS)
	WaitUtilisation  *Gauge   // OpenWaits as a percentage of MaxWaits

	// stored message bytes (plans/storage.go): the server-wide total as last read by this copy, and the two ceilings
	StorageTotal, StorageTotalCeiling, StorageAccountCeiling *Gauge
	StorageTotalPct, StorageTotalLevel                       *Gauge
}

func NewSet() *Set {
	r := New()
	return &Set{
		Reg:              r,
		DeliveryLag:      r.Histogram("botlink_delivery_lag_seconds", "Time from message commit to the copy being leased or shown.", nil, "stage"),
		WakeLatency:      r.Histogram("botlink_wake_latency_seconds", "Time from message commit to a bell-woken poll returning it.", nil),
		LeaseExpired:     r.Counter("botlink_lease_expired_total", "Copies leased again after a previous lease expired without an ack."),
		Stuck:            r.Counter("botlink_stuck_total", "Copies marked stuck."),
		Push:             r.Counter("botlink_push_total", "Always-on push attempts by result.", "result"),
		Events:           r.Counter("botlink_events_total", "bot-link Events webhook attempts by result.", "result"),
		OpenPolls:        r.Gauge("botlink_open_polls", "Open long-polls on this copy.", "kind"),
		ListenReconnects: r.Counter("botlink_listen_reconnects_total", "Times this copy's LISTEN connection was re-established."),
		HTTPRequests:     r.Counter("botlink_http_requests_total", "HTTP requests by route and status code.", "route", "code"),
		RateLimited:      r.Counter("botlink_rate_limited_total", "Requests turned away by a quota (429), by quota.", "limit"),
		OpenWaits:        r.Gauge("botlink_open_waits", "Long-polls holding a slot of this copy's cap."),
		MaxWaits:         r.Gauge("botlink_max_waits", "This copy's cap on open long-polls (BOTLINK_MAX_WAITS)."),
		WaitUtilisation:  r.Gauge("botlink_wait_utilisation_pct", "Open long-polls as a percentage of this copy's cap."),

		StorageTotal:          r.Gauge("botlink_storage_total_bytes", "Stored message bytes across all accounts, as last read by this copy (a send or the sweeper's fold)."),
		StorageTotalCeiling:   r.Gauge("botlink_storage_total_ceiling_bytes", "Server-wide ceiling on stored message bytes (BOTLINK_STORAGE_TOTAL_MB)."),
		StorageAccountCeiling: r.Gauge("botlink_storage_account_ceiling_bytes", "Per-account ceiling on stored message bytes (BOTLINK_STORAGE_CEILING_MB)."),
		StorageTotalPct:       r.Gauge("botlink_storage_total_pct", "Stored message bytes as a percentage of the server-wide ceiling."),
		StorageTotalLevel:     r.Gauge("botlink_storage_total_level", "0 ok, 1 warn (50 % of the server-wide storage ceiling), 2 high (80 %); at 100 % sends get 409 server_full."),
	}
}

// ProcessRSS reads VmRSS from /proc/self/status (Linux), in bytes; 0 if unknown.
func ProcessRSS() int64 {
	b, err := os.ReadFile("/proc/self/status")
	if err != nil {
		return 0
	}
	for _, line := range strings.Split(string(b), "\n") {
		if strings.HasPrefix(line, "VmRSS:") {
			f := strings.Fields(line)
			if len(f) >= 2 {
				kb, _ := strconv.ParseInt(f[1], 10, 64)
				return kb * 1024
			}
		}
	}
	return 0
}

// SetStorage records the server-wide stored bytes, its percentage of the ceiling and its level (0 ok, 1 warn, 2 high).
func (s *Set) SetStorage(total, pct, level int64) {
	s.StorageTotal.Set(total)
	s.StorageTotalPct.Set(pct)
	s.StorageTotalLevel.Set(level)
}
