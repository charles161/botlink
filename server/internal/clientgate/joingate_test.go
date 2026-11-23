package clientgate

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestParseAndCompareVersion(t *testing.T) {
	for _, c := range []struct {
		a, b string
		want int
	}{
		{"1.0.0", "1.0.1", -1},
		{"1.0.1", "1.0.1", 0},
		{"1.0.10", "1.0.9", 1},
		{"1.0.0-dev", "1.0.0", -1},
		{"1.0.0-dev", "1.0.1", -1},
		{"2.0.0", "1.99.99", 1},
		{"1.0.0-alpha.2", "1.0.0-alpha.10", -1},
		{"1.0.0-alpha", "1.0.0-alpha.1", -1},
		{"1.0.0-1", "1.0.0-alpha", -1},
		{"v1.2.3", "1.2.3", 0},
		{"1.2.3+build.5", "1.2.3", 0},
	} {
		a, ok1 := ParseVersion(c.a)
		b, ok2 := ParseVersion(c.b)
		if !ok1 || !ok2 {
			t.Fatalf("parse %q %q: %v %v", c.a, c.b, ok1, ok2)
		}
		if got := Compare(a, b); got != c.want {
			t.Errorf("Compare(%s, %s) = %d, want %d", c.a, c.b, got, c.want)
		}
	}
	for _, bad := range []string{"", "1", "1.0", "1.0.0.0", "01.0.0", "latest", "1.0.0-", "x.y.z", "1.0.0-" + strings.Repeat("a", 41)} {
		if _, ok := ParseVersion(bad); ok {
			t.Errorf("ParseVersion(%q) accepted", bad)
		}
	}
}

