package pages

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/charles161/botlink/server/internal/config"
)

// The GitHub star count behind the header's GitHub link (github_stars.go): fetched only by the server, from a
// constant API host, for the repository BOTLINK_SOURCE_URL names; cached; never on the request path; shown from 50.

// fakeGitHub answers every request with h and counts them. It listens on 127.0.0.1 (httptest).
type fakeGitHub struct {
	srv  *httptest.Server
	hits atomic.Int64
	mu   sync.Mutex
	last *http.Request
}

func newFakeGitHub(t *testing.T, h http.HandlerFunc) *fakeGitHub {
	t.Helper()
	f := &fakeGitHub{}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.hits.Add(1)
		f.mu.Lock()
		f.last = r.Clone(r.Context())
		f.mu.Unlock()
		h(w, r)
	}))
	t.Cleanup(f.srv.Close)
	if !strings.HasPrefix(f.srv.URL, "http://127.0.0.1:") {
		t.Fatalf("fake GitHub must listen on 127.0.0.1, got %s", f.srv.URL)
	}
	return f
}

func starsJSON(n int) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"id":1,"full_name":"charles161/botlink","stargazers_count":%d,"forks_count":3}`, n)
	}
}

// testStars points the fetcher at the fake, with a clock the test moves.
type clock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *clock) now() time.Time      { c.mu.Lock(); defer c.mu.Unlock(); return c.t }
func (c *clock) add(d time.Duration) { c.mu.Lock(); c.t = c.t.Add(d); c.mu.Unlock() }

func testStars(t *testing.T, f *fakeGitHub) (*Stars, *clock) {
	t.Helper()
	s := newStars(f.srv.URL, "https://github.com/charles161/botlink")
	if s == nil {
		t.Fatal("newStars refused a GitHub repository URL")
	}
	c := &clock{t: time.Date(2026, 11, 21, 12, 0, 0, 0, time.UTC)}
	s.now = c.now
	s.timeout = 300 * time.Millisecond
	return s, c
}

func askStars(t *testing.T, s *Stars, path string) (string, http.Header) {
	t.Helper()
	mux := http.NewServeMux()
	s.Routes(mux)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", path, nil)
	req.Header.Set("Cookie", "botlink_session=secret")
	req.Header.Set("Authorization", "Bearer browser-token")
	mux.ServeHTTP(rec, req)
	if rec.Code != 200 {
		t.Fatalf("GET %s: %d %s", path, rec.Code, rec.Body)
	}
	return rec.Body.String(), rec.Header()
}

// first request: no count yet (the fetch runs in the background), then the cached value
func settled(t *testing.T, s *Stars) string {
	t.Helper()
	first, _ := askStars(t, s, "/site/github.json")
	if first != "{}" {
		t.Fatalf("first request answered %q before any fetch finished, want {} (never fetched on the request path)", first)
	}
	s.wg.Wait()
	b, _ := askStars(t, s, "/site/github.json")
	return b
}

func TestStarsThreshold(t *testing.T) {
	for _, tc := range []struct {
		n    int
		want string
	}{{0, "{}"}, {49, "{}"}, {50, `{"stars":50}`}, {1234, `{"stars":1234}`}} {
		f := newFakeGitHub(t, starsJSON(tc.n))
		s, _ := testStars(t, f)
		if got := settled(t, s); got != tc.want {
			t.Errorf("%d stars: got %s, want %s", tc.n, got, tc.want)
		}
	}
}

func TestStarsHeadersAndRequest(t *testing.T) {
	f := newFakeGitHub(t, starsJSON(120))
	s, _ := testStars(t, f)
	askStars(t, s, "/site/github.json?repo=evil/evil&url=http://169.254.169.254/&host=evil.example")
	s.wg.Wait()
	b, hd := askStars(t, s, "/site/github.json?repo=evil/evil")
	if b != `{"stars":120}` {
		t.Fatalf("body %s", b)
	}
	if hd.Get("Content-Type") != "application/json" || hd.Get("Cache-Control") != "public, max-age=300" {
		t.Errorf("headers: Content-Type %q, Cache-Control %q", hd.Get("Content-Type"), hd.Get("Cache-Control"))
	}
	f.mu.Lock()
	r := f.last
	f.mu.Unlock()
	if r.URL.Path != "/repos/charles161/botlink" || r.URL.RawQuery != "" || r.Method != "GET" {
		t.Errorf("fetched %s %s?%s, want GET /repos/charles161/botlink with no query (no request parameter reaches the URL)", r.Method, r.URL.Path, r.URL.RawQuery)
	}
	if r.Header.Get("User-Agent") != "bot-link" {
		t.Errorf("User-Agent %q, want bot-link", r.Header.Get("User-Agent"))
	}
	if r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" {
		t.Errorf("sent Authorization %q / Cookie %q to GitHub, want neither", r.Header.Get("Authorization"), r.Header.Get("Cookie"))
	}
}

// Every failure answers {} and is cached: many requests during an outage cost one fetch per failure window.
func TestStarsFailures(t *testing.T) {
	cases := map[string]http.HandlerFunc{
		"500": func(w http.ResponseWriter, _ *http.Request) { http.Error(w, "boom", 500) },
		"403 rate limit": func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("X-RateLimit-Remaining", "0")
			w.WriteHeader(403)
			fmt.Fprint(w, `{"message":"API rate limit exceeded","stargazers_count":999}`)
		},
		"garbage":      func(w http.ResponseWriter, _ *http.Request) { fmt.Fprint(w, "<html>not json") },
		"no field":     func(w http.ResponseWriter, _ *http.Request) { fmt.Fprint(w, `{"full_name":"x"}`) },
		"negative":     func(w http.ResponseWriter, _ *http.Request) { fmt.Fprint(w, `{"stargazers_count":-5}`) },
		"string count": func(w http.ResponseWriter, _ *http.Request) { fmt.Fprint(w, `{"stargazers_count":"999"}`) },
		"redirect":     func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, "/elsewhere", http.StatusFound) },
		"oversize body": func(w http.ResponseWriter, _ *http.Request) {
			fmt.Fprintf(w, `{"stargazers_count":999,"pad":"%s"}`, strings.Repeat("x", 70<<10))
		},
		"slow": func(w http.ResponseWriter, r *http.Request) {
			select {
			case <-time.After(3 * time.Second):
			case <-r.Context().Done():
			}
			starsJSON(999)(w, r)
		},
	}
	for name, h := range cases {
		t.Run(name, func(t *testing.T) {
			f := newFakeGitHub(t, h)
			s, c := testStars(t, f)
			start := time.Now()
			if got := settled(t, s); got != "{}" {
				t.Fatalf("got %s, want {}", got)
			}
			if el := time.Since(start); el > 2*time.Second {
				t.Errorf("took %s: the timeout did not cut the fetch", el)
			}
			for i := 0; i < 200; i++ {
				if b, _ := askStars(t, s, "/site/github.json"); b != "{}" {
					t.Fatalf("request %d: %s", i, b)
				}
			}
			c.add(9 * time.Minute)
			askStars(t, s, "/site/github.json")
			s.wg.Wait()
			if n := f.hits.Load(); n != 1 {
				t.Fatalf("%d fetches within the failure window, want 1 (no retry storm)", n)
			}
			c.add(2 * time.Minute)
			askStars(t, s, "/site/github.json")
			s.wg.Wait()
			if n := f.hits.Load(); n != 2 {
				t.Fatalf("%d fetches after the failure window, want 2 (one retry)", n)
			}
		})
	}
}

// A good value is kept for an hour: one fetch for any number of requests, then one background refresh.
func TestStarsOneFetchPerHour(t *testing.T) {
	var stars atomic.Int64
	stars.Store(100)
	f := newFakeGitHub(t, func(w http.ResponseWriter, r *http.Request) { starsJSON(int(stars.Load()))(w, r) })
	s, c := testStars(t, f)
	if got := settled(t, s); got != `{"stars":100}` {
		t.Fatalf("got %s", got)
	}
	for i := 0; i < 1000; i++ {
		askStars(t, s, "/site/github.json")
	}
	c.add(59 * time.Minute)
	askStars(t, s, "/site/github.json")
	s.wg.Wait()
	if n := f.hits.Load(); n != 1 {
		t.Fatalf("%d fetches within the hour, want 1", n)
	}
	stars.Store(2000)
	c.add(2 * time.Minute)
	if b, _ := askStars(t, s, "/site/github.json"); b != `{"stars":100}` {
		t.Fatalf("after the hour the request should answer the cached value at once, got %s", b)
	}
	s.wg.Wait()
	if b, _ := askStars(t, s, "/site/github.json"); b != `{"stars":2000}` {
		t.Fatalf("after the refresh: %s", b)
	}
	if n := f.hits.Load(); n != 2 {
		t.Fatalf("%d fetches, want 2", n)
	}
}

// Many requests at once while a fetch is out: one fetch (single flight), and none of them waits for it.
func TestStarsSingleFlight(t *testing.T) {
	release := make(chan struct{})
	f := newFakeGitHub(t, func(w http.ResponseWriter, r *http.Request) { <-release; starsJSON(500)(w, r) })
	s, _ := testStars(t, f)
	s.timeout = 5 * time.Second
	var wg sync.WaitGroup
	start := time.Now()
	for i := 0; i < 100; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if b, _ := askStars(t, s, "/site/github.json"); b != "{}" {
				t.Errorf("got %s while the fetch is out", b)
			}
		}()
	}
	wg.Wait()
	if el := time.Since(start); el > time.Second {
		t.Errorf("requests waited %s for the fetch", el)
	}
	close(release)
	s.wg.Wait()
	if n := f.hits.Load(); n != 1 {
		t.Fatalf("%d fetches, want 1", n)
	}
}

func TestStarsRepoFromSourceURL(t *testing.T) {
	ok := map[string]string{
		"https://github.com/charles161/botlink":   "/repos/charles161/botlink",
		"https://github.com/a/b.c-d_e":            "/repos/a/b.c-d_e",
		"https://github.com/Some-Org/repo.github": "/repos/Some-Org/repo.github",
	}
	for in, want := range ok {
		if got, good := githubRepoPath(in); !good || got != want {
			t.Errorf("%q: got %q %v, want %q", in, got, good, want)
		}
	}
	for _, in := range []string{
		"", "http://github.com/a/b", "https://gitlab.com/a/b", "https://github.com/a", "https://github.com/a/b/c",
		"https://github.com/a/b?x=1", "https://github.com/a/b#x", "https://github.com/a/b/", "https://api.github.com/a/b",
		"https://github.com.evil.example/a/b", "https://user@github.com/a/b", "https://github.com:443/a/b",
		"https://github.com/a/..", "https://github.com/a/.", "https://github.com/-a/b", "https://github.com/a/b%2f..",
		"https://GITHUB.com/a/b", " https://github.com/a/b", "https://github.com/a/b\n",
	} {
		if got, good := githubRepoPath(in); good {
			t.Errorf("%q accepted as %q, want refused", in, got)
		}
		if newStars("http://127.0.0.1:1", in) != nil {
			t.Errorf("newStars(%q) enabled a fetch, want nil", in)
		}
	}
}

// Off unless configured: dev never fetches (tests point newStars at a fake instead), no source URL never fetches,
// and staging/prod fetch only from the constant API host. Off still answers {}.
func TestStarsConfig(t *testing.T) {
	src := "https://github.com/charles161/botlink"
	for _, cfg := range []*config.Config{nil, {Env: "dev", SourceURL: src}, {Env: "prod"}, {Env: "staging"}} {
		s := NewStars(cfg)
		if s.api != "" {
			t.Errorf("%+v: fetch enabled (api %q), want off", cfg, s.api)
		}
		if b, _ := askStars(t, s, "/site/github.json"); b != "{}" {
			t.Errorf("off: %s", b)
		}
		s.wg.Wait()
	}
	for _, env := range []string{"prod", "staging"} {
		s := NewStars(&config.Config{Env: env, SourceURL: src})
		if s.api != "https://api.github.com" || s.path != "/repos/charles161/botlink" {
			t.Errorf("%s: api %q path %q", env, s.api, s.path)
		}
		if s.timeout != 3*time.Second {
			t.Errorf("%s: timeout %s, want 3s", env, s.timeout)
		}
	}
}
