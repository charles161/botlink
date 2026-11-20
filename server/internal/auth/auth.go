// Package auth signs people in: GitHub and Google OAuth 2 (authorization code + PKCE) behind the
// Provider interface (Supabase Auth can replace them later as provider "supabase"), account linking by
// verified email, and cookie sessions (ENVELOPE §6).
package auth

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"

	"github.com/charles161/botlink/server/internal/store"
	"github.com/charles161/botlink/server/internal/wire"
)

// Identity is what a provider vouches for.
type Identity struct {
	Provider      string
	Subject       string
	Email         string
	EmailVerified bool
	Name          string
	AvatarURL     string
}

// Provider is one login method. Supabase Auth would be another implementation.
type Provider interface {
	Name() string
	AuthCodeURL(state, codeChallenge, redirectURI string) string
	Exchange(ctx context.Context, code, verifier, redirectURI string) (*Identity, error)
}

var ErrEmailNotVerified = errors.New("email not verified")

// ── PKCE

func PKCEChallenge(verifier string) string {
	h := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(h[:])
}

func NewVerifier() string { return base64.RawURLEncoding.EncodeToString(wire.RandBytes(32)) }

// ── OAuth 2 generic plumbing

type oauthEndpoints struct {
	AuthURL, TokenURL string
}

