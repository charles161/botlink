package test

// Blocker 8 (fix-all lane LIMITS): new accounts are limited per source address and in total, per hour and per day
// (config BOTLINK_SIGNUP_*). The source address is the one the server already uses for its per-IP limits:
// CF-Connecting-IP when BOTLINK_TRUST_CF=1, else the socket address. An existing account always signs in. The
// refusal never says whether an email is registered.

import (
	"bytes"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/charles161/botlink/server/internal/auth"
	"github.com/charles161/botlink/server/internal/config"
)

func TestSignupLimitsPerAddressAndGlobal(t *testing.T) {
	var mu sync.Mutex
	users := map[string]fakeUser{}
	fake := newFakeGitHub(&mu, users)
	defer fake.Close()
	c := StartCopy(t, NewDB(t), "A", func(cfg *config.Config) {
		cfg.GitHubClientID, cfg.GitHubSecret = "id", "sec"
		cfg.TrustCF = true
		cfg.Signup = config.SignupConfig{PerAddrHour: 2, PerAddrDay: 3, GlobalHour: 4, GlobalDay: 100}
	})
	gh := c.S.App.Providers["github"].(*auth.GitHub)
	gh.AuthURLBase, gh.TokenURL, gh.APIBase = fake.URL+"/authorize", fake.URL+"/token", fake.URL
	now := time.Date(2026, 11, 16, 10, 0, 0, 0, time.UTC)
	c.S.App.Signup.Now = func() time.Time { return now }
	ids := map[string]int{}
	login := func(email, ip string) (int, string) {
		t.Helper()
		if ids[email] == 0 {
			ids[email] = 1000 + len(ids)
		}
		cl := &http.Client{Jar: newJar(), CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
		res, err := cl.Get(c.URL + "/app/v1/auth/github/start?return_to=/")
		if err != nil || res.StatusCode != 302 {
			t.Fatalf("start: %v %v", err, res)
		}
		res.Body.Close()
		loc, _ := url.Parse(res.Header.Get("Location"))
		code := "code-" + newID()
		mu.Lock()
		users[code] = fakeUser{challenge: loc.Query().Get("code_challenge"), email: email, id: ids[email]}
		mu.Unlock()
		req, _ := http.NewRequest("GET", c.URL+"/app/v1/auth/github/callback?code="+code+"&state="+url.QueryEscape(loc.Query().Get("state")), nil)
		req.Header.Set("CF-Connecting-IP", ip)
		res, err = cl.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		b, _ := io.ReadAll(res.Body)
		return res.StatusCode, string(b)
	}
	accounts := func(email string) int {
		return count(t, c, `select count(*) from accounts where email = $1`, email)
	}
	ok := func(email, ip string) {
		t.Helper()
		if st, body := login(email, ip); st != 302 {
			t.Fatalf("%s from %s: %d %s", email, ip, st, body)
		}
	}
	var refusedBodies []string
	refused := func(email, ip string) {
		t.Helper()
		st, body := login(email, ip)
		if st == 302 {
			t.Fatalf("%s from %s: not refused", email, ip)
		}
		if !strings.Contains(body, "Try again") || strings.Contains(body, email) || strings.Contains(strings.ToLower(body), "already") ||
			strings.Contains(strings.ToLower(body), "registered") {
			t.Fatalf("refusal page: %d %s", st, body)
		}
		if accounts(email) != 0 {
			t.Fatalf("%s: an account was made", email)
		}
		refusedBodies = append(refusedBodies, body)
	}

	// per address: 2 an hour
	ok("a1@acme.dev", "203.0.113.5")
	ok("a2@acme.dev", "203.0.113.5")
	refused("a3@acme.dev", "203.0.113.5")
	// an existing account signs in from that address all the same (sign-in is never limited, only new accounts)
	ok("a1@acme.dev", "203.0.113.5")
	// another address is not affected
	ok("b1@acme.dev", "198.51.100.7")
	// globally: 4 an hour
	ok("c1@acme.dev", "192.0.2.9")
	var logs bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, nil)))
	refused("d1@acme.dev", "192.0.2.10")
	slog.SetDefault(prev)
	// a refusal by the global cap is seen: a metric and a log line, with no email and no address in it
	if c.S.M.RateLimited.Value("signup:all") < 1 {
		t.Fatal("global refusal not counted in botlink_rate_limited_total")
	}
	if l := logs.String(); !strings.Contains(l, "sign-up refused") || !strings.Contains(l, "signup:all") ||
		strings.Contains(l, "d1@acme.dev") || strings.Contains(l, "192.0.2") {
		t.Fatalf("log: %q", l)
	}
	// one answer for every refusal: per address or global, nothing about the email
	if refusedBodies[0] != refusedBodies[1] {
		t.Fatalf("refusals differ:\n%s\n%s", refusedBodies[0], refusedBodies[1])
	}

	// the hour window resets (clock moved, no sleep)
	now = now.Add(time.Hour)
	ok("a3@acme.dev", "203.0.113.5")
	// per address: 3 a day
	refused("a4@acme.dev", "203.0.113.5")
	// IPv6: one /64 is one address
	ok("v1@acme.dev", "2001:db8:1:2::1")
	ok("v2@acme.dev", "2001:db8:1:2:ffff::9")
	now = now.Add(time.Hour)
	ok("v3@acme.dev", "2001:db8:1:2::abcd")
	refused("v4@acme.dev", "2001:db8:1:2::abce")
	ok("v4@acme.dev", "2001:db8:1:3::1")

	// the day window resets
	now = now.Add(24 * time.Hour)
	ok("a4@acme.dev", "203.0.113.5")
}

