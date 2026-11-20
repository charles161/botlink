// Package agentapi is the /api/v1 surface: agents only, every request Ed25519-signed (ENVELOPE §3).
// No cookies, no CORS, no approve / room-management / invite-creation routes.
package agentapi

import (
	"context"
	"crypto/ed25519"
	"errors"
	"github.com/charles161/botlink/server/internal/ratelimit"
	"net/http"
	"strconv"
	"sync"

	"github.com/jackc/pgx/v5"

	"github.com/charles161/botlink/server/internal/analytics"
	"github.com/charles161/botlink/server/internal/config"
	"github.com/charles161/botlink/server/internal/httpx"
	"github.com/charles161/botlink/server/internal/load"
	"github.com/charles161/botlink/server/internal/metrics"
	"github.com/charles161/botlink/server/internal/push"
	"github.com/charles161/botlink/server/internal/store"
	"github.com/charles161/botlink/server/internal/wake"
	"github.com/charles161/botlink/server/internal/wire"
)

type API struct {
	Patterns []string // every registered route (route table test: no approve routes here)
	St       *store.Store
	Bus      *wake.Bus
	Cfg      *config.Config
	M        *metrics.Set
	Polls    *PollReg
	Pusher   *push.Client
	An       *analytics.Client // server-side product events (nil: off)

	joinWaitMu sync.Mutex
	joinWaits  map[string]int // open join waits per key on this copy (holdJoinWait)
	Load       *load.Gate     // per-copy cap on open waits; nil = no cap
}

func New(st *store.Store, bus *wake.Bus, cfg *config.Config, m *metrics.Set, p *push.Client) *API {
	return &API{St: st, Bus: bus, Cfg: cfg, M: m, Polls: NewPollReg(m), Pusher: p}
}

// Routes registers every /api/v1 route. The route table test checks there is no approve route here.
func (a *API) Routes(m *http.ServeMux) {
	mux := patternRecorder{m, &a.Patterns}
	mux.Handle("GET /api/v1/health", httpx.Handler(func(w http.ResponseWriter, r *http.Request) error {
		w.Header().Set("Content-Type", "text/plain")
		_, _ = w.Write([]byte("ok"))
		return nil
	}))
	mux.Handle("GET /api/v1/invites/{invite}", httpx.Handler(a.getInvite))
	mux.Handle("POST /api/v1/join-requests", a.signed(authKey, a.postJoinRequest))
	mux.Handle("POST /api/v1/join-requests/{id}/wait", a.signed(authKey, a.postJoinWait))
	mux.Handle("POST /api/v1/join-requests/{id}/cancel", a.signed(authKey, a.postJoinCancel))
	mux.Handle("POST /api/v1/room-drafts", a.signed(authKey, a.postRoomDraft))
	mux.Handle("POST /api/v1/room-drafts/{id}/wait", a.signed(authKey, a.postRoomDraftWait))
	mux.Handle("POST /api/v1/room-drafts/{id}/cancel", a.signed(authKey, a.postRoomDraftCancel))
	mux.Handle("POST /api/v1/me/invite-link", a.signed(authHeld, a.postInviteLink))
	mux.Handle("GET /api/v1/me", a.signed(authHeld, a.getMe))
	mux.Handle("DELETE /api/v1/me", a.signed(authHeld, a.deleteMe))
	mux.Handle("GET /api/v1/me/roster", a.signed(authHeld, a.polled(a.getRoster)))
	mux.Handle("POST /api/v1/me/claim", a.signed(authMember, a.postClaim))
	mux.Handle("PUT /api/v1/me/handover", a.signed(authHeld, a.putHandover))
	mux.Handle("PUT /api/v1/me/card", a.signed(authHeld, a.putCard))
	mux.Handle("PUT /api/v1/me/turn", a.signed(authHeld, a.putTurn))
	mux.Handle("POST /api/v1/me/ask-human", a.signed(authHeld, a.postAskHuman))
	mux.Handle("POST /api/v1/messages", a.signed(authHeld, a.postMessage))
	mux.Handle("POST /api/v1/me/inbox/lease", a.signed(authMember, a.polled(a.postLease)))
	mux.Handle("POST /api/v1/me/inbox/ack", a.signed(authMember, a.postAck))
	mux.Handle("GET /api/v1/me/inbox/recent", a.signed(authMember, a.getRecent))
	mux.Handle("GET /api/v1/me/inbox/count", a.signed(authMember, a.polled(a.getCount)))
	mux.Handle("POST /api/v1/me/wait", a.signed(authHeld, a.polled(a.postWait)))
	mux.Handle("POST /api/v1/me/presence", a.signed(authHeld, a.postPresence))
	mux.Handle("PUT /api/v1/me/mutes/{member_id}", a.signed(authHeld, a.putMute))
	mux.Handle("GET /api/v1/me/mutes", a.signed(authHeld, a.getMutes))
	mux.Handle("PUT /api/v1/me/wake-policy", a.signed(authHeld, a.putWakePolicy))
	mux.Handle("POST /api/v1/me/selftest", a.signed(authHeld, a.postSelftest))
	mux.Handle("GET /api/v1/me/selftest/{id}", a.signed(authHeld, a.getSelftest))
	mux.Handle("POST /api/v1/me/events/subscriptions", a.signed(authHeld, a.postEventSub))
	mux.Handle("GET /api/v1/me/events/subscriptions", a.signed(authHeld, a.getEventSubs))
	mux.Handle("DELETE /api/v1/me/events/subscriptions/{id}", a.signed(authHeld, a.deleteEventSub))
	mux.Handle("DELETE /api/v1/me/events/requests/{id}", a.signed(authHeld, a.deleteEventRequest))
	mux.Handle("/api/v1/", httpx.Handler(func(w http.ResponseWriter, r *http.Request) error { return httpx.NotFound() }))
}

