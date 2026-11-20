package appapi

import (
	"context"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"fmt"
	"html"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"

	"github.com/charles161/botlink/server/internal/analytics"
	"github.com/charles161/botlink/server/internal/auth"
	"github.com/charles161/botlink/server/internal/httpx"
	"github.com/charles161/botlink/server/internal/humancheck"
	"github.com/charles161/botlink/server/internal/store"
	"github.com/charles161/botlink/server/internal/wire"
)

func (a *API) getProviders(w http.ResponseWriter, r *http.Request) error {
	httpx.WriteJSON(w, 200, map[string]any{"providers": a.Cfg.Providers()})
	return nil
}

var returnToRe = regexp.MustCompile(`^/[^/\\].*$|^/$`)

// safeReturn keeps return_to on this site: a path starting with one "/", no backslash and no control or space
// characters at all (security review: browsers drop a tab or a newline, so "/\t/evil.example" became
// "//evil.example", another site).
func safeReturn(s string) string {
	if s == "" || !returnToRe.MatchString(s) || len(s) > 500 || strings.ContainsRune(s, '\\') {
		return "/rooms"
	}
	for _, r := range s {
		if r <= ' ' || r == 0x7f || r == '\u00a0' || r == '\u2028' || r == '\u2029' || r == '\ufeff' {
			return "/rooms"
		}
	}
	return s
}

// The sign-in's OAuth state is bound to the browser that started it (security review: login CSRF). Without it, an
// attacker could start a sign-in in their own browser and hand the victim the callback link, signing the victim into
// the attacker's account. __Host- where cookies are Secure: only this exact host can set it.
const (
	oauthCookieHost = "__Host-bl_oauth"
	oauthCookieBare = "bl_oauth"
)

func (a *API) oauthCookieName() string {
	if a.Cfg.SecureCookies() {
		return oauthCookieHost
	}
	return oauthCookieBare
}

func (a *API) oauthCookie(val string, maxAge int) *http.Cookie {
	return &http.Cookie{Name: a.oauthCookieName(), Value: val, Path: "/", HttpOnly: true, Secure: a.Cfg.SecureCookies(),
		SameSite: http.SameSiteLaxMode, MaxAge: maxAge}
}

// stateFromThisBrowser: the callback's state is the one this browser's cookie holds (constant time).
func (a *API) stateFromThisBrowser(r *http.Request, state string) bool {
	ck, err := r.Cookie(a.oauthCookieName())
	if err != nil || ck.Value == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(ck.Value), []byte(state)) == 1
}

func (a *API) redirectURI(provider string) string {
	return a.Cfg.AppOrigin + "/app/v1/auth/" + provider + "/callback"
}

// GET /app/v1/auth/{provider}/start → 302 to the provider (PKCE; state in oauth_states).
func (a *API) getOAuthStart(w http.ResponseWriter, r *http.Request) error {
	p := a.Providers[r.PathValue("provider")]
	if p == nil {
		return httpx.NotFound()
	}
	state := wire.B64URL(wire.RandBytes(32))
	verifier := auth.NewVerifier()
	if _, err := a.St.Pool.Exec(r.Context(), `insert into oauth_states (state_hash, provider, verifier, return_to, expires_at)
		values ($1,$2,$3,$4, now() + interval '10 minutes')`, wire.SHA256([]byte(state)), p.Name(), verifier,
		safeReturn(r.URL.Query().Get("return_to"))); err != nil {
		return err
	}
	http.SetCookie(w, a.oauthCookie(state, 600))
	http.Redirect(w, r, p.AuthCodeURL(state, auth.PKCEChallenge(verifier), a.redirectURI(p.Name())), http.StatusFound)
	return nil
}

func (a *API) oauthErrorPage(w http.ResponseWriter, code, msg string) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("X-Robots-Tag", "noindex")
	w.WriteHeader(400)
	fmt.Fprintf(w, `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign-in problem · bot-link</title><link rel="stylesheet" href="/assets/app.css"></head>
<body><main class="page narrow"><h1>Sign-in didn't work</h1><p>%s</p><p><a href="/login">Try again</a></p>
<!-- %s --></main></body></html>`, html.EscapeString(msg), html.EscapeString(code))
}

