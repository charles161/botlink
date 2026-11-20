package test

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/charles161/botlink/server/internal/config"
	"github.com/charles161/botlink/server/internal/pages"
)

// The host routing table (server/internal/pages/testdata/host-routes.json), run through the server's own handler.
// deploy/check-domains.py runs the same file against a real server (a local binary, or the public hosts).

const hostRoutesFile = "../internal/pages/testdata/host-routes.json"

type hostRoutes struct {
	Rows       []map[string]any `json:"rows"`
	SingleRows []map[string]any `json:"single_rows"`
	Headers    struct {
		Site, App, API hostHeaderCheck
		HSTS           string `json:"hsts"`
	} `json:"headers"`
}

type hostHeaderCheck struct {
	Path  string              `json:"path"`
	Has   map[string][]string `json:"has"`
	Lacks map[string][]string `json:"lacks"`
}

func loadHostRoutes(t *testing.T) hostRoutes {
	t.Helper()
	b, err := os.ReadFile(hostRoutesFile)
	if err != nil {
		t.Fatal(err)
	}
	var hr hostRoutes
	if err := json.Unmarshal(b, &hr); err != nil {
		t.Fatalf("%s: %v", hostRoutesFile, err)
	}
	return hr
}

// hostKeys: the host keys a row may name, in a fixed order.
var hostKeys = []string{"site", "app", "api", "site_upper", "app_upper", "app_port", "unknown", "fwd_app", "abs_evil"}

// clientDir writes a tiny client tarball and a manifest next to it, so /dl answers on the API host.
func clientDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	pkg := []byte(`{"name":"botlink","version":"0.0.0-test"}`)
	_ = tw.WriteHeader(&tar.Header{Name: "package/package.json", Mode: 0o644, Size: int64(len(pkg))})
	_, _ = tw.Write(pkg)
	_ = tw.Close()
	_ = gz.Close()
	if err := os.WriteFile(filepath.Join(dir, "botlink.tgz"), buf.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "botlink.manifest.json"), []byte(`{"test":true}`), 0o644); err != nil {
		t.Fatal(err)
	}
	return filepath.Join(dir, "botlink.tgz")
}

// hostRequest: where a host key of the data file sends a request (target, Host header, extra headers).
type hostRequest func(key, path string) (target, host string, hdr http.Header)

func sessionCookie(t *testing.T, c *Copy) string {
	t.Helper()
	adam := NewPerson(t, c, "Adam")
	var cookie string
	for _, ck := range adam.Client.Jar.Cookies(mustURL(c.URL)) {
		cookie = ck.Name + "=" + ck.Value
	}
	if cookie == "" {
		t.Fatal("no session cookie")
	}
	return cookie
}

// runHostRows sends every row's request for each host key it names through the server's handler and checks the
// answer; it returns how many requests ran.
func runHostRows(t *testing.T, c *Copy, rows []map[string]any, keys []string, at hostRequest, origins map[string]string, cookie string) int {
	t.Helper()
	ran := 0
	for i, row := range rows {
		path, _ := row["path"].(string)
		method, _ := row["method"].(string)
		if method == "" {
			method = "GET"
		}
		for _, key := range keys {
			want, ok := row[key].(string)
			if !ok {
				continue
			}
			target, host, hdr := at(key, path)
			req := httptest.NewRequest(method, target, nil)
			if host != "" {
				req.Host = host
			}
			for k, v := range hdr {
				req.Header[k] = v
			}
			if a, _ := row["accept"].(string); a != "" {
				req.Header.Set("Accept", a)
			}
			if in, _ := row["signed_in"].(bool); in {
				req.Header.Set("Cookie", cookie)
			}
			rec := httptest.NewRecorder()
			c.S.Handler.ServeHTTP(rec, req)
			ran++
			got := rec.Code
			name := method + " " + key + " " + path
			if row["signed_in"] == true {
				name += " (signed in)"
			}
			sub := func(s string) string {
				for k, v := range origins {
					s = strings.ReplaceAll(s, k, v)
				}
				return s
			}
			wantCode, wantLoc, _ := strings.Cut(want, " ")
			wantLoc = sub(wantLoc)
			gotLoc := rec.Header().Get("Location")
			if wantCode != strconv.Itoa(got) || gotLoc != wantLoc {
				t.Errorf("row %d %s: got %d %q, want %s %q", i, name, got, gotLoc, wantCode, wantLoc)
				continue
			}
			if b, ok := row["body_"+key].(string); ok && !strings.Contains(rec.Body.String(), sub(b)) {
				t.Errorf("row %d %s: body lacks %q: %s", i, name, sub(b), trunc(rec.Body.Bytes()))
			}
			if got == 301 && rec.Header().Get("Cache-Control") != "no-store" {
				t.Errorf("row %d %s: a cross-host redirect is not stored by browsers (Cache-Control %q, want no-store)", i, name, rec.Header().Get("Cache-Control"))
			}
			if key == "site" || key == "site_upper" {
				if sc := rec.Header().Values("Set-Cookie"); len(sc) != 0 {
					t.Errorf("row %d %s: the site host set a cookie: %q", i, name, sc)
				}
			}
		}
	}
	return ran
}

