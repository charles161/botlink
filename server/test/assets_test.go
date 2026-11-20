package test

import (
	"io"
	"net/http"
	"regexp"
	"strings"
	"testing"
)

// Launch plan #5: a dashboard fix must not wait for a cache (Cloudflare kept /assets/app.css for 4 h). The HTML pages
// are no-cache and name the stylesheet and scripts under /assets/v/<version>/…, a version derived from the assets'
// bytes; those URLs are immutable for a year. Relative module imports resolve under the same prefix. An unknown
// version still serves the current file, no-cache (a page from before a deploy keeps working).
func TestVersionedAssets(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A")
	get := func(path string, hdr ...string) (*http.Response, string) {
		req, _ := http.NewRequest("GET", c.URL+path, nil)
		for i := 0; i+1 < len(hdr); i += 2 {
			req.Header.Set(hdr[i], hdr[i+1])
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		b, _ := io.ReadAll(res.Body)
		return res, string(b)
	}
	res, html := get("/")
	if res.StatusCode != 200 || res.Header.Get("Cache-Control") != "no-cache" {
		t.Fatalf("/: %d %s", res.StatusCode, res.Header.Get("Cache-Control"))
	}
	m := regexp.MustCompile(`href="/assets/v/([0-9a-f]{12})/app\.css"`).FindStringSubmatch(html)
	if m == nil {
		t.Fatalf("index.html names no versioned app.css:\n%s", html)
	}
	ver := m[1]
	for _, want := range []string{`src="/assets/v/` + ver + `/js/app.js"`, `src="/assets/v/` + ver + `/js/theme-boot.js"`} {
		if !strings.Contains(html, want) {
			t.Fatalf("index.html lacks %s", want)
		}
	}
	if strings.Contains(html, `"/assets/app.css"`) || strings.Contains(html, `"/assets/js/`) {
		t.Fatal("index.html still names an unversioned stylesheet or script")
	}
	for _, p := range []string{"/rooms", "/login", "/docs"} {
		if res, b := get(p); res.Header.Get("Cache-Control") != "no-cache" || !strings.Contains(b, "/assets/v/"+ver+"/app.css") {
			t.Fatalf("%s: %s", p, res.Header.Get("Cache-Control"))
		}
	}
	_, plainCSS := get("/assets/app.css")
	for _, p := range []string{"/assets/v/" + ver + "/app.css", "/assets/v/" + ver + "/js/app.js", "/assets/v/" + ver + "/js/views/rooms.js", "/assets/v/" + ver + "/fonts/fonts.css"} {
		res, b := get(p)
		if res.StatusCode != 200 || res.Header.Get("Cache-Control") != "public, max-age=31536000, immutable" {
			t.Fatalf("%s: %d %q", p, res.StatusCode, res.Header.Get("Cache-Control"))
		}
		if p == "/assets/v/"+ver+"/app.css" && (b != plainCSS || !strings.HasPrefix(res.Header.Get("Content-Type"), "text/css")) {
			t.Fatalf("versioned app.css differs from /assets/app.css or has type %q", res.Header.Get("Content-Type"))
		}
		if strings.HasSuffix(p, ".js") && !strings.Contains(res.Header.Get("Content-Type"), "javascript") {
			t.Fatalf("%s type %q", p, res.Header.Get("Content-Type"))
		}
	}
	// an older (or unknown) version: the current bytes, not cached
	other := "000000000000"
	if other == ver {
		other = "111111111111"
	}
	if res, b := get("/assets/v/" + other + "/app.css"); res.StatusCode != 200 || res.Header.Get("Cache-Control") != "no-cache" || b != plainCSS {
		t.Fatalf("old version: %d %q", res.StatusCode, res.Header.Get("Cache-Control"))
	}
	for _, p := range []string{"/assets/v/" + ver + "/nope.js", "/assets/v/" + ver + "/", "/assets/v/zz/app.css", "/assets/v/" + ver + "/.gitkeep", "/assets/v/" + ver + "/%2e%2e/index.html"} {
		if res, _ := get(p); res.StatusCode != 404 {
			t.Fatalf("%s: %d", p, res.StatusCode)
		}
	}
	// the server-rendered invite page links the versioned stylesheet too
	adam := NewPerson(t, c, "Adam")
	room := adam.CreateRoom("assets")
	inv := adam.Invite(room)
	code := inv[strings.LastIndex(inv, "/")+1:]
	if res, b := get("/i/"+code, "Accept", "text/html"); res.StatusCode != 200 || !strings.Contains(b, `href="/assets/v/`+ver+`/app.css"`) {
		t.Fatalf("invite page stylesheet: %d %s", res.StatusCode, b)
	}
	if res, b := get("/i/nope-ABCDEFGH", "Accept", "text/html"); res.StatusCode != 404 || !strings.Contains(b, `href="/assets/v/`+ver+`/app.css"`) {
		t.Fatalf("invite 404 page stylesheet: %d %s", res.StatusCode, b)
	}
}
