// Package config reads the server's environment (PLAN.md §2). No secret values have defaults.
package config

import (
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	Env         string // dev | staging | prod
	Addr        string
	CopyID      string
	DatabaseURL string
	ListenURL   string
	AppOrigin   string // e.g. http://localhost:8811
	AppHost     string // host split (prod); empty = one host serves everything
	APIHost     string
	// SiteHost (BOTLINK_SITE_HOST, optional, needs the host split): the public site (landing page, docs, static
	// pages). It serves no dashboard page, no /app/v1, no invite or approve page and no API; the app host then
	// serves no landing page. Empty: the app host serves the landing page too, as before.
	SiteHost                     string
	rpIDDerived                  bool // FromEnv took the WebAuthn RP ID from the app origin (BOTLINK_WEBAUTHN_RP_ID unset)
	DevLogin                     bool
	HumanCheck                   string // stub | real
	TurnstileSiteKey             string
	TurnstileSecret              string
	TurnstileVerifyURL           string // override for tests; default Cloudflare siteverify
	WebAuthnRPID                 string
	WebAuthnOrigin               string
	GitHubClientID, GitHubSecret string
	GoogleClientID, GoogleSecret string
	TrustCF                      bool
	WebDir                       string
	// ClientTGZ: the client tarball served at GET /dl/botlink.tgz on the API host (BOTLINK_CLIENT_TGZ, or
	// BOTLINK_DL_DIR/botlink.tgz). Empty: no /dl route. Read per request, so a `current` symlink follows deploys.
	ClientTGZ string
	// ClientURL: what people and agents run, `npx -y <ClientURL> …` (BOTLINK_CLIENT_URL; default
	// https://<API host>/dl/botlink.tgz, single-host: <app origin>/dl/botlink.tgz). Never the bare npm name.
	ClientURL   string
	DocsDir     string
	RetryMS     int
	MetricsAddr string
	TestFaults  string
	// PushAllowLoopback lets always-on URLs point at 127.0.0.1/::1 (dev/test only, never prod). Private,
	// link-local, metadata and every other blocked range stay blocked.
	PushAllowLoopback bool
	// RecheckMS (BOTLINK_RECHECK_MS; dev/test only, never staging or prod; 0 = the built-in 15 s): how often an open
	// wait looks again by itself. A TEST HOOK for the eval harness: a delayed wake test is noticed on this tick, and
	// at 15 s every wake test in a run costs a quarter of a minute. It changes timing only.
	RecheckMS int
	// EventsNoChallengeHosts (BOTLINK_EVENTS_NO_CHALLENGE_HOSTS, comma-separated exact host names; dev/test only, never
	// prod; empty by default): event subscriptions to a URL on one of these hosts skip the challenge handshake
	// (SPEC §6.13). For a test server whose operator names a trigger endpoint that can only answer 2xx (a cloud
	// agent's routine webhook). Every other guard stays (https, public addresses, no redirects, 5 s).
	EventsNoChallengeHosts []string
	// Workers lets tests run a copy without the push worker / sweeper loops.
	DisablePushWorker bool
	DisableSweeper    bool
	// AdminEmails: verified account emails that may open /admin (BOTLINK_ADMIN_EMAILS, comma-separated,
	// lower-cased). Empty = the admin area doesn't exist (every /app/v1/admin route is 404).
	AdminEmails []string
	// PostHog, server side only (package analytics; SPEC §12). Off unless BOTLINK_POSTHOG_KEY and
	// BOTLINK_ANALYTICS_HASH_KEY (secret, 32+ characters: ids leave the server only as an HMAC with it) are both set.
	// BOTLINK_POSTHOG_HOST defaults to https://eu.i.posthog.com in the analytics package.
	PostHogKey, PostHogHost, AnalyticsHashKey string
	// Plans: the paywall switch (BOTLINK_PAYWALL, default off), the paid settings behind it and the fair-use storage
	// limits (config/plans.go, CONTRACT-PLANS.md).
	Plans PlansConfig

	// MaxWaits (BOTLINK_MAX_WAITS, default 8400 = 70 % of the 12,000 one copy held in the load test): the cap on open
	// long-polls of this copy. At the cap new waits get 503 high_load and /readyz answers 503 "full".
	MaxWaits int
	// Signup: limits on new accounts per source address and in total (config/signup.go).
	Signup SignupConfig
	// Lost passkey (appapi/recovery.go): how long a passkey reset waits before a new passkey can replace the old ones
	// (BOTLINK_PASSKEY_RESET_DELAY, default 72h, at least 24h outside dev; zero or less means the default), and how
	// recent the sign-in that starts or finishes it must be (BOTLINK_PASSKEY_RESET_SIGNIN_MAX_AGE, default 10m).
	// The same sign-in age also gates the account export (appapi/account_data.go).
	PasskeyResetDelay, PasskeyResetSignInMaxAge time.Duration
	// MinClientRelease (BOTLINK_MIN_CLIENT_RELEASE, a signed release number like 12; empty or 0 = off): agent API calls
	// from a client installed from an older release get 426 client_too_old (package clientgate; outside dev, also a
	// client that sends no release number). /dl and /readyz are never behind it.
	MinClientRelease string
	// PasskeyReset (BOTLINK_PASSKEY_RESET, on | off, default on): off means no reset can be started or finished (a
	// waiting one can still be cancelled). PasskeyResetDeleteHold (BOTLINK_PASSKEY_RESET_DELETE_HOLD, default 168h):
	// account delete is refused while a reset is open and for this long after one finished.
	PasskeyReset           string
	PasskeyResetDeleteHold time.Duration
	// Account delete waits (appapi/account_data.go, security re-review of fix-all): an ask can be finished only after
	// AccountDeleteDelay (BOTLINK_ACCOUNT_DELETE_DELAY, default 72h; below 24h, 0 included, needs BOTLINK_ENV=dev) and
	// before AccountDeleteWindow more has passed (BOTLINK_ACCOUNT_DELETE_WINDOW, default 168h). AccountDeleteNoWait is
	// set when the delay was given as 0 (dev only): a zero AccountDeleteDelay alone means the default.
	AccountDeleteDelay, AccountDeleteWindow time.Duration
	AccountDeleteNoWait                     bool
	// AccountDeleteAskHold (BOTLINK_ACCOUNT_DELETE_ASK_HOLD, default 24h; below 24h, 0 included, needs BOTLINK_ENV=dev):
	// after a browser of the account is removed or "sign out other browsers" is used, a new delete ask is refused for
	// this long (third security pass). AccountDeleteAskHoldOff is set when it was given as 0 (dev only).
	AccountDeleteAskHold    time.Duration
	AccountDeleteAskHoldOff bool
	// SourceURL (BOTLINK_SOURCE_URL, default empty = no link anywhere): the public repository the landing page, the docs
	// and the trust page link to as "Self-host it" (config/source.go says the one form it takes).
	SourceURL string
	// JoinTTL (BOTLINK_JOIN_TTL, default 15m): how long a join request waits for its person. Prod runs only the
	// default; staging and dev accept 30s..15m, so a tester can see a request expire.
	JoinTTL time.Duration
	// Drafts: caps on the rooms chats ask for (config/drafts.go); a draft lives JoinRequestTTL.
	Drafts DraftConfig
}