// GET /app/v1/auth/{provider}/callback
func (a *API) getOAuthCallback(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	p := a.Providers[r.PathValue("provider")]
	if p == nil {
		return httpx.NotFound()
	}
	q := r.URL.Query()
	state, code := q.Get("state"), q.Get("code")
	if state == "" || code == "" {
		a.oauthErrorPage(w, "oauth_failed", "The sign-in was cancelled or incomplete.")
		return nil
	}
	fromHere := a.stateFromThisBrowser(r, state)
	http.SetCookie(w, a.oauthCookie("", -1)) // one use, whatever happens next
	if !fromHere {
		a.oauthErrorPage(w, "oauth_state_browser", "This sign-in was started in another browser or tab. Start again here.")
		return nil
	}
	var verifier, returnTo, provider string
	err := a.St.Pool.QueryRow(ctx, `delete from oauth_states where state_hash = $1 and expires_at > now() returning verifier, return_to, provider`,
		wire.SHA256([]byte(state))).Scan(&verifier, &returnTo, &provider)
	if err != nil || provider != p.Name() {
		a.oauthErrorPage(w, "oauth_failed", "This sign-in link expired. Start again.")
		return nil
	}
	id, err := p.Exchange(ctx, code, verifier, a.redirectURI(p.Name()))
	if err != nil {
		slog.WarnContext(ctx, "oauth exchange failed", "provider", p.Name(), "err", err, "request_id", httpx.RequestID(ctx))
		a.oauthErrorPage(w, "oauth_failed", "The sign-in provider didn't confirm who you are. Try again.")
		return nil
	}
	if !id.EmailVerified {
		a.oauthErrorPage(w, "email_not_verified", "bot-link needs a verified email address on your account.")
		return nil
	}
	var val, created string
	err = a.St.Tx(ctx, func(tx pgx.Tx) error {
		account, err := auth.LoginLimited(ctx, tx, id, a.Signup.Check(httpx.ClientIP(r, a.Cfg.TrustCF)))
		if err != nil {
			return err
		}
		if created = ""; a.An.Enabled() && analytics.IsNewAccount(ctx, tx, account) {
			created = account
		}
		val, err = auth.Create(ctx, tx, account, r.UserAgent())
		return err
	})
	if err == nil && created != "" {
		a.An.Capture(analytics.AccountCreated, a.An.ID(created), nil)
	}
	if errors.Is(err, auth.ErrEmailNotVerified) {
		a.oauthErrorPage(w, "email_not_verified", "bot-link needs a verified email address on your account.")
		return nil
	}
	if errors.Is(err, auth.ErrSignupLimited) { // one page for every sign-up limit; nothing about the email
		a.oauthErrorPage(w, "signup_limited", auth.SignupLimitedText)
		return nil
	}
	if err != nil {
		return err
	}
	http.SetCookie(w, auth.Cookie(val, a.Cfg.SecureCookies(), int(auth.SessionTTL.Seconds())))
	http.Redirect(w, r, safeReturn(returnTo), http.StatusFound)
	return nil
}

var emailRe = regexp.MustCompile(`^[^@\s]{1,64}@[^@\s]{1,189}$`)

