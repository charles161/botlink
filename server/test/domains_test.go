package test

import (
	"io"
	"net/http"
	"regexp"
	"strings"
	"testing"

	"github.com/charles161/botlink/server/internal/config"
)

// Domain layout (deploy/DOMAINS.md): the public site on its own host (BOTLINK_SITE_HOST), the dashboard on
// the app host, the agent API on the API host. In these tests the app host is the harness's own 127.0.0.1, so a
// Person works unchanged; the site and API hosts are set with the Host header.
const (
	siteHost = "site.localhost"
	apiHost  = "api.localhost"
)

func threeHosts(cfg *config.Config) {
	cfg.AppHost, cfg.APIHost, cfg.SiteHost = "127.0.0.1", apiHost, siteHost
	cfg.WebAuthnRPID = "127.0.0.1"
}

// noFollow never follows a redirect: the tests look at the redirect itself.
var noFollow = &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}

func hostDo(t *testing.T, c *Copy, method, host, path string, hdr ...string) (*http.Response, string) {
	t.Helper()
	req, _ := http.NewRequest(method, c.URL+path, nil)
	if host != "" {
		req.Host = host
	}
	for i := 0; i+1 < len(hdr); i += 2 {
		req.Header.Set(hdr[i], hdr[i+1])
	}
	res, err := noFollow.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	return res, string(b)
}

func TestSiteHostServesOnlyThePublicSite(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A", threeHosts)
	siteOrigin := c.S.Cfg.SiteOrigin()
	if want := "http://" + siteHost + c.URL[strings.LastIndex(c.URL, ":"):]; siteOrigin != want {
		t.Fatalf("site origin %q, want %q", siteOrigin, want)
	}
	adam := NewPerson(t, c, "Adam")
	room := adam.CreateRoom("domains")
	inv := adam.Invite(room)
	if !strings.HasPrefix(inv, c.URL+"/i/") {
		t.Fatalf("invite links stay on the app host: %s", inv)
	}
	invPath := inv[len(c.URL):]

	// the landing page, with the host named for the page's script and the versioned assets
	res, html := hostDo(t, c, "GET", siteHost, "/")
	if res.StatusCode != 200 || res.Header.Get("Cache-Control") != "no-cache" {
		t.Fatalf("site /: %d %q", res.StatusCode, res.Header.Get("Cache-Control"))
	}
	for _, want := range []string{`<meta name="botlink-host" content="site">`, `<meta name="botlink-app-origin" content="` + c.URL + `">`,
		`<meta name="botlink-site-origin" content="` + siteOrigin + `">`} {
		if !strings.Contains(html, want) {
			t.Errorf("site / lacks %s", want)
		}
	}
	if res.Header.Get("X-Robots-Tag") != "" {
		t.Errorf("site / must be indexable, got X-Robots-Tag %q", res.Header.Get("X-Robots-Tag"))
	}
	if !strings.Contains(res.Header.Get("Content-Security-Policy"), "script-src 'self'") {
		t.Errorf("site / has no CSP: %q", res.Header.Get("Content-Security-Policy"))
	}
	if res.Header.Get("Set-Cookie") != "" {
		t.Errorf("the site host sets no cookie: %q", res.Header.Get("Set-Cookie"))
	}
	m := regexp.MustCompile(`href="/assets/v/([0-9a-f]{12})/app\.css"`).FindStringSubmatch(html)
	if m == nil {
		t.Fatalf("site / names no versioned stylesheet:\n%s", html)
	}
	ver := m[1]
	for _, p := range []string{"/assets/v/" + ver + "/app.css", "/assets/v/" + ver + "/js/app.js", "/assets/v/" + ver + "/js/views/landing.js"} {
		if res, _ := hostDo(t, c, "GET", siteHost, p); res.StatusCode != 200 || res.Header.Get("Cache-Control") != "public, max-age=31536000, immutable" {
			t.Errorf("site %s: %d %q", p, res.StatusCode, res.Header.Get("Cache-Control"))
		}
	}
	for _, p := range []string{"/docs", "/favicon.ico", "/og-image.png", "/manifest.json", "/assets/app.css", "/agents.md", "/llms.txt", "/envelope.md",
		"/api/openapi.yaml", "/healthz"} {
		res, _ := hostDo(t, c, "GET", siteHost, p)
		if res.StatusCode != 200 {
			t.Errorf("site %s: %d, want 200", p, res.StatusCode)
		}
		if res.Header.Get("X-Robots-Tag") != "" {
			t.Errorf("site %s: X-Robots-Tag %q", p, res.Header.Get("X-Robots-Tag"))
		}
	}

	// nothing of the API or the dashboard's own API: 404, with and without a session cookie
	var cookies []string
	for _, ck := range adam.Client.Jar.Cookies(mustURL(c.URL)) {
		cookies = append(cookies, ck.Name+"="+ck.Value)
	}
	cookie := strings.Join(cookies, "; ")
	if cookie == "" {
		t.Fatal("no session cookie to try")
	}
	gone := []string{"/app/v1/me", "/app/v1/auth/providers", "/app/v1/rooms", "/app/v1/events", "/api/v1/health",
		"/api/v1/invites/" + invPath[strings.LastIndex(invPath, "-")+1:], "/dl/botlink.tgz", "/index.html", "/login/", "/nope"}
	for _, p := range gone {
		for _, hdr := range [][]string{nil, {"Cookie", cookie}, {"Accept", "text/html"}} {
			if res, body := hostDo(t, c, "GET", siteHost, p, hdr...); res.StatusCode != 404 {
				t.Errorf("site %s %v: %d, want 404 (%s)", p, hdr, res.StatusCode, trunc([]byte(body)))
			}
		}
	}
	if res, _ := hostDo(t, c, "POST", siteHost, "/app/v1/auth/dev-login", "Origin", siteOrigin, "Content-Type", "application/json"); res.StatusCode != 404 {
		t.Errorf("site POST dev-login: %d, want 404", res.StatusCode)
	}

	// every page of the app, a real invite link among them, moves to the same path on the app host, query kept
	for _, p := range []string{"/login?return_to=%2Fnew", "/rooms", "/new", "/devices", invPath, invPath + "?x=1", "/i/nope-ABCDEFGH",
		"/approve/01933b6e-0000-7000-8000-000000000001", "/p/23456789ABCDEFGH", "/admin", "/rooms/" + room.ID} {
		for _, hdr := range [][]string{nil, {"Cookie", cookie}, {"Accept", "text/html"}} {
			res, _ := hostDo(t, c, "GET", siteHost, p, hdr...)
			if res.StatusCode != 301 || res.Header.Get("Location") != c.URL+p || res.Header.Get("Cache-Control") != "no-store" {
				t.Errorf("site %s %v: %d Location %q Cache-Control %q", p, hdr, res.StatusCode, res.Header.Get("Location"), res.Header.Get("Cache-Control"))
			}
		}
	}
	if res, _ := hostDo(t, c, "POST", siteHost, "/login"); res.StatusCode != 404 {
		t.Errorf("site POST /login: %d, want 404", res.StatusCode)
	}
}

