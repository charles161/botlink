// Package adminapi is the owner-only, read-only admin area (/app/v1/admin/*, page /admin).
//
// Who: a signed-in account whose verified email is in BOTLINK_ADMIN_EMAILS. Everyone else (signed out,
// another account, or the feature off) gets exactly what an unknown /app/v1 route returns: 404 not_found.
// An admin must also pass the human check once per session (POST /app/v1/admin/human-check, then
// /unlock); that opens the area for UnlockFor, stored on the session row (web_sessions.admin_until) so
// every copy agrees. Until then the data route answers 403 admin_locked (only admins can ever see it).
//
// What: metadata only. Never message text, sealed copies, keys, tokens, cookies, push secrets or push
// URLs; push errors are reduced to a class; other accounts' emails are masked.
package adminapi

import (
	"context"
	"crypto/subtle"
	"encoding/hex"
	"fmt"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/charles161/botlink/server/internal/auth"
	"github.com/charles161/botlink/server/internal/config"
	"github.com/charles161/botlink/server/internal/httpx"
	"github.com/charles161/botlink/server/internal/humancheck"
	"github.com/charles161/botlink/server/internal/metrics"
	"github.com/charles161/botlink/server/internal/ratelimit"
	"github.com/charles161/botlink/server/internal/wake"
)

// UnlockFor is how long one human check keeps the admin area open in a session.
const UnlockFor = 30 * time.Minute

// ListCap bounds every list in the overview (the totals stay exact).
const ListCap = 500

type API struct {
	Pool    *pgxpool.Pool
	Cfg     *config.Config
	M       *metrics.Set
	Bus     *wake.Bus
	HC      *humancheck.Checker
	Errors  *ErrorRing
	Started time.Time
}

// Routes registers one subtree handler, so every method and sub-path behaves the same for non-admins.
func (a *API) Routes(mux *http.ServeMux) {
	mux.Handle("/app/v1/admin/", httpx.Handler(a.serve))
}

type route struct {
	method   string
	unlocked bool // needs admin_until > now()
	h        func(w http.ResponseWriter, r *http.Request, s *auth.Session) error
}

func (a *API) routes() map[string]route {
	m := map[string]route{
		"/app/v1/admin/overview":    {http.MethodGet, true, a.getOverview},
		"/app/v1/admin/metrics":     {http.MethodGet, true, a.getMetrics}, // metrics.go: the numbers behind KILL-CRITERIA.md
		"/app/v1/admin/status":      {http.MethodGet, false, a.getStatus},
		"/app/v1/admin/human-check": {http.MethodPost, false, a.postHumanCheck},
		"/app/v1/admin/unlock":      {http.MethodPost, false, a.postUnlock},
		"/app/v1/admin/lock":        {http.MethodPost, false, a.postLock},
	}
	if a.Cfg.Plans.Paywall() { // plans, limits, credits (plans.go): only with the paywall on
		for k, v := range a.planRoutes() {
			m[k] = v
		}
	}
	for k, v := range a.abuseRoutes() { // the storage list and refuse sends: always (plans.go)
		m[k] = v
	}
	return m
}

func adminLocked() *httpx.Error {
	return httpx.E(403, "admin_locked", "Confirm it's you to open the admin area.").With("unlock_minutes", int(UnlockFor/time.Minute))
}

func (a *API) serve(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	if len(a.Cfg.AdminEmails) == 0 {
		return httpx.NotFound()
	}
	ck, err := r.Cookie(auth.CookieName(a.Cfg.SecureCookies()))
	if err != nil {
		return httpx.NotFound()
	}
	s, err := auth.Load(ctx, a.Pool, ck.Value)
	if err != nil {
		return err
	}
	if s == nil || !a.Cfg.IsAdmin(s.Email) {
		return httpx.NotFound()
	}
	rt, ok := a.routes()[r.URL.Path]
	if !ok || rt.method != r.Method {
		return httpx.NotFound()
	}
	httpx.SetAccount(ctx, s.AccountID)
	if r.Method != http.MethodGet {
		tok := r.Header.Get("X-CSRF-Token")
		if r.Header.Get("Origin") != a.Cfg.AppOrigin || tok == "" || subtle.ConstantTimeCompare([]byte(tok), []byte(s.CSRF)) != 1 {
			return httpx.E(403, "csrf_failed", "This request didn't come from the bot-link dashboard.")
		}
	}
	if err := ratelimit.Hit(ctx, a.Pool, ratelimit.Dashboard, hex.EncodeToString(s.Hash[:12])); err != nil {
		return err
	}
	if rt.unlocked {
		until, err := a.unlockedUntil(ctx, s)
		if err != nil {
			return err
		}
		if until == nil {
			return adminLocked()
		}
	}
	return rt.h(w, r, s)
}

// unlockedUntil is the session's admin_until if it is still in the future (Postgres clock), else nil.
func (a *API) unlockedUntil(ctx context.Context, s *auth.Session) (*time.Time, error) {
	var until *time.Time
	err := a.Pool.QueryRow(ctx, `select case when admin_until > now() then admin_until end from web_sessions where token_hash = $1`,
		s.Hash).Scan(&until)
	return until, err
}

// getStatus says whether this session has the admin area open (so the page asks for the check without a 403).
func (a *API) getStatus(w http.ResponseWriter, r *http.Request, s *auth.Session) error {
	until, err := a.unlockedUntil(r.Context(), s)
	if err != nil {
		return err
	}
	var u any
	if until != nil {
		u = until.UTC()
	}
	httpx.WriteJSON(w, 200, map[string]any{"unlocked": until != nil, "unlocked_until": u, "unlock_minutes": int(UnlockFor / time.Minute)})
	return nil
}

func (a *API) postHumanCheck(w http.ResponseWriter, r *http.Request, s *auth.Session) error {
	body, err := httpx.ReadBody(r)
	if err != nil {
		return err
	}
	if len(body) > 0 {
		var b struct{}
		if err := httpx.DecodeStrict(body, &b); err != nil {
			return err
		}
	}
	out, err := a.HC.StartAdmin(r.Context(), a.Pool, s)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, 200, out)
	return nil
}

func (a *API) postUnlock(w http.ResponseWriter, r *http.Request, s *auth.Session) error {
	ctx := r.Context()
	body, err := httpx.ReadBody(r)
	if err != nil {
		return err
	}
	var b struct {
		HumanCheck *humancheck.Proof `json:"human_check"`
	}
	if err := httpx.DecodeStrict(body, &b); err != nil {
		return err
	}
	if err := a.HC.Verify(ctx, a.Pool, s, b.HumanCheck, humancheck.AdminAction, "", httpx.ClientIP(r, a.Cfg.TrustCF)); err != nil {
		return err
	}
	tx, err := a.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	if err := humancheck.Consume(ctx, tx, b.HumanCheck.ID, s); err != nil {
		return err
	}
	var until time.Time
	if err := tx.QueryRow(ctx, `update web_sessions set admin_until = now() + $2::interval where token_hash = $1 returning admin_until`,
		s.Hash, fmt.Sprintf("%d seconds", int(UnlockFor.Seconds()))).Scan(&until); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	httpx.WriteJSON(w, 200, map[string]any{"unlocked_until": until.UTC()})
	return nil
}

func (a *API) postLock(w http.ResponseWriter, r *http.Request, s *auth.Session) error {
	if _, err := a.Pool.Exec(r.Context(), `update web_sessions set admin_until = null where token_hash = $1`, s.Hash); err != nil {
		return err
	}
	httpx.WriteJSON(w, 200, map[string]any{"ok": true})
	return nil
}
