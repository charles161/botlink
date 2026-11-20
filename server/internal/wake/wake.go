// Package wake is the per-copy wake bus (SPEC §8): ONE dedicated LISTEN connection per copy feeding an
// in-process registry of bells. Waiters Hold a bell BEFORE checking the database, so a NOTIFY that lands
// between the check and the wait is never lost (the bell's buffered slot keeps it). On every (re)connect
// the bus rings every bell, because NOTIFYs sent while disconnected are gone.
package wake

import (
	"context"
	"log/slog"
	"math/rand/v2"
	"sync"
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5"
)

// Channels LISTENed on (db/migrations/0001_init.sql).
var Channels = []string{"bl_inbox", "bl_join", "bl_session", "bl_dash", "bl_push"}

// Key prefixes: bell keys are "<prefix>:<payload>".
const (
	Inbox   = "inbox"   // bl_inbox <member_id>
	Join    = "join"    // bl_join <join_request_id>
	Session = "session" // bl_session <member_id>
	Dash    = "dash"    // bl_dash <account_id>
	Push    = "push"    // bl_push ''
)

var chanPrefix = map[string]string{"bl_inbox": Inbox, "bl_join": Join, "bl_session": Session, "bl_dash": Dash, "bl_push": Push}

// Bell is a one-slot signal. A ring while nobody is selecting is kept until the next receive.
type Bell struct {
	C    chan struct{}
	keys []string
	bus  *Bus
	once sync.Once
}

func (b *Bell) ring() {
	select {
	case b.C <- struct{}{}:
	default:
	}
}

// Release unregisters the bell. Safe to call more than once.
func (b *Bell) Release() {
	b.once.Do(func() { b.bus.release(b) })
}

type Bus struct {
	mu      sync.Mutex
	waiters map[string]map[*Bell]struct{}
	all     map[*Bell]struct{}

	connected   atomic.Bool
	everUp      atomic.Bool
	conn        atomic.Pointer[pgx.Conn]
	appName     string
	OnReconnect func() // metrics hook: called on every successful re-connect (not the first connect)
	OnNotify    func(channel, payload string)
}

func New(copyID string) *Bus {
	return &Bus{
		waiters: map[string]map[*Bell]struct{}{},
		all:     map[*Bell]struct{}{},
		appName: "botlink-listen-" + copyID,
	}
}

// AppName is the application_name of this copy's LISTEN connection.
func (b *Bus) AppName() string { return b.appName }

// Hold registers a bell on the given keys (e.g. "inbox:<member>"). Call it before checking the DB.
func (b *Bus) Hold(keys ...string) *Bell {
	bell := &Bell{C: make(chan struct{}, 1), keys: keys, bus: b}
	b.mu.Lock()
	for _, k := range keys {
		s := b.waiters[k]
		if s == nil {
			s = map[*Bell]struct{}{}
			b.waiters[k] = s
		}
		s[bell] = struct{}{}
	}
	b.all[bell] = struct{}{}
	b.mu.Unlock()
	return bell
}

func (b *Bus) release(bell *Bell) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for _, k := range bell.keys {
		if s := b.waiters[k]; s != nil {
			delete(s, bell)
			if len(s) == 0 {
				delete(b.waiters, k)
			}
		}
	}
	delete(b.all, bell)
}

// Ring signals every bell held on key.
func (b *Bus) Ring(key string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for bell := range b.waiters[key] {
		bell.ring()
	}
}

// RingAll signals every held bell (every waiter re-queries).
func (b *Bus) RingAll() {
	b.mu.Lock()
	defer b.mu.Unlock()
	for bell := range b.all {
		bell.ring()
	}
}

// Held returns the number of bells currently held (tests, leak checks).
func (b *Bus) Held() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return len(b.all)
}

// Connected reports whether the LISTEN connection is up (feeds /readyz).
func (b *Bus) Connected() bool { return b.connected.Load() }

// InitialBackoff is the first reconnect delay (SPEC §8: 100 ms → 5 s with jitter). Tests may raise it
// to hold a copy disconnected long enough to commit messages inside the gap.
var InitialBackoff = 100 * time.Millisecond

// Run keeps the LISTEN connection alive until ctx ends. Backoff 100 ms → 5 s with jitter.
func (b *Bus) Run(ctx context.Context, connString string) {
	backoff := InitialBackoff
	for ctx.Err() == nil {
		wasUp, err := b.session(ctx, connString)
		b.connected.Store(false)
		if ctx.Err() != nil {
			return
		}
		slog.Warn("wake bus: LISTEN connection lost", "app", b.appName, "err", err)
		if wasUp { // a connection that worked resets the backoff
			backoff = InitialBackoff
		}
		d := backoff/2 + time.Duration(rand.Int64N(int64(backoff)))
		select {
		case <-ctx.Done():
			return
		case <-time.After(d):
		}
		if backoff *= 2; backoff > 5*time.Second {
			backoff = 5 * time.Second
		}
	}
}

func (b *Bus) session(ctx context.Context, connString string) (bool, error) {
	cfg, err := pgx.ParseConfig(connString)
	if err != nil {
		return false, err
	}
	cfg.RuntimeParams["application_name"] = b.appName
	cctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	conn, err := pgx.ConnectConfig(cctx, cfg)
	cancel()
	if err != nil {
		return false, err
	}
	defer conn.Close(context.Background())
	for _, ch := range Channels {
		if _, err := conn.Exec(ctx, "listen "+ch); err != nil {
			return false, err
		}
	}
	b.conn.Store(conn)
	defer b.conn.Store(nil)
	b.connected.Store(true)
	if b.everUp.Swap(true) && b.OnReconnect != nil {
		b.OnReconnect()
	}
	slog.Info("wake bus: listening", "app", b.appName)
	b.RingAll() // NOTIFYs during the gap are lost: every waiter re-queries
	for {
		n, err := conn.WaitForNotification(ctx)
		if err != nil {
			return true, err
		}
		if b.OnNotify != nil {
			b.OnNotify(n.Channel, n.Payload)
		}
		if p, ok := chanPrefix[n.Channel]; ok {
			b.Ring(p + ":" + n.Payload)
		}
	}
}