func TestAppHostWithASiteHost(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A", threeHosts)
	adam := NewPerson(t, c, "Adam")
	room := adam.CreateRoom("apphost")
	inv := adam.Invite(room)

	// "/" is the app's home, never the landing page: one page for both, drawn by the dashboard (the sign-in page signed
	// out, the rooms list signed in); the server reads no cookie for it
	ck := adam.Client.Jar.Cookies(mustURL(c.URL))[0]
	for _, hdr := range [][]string{nil, {"Cookie", ck.Name + "=" + ck.Value}} {
		res, html := hostDo(t, c, "GET", "", "/", hdr...)
		if res.StatusCode != 200 || !strings.Contains(html, `<meta name="botlink-host" content="app">`) || res.Header.Get("X-Robots-Tag") != "noindex" {
			t.Fatalf("app / %v: %d %q", hdr, res.StatusCode, res.Header.Get("Location"))
		}
	}

	// everything else on the app host is as before, never indexed
	for _, p := range []string{"/login", "/rooms", "/new", "/devices", "/rooms/" + room.ID, "/approve/01933b6e-0000-7000-8000-000000000001"} {
		res, html := hostDo(t, c, "GET", "", p)
		if res.StatusCode != 200 || !strings.Contains(html, `<meta name="botlink-host" content="app">`) {
			t.Errorf("app %s: %d, host meta missing: %v", p, res.StatusCode, !strings.Contains(html, `content="app"`))
		}
		if res.Header.Get("X-Robots-Tag") != "noindex" {
			t.Errorf("app %s must not be indexed", p)
		}
	}
	if res, _ := hostDo(t, c, "GET", "", "/agents.md"); res.StatusCode != 200 || res.Header.Get("X-Robots-Tag") != "noindex" {
		t.Errorf("app /agents.md: %d X-Robots-Tag %q", res.StatusCode, res.Header.Get("X-Robots-Tag"))
	}
	if res, body := hostDo(t, c, "GET", "", inv[len(c.URL):], "Accept", "text/html"); res.StatusCode != 200 || !strings.Contains(body, "Join #apphost") {
		t.Errorf("app invite page: %d", res.StatusCode)
	}
	if res, body := hostDo(t, c, "GET", "", inv[len(c.URL):]); res.StatusCode != 200 || !strings.Contains(body, inv) {
		t.Errorf("app invite markdown: %d %s", res.StatusCode, trunc([]byte(body)))
	}
	if r := adam.Do("GET", "/app/v1/me", nil); r.Status != 200 {
		t.Errorf("app /app/v1/me: %s", r)
	}
	if res, _ := hostDo(t, c, "GET", "", "/api/v1/health"); res.StatusCode != 404 {
		t.Errorf("app /api/v1/health: %d, want 404", res.StatusCode)
	}

	// the API host is unchanged
	for p, want := range map[string]int{"/api/v1/health": 200, "/agents.md": 200, "/": 404, "/login": 404, "/app/v1/auth/providers": 404} {
		if res, _ := hostDo(t, c, "GET", apiHost, p); res.StatusCode != want {
			t.Errorf("api %s: %d, want %d", p, res.StatusCode, want)
		}
	}
	if res, _ := hostDo(t, c, "GET", apiHost, "/agents.md"); res.Header.Get("X-Robots-Tag") != "" {
		t.Errorf("api /agents.md stays indexable, got %q", res.Header.Get("X-Robots-Tag"))
	}
	if res, _ := hostDo(t, c, "GET", "evil.test", "/"); res.StatusCode != 404 {
		t.Errorf("unknown host /: %d", res.StatusCode)
	}
}