// writeVersioned: a published client with this version in its signed manifest
func writeVersioned(t *testing.T, version string) string {
	t.Helper()
	dir := t.TempDir()
	p := writeRelease(t, dir, 3)
	doc := `{"manifest":"{\"v\":1,\"name\":\"botlink\",\"version\":\"` + version + `\",\"counter\":3}","sig":"x","key":"y"}`
	if err := os.WriteFile(filepath.Join(dir, "botlink.manifest.json"), []byte(doc), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestNewJoinGate(t *testing.T) {
	tgz := writeVersioned(t, "1.0.1")
	if g, err := NewJoinGate("", false, tgz); err != nil || g.min != nil {
		t.Fatalf("empty = off: %v %v", g, err)
	}
	for _, bad := range []string{"1", "latest", "1.0", "v"} {
		if _, err := NewJoinGate(bad, false, tgz); err == nil || !strings.Contains(err.Error(), "BOTLINK_MIN_JOIN_CLIENT_VERSION") {
			t.Errorf("%q: %v", bad, err)
		}
	}
	// above the newest published client: nobody could ever join
	if _, err := NewJoinGate("1.0.2", false, tgz); err == nil || !strings.Contains(err.Error(), "above the newest published client (1.0.1") {
		t.Errorf("above published: %v", err)
	}
	if g, err := NewJoinGate(" 1.0.1 ", false, tgz); err != nil || g.min == nil || g.min.String() != "1.0.1" {
		t.Errorf("equal to published: %v %v", g, err)
	}
	// nothing published to read: a warning, the gate still starts
	if g, err := NewJoinGate("1.0.1", false, ""); err != nil || g.min == nil {
		t.Errorf("unreadable published: %v %v", g, err)
	}
}

var cur101 = Current{Version: "1.0.1", URL: "https://api.botlink.dev/dl/botlink-0123456789abcdef.tgz", Release: 5}

func hdr(kv ...string) http.Header {
	h := http.Header{}
	for i := 0; i+1 < len(kv); i += 2 {
		h.Set(kv[i], kv[i+1])
	}
	return h
}

// Only a join, a room started by a chat and a member moved to a chat are refused; never reading, sending, waiting,
// leaving or a join's wait.
func TestJoinGateOutdated(t *testing.T) {
	min := Version{1, 0, 1, ""}
	gMin := &JoinGate{min: &min}
	gMinDev := &JoinGate{min: &min, dev: true}
	gOff := &JoinGate{}
	gated := []string{"POST /api/v1/join-requests", "POST /api/v1/room-drafts", "POST /api/v1/me/claim"}
	open := []string{"POST /api/v1/messages", "POST /api/v1/me/inbox/lease", "POST /api/v1/me/inbox/ack", "GET /api/v1/me", "DELETE /api/v1/me",
		"POST /api/v1/join-requests/x/wait", "POST /api/v1/me/wait", "GET /api/v1/me/roster", "GET /api/v1/invites/X", "PUT /api/v1/me/card"}
	old := hdr(VersionHeader, "1.0.0")
	for _, p := range gated {
		for _, c := range []struct {
			g    *JoinGate
			h    http.Header
			want bool
			why  string
		}{
			{gMin, old, true, "below_minimum"},
			{gMin, hdr(VersionHeader, "1.0.0-dev"), true, "below_minimum"},
			{gMin, hdr(), true, "no_version"},
			{gMin, hdr(VersionHeader, "garbage"), true, "no_version"},
			{gMinDev, hdr(), false, ""},
			{gMinDev, old, true, "below_minimum"},
			{gMin, hdr(VersionHeader, "1.0.1"), false, ""},
			{gMin, hdr(VersionHeader, "1.0.2"), false, ""},
			{gOff, old, false, ""},
			{gOff, hdr(), false, ""},
			// a client from 1.0.1 asks to be refused when it is behind the served client
			{gOff, hdr(VersionHeader, "1.0.1", StaleHeader, "refuse"), false, ""},
			{gOff, hdr(VersionHeader, "1.0.0", StaleHeader, "refuse"), true, "behind_current"},
			{gOff, hdr(VersionHeader, "1.0.2", StaleHeader, "refuse"), false, ""},
			{gOff, hdr(StaleHeader, "refuse"), false, ""},
		} {
			got, why := c.g.Outdated(p, c.h, cur101)
			if got != c.want || why != c.why {
				t.Errorf("%s %v (min %v dev %v): %v %q, want %v %q", p, c.h, c.g.min, c.g.dev, got, why, c.want, c.why)
			}
		}
	}
	for _, p := range open {
		if got, _ := gMin.Outdated(p, hdr(), cur101); got {
			t.Errorf("%s refused for an old client: reading, sending and waiting must keep working", p)
		}
		if got, _ := gOff.Outdated(p, hdr(VersionHeader, "1.0.0", StaleHeader, "refuse"), cur101); got {
			t.Errorf("%s refused for a behind client", p)
		}
	}
	// nothing served: a behind client can't be told apart; a minimum still applies
	if got, _ := gOff.Outdated(gated[0], hdr(VersionHeader, "1.0.0", StaleHeader, "refuse"), Current{}); got {
		t.Error("no served client: refused")
	}
	var nilGate *JoinGate
	if got, _ := nilGate.Outdated(gated[0], old, cur101); got {
		t.Error("nil gate refused")
	}
}

// What an old client shows its model: the exact command, not to retry, within the 240 characters it quotes.
func TestOutdatedText(t *testing.T) {
	msg := OutdatedText("1.0.0", cur101)
	want := "This bot-link client (1.0.0) is out of date. Run exactly: npx -y --allow-remote=all https://api.botlink.dev/dl/botlink-0123456789abcdef.tgz <the same command and arguments>. Do not retry the old command: it runs the old copy again."
	if msg != want {
		t.Fatalf("got  %q\nwant %q", msg, want)
	}
	long := OutdatedText("1.0.0-"+strings.Repeat("a", 40), Current{URL: "https://api.botlink.dev/dl/botlink-0123456789abcdef.tgz"})
	// npm 12 (21 Nov 2026): the flag made a 20-character version too long; the version gives way, the command stays whole
	widest := OutdatedText("10000.10000.10000-ab", cur101)
	if !strings.Contains(widest, "Run exactly: npx -y --allow-remote=all "+cur101.URL+" <the same command and arguments>.") {
		t.Errorf("the command is not whole: %q", widest)
	}
	for _, m := range []string{msg, long, widest, OutdatedText("", Current{}), OutdatedText("<script>", cur101), OutdatedText("1.0.0", Current{URL: "http://127.0.0.1:57400/dl/botlink-0123456789abcdef.tgz"})} {
		if len(m) > 240 {
			t.Errorf("%d characters (older clients quote 240): %q", len(m), m)
		}
		if strings.Contains(m, "<script>") {
			t.Errorf("the client's own header is echoed: %q", m)
		}
	}
	// words older clients refuse to show (client core.ts FORBIDDEN_COPY)
	for _, w := range []string{"receipt", "seen", "answered", "webhook", "delivered", "lease", "envelope", "chatgpt"} {
		if strings.Contains(strings.ToLower(msg), w) {
			t.Errorf("message has %q, which older clients replace with a bare code", w)
		}
	}
}

func TestJoinGateWrap(t *testing.T) {
	calls := 0
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls++; w.WriteHeader(200) })
	min := Version{1, 0, 1, ""}
	h := (&JoinGate{min: &min}).WithCurrent(func() Current { return cur101 }).Wrap(next)
	do := func(method, path, version string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, path, strings.NewReader("{}"))
		if version != "" {
			req.Header.Set(VersionHeader, version)
		}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec
	}
	rec := do("POST", "/api/v1/join-requests", "1.0.0")
	if rec.Code != 409 || !strings.Contains(rec.Body.String(), `"code":"client_outdated"`) || !strings.Contains(rec.Body.String(), "npx -y --allow-remote=all https://api.botlink.dev/dl/botlink-0123456789abcdef.tgz") || calls != 0 {
		t.Fatalf("old join: %d %s (next called %d)", rec.Code, rec.Body, calls)
	}
	for _, r := range []*httptest.ResponseRecorder{rec, do("GET", "/api/v1/me", "1.0.0"), do("POST", "/api/v1/messages", "")} {
		if r.Header().Get(CurrentHeader) != "1.0.1" || r.Header().Get(CurrentURLHeader) != cur101.URL || r.Header().Get(CurrentReleaseHeader) != "5" {
			t.Errorf("headers: %v", r.Header())
		}
	}
	if calls != 2 {
		t.Errorf("reading and sending reached the API %d times, want 2", calls)
	}
	// no client served: no headers
	h2 := (&JoinGate{}).WithCurrent(nil).Wrap(next)
	rec2 := httptest.NewRecorder()
	h2.ServeHTTP(rec2, httptest.NewRequest("GET", "/api/v1/me", nil))
	if rec2.Header().Get(CurrentHeader) != "" {
		t.Errorf("header without a served client: %v", rec2.Header())
	}
}

func TestCached(t *testing.T) {
	n := 0
	f := Cached(50*time.Millisecond, func() Current { n++; return cur101 })
	f()
	f()
	if n != 1 {
		t.Fatalf("called %d times within the ttl", n)
	}
	time.Sleep(60 * time.Millisecond)
	f()
	if n != 2 {
		t.Fatalf("called %d times after the ttl", n)
	}
}
