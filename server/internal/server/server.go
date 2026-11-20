// Package server assembles one copy: pool, migrations, wake bus, both API surfaces, pages, push worker,
// sweeper, metrics, and host routing.
package server

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/charles161/botlink/server/internal/adminapi"
	"github.com/charles161/botlink/server/internal/agentapi"
	"github.com/charles161/botlink/server/internal/analytics"
	"github.com/charles161/botlink/server/internal/appapi"
	"github.com/charles161/botlink/server/internal/auth"
	"github.com/charles161/botlink/server/internal/config"
	"github.com/charles161/botlink/server/internal/events"
	"github.com/charles161/botlink/server/internal/httpx"
	"github.com/charles161/botlink/server/internal/load"
	"github.com/charles161/botlink/server/internal/metrics"
	"github.com/charles161/botlink/server/internal/migrate"
	"github.com/charles161/botlink/server/internal/pages"
	"github.com/charles161/botlink/server/internal/plans"
	"github.com/charles161/botlink/server/internal/push"
	"github.com/charles161/botlink/server/internal/store"
	"github.com/charles161/botlink/server/internal/sweeper"
	"github.com/charles161/botlink/server/internal/wake"
)

type Server struct {
	Cfg     *config.Config
	Pool    *pgxpool.Pool
	Bus     *wake.Bus
	Load    *load.Gate // per-copy cap on open waits (BOTLINK_MAX_WAITS)
	M       *metrics.Set
	St      *store.Store
	Agent   *agentapi.API
	App     *appapi.API
	Admin   *adminapi.API
	Plans   *appapi.PlansAPI    // plans, usage, credits, billing (CONTRACT-PLANS.md)
	Errors  *adminapi.ErrorRing // this copy's recent 5xx (admin area)
	Pusher  *push.Client
	Worker  *push.Worker
	Events  *events.Worker // bot-link Events webhooks (SPEC §6.13)
	Sweeper *sweeper.Sweeper
	Handler http.Handler
	Mux     *http.ServeMux

	Analytics *analytics.Client // server-side PostHog events (nil: off unless configured; flushed by Shutdown)

	wg     sync.WaitGroup
	cancel context.CancelFunc

	drain     chan struct{} // closed by Drain: open long-polls and event streams end with their normal answer
	drainOnce sync.Once
}

// Drain tells every open long-poll and event stream to end now (idempotent). Shutdown calls it.
func (s *Server) Drain() { s.drainOnce.Do(func() { close(s.drain) }) }

// Shutdown ends open waits (Drain), then shuts hs down: it stops accepting and waits for the handlers, which now
// finish within moments instead of holding a 50 s wait past the deadline.
func (s *Server) Shutdown(ctx context.Context, hs *http.Server) error {
	s.Drain()
	err := hs.Shutdown(ctx)
	s.Analytics.Close(ctx) // send the queued events within the same window
	return err
}

