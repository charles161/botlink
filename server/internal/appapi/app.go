// Package appapi is the /app/v1 surface: people only. Cookie session bl_session + X-CSRF-Token + Origin
// check on every non-GET (ENVELOPE §6). No CORS headers. It never answers a signed-only request.
package appapi

import (
	"crypto/subtle"
	"encoding/hex"
	"net/http"

	"github.com/charles161/botlink/server/internal/analytics"
	"github.com/charles161/botlink/server/internal/auth"
	"github.com/charles161/botlink/server/internal/config"
	"github.com/charles161/botlink/server/internal/httpx"
	"github.com/charles161/botlink/server/internal/humancheck"
	"github.com/charles161/botlink/server/internal/metrics"
	"github.com/charles161/botlink/server/internal/push"
	"github.com/charles161/botlink/server/internal/ratelimit"
	"github.com/charles161/botlink/server/internal/store"
	"github.com/charles161/botlink/server/internal/wake"
)

type API struct {
	St        *store.Store
	Bus       *wake.Bus
	Cfg       *config.Config
	M         *metrics.Set
	HC        *humancheck.Checker
	Providers map[string]auth.Provider
	An        *analytics.Client  // server-side product events (nil: off)
	Signup    *auth.SignupLimits // limits on new accounts (OAuth sign-ups; dev login is not limited)
	Mail      RecoveryMailer     // passkey reset notices (recoverymail.go); NoMail unless set
	Pusher    *push.Client       // the push guard (an event address is checked again when its person approves it)
}

func New(st *store.Store, bus *wake.Bus, cfg *config.Config, m *metrics.Set, hc *humancheck.Checker) *API {
	a := &API{St: st, Bus: bus, Cfg: cfg, M: m, HC: hc, Providers: map[string]auth.Provider{}, Signup: auth.NewSignupLimits(cfg.Signup), Mail: NoMail{}}
	if cfg.GitHubClientID != "" && cfg.GitHubSecret != "" {
		a.Providers["github"] = &auth.GitHub{ClientID: cfg.GitHubClientID, Secret: cfg.GitHubSecret}
	}
	if cfg.GoogleClientID != "" && cfg.GoogleSecret != "" {
		a.Providers["google"] = &auth.Google{ClientID: cfg.GoogleClientID, Secret: cfg.GoogleSecret}
	}
	return a
}

type sessHandler func(w http.ResponseWriter, r *http.Request, s *auth.Session) error