// StagingWaitFloor: the shortest passkey reset and account delete waits a staging server accepts (prod: 24 h).
const StagingWaitFloor = 5 * time.Minute

// DefaultJoinTTL and MinJoinTTL bound BOTLINK_JOIN_TTL (prod: the default only).
const (
	DefaultJoinTTL = 15 * time.Minute
	MinJoinTTL     = 30 * time.Second
)

func getenv(k, def string) string {
	if v, ok := os.LookupEnv(k); ok {
		return v
	}
	return def
}

// FromEnv builds the config and validates it (prod refuses dev login, stub human check and fault hooks).
func FromEnv() (*Config, error) {
	c := &Config{
		Env:                    getenv("BOTLINK_ENV", "dev"),
		Addr:                   getenv("BOTLINK_ADDR", ":8811"),
		CopyID:                 getenv("BOTLINK_COPY_ID", "A"),
		DatabaseURL:            getenv("BOTLINK_DATABASE_URL", "postgres://botlink@127.0.0.1:55432/botlink_dev"),
		AppHost:                os.Getenv("BOTLINK_APP_HOST"),
		APIHost:                os.Getenv("BOTLINK_API_HOST"),
		SiteHost:               strings.ToLower(strings.TrimSpace(os.Getenv("BOTLINK_SITE_HOST"))),
		DevLogin:               getenv("BOTLINK_DEV_LOGIN", "0") == "1",
		TurnstileSiteKey:       os.Getenv("BOTLINK_TURNSTILE_SITE_KEY"),
		TurnstileSecret:        os.Getenv("BOTLINK_TURNSTILE_SECRET"),
		TurnstileVerifyURL:     getenv("BOTLINK_TURNSTILE_VERIFY_URL", "https://challenges.cloudflare.com/turnstile/v0/siteverify"),
		GitHubClientID:         os.Getenv("BOTLINK_GITHUB_CLIENT_ID"),
		GitHubSecret:           os.Getenv("BOTLINK_GITHUB_CLIENT_SECRET"),
		GoogleClientID:         os.Getenv("BOTLINK_GOOGLE_CLIENT_ID"),
		GoogleSecret:           os.Getenv("BOTLINK_GOOGLE_CLIENT_SECRET"),
		TrustCF:                getenv("BOTLINK_TRUST_CF", "0") == "1",
		WebDir:                 os.Getenv("BOTLINK_WEB_DIR"),
		DocsDir:                os.Getenv("BOTLINK_DOCS_DIR"),
		MetricsAddr:            getenv("BOTLINK_METRICS_ADDR", "127.0.0.1:9811"),
		TestFaults:             os.Getenv("BOTLINK_TEST_FAULTS"),
		PushAllowLoopback:      getenv("BOTLINK_PUSH_ALLOW_LOOPBACK", "0") == "1",
		EventsNoChallengeHosts: ParseHosts(os.Getenv("BOTLINK_EVENTS_NO_CHALLENGE_HOSTS")),
		AdminEmails:            ParseEmails(os.Getenv("BOTLINK_ADMIN_EMAILS")),
		PostHogKey:             strings.TrimSpace(os.Getenv("BOTLINK_POSTHOG_KEY")),
		PostHogHost:            strings.TrimSpace(os.Getenv("BOTLINK_POSTHOG_HOST")),
		AnalyticsHashKey:       os.Getenv("BOTLINK_ANALYTICS_HASH_KEY"),
		MinClientRelease:       strings.TrimSpace(os.Getenv("BOTLINK_MIN_CLIENT_RELEASE")),
		SourceURL:              os.Getenv("BOTLINK_SOURCE_URL"),
	}
	defHC := "real"
	if c.Env == "dev" {
		defHC = "stub"
	}
	c.HumanCheck = getenv("BOTLINK_HUMAN_CHECK", defHC)
	c.ListenURL = getenv("BOTLINK_LISTEN_URL", c.DatabaseURL)
	c.MaxWaits = 8400
	if v := strings.TrimSpace(os.Getenv("BOTLINK_MAX_WAITS")); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 || n > 1000000 {
			return nil, fmt.Errorf("BOTLINK_MAX_WAITS must be 1..1000000 (got %q)", v)
		}
		c.MaxWaits = n
	}
	c.AppOrigin = strings.TrimRight(getenv("BOTLINK_APP_ORIGIN", "http://localhost:8811"), "/")
	c.WebAuthnOrigin = getenv("BOTLINK_WEBAUTHN_ORIGIN", c.AppOrigin)
	c.ClientTGZ = os.Getenv("BOTLINK_CLIENT_TGZ")
	if c.ClientTGZ == "" && os.Getenv("BOTLINK_DL_DIR") != "" {
		c.ClientTGZ = filepath.Join(os.Getenv("BOTLINK_DL_DIR"), "botlink.tgz")
	}
	c.ClientURL = os.Getenv("BOTLINK_CLIENT_URL")
	if c.ClientURL == "" {
		if c.APIHost != "" {
			c.ClientURL = "https://" + c.APIHost + "/dl/botlink.tgz"
		} else {
			c.ClientURL = c.AppOrigin + "/dl/botlink.tgz"
		}
	}
	c.WebAuthnRPID = getenv("BOTLINK_WEBAUTHN_RP_ID", "")
	if c.WebAuthnRPID == "" {
		c.rpIDDerived = true
		if u, err := url.Parse(c.AppOrigin); err == nil {
			c.WebAuthnRPID = u.Hostname()
		}
	}
	var err error
	if c.Plans, err = plansFromEnv(); err != nil {
		return nil, err
	}
	if w := c.Plans.IgnoredWarning(); w != "" {
		slog.Warn(w)
	}
	if c.Signup, err = signupFromEnv(); err != nil {
		return nil, err
	}
	if c.Drafts, err = draftsFromEnv(); err != nil {
		return nil, err
	}
	if c.RetryMS, err = strconv.Atoi(getenv("BOTLINK_RETRY_MS", "0")); err != nil {
		return nil, fmt.Errorf("BOTLINK_RETRY_MS: %w", err)
	}
	if c.RecheckMS, err = strconv.Atoi(getenv("BOTLINK_RECHECK_MS", "0")); err != nil {
		return nil, fmt.Errorf("BOTLINK_RECHECK_MS: %w", err)
	}
	if c.PasskeyResetDelay, err = time.ParseDuration(getenv("BOTLINK_PASSKEY_RESET_DELAY", "72h")); err != nil {
		return nil, fmt.Errorf("BOTLINK_PASSKEY_RESET_DELAY: %w", err)
	}
	if c.PasskeyResetSignInMaxAge, err = time.ParseDuration(getenv("BOTLINK_PASSKEY_RESET_SIGNIN_MAX_AGE", "10m")); err != nil {
		return nil, fmt.Errorf("BOTLINK_PASSKEY_RESET_SIGNIN_MAX_AGE: %w", err)
	}
	c.PasskeyReset = getenv("BOTLINK_PASSKEY_RESET", "on")
	if c.PasskeyResetDeleteHold, err = time.ParseDuration(getenv("BOTLINK_PASSKEY_RESET_DELETE_HOLD", "168h")); err != nil {
		return nil, fmt.Errorf("BOTLINK_PASSKEY_RESET_DELETE_HOLD: %w", err)
	}
	if c.AccountDeleteDelay, err = time.ParseDuration(getenv("BOTLINK_ACCOUNT_DELETE_DELAY", "72h")); err != nil || c.AccountDeleteDelay < 0 {
		return nil, fmt.Errorf("BOTLINK_ACCOUNT_DELETE_DELAY: a duration of 0 or more (%v)", err)
	}
	c.AccountDeleteNoWait = c.AccountDeleteDelay == 0
	if c.AccountDeleteAskHold, err = time.ParseDuration(getenv("BOTLINK_ACCOUNT_DELETE_ASK_HOLD", "24h")); err != nil || c.AccountDeleteAskHold < 0 {
		return nil, fmt.Errorf("BOTLINK_ACCOUNT_DELETE_ASK_HOLD: a duration of 0 or more (%v)", err)
	}
	c.AccountDeleteAskHoldOff = c.AccountDeleteAskHold == 0
	if c.AccountDeleteWindow, err = time.ParseDuration(getenv("BOTLINK_ACCOUNT_DELETE_WINDOW", "168h")); err != nil {
		return nil, fmt.Errorf("BOTLINK_ACCOUNT_DELETE_WINDOW: %w", err)
	}
	if c.JoinTTL, err = time.ParseDuration(getenv("BOTLINK_JOIN_TTL", "15m")); err != nil {
		return nil, fmt.Errorf("BOTLINK_JOIN_TTL: %w", err)
	}
	return c, c.Validate()
}