// POST /app/v1/auth/dev-login (BOTLINK_DEV_LOGIN=1 only; never in prod).
func (a *API) postDevLogin(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	if !a.originOK(r) {
		return csrfFailed()
	}
	body, err := httpx.ReadBody(r)
	if err != nil {
		return err
	}
	var b struct {
		Email       string  `json:"email"`
		DisplayName *string `json:"display_name"`
	}
	if err := httpx.DecodeStrict(body, &b); err != nil {
		return err
	}
	email := strings.ToLower(strings.TrimSpace(b.Email))
	if !emailRe.MatchString(email) {
		return httpx.BadRequest("email must be an email address.")
	}
	name := ""
	if b.DisplayName != nil {
		name = strings.TrimSpace(*b.DisplayName)
		if n := utf8.RuneCountInString(name); n < 1 || n > 80 {
			return httpx.BadRequest("display_name must be 1..80 characters.")
		}
	}
	var val, created string
	err = a.St.Tx(ctx, func(tx pgx.Tx) error {
		account, err := auth.Login(ctx, tx, &auth.Identity{Provider: "dev", Subject: email, Email: email, EmailVerified: true, Name: name})
		if err != nil {
			return err
		}
		if created = ""; a.An.Enabled() && analytics.IsNewAccount(ctx, tx, account) {
			created = account
		}
		if name != "" {
			if _, err := tx.Exec(ctx, `update accounts set display_name = $2 where id = $1`, account, name); err != nil {
				return err
			}
		}
		val, err = auth.Create(ctx, tx, account, r.UserAgent())
		return err
	})
	if err != nil {
		return err
	}
	if created != "" {
		a.An.Capture(analytics.AccountCreated, a.An.ID(created), nil)
	}
	http.SetCookie(w, auth.Cookie(val, a.Cfg.SecureCookies(), int(auth.SessionTTL.Seconds())))
	s, err := auth.Load(ctx, a.St.Pool, val)
	if err != nil || s == nil {
		return httpx.Internal(fmt.Errorf("session vanished: %v", err))
	}
	me, err := a.appMe(ctx, s, "")
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, 200, me)
	return nil
}

func (a *API) postLogout(w http.ResponseWriter, r *http.Request, s *auth.Session) error {
	if _, err := a.St.Pool.Exec(r.Context(), `delete from web_sessions where token_hash = $1`, s.Hash); err != nil {
		return err
	}
	http.SetCookie(w, auth.Cookie("", a.Cfg.SecureCookies(), -1))
	httpx.WriteJSON(w, 200, map[string]any{"ok": true})
	return nil
}

// POST /app/v1/me/sessions/sign-out-others: end every session of my account but this one (security review: there was
// no way to revoke a browser's sign-in).
// It also cancels a pending account delete and pauses new asks (account_guard.go).
func (a *API) postSignOutOthers(w http.ResponseWriter, r *http.Request, s *auth.Session) error {
	n, cancelled, undone, err := a.signOutOthers(r.Context(), s)
	if err != nil {
		return err
	}
	out := undoneJSON(undone)
	out["signed_out"], out["delete_cancelled"], out["first_passkey_removed"] = n, cancelled, undone != nil
	httpx.WriteJSON(w, 200, out)
	return nil
}

// appMe builds AppMe; deviceID is this browser's device (null unless it's mine).
func (a *API) appMe(ctx context.Context, s *auth.Session, deviceID string) (map[string]any, error) {
	var dev any
	if deviceID != "" {
		d, err := a.deviceJSON(ctx, a.St.Pool, s.AccountID, deviceID)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return nil, err
		}
		if d != nil {
			dev = d
		}
	}
	var registered bool
	if err := a.St.Pool.QueryRow(ctx, `select exists(select 1 from webauthn_credentials where account_id = $1)`, s.AccountID).Scan(&registered); err != nil {
		return nil, err
	}
	paused, err := wakesPaused(ctx, a.St.Pool, s.AccountID)
	if err != nil {
		return nil, err
	}
	me := map[string]any{
		"account":    map[string]any{"id": s.AccountID, "email": s.Email, "display_name": s.DisplayName, "avatar_url": s.AvatarURL},
		"csrf_token": s.CSRF, "device": dev, "webauthn_registered": registered, "uv_fresh": s.UVFresh,
		"human_check_mode": a.Cfg.HumanCheck, "wakes_paused": paused != nil,
		"paywall": a.Cfg.Plans.Paywall(), // false: the dashboard shows no plan, usage, credits or billing screen
	}
	if a.Cfg.IsAdmin(s.Email) { // admin area (adminapi); absent for everyone else, so non-admins see no trace of it
		me["is_admin"] = true
	}
	return me, nil
}

func (a *API) getMe(w http.ResponseWriter, r *http.Request, s *auth.Session) error {
	dev := r.URL.Query().Get("device_id")
	if dev != "" && !wire.IsUUID(dev) {
		return httpx.BadRequest("device_id must be a uuid.")
	}
	me, err := a.appMe(r.Context(), s, dev)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, 200, me)
	return nil
}

