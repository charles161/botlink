package test

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/charles161/botlink/server/internal/config"
)

// The security settings of the host split (deploy/DOMAINS.md): what a page on one host can do with the other's
// cookie, where sign-in providers send people back, and the headers both browser hosts send over HTTPS.

// A page on the site host cannot act with the app host's cookie: the browser sends it (the two hosts are same-site,
// SameSite=Lax lets it through), so the app refuses by Origin, and no CORS answer lets a site page read the reply.
func TestSiteCannotActWithAppCookie(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A", threeHosts)
	site := c.S.Cfg.SiteOrigin()
	adam := NewPerson(t, c, "Adam")
	csrf := adam.Do("GET", "/app/v1/me", nil).Str("csrf_token")
	var cookie string
	for _, ck := range adam.Client.Jar.Cookies(mustURL(c.URL)) {
		cookie = ck.Name + "=" + ck.Value
	}
	post := func(origin string) (int, string) {
		req, _ := http.NewRequest("POST", c.URL+"/app/v1/auth/logout", nil)
		req.Header.Set("Origin", origin)
		req.Header.Set("Cookie", cookie)
		req.Header.Set("X-CSRF-Token", csrf)
		r := doRaw(t, req)
		return r.Status, r.Code()
	}
	if st, code := post(site); st != 403 || code != "csrf_failed" {
		t.Fatalf("POST from the site's origin with the app cookie and its CSRF token: %d %s, want 403 csrf_failed", st, code)
	}
	req, _ := http.NewRequest("GET", c.URL+"/app/v1/me", nil)
	req.Header.Set("Origin", site)
	req.Header.Set("Cookie", cookie)
	r := doRaw(t, req)
	for _, h := range []string{"Access-Control-Allow-Origin", "Access-Control-Allow-Credentials"} {
		if v := r.Header.Get(h); v != "" {
			t.Errorf("GET /app/v1/me from the site's origin: %s %q lets a site page read the app's answers", h, v)
		}
	}
	if st, _ := post(c.URL); st != 200 {
		t.Fatalf("control, POST from the app's own origin: %d", st)
	}
}

// Sign-in providers send people back to the app host (BOTLINK_APP_ORIGIN/app/v1/auth/<provider>/callback), the
// address registered with GitHub and Google; the split changes nothing there. The site host has no sign-in at all.
func TestOAuthCallbackStaysOnTheAppHost(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A", threeHosts, func(cfg *config.Config) {
		cfg.GitHubClientID, cfg.GitHubSecret, cfg.GoogleClientID, cfg.GoogleSecret = "id", "sec", "gid", "sec"
	})
	for _, p := range []string{"github", "google"} {
		res, _ := hostDo(t, c, "GET", "", "/app/v1/auth/"+p+"/start?return_to=%2Frooms")
		if res.StatusCode != 302 {
			t.Fatalf("%s start: %d", p, res.StatusCode)
		}
		loc, _ := url.Parse(res.Header.Get("Location"))
		if got, want := loc.Query().Get("redirect_uri"), c.URL+"/app/v1/auth/"+p+"/callback"; got != want {
			t.Errorf("%s redirect_uri %q, want %q", p, got, want)
		}
		for _, sc := range res.Header.Values("Set-Cookie") {
			if strings.Contains(strings.ToLower(sc), "domain=") {
				t.Errorf("%s start sets a cookie with a Domain (it would reach the site host): %s", p, sc)
			}
		}
		for _, path := range []string{"/app/v1/auth/" + p + "/start", "/app/v1/auth/" + p + "/callback?code=x&state=y"} {
			if res, _ := hostDo(t, c, "GET", siteHost, path); res.StatusCode != 404 {
				t.Errorf("site %s: %d, want 404", path, res.StatusCode)
			}
		}
	}
}

// Where cookies are Secure (staging, prod): HSTS on the site and the app host alike, and each host keeps its own CSP.
func TestHSTSOnBothBrowserHosts(t *testing.T) {
	hr := loadHostRoutes(t)
	c := StartCopy(t, NewDB(t), "A", threeHosts, func(cfg *config.Config) { cfg.Env = "staging" })
	for key, chk := range map[string]hostHeaderCheck{"site": hr.Headers.Site, "app": hr.Headers.App, "api": hr.Headers.API} {
		req := httptest.NewRequest("GET", chk.Path, nil)
		req.Host = map[string]string{"site": siteHost, "app": c.Host, "api": apiHost}[key]
		rec := httptest.NewRecorder()
		c.S.Handler.ServeHTTP(rec, req)
		if rec.Code != 200 {
			t.Fatalf("%s %s: %d", key, chk.Path, rec.Code)
		}
		if got := rec.Header().Get("Strict-Transport-Security"); got != hr.Headers.HSTS {
			t.Errorf("%s: Strict-Transport-Security %q, want %q", key, got, hr.Headers.HSTS)
		}
		checkHeaders(t, key+" (staging) "+chk.Path, rec.Header(), chk)
	}
}

// One host (staging, test.botlink.dev): the app's CSP on every page (the landing shares the host with sign-in and
// its human check), HSTS and no host role. (The passkey RP ID there is the app origin's host: TestSiteHostConfig.)
func TestOneHostSecurityHeaders(t *testing.T) {
	hr := loadHostRoutes(t)
	c := StartCopy(t, NewDB(t), "A", func(cfg *config.Config) { cfg.Env = "staging" })
	for _, path := range []string{"/", "/login", "/agents.md"} {
		req := httptest.NewRequest("GET", path, nil)
		req.Host = c.Host
		rec := httptest.NewRecorder()
		c.S.Handler.ServeHTTP(rec, req)
		if rec.Code != 200 {
			t.Fatalf("one host %s: %d", path, rec.Code)
		}
		h := rec.Header()
		checkHeaders(t, "one host "+path, h, hostHeaderCheck{Has: map[string][]string{"Content-Security-Policy": hr.Headers.App.Has["Content-Security-Policy"]}})
		if got := h.Get("Strict-Transport-Security"); got != hr.Headers.HSTS {
			t.Errorf("one host %s: HSTS %q", path, got)
		}
		if h.Get("Permissions-Policy") != "" {
			t.Errorf("one host %s: the site's Permissions-Policy would stop passkeys on the one host", path)
		}
		if strings.Contains(rec.Body.String(), "botlink-host") {
			t.Errorf("one host %s names a host role", path)
		}
	}
}