func (c *Config) Validate() error {
	switch c.Env {
	case "dev", "staging", "prod":
	default:
		return fmt.Errorf("BOTLINK_ENV must be dev, staging or prod (got %q)", c.Env)
	}
	// dev (also what a missing BOTLINK_ENV means) drops Secure cookies, HSTS and the real human check: it runs only
	// for this computer (fourth security pass, finding 1)
	if c.Env == "dev" {
		for _, s := range []struct {
			name, val string
			origin    bool
		}{
			{"BOTLINK_APP_ORIGIN", c.AppOrigin, true}, {"BOTLINK_WEBAUTHN_ORIGIN", c.WebAuthnOrigin, true},
			{"BOTLINK_WEBAUTHN_RP_ID", c.WebAuthnRPID, false}, {"BOTLINK_APP_HOST", c.AppHost, false},
			{"BOTLINK_API_HOST", c.APIHost, false}, {"BOTLINK_SITE_HOST", c.SiteHost, false},
		} {
			if s.val != "" && !isLocal(s.val, s.origin) {
				return fmt.Errorf("refusing to start: %s=%q is not this computer, and BOTLINK_ENV is dev (a missing BOTLINK_ENV means dev): set BOTLINK_ENV=prod (or staging)", s.name, s.val)
			}
		}
	}
	switch c.HumanCheck {
	case "stub", "real":
	default:
		return fmt.Errorf("BOTLINK_HUMAN_CHECK must be stub or real (got %q)", c.HumanCheck)
	}
	switch c.PasskeyReset {
	case "", "on", "off":
	default:
		return fmt.Errorf("BOTLINK_PASSKEY_RESET must be on or off (got %q)", c.PasskeyReset)
	}
	if c.Env == "prod" {
		if c.DevLogin {
			return errors.New("refusing to start: BOTLINK_DEV_LOGIN=1 is not allowed with BOTLINK_ENV=prod")
		}
		if c.HumanCheck == "stub" {
			return errors.New("refusing to start: BOTLINK_HUMAN_CHECK=stub is not allowed with BOTLINK_ENV=prod")
		}
	}
	floor, floorText := 24*time.Hour, "below 24h needs BOTLINK_ENV=dev"
	if c.Env == "staging" {
		floor, floorText = StagingWaitFloor, "below 5m needs BOTLINK_ENV=dev (staging accepts 5m and up)"
	}
	if c.JoinTTL != 0 && c.JoinTTL != DefaultJoinTTL {
		if c.Env == "prod" {
			return errors.New("refusing to start: BOTLINK_JOIN_TTL other than 15m is not allowed with BOTLINK_ENV=prod")
		}
		if c.JoinTTL < MinJoinTTL || c.JoinTTL > DefaultJoinTTL {
			return fmt.Errorf("BOTLINK_JOIN_TTL must be 30s..15m (got %v)", c.JoinTTL)
		}
	}
	if c.Env != "dev" && c.DevLogin && len(c.AdminEmails) > 0 {
		return errors.New("refusing to start: BOTLINK_DEV_LOGIN=1 signs anyone in as any email, so with BOTLINK_ADMIN_EMAILS set anyone could open the admin area: empty BOTLINK_ADMIN_EMAILS or set BOTLINK_DEV_LOGIN=0")
	}
	if c.Env != "dev" {
		if c.TestFaults != "" {
			return errors.New("refusing to start: BOTLINK_TEST_FAULTS needs BOTLINK_ENV=dev")
		}
		if c.PushAllowLoopback {
			return errors.New("refusing to start: BOTLINK_PUSH_ALLOW_LOOPBACK needs BOTLINK_ENV=dev")
		}
		if c.RecheckMS != 0 {
			return errors.New("refusing to start: BOTLINK_RECHECK_MS needs BOTLINK_ENV=dev")
		}
		if len(c.EventsNoChallengeHosts) > 0 {
			return errors.New("refusing to start: BOTLINK_EVENTS_NO_CHALLENGE_HOSTS needs BOTLINK_ENV=dev")
		}
		if c.PasskeyResetDelay > 0 && c.PasskeyResetDelay < floor {
			return errors.New("refusing to start: BOTLINK_PASSKEY_RESET_DELAY " + floorText)
		}
		if c.AccountDeleteNoWait || (c.AccountDeleteDelay > 0 && c.AccountDeleteDelay < floor) {
			return errors.New("refusing to start: BOTLINK_ACCOUNT_DELETE_DELAY " + floorText)
		}
		if c.AccountDeleteAskHoldOff || (c.AccountDeleteAskHold > 0 && c.AccountDeleteAskHold < floor) {
			return errors.New("refusing to start: BOTLINK_ACCOUNT_DELETE_ASK_HOLD " + floorText)
		}
	}
	if c.PostHogHost != "" && c.Env != "dev" && !strings.HasPrefix(c.PostHogHost, "https://") {
		return errors.New("BOTLINK_POSTHOG_HOST must be an https:// address")
	}
	if c.HumanCheck == "real" && (c.TurnstileSiteKey == "" || c.TurnstileSecret == "") {
		return errors.New("BOTLINK_HUMAN_CHECK=real needs BOTLINK_TURNSTILE_SITE_KEY and BOTLINK_TURNSTILE_SECRET")
	}
	if (c.AppHost == "") != (c.APIHost == "") {
		return errors.New("set both BOTLINK_APP_HOST and BOTLINK_API_HOST, or neither")
	}
	if c.RecheckMS != 0 && (c.RecheckMS < 100 || c.RecheckMS > 15000) {
		return errors.New("BOTLINK_RECHECK_MS must be 100..15000")
	}
	if err := c.Plans.validate(c.Env); err != nil {
		return err
	}
	if err := validSourceURL(c.SourceURL); err != nil {
		return err
	}
	u, err := url.Parse(c.AppOrigin)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return fmt.Errorf("BOTLINK_APP_ORIGIN must be an origin like https://app.botlink.dev (got %q)", c.AppOrigin)
	}
	if c.SiteHost != "" {
		site := c.SiteHost
		if c.AppHost == "" {
			return errors.New("BOTLINK_SITE_HOST needs BOTLINK_APP_HOST and BOTLINK_API_HOST")
		}
		if site != strings.ToLower(site) || strings.ContainsAny(site, ":/ ") {
			return fmt.Errorf("BOTLINK_SITE_HOST must be a bare lower-case host name like botlink.dev (got %q)", site)
		}
		if site == strings.ToLower(c.AppHost) || site == strings.ToLower(c.APIHost) {
			return errors.New("BOTLINK_SITE_HOST must differ from BOTLINK_APP_HOST and BOTLINK_API_HOST")
		}
		// Passkeys belong to the app host alone. A derived value moves when the app origin does; a parent domain
		// would let the site host (and every other subdomain) ask for the dashboard's passkey.
		rp := strings.ToLower(c.WebAuthnRPID)
		if c.rpIDDerived || rp == "" {
			return errors.New("BOTLINK_SITE_HOST needs an explicit BOTLINK_WEBAUTHN_RP_ID (the app host, e.g. app.botlink.dev)")
		}
		if site == rp || strings.HasSuffix(site, "."+rp) {
			return fmt.Errorf("BOTLINK_WEBAUTHN_RP_ID %q covers the site host %q; use the app host", c.WebAuthnRPID, site)
		}
	}
	return nil
}