// New connects, migrates and builds the handler. Call Start to run the background loops.
func New(ctx context.Context, cfg *config.Config) (*Server, error) {
	pre, err := Preflight(cfg) // every refusal that needs no database or network (also `botlink check-config`)
	if err != nil {
		return nil, err
	}
	if cfg.RecheckMS > 0 { // dev only (config refuses it elsewhere): the eval harness's faster tick
		agentapi.RecheckEvery = time.Duration(cfg.RecheckMS) * time.Millisecond
	}
	pcfg, err := pgxpool.ParseConfig(cfg.DatabaseURL)
	if err != nil {
		return nil, fmt.Errorf("BOTLINK_DATABASE_URL: %w", err)
	}
	if pcfg.MaxConns < 30 {
		pcfg.MaxConns = 30
	}
	pcfg.ConnConfig.RuntimeParams["application_name"] = "botlink-" + cfg.CopyID
	pool, err := pgxpool.NewWithConfig(ctx, pcfg)
	if err != nil {
		return nil, err
	}
	if _, err := migrate.Up(ctx, pool); err != nil {
		pool.Close()
		return nil, err
	}
	m := metrics.NewSet()
	bus := wake.New(cfg.CopyID)
	bus.OnReconnect = func() { m.ListenReconnects.Inc() }
	st := &store.Store{Pool: pool, Metrics: m, AppOrigin: cfg.AppOrigin}
	hc := pre.HC
	pusher := push.NewClient(cfg.Env == "dev", cfg.Env == "dev" && cfg.PushAllowLoopback)
	s := &Server{Cfg: cfg, Pool: pool, Bus: bus, Load: load.New(cfg.MaxWaits, m), M: m, St: st, Pusher: pusher, Errors: adminapi.NewErrorRing(100), drain: make(chan struct{})}
	s.Agent = agentapi.New(st, bus, cfg, m, pusher)
	s.Agent.Load = s.Load
	s.App = appapi.New(st, bus, cfg, m, hc)
	s.App.Pusher = pusher // the push guard, run again when a person approves an event address
	s.Analytics = analytics.New(analytics.Config{Key: cfg.PostHogKey, Host: cfg.PostHogHost, HashKey: cfg.AnalyticsHashKey})
	s.Agent.An, s.App.An = s.Analytics, s.Analytics
	if cfg.PostHogKey != "" && s.Analytics == nil {
		slog.Warn("analytics off: BOTLINK_POSTHOG_KEY is set but BOTLINK_ANALYTICS_HASH_KEY is missing or under 32 characters")
	}
	gw := pre.GW
	s.Plans = &appapi.PlansAPI{API: s.App, GW: gw}
	s.Admin = &adminapi.API{Pool: pool, Cfg: cfg, M: m, Bus: bus, HC: hc, Errors: s.Errors, Started: time.Now()}
	s.Worker = &push.Worker{Pool: pool, Client: pusher, Bus: bus, M: m}
	s.Events = &events.Worker{Pool: pool, Client: pusher, Bus: bus, M: m}
	storageLim := int64(cfg.Plans.StorageTotal()) * plans.MiB
	s.Sweeper = &sweeper.Sweeper{Pool: pool, OnTotal: func(n int64) {
		m.SetStorage(n, plans.StoragePct(n, storageLim), plans.StorageLevelNum(n, storageLim))
	}}
	m.StorageTotalCeiling.Set(int64(cfg.Plans.StorageTotal()) << 20)
	m.StorageAccountCeiling.Set(int64(cfg.Plans.StorageCeiling()) << 20)
	pg, err := pages.New(cfg, st)
	if err != nil {
		pool.Close()
		return nil, err
	}
	var cf *pages.ClientFile
	if cfg.ClientTGZ != "" {
		cf = pages.NewClientFile(cfg.ClientTGZ)
		pg.Client = cf // invite pages + open docs name the current versioned client URL
	}

	apiMux := http.NewServeMux()
	s.Agent.Routes(apiMux)
	appMux := http.NewServeMux()
	s.App.Routes(appMux)
	s.Admin.Routes(appMux)
	s.Plans.Routes(appMux)
	pg.Routes(appMux)
	health := http.NewServeMux()
	health.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		_, _ = w.Write([]byte("ok"))
	})
	health.Handle("GET /readyz", httpx.Handler(s.readyz))

	gate := pre.Gate // minimum client release (off by default)
	mux := http.NewServeMux()
	mux.Handle("/healthz", health)
	mux.Handle("/readyz", health)
	mux.Handle("/api/v1/", gate.Wrap(apiMux)) // only the agent API: /dl, the manifest and /readyz stay open to old clients
	if cf != nil {
		mux.Handle("/dl/botlink.tgz", cf.Download())
		mux.Handle("/dl/botlink.json", cf.Info(cfg.ClientURL))
		mux.Handle("/dl/botlink.manifest.json", cf.Manifest()) // signed release manifest (client lane: signed updates)
		mux.Handle("/dl/", cf.Versioned())                     // /dl/botlink-<16 hex>.tgz (launch plan #3); anything else 404
	}
	mux.Handle("/", appMux)
	s.Mux = mux
	var h http.Handler = s.instrument(mux, apiMux, appMux)
	h = pages.HostSplit(cfg, h) // which host serves which path: the host table (pages/hosts.go)
	h = auth.DropOldCookie(cfg.SecureCookies(), h)
	h = pages.SecurityHeaders(cfg, h)
	h = httpx.WithRequestID(h)
	drain := (<-chan struct{})(s.drain)
	inner := h
	h = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		inner.ServeHTTP(w, r.WithContext(httpx.WithDrain(r.Context(), drain)))
	})
	s.Handler = h
	return s, nil
}