// Without BOTLINK_SITE_HOST nothing changes: the app host serves the landing page, indexable, with no host tags.
func TestAppHostUnchangedWithoutSiteHost(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A", func(cfg *config.Config) { cfg.AppHost, cfg.APIHost = "127.0.0.1", apiHost })
	res, html := hostDo(t, c, "GET", "", "/")
	if res.StatusCode != 200 || res.Header.Get("X-Robots-Tag") != "" || strings.Contains(html, "botlink-host") {
		t.Fatalf("app /: %d X-Robots-Tag %q host tag %v", res.StatusCode, res.Header.Get("X-Robots-Tag"), strings.Contains(html, "botlink-host"))
	}
	if res, _ := hostDo(t, c, "GET", "", "/login"); res.StatusCode != 200 || res.Header.Get("X-Robots-Tag") != "noindex" {
		t.Errorf("app /login: %d %q", res.StatusCode, res.Header.Get("X-Robots-Tag"))
	}
	if res, _ := hostDo(t, c, "GET", "", "/agents.md"); res.Header.Get("X-Robots-Tag") != "" {
		t.Errorf("app /agents.md: X-Robots-Tag %q", res.Header.Get("X-Robots-Tag"))
	}
	if res, _ := hostDo(t, c, "GET", siteHost, "/"); res.StatusCode != 404 {
		t.Errorf("an unconfigured site host: %d, want 404", res.StatusCode)
	}
	// one host (development): the same
	d := StartCopy(t, NewDB(t), "B")
	if res, html := hostDo(t, d, "GET", "", "/"); res.StatusCode != 200 || strings.Contains(html, "botlink-host") {
		t.Errorf("one host /: %d", res.StatusCode)
	}
}