// isLocal: the origin's (or host name's) host is this computer: localhost, a name under .localhost, or a loopback
// address, with any port.
func isLocal(v string, origin bool) bool {
	h := v
	if origin {
		u, err := url.Parse(v)
		if err != nil {
			return false
		}
		h = u.Hostname()
	} else if host, _, err := net.SplitHostPort(v); err == nil {
		h = host
	}
	h = strings.TrimSuffix(strings.ToLower(h), ".")
	if h == "localhost" || strings.HasSuffix(h, ".localhost") {
		return true
	}
	ip := net.ParseIP(strings.Trim(h, "[]"))
	return ip != nil && ip.IsLoopback()
}

// SiteOrigin is the public site's origin ("" without BOTLINK_SITE_HOST): the app origin's scheme and port with the
// site host (prod has no port; a local run serves every host on one port).
func (c *Config) SiteOrigin() string {
	if c.SiteHost == "" {
		return ""
	}
	u, err := url.Parse(c.AppOrigin)
	if err != nil {
		return ""
	}
	host := c.SiteHost
	if p := u.Port(); p != "" {
		host = net.JoinHostPort(host, p)
	}
	return u.Scheme + "://" + host
}

// Providers lists enabled login methods (a provider is enabled iff both id and secret are set).
func (c *Config) Providers() []string {
	p := []string{}
	if c.GitHubClientID != "" && c.GitHubSecret != "" {
		p = append(p, "github")
	}
	if c.GoogleClientID != "" && c.GoogleSecret != "" {
		p = append(p, "google")
	}
	if c.DevLogin {
		p = append(p, "dev")
	}
	return p
}