// ── devices

func (a *API) deviceJSON(ctx context.Context, q store.Q, account, id string) (map[string]any, error) {
	var pk []byte
	var label string
	var created time.Time
	var revoked, approved *time.Time
	var certified, pending int
	err := q.QueryRow(ctx, `
		select d.ed25519_pk, d.label, d.created_at, d.revoked_at, d.approved_at,
		  (select count(*) from room_signers s join rooms r on r.id = s.room_id
		     where s.ed25519_pk = d.ed25519_pk and s.removed_seq is null and r.deleted_at is null),
		  (select count(*) from room_people p join rooms r on r.id = p.room_id
		     where p.account_id = d.account_id and p.removed_at is null and r.deleted_at is null
		       and not exists (select 1 from room_signers s where s.room_id = p.room_id and s.ed25519_pk = d.ed25519_pk and s.removed_seq is null))
		from devices d where d.id = $1 and d.account_id = $2`, id, account).Scan(&pk, &label, &created, &revoked, &approved, &certified, &pending)
	if err != nil {
		return nil, err
	}
	list := []store.PendingRoom{}
	if revoked != nil {
		pending = 0
	} else if pending > 0 {
		if list, err = store.DevicePendingRooms(ctx, q, account, pk); err != nil {
			return nil, err
		}
	}
	return map[string]any{"id": id, "ed25519_pk": hex.EncodeToString(pk), "label": label, "fingerprint": wire.DeviceFP(pk),
		"created_at": created.UTC(), "revoked_at": utcPtr(revoked), "certified_rooms": certified, "pending_rooms": pending,
		"approved": approved != nil && revoked == nil, "pending": list}, nil
}

func utcPtr(t *time.Time) any {
	if t == nil {
		return nil
	}
	return t.UTC()
}

func (a *API) getDevices(w http.ResponseWriter, r *http.Request, s *auth.Session) error {
	ctx := r.Context()
	rows, err := a.St.Pool.Query(ctx, `select id from devices where account_id = $1 order by created_at`, s.AccountID)
	if err != nil {
		return err
	}
	ids, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return err
	}
	out := make([]map[string]any, 0, len(ids))
	for _, id := range ids {
		d, err := a.deviceJSON(ctx, a.St.Pool, s.AccountID, id)
		if err != nil {
			return err
		}
		out = append(out, d)
	}
	httpx.WriteJSON(w, 200, map[string]any{"devices": out})
	return nil
}

// POST /app/v1/devices: register this browser's device key (idempotent by id).
func (a *API) postDevice(w http.ResponseWriter, r *http.Request, s *auth.Session) error {
	ctx := r.Context()
	body, err := httpx.ReadBody(r)
	if err != nil {
		return err
	}
	var b struct {
		ID    string `json:"id"`
		PK    string `json:"ed25519_pk"`
		Label string `json:"label"`
	}
	if err := httpx.DecodeStrict(body, &b); err != nil {
		return err
	}
	pk, ok := wire.DecodeHex32(b.PK)
	if !wire.IsUUID(b.ID) || !ok {
		return httpx.BadRequest("id must be a uuid and ed25519_pk 64 lowercase hex chars.")
	}
	if n := utf8.RuneCountInString(b.Label); n < 1 || n > 80 {
		return httpx.BadRequest("label must be 1..80 characters.")
	}
	status := 201
	err = a.St.Tx(ctx, func(tx pgx.Tx) error {
		var acct string
		var oldPK []byte
		err := tx.QueryRow(ctx, `select account_id, ed25519_pk from devices where id = $1`, b.ID).Scan(&acct, &oldPK)
		if err == nil {
			if acct == s.AccountID && hex.EncodeToString(oldPK) == b.PK {
				status = 200
				return nil
			}
			return httpx.E(409, "id_conflict", "A different device already used this id.")
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		// the account's first browser is approved by signing in; every later one by a browser already approved
		if _, err := tx.Exec(ctx, `insert into devices (id, account_id, ed25519_pk, label, approved_at) values ($1,$2,$3,$4,
			case when exists(select 1 from devices where account_id = $2 and revoked_at is null) then null else now() end)`,
			b.ID, s.AccountID, pk, b.Label); err != nil {
			if store.IsUniqueViolation(err, "") {
				return httpx.E(409, "key_in_use", "This device key is already registered.")
			}
			return err
		}
		// a new browser for a person already in rooms → "What needs you" on a browser that can sign
		return store.SyncDeviceAttention(ctx, tx, s.AccountID, b.ID)
	})
	if err != nil {
		return err
	}
	d, err := a.deviceJSON(ctx, a.St.Pool, s.AccountID, b.ID)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, status, d)
	return nil
}