func exchangeToken(ctx context.Context, hc *http.Client, tokenURL, clientID, secret, code, verifier, redirectURI string) (string, error) {
	form := url.Values{"grant_type": {"authorization_code"}, "code": {code}, "redirect_uri": {redirectURI},
		"client_id": {clientID}, "client_secret": {secret}, "code_verifier": {verifier}}
	req, err := http.NewRequestWithContext(ctx, "POST", tokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	resp, err := hc.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	var tok struct {
		AccessToken string `json:"access_token"`
		Error       string `json:"error"`
	}
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	if err := json.Unmarshal(b, &tok); err != nil || resp.StatusCode != 200 || tok.AccessToken == "" {
		return "", fmt.Errorf("token exchange failed (%d %s)", resp.StatusCode, tok.Error)
	}
	return tok.AccessToken, nil
}

func getJSON(ctx context.Context, hc *http.Client, u, token string, v any) error {
	req, err := http.NewRequestWithContext(ctx, "GET", u, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/json")
	resp, err := hc.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("GET %s: %d", u, resp.StatusCode)
	}
	return json.NewDecoder(io.LimitReader(resp.Body, 256<<10)).Decode(v)
}

func authURL(base, clientID, redirectURI, scope, state, challenge string, extra url.Values) string {
	q := url.Values{"response_type": {"code"}, "client_id": {clientID}, "redirect_uri": {redirectURI}, "scope": {scope},
		"state": {state}, "code_challenge": {challenge}, "code_challenge_method": {"S256"}}
	for k, v := range extra {
		q[k] = v
	}
	return base + "?" + q.Encode()
}

// ── GitHub

type GitHub struct {
	ClientID, Secret string
	AuthURLBase      string // default https://github.com/login/oauth/authorize
	TokenURL         string // default https://github.com/login/oauth/access_token
	APIBase          string // default https://api.github.com
	HTTP             *http.Client
}

func (g *GitHub) Name() string { return "github" }

func (g *GitHub) defaults() {
	if g.AuthURLBase == "" {
		g.AuthURLBase = "https://github.com/login/oauth/authorize"
	}
	if g.TokenURL == "" {
		g.TokenURL = "https://github.com/login/oauth/access_token"
	}
	if g.APIBase == "" {
		g.APIBase = "https://api.github.com"
	}
	if g.HTTP == nil {
		g.HTTP = &http.Client{Timeout: 10 * time.Second}
	}
}

func (g *GitHub) AuthCodeURL(state, challenge, redirectURI string) string {
	g.defaults()
	return authURL(g.AuthURLBase, g.ClientID, redirectURI, "read:user user:email", state, challenge, url.Values{"allow_signup": {"true"}})
}

func (g *GitHub) Exchange(ctx context.Context, code, verifier, redirectURI string) (*Identity, error) {
	g.defaults()
	tok, err := exchangeToken(ctx, g.HTTP, g.TokenURL, g.ClientID, g.Secret, code, verifier, redirectURI)
	if err != nil {
		return nil, err
	}
	var u struct {
		ID        int64  `json:"id"`
		Login     string `json:"login"`
		Name      string `json:"name"`
		AvatarURL string `json:"avatar_url"`
	}
	if err := getJSON(ctx, g.HTTP, g.APIBase+"/user", tok, &u); err != nil {
		return nil, err
	}
	var emails []struct {
		Email    string `json:"email"`
		Primary  bool   `json:"primary"`
		Verified bool   `json:"verified"`
	}
	if err := getJSON(ctx, g.HTTP, g.APIBase+"/user/emails", tok, &emails); err != nil {
		return nil, err
	}
	id := &Identity{Provider: "github", Subject: strconv.FormatInt(u.ID, 10), Name: u.Name, AvatarURL: u.AvatarURL}
	if id.Name == "" {
		id.Name = u.Login
	}
	for _, e := range emails {
		if e.Primary && e.Verified {
			id.Email, id.EmailVerified = e.Email, true
		}
	}
	if u.ID == 0 {
		return nil, errors.New("github returned no user id")
	}
	return id, nil
}

// ── Google

type Google struct {
	ClientID, Secret string
	AuthURLBase      string // default https://accounts.google.com/o/oauth2/v2/auth
	TokenURL         string // default https://oauth2.googleapis.com/token
	UserInfoURL      string // default https://openidconnect.googleapis.com/v1/userinfo
	HTTP             *http.Client
}

func (g *Google) Name() string { return "google" }

func (g *Google) defaults() {
	if g.AuthURLBase == "" {
		g.AuthURLBase = "https://accounts.google.com/o/oauth2/v2/auth"
	}
	if g.TokenURL == "" {
		g.TokenURL = "https://oauth2.googleapis.com/token"
	}
	if g.UserInfoURL == "" {
		g.UserInfoURL = "https://openidconnect.googleapis.com/v1/userinfo"
	}
	if g.HTTP == nil {
		g.HTTP = &http.Client{Timeout: 10 * time.Second}
	}
}

func (g *Google) AuthCodeURL(state, challenge, redirectURI string) string {
	g.defaults()
	return authURL(g.AuthURLBase, g.ClientID, redirectURI, "openid email profile", state, challenge, url.Values{"prompt": {"select_account"}})
}

func (g *Google) Exchange(ctx context.Context, code, verifier, redirectURI string) (*Identity, error) {
	g.defaults()
	tok, err := exchangeToken(ctx, g.HTTP, g.TokenURL, g.ClientID, g.Secret, code, verifier, redirectURI)
	if err != nil {
		return nil, err
	}
	var u struct {
		Sub           string `json:"sub"`
		Email         string `json:"email"`
		EmailVerified any    `json:"email_verified"` // bool, sometimes "true"
		Name          string `json:"name"`
		Picture       string `json:"picture"`
	}
	if err := getJSON(ctx, g.HTTP, g.UserInfoURL, tok, &u); err != nil {
		return nil, err
	}
	if u.Sub == "" {
		return nil, errors.New("google returned no subject")
	}
	verified := u.EmailVerified == true || u.EmailVerified == "true"
	return &Identity{Provider: "google", Subject: u.Sub, Email: u.Email, EmailVerified: verified, Name: u.Name, AvatarURL: u.Picture}, nil
}

// ── accounts

func cleanName(name, email string) string {
	name = strings.TrimSpace(name)
	if name == "" {
		name, _, _ = strings.Cut(email, "@")
	}
	if name == "" {
		name = "Someone"
	}
	for utf8.RuneCountInString(name) > 80 {
		r := []rune(name)
		name = string(r[:80])
	}
	return name
}

// Login maps a verified identity to an account: known identity → its account; known email → link;
// else a new account. The email decides the account (one account per verified email).
func Login(ctx context.Context, tx pgx.Tx, id *Identity) (string, error) {
	return LoginLimited(ctx, tx, id, nil)
}

// LoginLimited is Login that runs beforeNew (sign-up limits, signup_limit.go) only when it would create an account.
func LoginLimited(ctx context.Context, tx pgx.Tx, id *Identity, beforeNew func(context.Context, pgx.Tx) error) (string, error) {
	if !id.EmailVerified || !strings.Contains(id.Email, "@") {
		return "", ErrEmailNotVerified
	}
	email := strings.ToLower(strings.TrimSpace(id.Email))
	var account string
	err := tx.QueryRow(ctx, `select account_id from identities where provider = $1 and subject = $2`, id.Provider, id.Subject).Scan(&account)
	if err == nil {
		_, err = tx.Exec(ctx, `update identities set email = $3 where provider = $1 and subject = $2`, id.Provider, id.Subject, email)
		return account, err
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return "", err
	}
	err = tx.QueryRow(ctx, `select id from accounts where email = $1`, email).Scan(&account)
	if errors.Is(err, pgx.ErrNoRows) {
		if beforeNew != nil {
			if err := beforeNew(ctx, tx); err != nil {
				return "", err
			}
		}
		account = wire.NewV7().String()
		var avatar *string
		if id.AvatarURL != "" && len(id.AvatarURL) <= 500 && strings.HasPrefix(id.AvatarURL, "https://") {
			avatar = &id.AvatarURL
		}
		if _, err := tx.Exec(ctx, `insert into accounts (id, email, display_name, avatar_url) values ($1,$2,$3,$4)
			on conflict (email) do nothing`, account, email, cleanName(id.Name, email), avatar); err != nil {
			return "", err
		}
		if err := tx.QueryRow(ctx, `select id from accounts where email = $1`, email).Scan(&account); err != nil {
			return "", err
		}
	} else if err != nil {
		return "", err
	}
	_, err = tx.Exec(ctx, `insert into identities (provider, subject, account_id, email) values ($1,$2,$3,$4)
		on conflict (provider, subject) do nothing`, id.Provider, id.Subject, account, email)
	return account, err
}

// ── sessions

// The session cookie. Where cookies are Secure (everywhere but dev) it is __Host-bl_session: a browser accepts that
// name only from this exact host, with Secure, Path=/ and no Domain, so a page on another host of the same domain
// (the public site) cannot plant one. A __Host- cookie needs Secure, so dev over plain http keeps the bare name.
// The bare name is also what Secure deployments used before: there it is ignored and cleared (DropOldCookie).
const (
	CookieHostName = "__Host-bl_session"
	CookieBareName = "bl_session"
)

// CookieName is the session cookie's name for this deployment.
func CookieName(secure bool) string {
	if secure {
		return CookieHostName
	}
	return CookieBareName
}

// DropOldCookie expires a bl_session cookie that a browser still sends to /app/v1 of a Secure deployment (the name
// before __Host-bl_session). It is never read as a session: the person signs in again.
func DropOldCookie(secure bool, next http.Handler) http.Handler {
	if !secure {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/app/v1/") {
			if _, err := r.Cookie(CookieBareName); err == nil {
				http.SetCookie(w, &http.Cookie{Name: CookieBareName, Value: "", Path: "/", HttpOnly: true, Secure: true, SameSite: http.SameSiteLaxMode, MaxAge: -1})
			}
		}
		next.ServeHTTP(w, r)
	})
}

