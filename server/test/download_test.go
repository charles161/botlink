package test

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/charles161/botlink/server/internal/config"
)

// GET|HEAD /dl/botlink.tgz (deploy/NEEDS.md item 4): the client tarball on the API host only, from BOTLINK_CLIENT_TGZ
// (or BOTLINK_DL_DIR/botlink.tgz), read per request so a swapped file/symlink is served at once; and the invite pages
// tell agents to run `npx -y <that URL> …`, never a bare `npx botlink`.
func TestClientDownload(t *testing.T) {
	dir := t.TempDir()
	rel1 := filepath.Join(dir, "r1.tgz")
	rel2 := filepath.Join(dir, "r2.tgz")
	if err := os.WriteFile(rel1, []byte("\x1f\x8b fake tarball one"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(rel2, []byte("\x1f\x8b fake tarball two, longer"), 0o644); err != nil {
		t.Fatal(err)
	}
	cur := filepath.Join(dir, "botlink.tgz")
	if err := os.Symlink(rel1, cur); err != nil {
		t.Fatal(err)
	}
	t.Setenv("BOTLINK_DL_DIR", dir) // config.Load path (BOTLINK_DL_DIR -> <dir>/botlink.tgz)
	t.Setenv("BOTLINK_CLIENT_TGZ", "")
	t.Setenv("BOTLINK_API_HOST", "api.localhost")
	t.Setenv("BOTLINK_APP_HOST", "app.localhost")
	t.Setenv("BOTLINK_CLIENT_URL", "")
	lc, err := config.FromEnv()
	if err != nil {
		t.Fatal(err)
	}
	if lc.ClientTGZ != cur || lc.ClientURL != "https://api.localhost/dl/botlink.tgz" {
		t.Fatalf("config: tgz %q url %q", lc.ClientTGZ, lc.ClientURL)
	}
	c := StartCopy(t, NewDB(t), "A", func(cfg *config.Config) {
		cfg.AppHost, cfg.APIHost = "app.localhost", "api.localhost"
		cfg.ClientTGZ = cur
		cfg.ClientURL = "https://api.localhost/dl/botlink.tgz"
	})
	do := func(method, host, path string, hdr map[string]string) (*http.Response, []byte) {
		req, _ := http.NewRequest(method, c.URL+path, nil)
		req.Host = host
		for k, v := range hdr {
			req.Header.Set(k, v)
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		b, _ := io.ReadAll(res.Body)
		return res, b
	}
	etag := func(p string) string {
		b, _ := os.ReadFile(p)
		s := sha256.Sum256(b)
		return `"` + hex.EncodeToString(s[:]) + `"`
	}
	res, body := do("GET", "api.localhost", "/dl/botlink.tgz", nil)
	if res.StatusCode != 200 || string(body) != "\x1f\x8b fake tarball one" {
		t.Fatalf("GET: %d %q", res.StatusCode, body)
	}
	for k, want := range map[string]string{"Content-Type": "application/gzip", "Cache-Control": "no-cache", "ETag": etag(rel1), "X-Robots-Tag": "noindex"} {
		if got := res.Header.Get(k); got != want {
			t.Fatalf("%s = %q, want %q", k, got, want)
		}
	}
	if res, body := do("HEAD", "api.localhost", "/dl/botlink.tgz", nil); res.StatusCode != 200 || len(body) != 0 || res.Header.Get("ETag") != etag(rel1) || res.ContentLength != int64(len("\x1f\x8b fake tarball one")) {
		t.Fatalf("HEAD: %d len %d %v", res.StatusCode, len(body), res.Header)
	}
	if res, _ := do("GET", "api.localhost", "/dl/botlink.tgz", map[string]string{"If-None-Match": etag(rel1)}); res.StatusCode != 304 {
		t.Fatalf("If-None-Match: %d", res.StatusCode)
	}
	if res, _ := do("POST", "api.localhost", "/dl/botlink.tgz", nil); res.StatusCode != 405 {
		t.Fatalf("POST: %d", res.StatusCode)
	}
	// API host only
	if res, _ := do("GET", "app.localhost", "/dl/botlink.tgz", nil); res.StatusCode != 404 {
		t.Fatalf("app host serves /dl: %d", res.StatusCode)
	}
	if res, _ := do("GET", "api.localhost", "/dl/other.tgz", nil); res.StatusCode != 404 {
		t.Fatalf("other /dl file: %d", res.StatusCode)
	}
	// a deploy swaps the symlink: served at once, new ETag
	_ = os.Remove(cur)
	if err := os.Symlink(rel2, cur); err != nil {
		t.Fatal(err)
	}
	if res, body := do("GET", "api.localhost", "/dl/botlink.tgz", map[string]string{"If-None-Match": etag(rel1)}); res.StatusCode != 200 || string(body) != "\x1f\x8b fake tarball two, longer" || res.Header.Get("ETag") != etag(rel2) {
		t.Fatalf("after swap: %d %q %s", res.StatusCode, body, res.Header.Get("ETag"))
	}
	// file gone: 404, never a directory listing or a crash
	_ = os.Remove(cur)
	if res, _ := do("GET", "api.localhost", "/dl/botlink.tgz", nil); res.StatusCode != 404 {
		t.Fatalf("missing file: %d", res.StatusCode)
	}

	// invite pages: the distribution URL, never a bare `npx botlink`
	// (a single-host copy: the test person signs in without a Host header)
	ci := StartCopy(t, NewDB(t), "I", func(cfg *config.Config) { cfg.ClientURL = "https://api.localhost/dl/botlink.tgz" })
	adam := NewPerson(t, ci, "Adam")
	room := adam.CreateRoom("dl")
	inv := adam.Invite(room)
	code := inv[strings.LastIndex(inv, "/")+1:]
	for _, accept := range []string{"text/markdown", "text/html"} {
		req, _ := http.NewRequest("GET", ci.URL+"/i/"+code, nil)
		req.Header.Set("Accept", accept)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		b, _ := io.ReadAll(res.Body)
		res.Body.Close()
		page := string(b)
		if res.StatusCode != 200 || !strings.Contains(page, "npx -y https://api.localhost/dl/botlink.tgz join ") {
			t.Fatalf("%s invite page lacks the distribution URL: %d %s", accept, res.StatusCode, page)
		}
		// the 2026-11-10 test run (SPEC §6.14): the invite page tells agents to set up listening right after joining, their own way:
		// the one signal (wait) with the client's address, and no command picked per app
		if accept == "text/markdown" && (!strings.Contains(page, "Set up listening right after you join") || !strings.Contains(page, "stands for `npx -y https://api.localhost/dl/botlink.tgz`") || !strings.Contains(page, "`... wait`") || strings.Contains(page, "codex-queue") || strings.Contains(page, "%!")) {
			t.Fatalf("%s invite page lacks the listening steps: %s", accept, page)
		}
		bare := strings.ReplaceAll(page, "never run a bare `npx botlink`", "")
		if strings.Contains(bare, "npx botlink") {
			t.Fatalf("%s invite page tells agents to run a bare npx botlink: %s", accept, page)
		}
	}
	// no tarball configured: no route
	c2 := StartCopy(t, NewDB(t), "B")
	if r := doRaw(t, mustReq("GET", c2.URL+"/dl/botlink.tgz")); r.Status != 404 {
		t.Fatalf("unconfigured /dl: %d", r.Status)
	}
}

// GET|HEAD /dl/botlink.json: the self-update check (CONTRACT-CHANGES 2026-11-06): version + sha256 + size of the
// tarball /dl/botlink.tgz serves right now, API host only, follows a symlink swap at once.
func TestClientInfo(t *testing.T) {
	dir := t.TempDir()
	mk := func(name, version string) (string, string, int) {
		var buf bytes.Buffer
		gz := gzip.NewWriter(&buf)
		tw := tar.NewWriter(gz)
		pj := []byte(`{"name":"botlink","version":"` + version + `"}`)
		_ = tw.WriteHeader(&tar.Header{Name: "package/dist/cli.js", Mode: 0o644, Size: 2})
		_, _ = tw.Write([]byte("//"))
		_ = tw.WriteHeader(&tar.Header{Name: "package/package.json", Mode: 0o644, Size: int64(len(pj))})
		_, _ = tw.Write(pj)
		_ = tw.Close()
		_ = gz.Close()
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, buf.Bytes(), 0o644); err != nil {
			t.Fatal(err)
		}
		s := sha256.Sum256(buf.Bytes())
		return p, hex.EncodeToString(s[:]), buf.Len()
	}
	r1, sha1, n1 := mk("r1.tgz", "1.0.0-dev")
	r2, sha2, n2 := mk("r2.tgz", "1.0.1")
	cur := filepath.Join(dir, "botlink.tgz")
	if err := os.Symlink(r1, cur); err != nil {
		t.Fatal(err)
	}
	c := StartCopy(t, NewDB(t), "A", func(cfg *config.Config) {
		cfg.AppHost, cfg.APIHost = "app.localhost", "api.localhost"
		cfg.ClientTGZ = cur
		cfg.ClientURL = "https://api.localhost/dl/botlink.tgz"
	})
	get := func(method, host string, hdr map[string]string) (*http.Response, map[string]any) {
		req, _ := http.NewRequest(method, c.URL+"/dl/botlink.json", nil)
		req.Host = host
		for k, v := range hdr {
			req.Header.Set(k, v)
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		b, _ := io.ReadAll(res.Body)
		var v map[string]any
		_ = json.Unmarshal(b, &v)
		return res, v
	}
	res, v := get("GET", "api.localhost", nil)
	if res.StatusCode != 200 || v["sha256"] != sha1 || v["version"] != "1.0.0-dev" || v["size"] != float64(n1) || v["v"] != float64(1) ||
		v["url"] != "https://api.localhost/dl/botlink-"+sha1[:16]+".tgz" || res.Header.Get("Cache-Control") != "no-cache" || res.Header.Get("Content-Type") != "application/json" {
		t.Fatalf("info: %d %v %v", res.StatusCode, v, res.Header)
	}
	if res, _ := get("GET", "api.localhost", map[string]string{"If-None-Match": res.Header.Get("ETag")}); res.StatusCode != 304 {
		t.Fatalf("If-None-Match: %d", res.StatusCode)
	}
	if res, _ := get("HEAD", "api.localhost", nil); res.StatusCode != 200 {
		t.Fatalf("HEAD: %d", res.StatusCode)
	}
	if res, _ := get("GET", "app.localhost", nil); res.StatusCode != 404 {
		t.Fatalf("app host serves /dl/botlink.json: %d", res.StatusCode)
	}
	_ = os.Remove(cur)
	if err := os.Symlink(r2, cur); err != nil {
		t.Fatal(err)
	}
	if res, v := get("GET", "api.localhost", nil); res.StatusCode != 200 || v["sha256"] != sha2 || v["version"] != "1.0.1" || v["size"] != float64(n2) {
		t.Fatalf("after swap: %d %v", res.StatusCode, v)
	}
	// the sha the info names is the sha of what /dl/botlink.tgz serves
	req, _ := http.NewRequest("GET", c.URL+"/dl/botlink.tgz", nil)
	req.Host = "api.localhost"
	tr, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	tb, _ := io.ReadAll(tr.Body)
	tr.Body.Close()
	if s := sha256.Sum256(tb); hex.EncodeToString(s[:]) != sha2 {
		t.Fatal("tarball sha differs from the info")
	}
	_ = os.Remove(cur)
	if res, _ := get("GET", "api.localhost", nil); res.StatusCode != 404 {
		t.Fatalf("missing file: %d", res.StatusCode)
	}
}

// Launch plan #3: npx keeps running the first copy it fetched for a given spec, so a fixed URL leaves people on old
// clients. Everything that tells someone what to run names a versioned URL, /dl/botlink-<first 16 hex of the
// tarball's sha256>.tgz: the invite pages (HTML + Markdown), /agents.md, /llms.txt and the url in /dl/botlink.json.
// That URL is immutable; an older one redirects to the current one; the fixed /dl/botlink.tgz keeps working.
func TestClientVersionedDownload(t *testing.T) {
	dir := t.TempDir()
	r1, r2 := filepath.Join(dir, "r1.tgz"), filepath.Join(dir, "r2.tgz")
	one, two := []byte("\x1f\x8b fake tarball one"), []byte("\x1f\x8b fake tarball two, longer")
	_ = os.WriteFile(r1, one, 0o644)
	_ = os.WriteFile(r2, two, 0o644)
	cur := filepath.Join(dir, "botlink.tgz")
	if err := os.Symlink(r1, cur); err != nil {
		t.Fatal(err)
	}
	short := func(b []byte) string { s := sha256.Sum256(b); return hex.EncodeToString(s[:])[:16] }
	v1, v2 := short(one), short(two)
	// a single-host copy (no host split), so invite pages and /dl are on the same origin
	c := StartCopy(t, NewDB(t), "V", func(cfg *config.Config) {
		cfg.ClientTGZ = cur
		cfg.ClientURL = "https://api.localhost/dl/botlink.tgz"
	})
	get := func(path string, hdr map[string]string) (*http.Response, []byte) {
		req, _ := http.NewRequest("GET", c.URL+path, nil)
		for k, v := range hdr {
			req.Header.Set(k, v)
		}
		res, err := noRedirect.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		b, _ := io.ReadAll(res.Body)
		return res, b
	}
	want := "https://api.localhost/dl/botlink-" + v1 + ".tgz"

	// the versioned URL serves the bytes, immutable
	res, body := get("/dl/botlink-"+v1+".tgz", nil)
	if res.StatusCode != 200 || string(body) != string(one) {
		t.Fatalf("versioned GET: %d %q", res.StatusCode, body)
	}
	if cc := res.Header.Get("Cache-Control"); cc != "public, max-age=31536000, immutable" {
		t.Fatalf("versioned Cache-Control %q", cc)
	}
	if res.Header.Get("Content-Type") != "application/gzip" || res.Header.Get("X-Robots-Tag") != "noindex" {
		t.Fatalf("versioned headers: %v", res.Header)
	}
	// the fixed URL still serves the current one, revalidated each time
	if res, body := get("/dl/botlink.tgz", nil); res.StatusCode != 200 || string(body) != string(one) || res.Header.Get("Cache-Control") != "no-cache" {
		t.Fatalf("fixed URL: %d %q %s", res.StatusCode, body, res.Header.Get("Cache-Control"))
	}
	// info names the versioned URL
	res, body = get("/dl/botlink.json", nil)
	var info map[string]any
	_ = json.Unmarshal(body, &info)
	if res.StatusCode != 200 || info["url"] != want {
		t.Fatalf("info url: %d %v", res.StatusCode, info)
	}
	// invite pages + open docs name it
	adam := NewPerson(t, c, "Adam")
	room := adam.CreateRoom("ver")
	inv := adam.Invite(room)
	code := inv[strings.LastIndex(inv, "/")+1:]
	for _, accept := range []string{"text/markdown", "text/html"} {
		res, b := get("/i/"+code, map[string]string{"Accept": accept})
		page := string(b)
		if res.StatusCode != 200 || !strings.Contains(page, "npx -y "+want+" join ") || strings.Contains(page, "/dl/botlink.tgz") {
			t.Fatalf("%s invite page lacks the versioned URL: %d %s", accept, res.StatusCode, page)
		}
	}
	for _, doc := range []string{"/agents.md", "/llms.txt"} {
		res, b := get(doc, nil)
		if res.StatusCode != 200 || !strings.Contains(string(b), want) || strings.Contains(string(b), "/dl/botlink.tgz") {
			t.Fatalf("%s lacks the versioned URL: %d", doc, res.StatusCode)
		}
	}

	// a deploy swaps the tarball: everything names the new version at once; the old versioned URL redirects
	_ = os.Remove(cur)
	if err := os.Symlink(r2, cur); err != nil {
		t.Fatal(err)
	}
	want2 := "https://api.localhost/dl/botlink-" + v2 + ".tgz"
	res, b := get("/i/"+code, map[string]string{"Accept": "text/markdown"})
	if res.StatusCode != 200 || !strings.Contains(string(b), "npx -y "+want2+" join ") {
		t.Fatalf("after swap the invite page names %s: %s", want2, b)
	}
	if res, b := get("/agents.md", nil); res.StatusCode != 200 || !strings.Contains(string(b), want2) {
		t.Fatalf("after swap /agents.md lacks %s", want2)
	}
	res, _ = get("/dl/botlink-"+v1+".tgz", nil)
	if res.StatusCode != 302 || res.Header.Get("Location") != "/dl/botlink-"+v2+".tgz" || res.Header.Get("Cache-Control") != "no-store" {
		t.Fatalf("old version: %d %s %s", res.StatusCode, res.Header.Get("Location"), res.Header.Get("Cache-Control"))
	}
	if res, body := get("/dl/botlink-"+v2+".tgz", nil); res.StatusCode != 200 || string(body) != string(two) {
		t.Fatalf("new versioned GET: %d", res.StatusCode)
	}
	// anything else under /dl is 404, never a directory listing
	for _, p := range []string{"/dl/", "/dl/botlink-zz.tgz", "/dl/botlink-" + v2 + ".tgz.bak", "/dl/botlink-" + strings.ToUpper(v2) + ".tgz", "/dl/../index.html"} {
		if res, _ := get(p, nil); res.StatusCode != 404 && res.StatusCode != 301 && res.StatusCode != 307 { // 30x: the mux cleaning the path
			t.Fatalf("%s: %d", p, res.StatusCode)
		}
	}
	if res, _ := get("/dl/botlink-"+v2+".tgz", nil); res.StatusCode != 200 {
		t.Fatal("still served")
	}
	// file gone: 404 everywhere; the pages fall back to the configured URL
	_ = os.Remove(cur)
	if res, _ := get("/dl/botlink-"+v2+".tgz", nil); res.StatusCode != 404 {
		t.Fatalf("missing file, versioned: %d", res.StatusCode)
	}
	if res, b := get("/i/"+code, map[string]string{"Accept": "text/markdown"}); res.StatusCode != 200 || !strings.Contains(string(b), "npx -y https://api.localhost/dl/botlink.tgz join ") {
		t.Fatalf("no tarball: invite page should name the configured URL: %s", b)
	}
}

var noRedirect = &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