func (a *API) myDevicePK(ctx context.Context, q store.Q, account, id string) ([]byte, error) {
	var pk []byte
	err := q.QueryRow(ctx, `select ed25519_pk from devices where id = $1 and account_id = $2 and revoked_at is null`, id, account).Scan(&pk)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, httpx.NotFound()
	}
	return pk, err
}

// POST /app/v1/devices/{id}/ask: this browser can't sign in some room → (re)open its new_device item, so the
// person's other browsers show "New browser … Approve" (also after the item was dismissed). Idempotent.
func (a *API) postDeviceAsk(w http.ResponseWriter, r *http.Request, s *auth.Session) error {
	ctx := r.Context()
	id := r.PathValue("id")
	if !wire.IsUUID(id) {
		return httpx.NotFound()
	}
	if _, err := a.myDevicePK(ctx, a.St.Pool, s.AccountID, id); err != nil {
		return err
	}
	if err := a.St.Tx(ctx, func(tx pgx.Tx) error { return store.SyncDeviceAttention(ctx, tx, s.AccountID, id) }); err != nil {
		return err
	}
	d, err := a.deviceJSON(ctx, a.St.Pool, s.AccountID, id)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, 200, d)
	return nil
}

// GET /app/v1/devices/{id}/pending-rooms
func (a *API) getPendingRooms(w http.ResponseWriter, r *http.Request, s *auth.Session) error {
	ctx := r.Context()
	id := r.PathValue("id")
	if !wire.IsUUID(id) {
		return httpx.NotFound()
	}
	pk, err := a.myDevicePK(ctx, a.St.Pool, s.AccountID, id)
	if err != nil {
		return err
	}
	rows, err := a.St.Pool.Query(ctx, `
		select r.id, r.roster_head_seq, e.entry_hash from room_people p join rooms r on r.id = p.room_id
		join roster_entries e on e.room_id = r.id and e.seq = r.roster_head_seq
		where p.account_id = $1 and p.removed_at is null and r.deleted_at is null
		  and not exists (select 1 from room_signers s where s.room_id = r.id and s.ed25519_pk = $2 and s.removed_seq is null)
		order by r.id`, s.AccountID, pk)
	if err != nil {
		return err
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var room string
		var head int
		var hash []byte
		if err := rows.Scan(&room, &head, &hash); err != nil {
			return err
		}
		out = append(out, map[string]any{"room_id": room, "head_seq": head, "head_hash": hex.EncodeToString(hash)})
	}
	if err := rows.Err(); err != nil {
		return err
	}
	httpx.WriteJSON(w, 200, map[string]any{"rooms": out})
	return nil
}

// POST /app/v1/human-check
func (a *API) postHumanCheck(w http.ResponseWriter, r *http.Request, s *auth.Session) error {
	body, err := httpx.ReadBody(r)
	if err != nil {
		return err
	}
	var b struct {
		Action  string   `json:"action"`
		Target  *string  `json:"target_id"`
		Targets []string `json:"targets"`
	}
	if err := httpx.DecodeStrict(body, &b); err != nil {
		return err
	}
	out, err := a.HC.Start(r.Context(), a.St.Pool, s, b.Action, b.Target, b.Targets)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, 200, out)
	return nil
}

// verifyHuman runs the pre-transaction part of the human check.
func (a *API) verifyHuman(r *http.Request, s *auth.Session, p *humancheck.Proof, action, target string) error {
	return a.HC.Verify(r.Context(), a.St.Pool, s, p, action, target, httpx.ClientIP(r, a.Cfg.TrustCF))
}