// The split: site, app and API on three hosts.
func TestHostRoutingTable(t *testing.T) {
	hr := loadHostRoutes(t)
	tgz := clientDir(t)
	c := StartCopy(t, NewDB(t), "A", threeHosts, func(cfg *config.Config) { cfg.ClientTGZ = tgz })
	appHost := pages.RequestHost(&http.Request{Host: c.Host})
	at := func(key, path string) (string, string, http.Header) {
		hdr := http.Header{}
		switch key {
		case "site":
			return path, siteHost, hdr
		case "app":
			return path, c.Host, hdr
		case "api":
			return path, apiHost, hdr
		case "site_upper":
			return path, strings.ToUpper(siteHost), hdr
		case "app_upper":
			return path, strings.ToUpper(appHost) + c.Host[len(appHost):], hdr
		case "app_port":
			return path, appHost + ":443", hdr
		case "fwd_app":
			hdr.Set("X-Forwarded-Host", c.Host)
		case "abs_evil":
			return "http://evil.example" + path, "", hdr
		}
		return path, "evil.example", hdr // unknown, fwd_app
	}
	ran := runHostRows(t, c, hr.Rows, hostKeys, at, map[string]string{"{app}": c.URL, "{site}": c.S.Cfg.SiteOrigin()}, sessionCookie(t, c))
	if ran < 150 {
		t.Fatalf("only %d requests ran from %s", ran, hostRoutesFile)
	}
	t.Logf("%d requests from %d rows", ran, len(hr.Rows))
}

// One host for everything (staging: test.botlink.dev): every path on that host, and nothing ever moves.
func TestHostRoutingTableSingleHost(t *testing.T) {
	hr := loadHostRoutes(t)
	tgz := clientDir(t)
	c := StartCopy(t, NewDB(t), "A", func(cfg *config.Config) { cfg.ClientTGZ = tgz })
	at := func(key, path string) (string, string, http.Header) {
		if key == "one_other" {
			return path, "evil.example", nil
		}
		return path, c.Host, nil
	}
	ran := runHostRows(t, c, hr.SingleRows, []string{"one", "one_other"}, at, map[string]string{"{one}": c.URL}, sessionCookie(t, c))
	for i, row := range hr.SingleRows {
		for k, v := range row {
			if s, ok := v.(string); ok && (k == "one" || k == "one_other") && strings.HasPrefix(s, "301") {
				t.Errorf("single-host row %d %s: one host never moves a path (%s)", i, row["path"], s)
			}
		}
	}
	if ran < 50 {
		t.Fatalf("only %d requests ran from %s", ran, hostRoutesFile)
	}
	t.Logf("%d requests from %d rows", ran, len(hr.SingleRows))
}

// The per-host security headers of the same file.
func TestHostSecurityHeaders(t *testing.T) {
	hr := loadHostRoutes(t)
	c := StartCopy(t, NewDB(t), "A", threeHosts)
	for key, chk := range map[string]hostHeaderCheck{"site": hr.Headers.Site, "app": hr.Headers.App, "api": hr.Headers.API} {
		host := map[string]string{"site": siteHost, "app": c.Host, "api": apiHost}[key]
		req := httptest.NewRequest("GET", chk.Path, nil)
		req.Host = host
		rec := httptest.NewRecorder()
		c.S.Handler.ServeHTTP(rec, req)
		if rec.Code != 200 {
			t.Fatalf("%s %s: %d", key, chk.Path, rec.Code)
		}
		checkHeaders(t, key+" "+chk.Path, rec.Header(), chk)
		if v := rec.Header().Get("Strict-Transport-Security"); v != "" {
			t.Errorf("%s: HSTS over plain http in dev: %q", key, v)
		}
	}
}

func checkHeaders(t *testing.T, name string, h http.Header, chk hostHeaderCheck) {
	t.Helper()
	for k, subs := range chk.Has {
		v := strings.Join(h.Values(k), ", ")
		for _, s := range subs {
			if !strings.Contains(v, s) {
				t.Errorf("%s: %s %q lacks %q", name, k, v, s)
			}
		}
	}
	for k, subs := range chk.Lacks {
		v := strings.Join(h.Values(k), ", ")
		for _, s := range subs {
			if (s == "" && len(h.Values(k)) > 0) || (s != "" && strings.Contains(v, s)) {
				t.Errorf("%s: %s %q must not hold %q", name, k, v, s)
			}
		}
	}
}