func TestSignupLimitsDefaultsAndConfig(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A")
	s := c.S.App.Signup
	if s.PerAddrHour != 10 || s.PerAddrDay != 30 || s.GlobalHour != 1000 || s.GlobalDay != 5000 {
		t.Fatalf("defaults: %+v", s)
	}
	for _, k := range []string{"BOTLINK_SIGNUP_PER_IP_HOUR", "BOTLINK_SIGNUP_PER_IP_DAY", "BOTLINK_SIGNUP_GLOBAL_HOUR", "BOTLINK_SIGNUP_GLOBAL_DAY"} {
		t.Setenv(k, "0")
		if _, err := config.FromEnv(); err == nil || !strings.Contains(err.Error(), k) {
			t.Fatalf("%s=0 accepted: %v", k, err)
		}
		t.Setenv(k, "7")
	}
	t.Setenv("BOTLINK_STORAGE_CEILING_MB", "abc")
	if _, err := config.FromEnv(); err == nil || !strings.Contains(err.Error(), "BOTLINK_STORAGE_CEILING_MB") {
		t.Fatalf("bad ceiling accepted: %v", err)
	}
	t.Setenv("BOTLINK_STORAGE_CEILING_MB", "64")
	cfg, err := config.FromEnv()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Signup.PerAddrHour != 7 || cfg.Signup.GlobalDay != 7 || cfg.Plans.StorageCeiling() != 64 {
		t.Fatalf("from env: %+v %d", cfg.Signup, cfg.Plans.StorageCeiling())
	}
}

// IPv6 addresses are counted per /64 (one customer network); IPv4 per address.
func TestSignupSourceKey(t *testing.T) {
	for in, want := range map[string]string{
		"203.0.113.5":             "203.0.113.5",
		"2001:db8:1:2::1":         "2001:db8:1:2::/64",
		"2001:db8:1:2:ffff:1:2:3": "2001:db8:1:2::/64",
		"::ffff:203.0.113.5":      "203.0.113.5",
		"not an ip":               "not an ip",
	} {
		if got := auth.SignupSourceKey(in); got != want {
			t.Errorf("%s: %s, want %s", in, got, want)
		}
	}
}

type fakeUser struct {
	challenge, email string
	id               int
}

// newFakeGitHub answers the GitHub OAuth calls for many people: each code is one person (users[code]).
func newFakeGitHub(mu *sync.Mutex, users map[string]fakeUser) *httptest.Server {
	who := func(r *http.Request) (fakeUser, bool) {
		mu.Lock()
		defer mu.Unlock()
		u, ok := users[strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")]
		return u, ok
	}
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/token":
			_ = r.ParseForm()
			code := r.Form.Get("code")
			mu.Lock()
			u, ok := users[code]
			mu.Unlock()
			if !ok || pkce(r.Form.Get("code_verifier")) != u.challenge {
				w.WriteHeader(400)
				_, _ = w.Write([]byte(`{"error":"invalid_grant"}`))
				return
			}
			_, _ = w.Write([]byte(`{"access_token":"` + code + `","token_type":"bearer"}`))
		case "/user":
			u, _ := who(r)
			_, _ = fmt.Fprintf(w, `{"id":%d,"login":"u%d","name":"Someone"}`, u.id, u.id)
		case "/user/emails":
			u, _ := who(r)
			_, _ = fmt.Fprintf(w, `[{"email":%q,"primary":true,"verified":true}]`, u.email)
		}
	}))
}