// ParseEmails splits a comma-separated list into trimmed, lower-cased, non-empty emails.
func ParseEmails(v string) []string {
	var out []string
	for _, e := range strings.Split(v, ",") {
		if e = strings.ToLower(strings.TrimSpace(e)); e != "" {
			out = append(out, e)
		}
	}
	return out
}

// IsAdmin: the account's verified email is in BOTLINK_ADMIN_EMAILS (case-insensitive).
func (c *Config) IsAdmin(email string) bool {
	email = strings.ToLower(strings.TrimSpace(email))
	if email == "" {
		return false
	}
	for _, e := range c.AdminEmails {
		if strings.ToLower(e) == email {
			return true
		}
	}
	return false
}

// ResetDelay is how long a passkey reset waits (never zero: an unset or zero value is the 72 h default).
func (c *Config) ResetDelay() time.Duration {
	if c.PasskeyResetDelay <= 0 {
		return 72 * time.Hour
	}
	return c.PasskeyResetDelay
}

// ResetEnabled: passkey resets may be started and finished (BOTLINK_PASSKEY_RESET is not "off").
func (c *Config) ResetEnabled() bool { return c.PasskeyReset != "off" }

// ResetDeleteHold is how long account delete stays refused after a reset finished (default 7 days, never zero).
func (c *Config) ResetDeleteHold() time.Duration {
	if c.PasskeyResetDeleteHold <= 0 {
		return 7 * 24 * time.Hour
	}
	return c.PasskeyResetDeleteHold
}