const SessionTTL = 30 * 24 * time.Hour

// Session is a signed-in browser.
type Session struct {
	Hash        []byte
	AccountID   string
	CSRF        string
	UVAt        *time.Time
	UVFresh     bool // WebAuthn step-up within 60 min
	FreshLogin  bool // created within 5 min (fallback human check)
	Email       string
	DisplayName string
	AvatarURL   *string
}

// Create inserts a session and returns the cookie value.
func Create(ctx context.Context, q store.Q, account, userAgent string) (string, error) {
	tok := wire.RandBytes(32)
	val := base64.RawURLEncoding.EncodeToString(tok)
	if len(userAgent) > 300 {
		userAgent = userAgent[:300]
	}
	csrf := base64.RawURLEncoding.EncodeToString(wire.RandBytes(32))
	_, err := q.Exec(ctx, `insert into web_sessions (token_hash, account_id, csrf_token, user_agent, expires_at)
		values ($1,$2,$3,$4, now() + interval '30 days')`, wire.SHA256([]byte(val)), account, csrf, strings.ToValidUTF8(userAgent, ""))
	return val, err
}

// Load reads the session behind a cookie value (nil if missing/expired) and slides last_seen_at.
func Load(ctx context.Context, q store.Q, cookieVal string) (*Session, error) {
	if cookieVal == "" || len(cookieVal) > 100 {
		return nil, nil
	}
	h := wire.SHA256([]byte(cookieVal))
	s := &Session{Hash: h}
	var stale bool
	err := q.QueryRow(ctx, `select s.account_id, s.csrf_token, s.uv_at, coalesce(s.uv_at > now() - interval '60 minutes', false),
			s.created_at > now() - interval '5 minutes', s.last_seen_at < now() - interval '1 minute',
			a.email, a.display_name, a.avatar_url
		from web_sessions s join accounts a on a.id = s.account_id
		where s.token_hash = $1 and s.expires_at > now() and a.deleted_at is null`, h).Scan(
		&s.AccountID, &s.CSRF, &s.UVAt, &s.UVFresh, &s.FreshLogin, &stale, &s.Email, &s.DisplayName, &s.AvatarURL)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if stale {
		_, _ = q.Exec(ctx, `update web_sessions set last_seen_at = now(), expires_at = greatest(expires_at, now() + interval '30 days')
			where token_hash = $1`, h)
	}
	return s, nil
}

// Cookie builds the session cookie: host-only (no Domain), Path=/, HttpOnly, SameSite=Lax.
func Cookie(val string, secure bool, maxAge int) *http.Cookie {
	return &http.Cookie{Name: CookieName(secure), Value: val, Path: "/", HttpOnly: true, Secure: secure, SameSite: http.SameSiteLaxMode, MaxAge: maxAge}
}