func TestSiteHostConfig(t *testing.T) {
	good := config.Config{Env: "prod", HumanCheck: "real", TurnstileSiteKey: "s", TurnstileSecret: "k", AppOrigin: "https://app.botlink.dev",
		AppHost: "app.botlink.dev", APIHost: "api.botlink.dev", SiteHost: "botlink.dev", WebAuthnRPID: "app.botlink.dev"}
	if err := good.Validate(); err != nil {
		t.Fatalf("good config: %v", err)
	}
	if got := good.SiteOrigin(); got != "https://botlink.dev" {
		t.Fatalf("site origin %q", got)
	}
	for name, mod := range map[string]func(*config.Config){
		"no host split":           func(c *config.Config) { c.AppHost, c.APIHost = "", "" },
		"site is the app host":    func(c *config.Config) { c.SiteHost = "app.botlink.dev" },
		"site is the API host":    func(c *config.Config) { c.SiteHost = "api.botlink.dev" },
		"site with a port":        func(c *config.Config) { c.SiteHost = "botlink.dev:443" },
		"site with a scheme":      func(c *config.Config) { c.SiteHost = "https://botlink.dev" },
		"upper case":              func(c *config.Config) { c.SiteHost = "Botlink.dev" },
		"passkeys on the parent":  func(c *config.Config) { c.WebAuthnRPID = "botlink.dev" },
		"passkeys on a wider one": func(c *config.Config) { c.SiteHost = "www.botlink.dev"; c.WebAuthnRPID = "botlink.dev" },
		"no passkey host":         func(c *config.Config) { c.WebAuthnRPID = "" },
	} {
		c := good
		mod(&c)
		if err := c.Validate(); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	none := good
	none.SiteHost = ""
	if none.SiteOrigin() != "" {
		t.Errorf("no site host, site origin %q", none.SiteOrigin())
	}

	// from the environment: the passkey host must be named, not taken from the app origin
	for k, v := range map[string]string{"BOTLINK_ENV": "dev", "BOTLINK_APP_ORIGIN": "https://app.localhost", "BOTLINK_APP_HOST": "app.localhost",
		"BOTLINK_API_HOST": "api.localhost", "BOTLINK_SITE_HOST": " Site.Localhost ", "BOTLINK_WEBAUTHN_RP_ID": "", "BOTLINK_CLIENT_URL": "",
		"BOTLINK_CLIENT_TGZ": "", "BOTLINK_DL_DIR": "", "BOTLINK_HUMAN_CHECK": "stub"} {
		t.Setenv(k, v)
	}
	if _, err := config.FromEnv(); err == nil || !strings.Contains(err.Error(), "BOTLINK_WEBAUTHN_RP_ID") {
		t.Fatalf("a derived passkey host with a site host: %v", err)
	}
	t.Setenv("BOTLINK_WEBAUTHN_RP_ID", "app.localhost")
	cfg, err := config.FromEnv()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.SiteHost != "site.localhost" || cfg.SiteOrigin() != "https://site.localhost" || cfg.WebAuthnRPID != "app.localhost" {
		t.Fatalf("config: site %q origin %q rp %q", cfg.SiteHost, cfg.SiteOrigin(), cfg.WebAuthnRPID)
	}
	// without a site host the old default stays (the app origin's host)
	t.Setenv("BOTLINK_SITE_HOST", "")
	t.Setenv("BOTLINK_WEBAUTHN_RP_ID", "")
	if cfg, err := config.FromEnv(); err != nil || cfg.WebAuthnRPID != "app.localhost" {
		t.Fatalf("no site host: %v %+v", err, cfg)
	}
}

// The session cookie where cookies are Secure (staging, prod): __Host-bl_session, Path=/, Secure, HttpOnly, no
// Domain. The name used before (bl_session) is not a session there, and is cleared.
func TestSessionCookieHostPrefix(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A", func(cfg *config.Config) { cfg.Env = "staging" })
	login := func() string {
		req, _ := http.NewRequest("POST", c.URL+"/app/v1/auth/dev-login", strings.NewReader(`{"email":"cookie@example.com","display_name":"Cookie"}`))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", c.URL)
		r := doRaw(t, req)
		if r.Status != 200 {
			t.Fatalf("dev-login: %s", r)
		}
		sc := r.Header.Values("Set-Cookie")
		if len(sc) != 1 {
			t.Fatalf("Set-Cookie: %q", sc)
		}
		return sc[0]
	}
	raw := login()
	if !strings.HasPrefix(raw, "__Host-bl_session=") {
		t.Fatalf("cookie name: %s", raw)
	}
	attrs := map[string]bool{}
	for _, a := range strings.Split(raw, ";")[1:] {
		attrs[strings.ToLower(strings.TrimSpace(a))] = true
	}
	for _, want := range []string{"path=/", "secure", "httponly", "samesite=lax"} {
		if !attrs[want] {
			t.Errorf("cookie lacks %s: %s", want, raw)
		}
	}
	for a := range attrs {
		if strings.HasPrefix(a, "domain") {
			t.Errorf("cookie has a Domain: %s", raw)
		}
	}
	val := strings.TrimPrefix(strings.SplitN(raw, ";", 2)[0], "__Host-bl_session=")
	me := func(cookie string) *Resp {
		req, _ := http.NewRequest("GET", c.URL+"/app/v1/me", nil)
		if cookie != "" {
			req.Header.Set("Cookie", cookie)
		}
		return doRaw(t, req)
	}
	if r := me("__Host-bl_session=" + val); r.Status != 200 || len(r.Header.Values("Set-Cookie")) != 0 {
		t.Fatalf("me with the new cookie: %s %q", r, r.Header.Values("Set-Cookie"))
	}
	// the old name, even with a live session's value (a cookie another host planted, or a browser from before)
	r := me("bl_session=" + val)
	if r.Status != 401 {
		t.Fatalf("me with the old cookie name: %s", r)
	}
	sc := r.Header.Values("Set-Cookie")
	if len(sc) != 1 || !strings.HasPrefix(sc[0], "bl_session=;") || !strings.Contains(sc[0], "Max-Age=0") || !strings.Contains(sc[0], "Path=/") ||
		strings.Contains(strings.ToLower(sc[0]), "domain") {
		t.Fatalf("the old cookie is not cleared: %q", sc)
	}
	// both sent: the new one is the session, the old one is cleared
	r = me("bl_session=planted; __Host-bl_session=" + val)
	if sc := r.Header.Values("Set-Cookie"); r.Status != 200 || len(sc) != 1 || !strings.HasPrefix(sc[0], "bl_session=;") {
		t.Fatalf("both cookies: %s %q", r, sc)
	}
	// sign-out clears the new name
	req, _ := http.NewRequest("POST", c.URL+"/app/v1/auth/logout", nil)
	req.Header.Set("Origin", c.URL)
	req.Header.Set("Cookie", "__Host-bl_session="+val)
	req.Header.Set("X-CSRF-Token", me("__Host-bl_session="+val).Str("csrf_token"))
	out := doRaw(t, req)
	if sc := out.Header.Values("Set-Cookie"); out.Status != 200 || len(sc) != 1 || !strings.HasPrefix(sc[0], "__Host-bl_session=;") || !strings.Contains(sc[0], "Secure") {
		t.Fatalf("sign-out: %s %q", out, sc)
	}
	if r := me("__Host-bl_session=" + val); r.Status != 401 {
		t.Fatalf("after sign-out: %s", r)
	}

	// dev over plain http keeps the bare name (a __Host- cookie needs Secure), and it is not cleared there
	d := StartCopy(t, NewDB(t), "B")
	adam := NewPerson(t, d, "Adam")
	cks := adam.Client.Jar.Cookies(mustURL(d.URL))
	if len(cks) != 1 || cks[0].Name != "bl_session" {
		t.Fatalf("dev cookie: %+v", cks)
	}
	if r := adam.Do("GET", "/app/v1/me", nil); r.Status != 200 || len(r.Header.Values("Set-Cookie")) != 0 {
		t.Fatalf("dev me: %s %q", r, r.Header.Values("Set-Cookie"))
	}
}

// Security, privacy and terms (web/public/*.html) belong to the public site: indexed there, and the app host sends
// them to it. Without a site host they are indexable files on the one host. Every index page names the client URL
// for the landing's one command.
func TestStaticPagesFollowTheSite(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A", threeHosts)
	for _, p := range []string{"/security.html", "/privacy.html", "/terms.html"} {
		res, body := hostDo(t, c, "GET", siteHost, p)
		if res.StatusCode != 200 || res.Header.Get("X-Robots-Tag") != "" || !strings.Contains(body, "<html") {
			t.Errorf("site %s: %d X-Robots-Tag %q", p, res.StatusCode, res.Header.Get("X-Robots-Tag"))
		}
		res, _ = hostDo(t, c, "GET", "", p+"?x=1")
		if res.StatusCode != 301 || res.Header.Get("Location") != c.S.Cfg.SiteOrigin()+p+"?x=1" {
			t.Errorf("app %s: %d Location %q", p, res.StatusCode, res.Header.Get("Location"))
		}
		if res, _ := hostDo(t, c, "GET", apiHost, p); res.StatusCode != 404 {
			t.Errorf("api %s: %d, want 404", p, res.StatusCode)
		}
	}
	_, html := hostDo(t, c, "GET", siteHost, "/")
	if !strings.Contains(html, `<meta name="botlink-client-url" content="`+c.S.Cfg.ClientURL+`">`) {
		t.Errorf("site / names no client URL")
	}

	one := StartCopy(t, NewDB(t), "A", func(cfg *config.Config) { cfg.AppHost, cfg.APIHost = "127.0.0.1", apiHost })
	for _, p := range []string{"/security.html", "/privacy.html", "/terms.html"} {
		if res, _ := hostDo(t, one, "GET", "", p); res.StatusCode != 200 || res.Header.Get("X-Robots-Tag") != "" {
			t.Errorf("one host %s: %d X-Robots-Tag %q", p, res.StatusCode, res.Header.Get("X-Robots-Tag"))
		}
	}
}