// DeleteDelay is how long an account delete waits after it is asked (72 h unless set; 0 only with AccountDeleteNoWait).
func (c *Config) DeleteDelay() time.Duration {
	if c.AccountDeleteNoWait {
		return 0
	}
	if c.AccountDeleteDelay <= 0 {
		return 72 * time.Hour
	}
	return c.AccountDeleteDelay
}

// DeleteAskHold is how long a delete ask stays refused after a browser of the account was removed or the others were
// signed out (24 h unless set; 0 only with AccountDeleteAskHoldOff).
func (c *Config) DeleteAskHold() time.Duration {
	if c.AccountDeleteAskHoldOff {
		return 0
	}
	if c.AccountDeleteAskHold <= 0 {
		return 24 * time.Hour
	}
	return c.AccountDeleteAskHold
}

// DeleteWindow is how long a ready account delete can still be finished before it lapses (7 days unless set).
func (c *Config) DeleteWindow() time.Duration {
	if c.AccountDeleteWindow <= 0 {
		return 7 * 24 * time.Hour
	}
	return c.AccountDeleteWindow
}

// JoinRequestTTL is how long a join request waits for its person (15 minutes unless set).
func (c *Config) JoinRequestTTL() time.Duration {
	if c.JoinTTL <= 0 {
		return DefaultJoinTTL
	}
	return c.JoinTTL
}

// ResetSignInMaxAge is how recent a sign-in must be to start or finish a passkey reset (default 10 minutes).
func (c *Config) ResetSignInMaxAge() time.Duration {
	if c.PasskeyResetSignInMaxAge <= 0 {
		return 10 * time.Minute
	}
	return c.PasskeyResetSignInMaxAge
}

// SecureCookies: cookies are Secure everywhere except dev.
func (c *Config) SecureCookies() bool { return c.Env != "dev" }

// ParseHosts splits a comma-separated list of host names (lower-cased, no port, no wildcard: exact names only).
func ParseHosts(s string) []string {
	var out []string
	for _, h := range strings.Split(s, ",") {
		h = strings.ToLower(strings.TrimSpace(h))
		if h != "" && !strings.ContainsAny(h, "*/: ") {
			out = append(out, h)
		}
	}
	return out
}

// EventsNoChallenge reports whether subscriptions to this host skip the challenge handshake (dev/test only).
func (c *Config) EventsNoChallenge(host string) bool {
	host = strings.ToLower(host)
	for _, h := range c.EventsNoChallengeHosts {
		if h == host {
			return true
		}
	}
	return false
}
