package test

import (
	"bytes"
	"context"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"testing"

	"github.com/charles161/botlink/server/internal/config"
)

// PLAN §5.6 security checks.

func TestCSRFAndOrigin(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A")
	adam := NewPerson(t, c, "Adam")
	post := func(origin, csrf string) *Resp {
		req, _ := http.NewRequest("POST", c.URL+"/app/v1/rooms/"+"01933b6e-0000-7000-8000-000000000001"+"/chat-invite", strings.NewReader(`{"action":"renew"}`))
		req.Header.Set("Content-Type", "application/json")
		if origin != "" {
			req.Header.Set("Origin", origin)
		}
		if csrf != "" {
			req.Header.Set("X-CSRF-Token", csrf)
		}
		for _, ck := range adam.Client.Jar.Cookies(mustURL(c.URL)) {
			req.AddCookie(ck)
		}
		return doRaw(t, req)
	}
	for name, r := range map[string]*Resp{
		"missing csrf":   post(c.URL, ""),
		"wrong csrf":     post(c.URL, "nope"+adam.CSRF),
		"cross origin":   post("https://evil.example", adam.CSRF),
		"missing origin": post("", adam.CSRF),
	} {
		if r.Status != 403 || r.Code() != "csrf_failed" {
			t.Errorf("%s: %s", name, r)
		}
	}
	if r := post(c.URL, adam.CSRF); r.Status != 404 { // passes CSRF, then the room doesn't exist
		t.Errorf("good csrf: %s", r)
	}
	// dev-login from another origin
	req, _ := http.NewRequest("POST", c.URL+"/app/v1/auth/dev-login", strings.NewReader(`{"email":"x@example.com"}`))
	req.Header.Set("Origin", "https://evil.example")
	if r := doRaw(t, req); r.Status != 403 {
		t.Errorf("cross-origin dev-login: %s", r)
	}
}

func TestSurfacesAreSeparate(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A")
	adam := NewPerson(t, c, "Adam")
	room := adam.CreateRoom("sep")
	a := adam.Member(c, room, "agent")
	// /api/v1 ignores cookies: a cookie-only request is unauthenticated there
	req, _ := http.NewRequest("GET", c.URL+"/api/v1/me", nil)
	for _, ck := range adam.Client.Jar.Cookies(mustURL(c.URL)) {
		req.AddCookie(ck)
	}
	if r := doRaw(t, req); r.Status != 401 || r.Code() != "bad_signature" {
		t.Errorf("/api/v1 with cookie: %s", r)
	}
	// /app/v1 never answers a signed-only request
	sreq := a.Req(c, "GET", "/app/v1/rooms", nil, nil)
	if r := doRaw(t, sreq); r.Status != 401 || r.Code() != "unauthenticated" {
		t.Errorf("/app/v1 signed-only: %s", r)
	}
	// no CORS headers anywhere (incl. preflight)
	for _, p := range []string{"/api/v1/me", "/app/v1/me", "/api/v1/invites/X", "/agents.md", "/"} {
		for _, m := range []string{"GET", "OPTIONS"} {
			r, _ := http.NewRequest(m, c.URL+p, nil)
			r.Header.Set("Origin", "https://evil.example")
			r.Header.Set("Access-Control-Request-Method", "POST")
			res, err := http.DefaultClient.Do(r)
			if err != nil {
				t.Fatal(err)
			}
			res.Body.Close()
			for k := range res.Header {
				if strings.HasPrefix(strings.ToLower(k), "access-control-") {
					t.Errorf("%s %s sent %s", m, p, k)
				}
			}
		}
	}
}

// The agent API has no approve, room-management or invite-creation routes.
func TestAgentRouteTable(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A")
	pats := c.S.Agent.Patterns
	if len(pats) < 15 {
		t.Fatalf("only %d agent routes recorded", len(pats))
	}
	bad := regexp.MustCompile(`approve|reject|/rooms|chat-invite|person-invites|person-requests|human-check|unstick|devices|certify|dismiss|needs-you`)
	for _, p := range pats {
		if bad.MatchString(p) {
			t.Errorf("agent route %q looks like a human-only action", p)
		}
		if !strings.Contains(p, "/api/v1/") {
			t.Errorf("agent route %q outside /api/v1", p)
		}
	}
	a := NewAgentKeys(t, "x")
	for _, p := range []string{"/api/v1/join-requests/01933b6e-0000-7000-8000-000000000001/approve", "/api/v1/rooms", "/api/v1/person-requests/01933b6e-0000-7000-8000-000000000001/approve"} {
		res, err := http.DefaultClient.Do(a.Req(c, "POST", p, map[string]any{}, nil)) // not in the spec: skip contract validation
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if res.StatusCode != 404 && res.StatusCode != 405 {
			t.Errorf("POST %s: %d", p, res.StatusCode)
		}
	}
}

func TestProdRefusesDevAndStub(t *testing.T) {
	base := config.Config{Env: "prod", HumanCheck: "real", TurnstileSiteKey: "s", TurnstileSecret: "k", AppOrigin: "https://app.botlink.dev"}
	ok := base
	if err := ok.Validate(); err != nil {
		t.Fatalf("good prod config: %v", err)
	}
	for name, mod := range map[string]func(*config.Config){
		"dev login":       func(c *config.Config) { c.DevLogin = true },
		"stub check":      func(c *config.Config) { c.HumanCheck = "stub" },
		"test faults":     func(c *config.Config) { c.TestFaults = "send_after_delivery:1" },
		"push loopback":   func(c *config.Config) { c.PushAllowLoopback = true },
		"half host split": func(c *config.Config) { c.AppHost = "app.botlink.dev" },
	} {
		c := base
		mod(&c)
		if err := c.Validate(); err == nil {
			t.Errorf("%s accepted in prod", name)
		}
	}
}