type patternRecorder struct {
	mux  *http.ServeMux
	list *[]string
}

func (p patternRecorder) Handle(pattern string, h http.Handler) {
	*p.list = append(*p.list, pattern)
	p.mux.Handle(pattern, h)
}

type authKind int

const (
	authKey    authKind = iota // join endpoints: signature by the key in the request; resolved by the handler
	authMember                 // the key must be an active member's
	// authHeld (r2, founder): an active member's key AND, when the member is held by a chat, that chat's
	// session (X-Botlink-Session, signed). A request signed with a member's key from any other session (another app's
	// chat on the same computer that read the key file) is refused with 403 not_holder. Holder-less members (Cursor,
	// OpenCode, scripts) act from their folder; moving a member to another session is only `claim`.
	authHeld
)

// Caller is a verified signed request.
type Caller struct {
	Key     []byte
	KeyHex  string
	Session string
	Body    []byte
	M       *Member // authMember only
}

// Member is the calling member (row at auth time).
type Member struct {
	ID, RoomID, AccountID, Name, App, Job, Folder, Machine, Turn string
	HolderSession                                                *string
	HolderEpoch                                                  int64
	KeyEpoch                                                     int
	Ed, X                                                        []byte
	Handover                                                     *string
	PersonName, RoomName, RoomPurpose                            string
}

func (m *Member) FP() string { return wire.MemberFP(m.Ed, m.X) }

func badSig(msg string) *httpx.Error { return httpx.E(401, "bad_signature", msg) }

func (a *API) signed(kind authKind, h func(w http.ResponseWriter, r *http.Request, c *Caller) error) http.Handler {
	return httpx.Handler(func(w http.ResponseWriter, r *http.Request) error {
		c, err := a.verify(r, kind)
		if err != nil {
			return err
		}
		return h(w, r, c)
	})
}

// verify implements ENVELOPE §3 "Server verification order", stopping at the first failure.
func (a *API) verify(r *http.Request, kind authKind) (*Caller, error) {
	ctx := r.Context()
	keyHex := r.Header.Get("X-Botlink-Key")
	ts := r.Header.Get("X-Botlink-Time")
	nonce := r.Header.Get("X-Botlink-Nonce")
	sigHex := r.Header.Get("X-Botlink-Signature")
	session := r.Header.Get("X-Botlink-Session")
	// 1. headers present and well-formed
	key, ok := wire.DecodeHex32(keyHex)
	if !ok {
		return nil, badSig("X-Botlink-Key must be 64 lowercase hex chars.")
	}
	t, err := strconv.ParseInt(ts, 10, 64)
	if err != nil || ts == "" || (len(ts) > 1 && ts[0] == '0') {
		return nil, badSig("X-Botlink-Time must be unix seconds.")
	}
	if !wire.IsNonce(nonce) {
		return nil, badSig("X-Botlink-Nonce must be 32 lowercase hex chars.")
	}
	sig, ok := wire.DecodeSig(sigHex)
	if !ok {
		return nil, badSig("X-Botlink-Signature must be 128 lowercase hex chars.")
	}
	if session != "" && !wire.IsSessionID(session) {
		return nil, badSig("X-Botlink-Session is not a valid session id.")
	}
	body, err := httpx.ReadBody(r)
	if err != nil {
		return nil, err
	}
	// 2. timestamp against Postgres now()
	now, err := store.DBNow(ctx, a.St.Pool)
	if err != nil {
		return nil, err
	}
	if d := now - t; d > 60 || d < -60 {
		e := httpx.E(401, "stale_timestamp", "The request time is too far from the server's clock.")
		e.ServerTime = now
		return nil, e
	}
	// 3. signature over the reconstructed string
	msg := wire.ReqStringToSign(r.Method, r.Host, r.RequestURI, wire.SHA256Hex(body), ts, nonce, keyHex, session)
	if !ed25519.Verify(ed25519.PublicKey(key), msg, sig) {
		return nil, badSig("The request signature doesn't verify.")
	}
	// 4. single-use nonce (after the signature check, so forgers can't burn nonces)
	tag, err := a.St.Pool.Exec(ctx, `insert into request_nonces (key_pk, nonce) values ($1, $2) on conflict do nothing`, key, nonce)
	if err != nil {
		return nil, err
	}
	if tag.RowsAffected() == 0 {
		return nil, httpx.E(401, "replayed", "This request was already used.")
	}
	c := &Caller{Key: key, KeyHex: keyHex, Session: session, Body: body}
	// 5. resolve the key
	if kind == authMember || kind == authHeld {
		m, err := a.loadMemberByKey(ctx, key)
		if err != nil {
			return nil, err
		}
		c.M = m
		httpx.SetMember(ctx, m.ID)
		if kind == authHeld && m.HolderSession != nil && *m.HolderSession != session {
			return nil, httpx.E(403, "not_holder", "This member belongs to another chat (its session). Only that chat may act as it; another chat takes it over only with claim.").
				With("holder_epoch", m.HolderEpoch)
		}
	}
	return c, nil
}

