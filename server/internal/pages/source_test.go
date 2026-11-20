package pages

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/charles161/botlink/server/internal/config"
)

// The "Self-host it" link (BOTLINK_SOURCE_URL) appears on the landing page, the docs and the trust page only when the
// setting names the repository, and points exactly at it as a plain external link. Unset: no page links to a repository.
func sourcePages(t *testing.T, source string) *http.ServeMux {
	t.Helper()
	cfg := &config.Config{Env: "dev", AppOrigin: "http://localhost:8811", SourceURL: source}
	p, err := New(cfg, nil)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	p.Routes(mux)
	return mux
}

func get(t *testing.T, mux *http.ServeMux, path string) string {
	t.Helper()
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest("GET", path, nil))
	if rec.Code != 200 {
		t.Fatalf("GET %s: %d", path, rec.Code)
	}
	return rec.Body.String()
}

func TestSourceLinkOff(t *testing.T) {
	mux := sourcePages(t, "")
	for _, path := range []string{"/", "/docs", "/trust.html"} {
		b := get(t, mux, path)
		if strings.Contains(b, "botlink-source-url") || strings.Contains(b, "github.com") || strings.Contains(b, "Self-host it") {
			t.Errorf("GET %s with BOTLINK_SOURCE_URL empty names a repository; there must be no link until the setting is set", path)
		}
	}
}

func TestSourceLinkOn(t *testing.T) {
	const u = "https://github.com/charles161/botlink"
	mux := sourcePages(t, u)
	for _, path := range []string{"/", "/docs"} {
		if b := get(t, mux, path); !strings.Contains(b, `<meta name="botlink-source-url" content="`+u+`">`) {
			t.Errorf("GET %s: no botlink-source-url meta naming %s (pages.go index, sourceMeta in source.go)", path, u)
		}
	}
	b := get(t, mux, "/trust.html")
	if want := `<a href="` + u + `" rel="noopener noreferrer">Self-host it</a>`; !strings.Contains(b, want) {
		t.Errorf("GET /trust.html: want the link %s in its footer (the <!-- source-link --> marker, source.go)", want)
	}
	if strings.Count(b, "github.com") != 1 {
		t.Errorf("GET /trust.html: the repository must appear exactly once (the link), got %d", strings.Count(b, "github.com"))
	}
}