// Names/jobs never reach the open invite page (escaped or not); invite lookups are rate-limited per IP.
func TestEscapingAndInviteLimits(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A")
	adam := NewPerson(t, c, "Adam <b>")
	room := adam.CreateRoom("esc")
	a := NewAgentKeys(t, "xss")
	inv := adam.Invite(room)
	a.ReqID = "" // custom job
	r := a.Do(c, "POST", "/api/v1/join-requests", map[string]any{"id": newID(), "kind": "join", "invite": inv, "name": "xss",
		"job": `<img src=x onerror=alert(1)>`, "app": "codex", "turn": "on_turn", "ed25519_pk": a.Key.Hex(), "x25519_pk": hexs(a.X)})
	if r.Status != 201 {
		t.Fatal(r)
	}
	a.ReqID = r.Str("id")
	if r := adam.Approve(room, a); r.Status != 200 {
		t.Fatal(r)
	}
	code := inv[strings.LastIndex(inv, "/")+1:]
	req, _ := http.NewRequest("GET", c.URL+"/i/"+code, nil)
	req.Header.Set("Accept", "text/html")
	page := doRaw(t, req)
	// the open invite page no longer shows names or jobs at all, escaped or not
	if strings.Contains(string(page.Body), "img src") || strings.Contains(string(page.Body), "Adam") || strings.Contains(string(page.Body), "xss") {
		t.Errorf("invite page shows a name or job: %s", page.Body)
	}
	if page.Header.Get("Content-Security-Policy") == "" || page.Header.Get("X-Robots-Tag") != "noindex" {
		t.Error("invite page headers")
	}
	md, _ := http.NewRequest("GET", c.URL+"/i/"+code, nil)
	if body := string(doRaw(t, md).Body); strings.Contains(body, "<img") {
		t.Errorf("markdown carries raw html: %s", body)
	}
	// 20 failed lookups per IP per hour, then 429 (even for a valid code)
	for i := 0; i < 20; i++ {
		if r := doRaw(t, mustReq("GET", c.URL+"/api/v1/invites/acme-ZZZZZZZZZZ")); r.Status != 404 {
			t.Fatalf("lookup %d: %s", i, r)
		}
	}
	if r := doRaw(t, mustReq("GET", c.URL+"/api/v1/invites/"+code)); r.Status != 429 || r.Header.Get("Retry-After") == "" {
		t.Errorf("21st lookup: %s", r)
	}
}

// No secrets, tokens or envelope bodies in logs (log capture at DEBUG).
func TestLogsCarryNoSecrets(t *testing.T) {
	var mu sync.Mutex
	var buf bytes.Buffer
	old := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(lockedWriter{&mu, &buf}, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(old) })
	c := StartCopy(t, NewDB(t), "A", allowLoopback)
	adam := NewPerson(t, c, "Adam")
	room := adam.CreateRoom("logs")
	s := adam.Member(c, room, "s")
	r := adam.Member(c, room, "r")
	pr := newPushReceiver(t)
	tr := r.Do(c, "PUT", "/api/v1/me/turn", map[string]any{"turn": "always_on", "url": pr.srv.URL})
	body := s.SendBody(newID(), false, []*Agent{r}, nil)
	if x := s.Do(c, "POST", "/api/v1/messages", body); x.Status != 201 {
		t.Fatal(x)
	}
	r.Lease(c, 0)
	// a failing request too (5xx path logs)
	s.Do(c, "POST", "/api/v1/messages", map[string]any{"bad": true})
	mu.Lock()
	logs := buf.String()
	mu.Unlock()
	env := body["envelopes"].([]map[string]any)[0]["envelope"].(map[string]any)
	ck := adam.Client.Jar.Cookies(mustURL(c.URL))[0].Value
	for name, secret := range map[string]string{"envelope h": env["h"].(string), "envelope ct": env["ct"].(string), "envelope sig": env["sig"].(string),
		"csrf token": adam.CSRF, "session cookie": ck, "push secret": tr.Str("push_secret"), "member key": s.Key.Hex()} {
		if secret != "" && strings.Contains(logs, secret) {
			t.Errorf("logs contain the %s", name)
		}
	}
	if !strings.Contains(logs, "request_id") {
		t.Error("logs have no request ids")
	}
}

type lockedWriter struct {
	mu *sync.Mutex
	b  *bytes.Buffer
}

func (w lockedWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.b.Write(p)
}

var _ = context.Background

// Host split (prod shape): /api/v1 only on the API host, pages + /app/v1 only on the app host.
func TestHostSplit(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A", func(cfg *config.Config) { cfg.AppHost, cfg.APIHost = "app.localhost", "api.localhost" })
	get := func(host, path string) *http.Response {
		req, _ := http.NewRequest("GET", c.URL+path, nil)
		req.Host = host
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		return res
	}
	cases := []struct {
		host, path string
		want       int
	}{
		{"api.localhost", "/api/v1/health", 200},
		{"app.localhost", "/api/v1/health", 404},
		{"app.localhost", "/app/v1/auth/providers", 200},
		{"api.localhost", "/app/v1/auth/providers", 404},
		{"app.localhost", "/", 200},
		{"api.localhost", "/", 404},
		{"api.localhost", "/agents.md", 200},
		{"app.localhost", "/agents.md", 200},
		{"api.localhost", "/api/openapi.yaml", 200},
		{"evil.test", "/healthz", 404},
		{"api.localhost:443", "/healthz", 200},
	}
	for _, cs := range cases {
		if res := get(cs.host, cs.path); res.StatusCode != cs.want {
			t.Errorf("%s%s: %d, want %d", cs.host, cs.path, res.StatusCode, cs.want)
		}
	}
}