func (a *API) loadMemberByKey(ctx context.Context, key []byte) (*Member, error) {
	m := &Member{}
	var removed, roomDeleted bool
	err := a.St.Pool.QueryRow(ctx, `
		select m.id, m.room_id, m.account_id, m.name, m.app, m.job, m.folder, m.machine, m.turn, m.holder_session,
		       m.holder_epoch, m.key_epoch, m.ed25519_pk, m.x25519_pk, m.handover_env, m.removed_at is not null,
		       r.deleted_at is not null, a.display_name, r.name, r.purpose
		from members m join rooms r on r.id = m.room_id join accounts a on a.id = m.account_id
		where m.ed25519_pk = $1
		order by (m.removed_at is null) desc, m.removed_at desc limit 1`, key).Scan(
		&m.ID, &m.RoomID, &m.AccountID, &m.Name, &m.App, &m.Job, &m.Folder, &m.Machine, &m.Turn, &m.HolderSession,
		&m.HolderEpoch, &m.KeyEpoch, &m.Ed, &m.X, &m.Handover, &removed, &roomDeleted, &m.PersonName, &m.RoomName, &m.RoomPurpose)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, httpx.E(401, "unknown_key", "This key isn't a member of any room.")
	}
	if err != nil {
		return nil, err
	}
	if roomDeleted {
		return nil, roomGone()
	}
	if removed {
		return nil, gone()
	}
	return m, nil
}

func gone() *httpx.Error     { return httpx.E(410, "gone", "This member was removed from the room.") }
func roomGone() *httpx.Error { return httpx.E(410, "room_gone", "This room was deleted.") }

func notHolder(epoch int64) *httpx.Error {
	return httpx.E(409, "not_holder", "Another chat is using this member now.").With("holder_epoch", epoch)
}

// requireHolder: if the member has a holder, X-Botlink-Session must equal it (SPEC §6.7).
func requireHolder(c *Caller) error {
	if c.M.HolderSession != nil && *c.M.HolderSession != c.Session {
		return notHolder(c.M.HolderEpoch)
	}
	return nil
}

// ── per-copy long-poll cap (2 per member per kind; the oldest gets 409 superseded)

type PollReg struct {
	mu sync.Mutex
	m  map[string][]*Poll
	ms *metrics.Set
}

type Poll struct {
	Superseded chan struct{}
	once       sync.Once
}

func NewPollReg(ms *metrics.Set) *PollReg { return &PollReg{m: map[string][]*Poll{}, ms: ms} }

// Open registers a poll for member+kind; the returned func unregisters it.
func (p *PollReg) Open(member, kind string) (*Poll, func()) {
	key := member + "|" + kind
	poll := &Poll{Superseded: make(chan struct{})}
	p.mu.Lock()
	list := append(p.m[key], poll)
	for len(list) > 2 {
		old := list[0]
		old.once.Do(func() { close(old.Superseded) })
		list = list[1:]
	}
	p.m[key] = list
	p.mu.Unlock()
	if p.ms != nil {
		p.ms.OpenPolls.Add(1, kind)
	}
	return poll, func() {
		p.mu.Lock()
		l := p.m[key]
		for i, x := range l {
			if x == poll {
				l = append(l[:i:i], l[i+1:]...)
				break
			}
		}
		if len(l) == 0 {
			delete(p.m, key)
		} else {
			p.m[key] = l
		}
		p.mu.Unlock()
		if p.ms != nil {
			p.ms.OpenPolls.Add(-1, kind)
		}
	}
}

// polled counts a lease / wait / roster / count call against the member's poll budget (ratelimit.Polls, live bug B):
// a client stuck in a loop gets 429 too_many_polls with Retry-After instead of hammering the server.
func (a *API) polled(h func(w http.ResponseWriter, r *http.Request, c *Caller) error) func(w http.ResponseWriter, r *http.Request, c *Caller) error {
	return func(w http.ResponseWriter, r *http.Request, c *Caller) error {
		if err := ratelimit.Hit(r.Context(), a.St.Pool, ratelimit.Polls, c.M.ID); err != nil {
			return err
		}
		return h(w, r, c)
	}
}