func (a *API) Routes(mux *http.ServeMux) {
	h := func(f func(w http.ResponseWriter, r *http.Request) error) http.Handler { return httpx.Handler(f) }
	mux.Handle("GET /app/v1/auth/providers", h(a.getProviders))
	mux.Handle("GET /app/v1/auth/{provider}/start", h(a.getOAuthStart))
	mux.Handle("GET /app/v1/auth/{provider}/callback", h(a.getOAuthCallback))
	if a.Cfg.DevLogin && a.Cfg.Env != "prod" {
		mux.Handle("POST /app/v1/auth/dev-login", h(a.postDevLogin))
	}
	mux.Handle("POST /app/v1/auth/logout", a.sess(a.postLogout))

	mux.Handle("GET /app/v1/me", a.sess(a.getMe))
	mux.Handle("GET /app/v1/devices", a.sess(a.getDevices))
	mux.Handle("POST /app/v1/devices", a.sess(a.postDevice))
	mux.Handle("GET /app/v1/devices/{id}/pending-rooms", a.sess(a.getPendingRooms))
	mux.Handle("POST /app/v1/devices/{id}/certify", a.sess(a.postCertify))
	mux.Handle("POST /app/v1/devices/{id}/ask", a.sess(a.postDeviceAsk))
	mux.Handle("POST /app/v1/human-check", a.sess(a.postHumanCheck))

	mux.Handle("GET /app/v1/rooms", a.sess(a.getRooms))
	mux.Handle("POST /app/v1/rooms", a.sess(a.postRoom))
	mux.Handle("GET /app/v1/rooms/{id}", a.sess(a.getRoom))
	mux.Handle("PATCH /app/v1/rooms/{id}", a.sess(a.patchRoom))
	mux.Handle("DELETE /app/v1/rooms/{id}", a.sess(a.deleteRoom))
	mux.Handle("GET /app/v1/rooms/{id}/roster", a.sess(a.getRoster))
	mux.Handle("POST /app/v1/rooms/{id}/roster", a.sess(a.postRoster))
	mux.Handle("GET /app/v1/rooms/{id}/activity", a.sess(a.getActivity))
	mux.Handle("GET /app/v1/rooms/{id}/chat-invite", a.sess(a.getChatInvite))
	mux.Handle("POST /app/v1/rooms/{id}/chat-invite", a.sess(a.postChatInvite))
	mux.Handle("GET /app/v1/rooms/{id}/person-invites", a.sess(a.getPersonInvites))
	mux.Handle("POST /app/v1/rooms/{id}/person-invites", a.sess(a.postPersonInvite))
	mux.Handle("GET /app/v1/person-invites/{code}", a.sess(a.getPersonInvitePreview))
	mux.Handle("POST /app/v1/person-invites/{code}/accept", a.sess(a.postPersonInviteAccept))

	mux.Handle("GET /app/v1/needs-you", a.sess(a.getNeedsYou))
	mux.Handle("POST /app/v1/join-requests/{id}/approve", a.sess(a.postJoinApprove))
	mux.Handle("POST /app/v1/rooms/{id}/join-requests/approve", a.sess(a.postJoinApproveBatch))
	mux.Handle("POST /app/v1/join-requests/{id}/reject", a.sess(a.postJoinReject))
	mux.Handle("GET /app/v1/join-requests/{id}/readdress", a.sess(a.getReaddress))
	mux.Handle("POST /app/v1/join-requests/{id}/readdress", a.sess(a.postReaddress))
	mux.Handle("POST /app/v1/room-drafts/{id}/claim", a.sess(a.postDraftClaim))
	mux.Handle("POST /app/v1/room-drafts/{id}/confirm", a.sess(a.postDraftConfirm))
	mux.Handle("POST /app/v1/room-drafts/{id}/reject", a.sess(a.postDraftReject))
	mux.Handle("POST /app/v1/person-requests/{id}/approve", a.sess(a.postPersonApprove))
	mux.Handle("POST /app/v1/person-requests/{id}/reject", a.sess(a.postPersonReject))
	mux.Handle("POST /app/v1/members/{id}/unstick", a.sess(a.postUnstick))
	mux.Handle("POST /app/v1/members/{id}/mute", a.sess(a.postMute))
	mux.Handle("POST /app/v1/me/pause", a.sess(a.postPause))
	mux.Handle("POST /app/v1/me/sessions/sign-out-others", a.sess(a.postSignOutOthers))
	mux.Handle("GET /app/v1/me/passkeys", a.sess(a.getPasskeys))
	mux.Handle("POST /app/v1/me/passkeys", a.sess(a.postPasskey))
	mux.Handle("POST /app/v1/me/passkeys/remove", a.sess(a.postPasskeyRemove))
	mux.Handle("POST /app/v1/attention/{id}/dismiss", a.sess(a.postDismiss))
	mux.Handle("GET /app/v1/events", a.sess(a.getEvents))
	a.accountRoutes(mux)  // account export and delete (account_data.go)
	a.recoveryRoutes(mux) // lost passkey and "remove this browser" (recovery.go, devremove.go)
	a.guardRoutes(mux)    // an account's first passkey and the delete wait (account_guard.go)
	a.eventURLRoutes(mux) // event addresses a person approves (eventurl.go)
	mux.Handle("/app/v1/", h(func(w http.ResponseWriter, r *http.Request) error { return httpx.NotFound() }))
}

func unauthenticated() *httpx.Error {
	return httpx.E(401, "unauthenticated", "Sign in first.")
}

func csrfFailed() *httpx.Error {
	return httpx.E(403, "csrf_failed", "This request didn't come from the bot-link dashboard.")
}

// originOK: non-GET requests must carry Origin == BOTLINK_APP_ORIGIN.
func (a *API) originOK(r *http.Request) bool {
	return r.Header.Get("Origin") == a.Cfg.AppOrigin
}

// sess loads the cookie session; non-GET also needs Origin + X-CSRF-Token; 600/min per session.
func (a *API) sess(h sessHandler) http.Handler {
	return httpx.Handler(func(w http.ResponseWriter, r *http.Request) error {
		ctx := r.Context()
		ck, err := r.Cookie(auth.CookieName(a.Cfg.SecureCookies()))
		if err != nil {
			return unauthenticated()
		}
		s, err := auth.Load(ctx, a.St.Pool, ck.Value)
		if err != nil {
			return err
		}
		if s == nil {
			return unauthenticated()
		}
		httpx.SetAccount(ctx, s.AccountID)
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			tok := r.Header.Get("X-CSRF-Token")
			if !a.originOK(r) || tok == "" || subtle.ConstantTimeCompare([]byte(tok), []byte(s.CSRF)) != 1 {
				return csrfFailed()
			}
		}
		if err := ratelimit.Hit(ctx, a.St.Pool, ratelimit.Dashboard, hex.EncodeToString(s.Hash[:12])); err != nil {
			return err
		}
		return h(w, r, s)
	})
}