func (s *Server) readyz(w http.ResponseWriter, r *http.Request) error {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	if err := s.Pool.Ping(ctx); err != nil {
		return httpx.Unavailable(err)
	}
	if !s.Bus.Connected() {
		return httpx.E(503, "unavailable", "This copy's wake connection is down.")
	}
	if s.Load.Full() { // a load balancer stops sending new traffic here until waits end
		httpx.SetHighLoad(r.Context())
		return httpx.E(503, "high_load", "This copy is full: its open waits are at the cap. Send new traffic to another copy.").With("reason", "full")
	}
	w.Header().Set("Content-Type", "text/plain")
	_, _ = w.Write([]byte("ready"))
	return nil
}

// instrument counts requests by route pattern and code, and logs each one (no bodies, no secrets).
func (s *Server) instrument(next http.Handler, _ ...*http.ServeMux) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &httpx.StatusRecorder{ResponseWriter: w}
		r, li := httpx.WithLogInfo(r)
		if s.Load.Full() { // the dashboard shows a calm banner while it sees this
			w.Header().Set("X-Botlink-Load", "high")
		}
		next.ServeHTTP(rec, r)
		route := r.Pattern
		if route == "" || route == "/" || route == "/api/v1/" {
			route = "other"
		}
		if rec.Status == 0 {
			rec.Status = 200
		}
		s.M.HTTPRequests.Inc(route, strconv.Itoa(rec.Status))
		if li.RateLimit != "" {
			s.M.RateLimited.Inc(li.RateLimit)
		}
		// Not when the caller went away first (context canceled): nobody saw that answer.
		if rec.Status >= 500 && !li.HighLoad && !errors.Is(r.Context().Err(), context.Canceled) {
			s.Errors.Record(r.Method, route, rec.Status, w.Header().Get("X-Request-Id"))
		}
		lvl := slog.LevelDebug
		if rec.Status >= 500 {
			lvl = slog.LevelWarn
		} else if rec.Status >= 400 || strings.HasPrefix(r.URL.Path, "/app/") || strings.HasPrefix(r.URL.Path, "/api/") {
			lvl = slog.LevelInfo
		}
		attrs := []any{"method", r.Method, "route", route, "status", rec.Status, "ms", time.Since(start).Milliseconds(),
			"request_id", w.Header().Get("X-Request-Id"), "copy", s.Cfg.CopyID}
		if li.MemberID != "" {
			attrs = append(attrs, "member_id", li.MemberID)
		}
		if li.AccountID != "" {
			attrs = append(attrs, "account_id", li.AccountID)
		}
		slog.Log(r.Context(), lvl, "http", attrs...)
	})
}

// Start runs the wake bus, push worker and sweeper until Close.
func (s *Server) Start(ctx context.Context) {
	ctx, s.cancel = context.WithCancel(ctx)
	s.wg.Add(1)
	go func() { defer s.wg.Done(); s.Bus.Run(ctx, s.Cfg.ListenURL) }()
	if !s.Cfg.DisablePushWorker {
		s.wg.Add(1)
		go func() { defer s.wg.Done(); s.Worker.Run(ctx) }()
		s.wg.Add(1)
		go func() { defer s.wg.Done(); s.Events.Run(ctx) }()
	}
	if !s.Cfg.DisableSweeper {
		s.wg.Add(1)
		go func() { defer s.wg.Done(); s.Sweeper.Run(ctx) }()
		if s.Cfg.Plans.Paywall() { // daily usage rollup (and credit debits, only if a unit price is set): paywall only
			p := s.Cfg.Plans.Paid()
			s.wg.Add(1)
			go func() {
				defer s.wg.Done()
				plans.RunUsage(ctx, s.Pool, plans.Prices{Message: p.PriceMessage, ChatDay: p.PriceChatDay, Wake: p.PriceWake}, 0)
			}()
		}
	}
}

// WaitReady blocks until the LISTEN connection is up (readyz would say 200).
func (s *Server) WaitReady(ctx context.Context) error {
	for !s.Bus.Connected() {
		select {
		case <-ctx.Done():
			return errors.New("wake bus never connected")
		case <-time.After(10 * time.Millisecond):
		}
	}
	return nil
}

// Close stops background loops and the pool.
func (s *Server) Close() {
	if s.cancel != nil {
		s.cancel()
	}
	s.wg.Wait()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	s.Analytics.Close(ctx)
	cancel()
	s.Pool.Close()
}

// MetricsHandler serves Prometheus text for this copy.
func (s *Server) MetricsHandler() http.Handler { return s.M.Reg.Handler() }
