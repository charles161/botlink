package clientgate

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestParseRelease(t *testing.T) {
	for _, c := range []struct {
		in   string
		want int64
		ok   bool
	}{
		{"1", 1, true},
		{"42", 42, true},
		{" 7 ", 7, true},
		{"", 0, false},
		{"0", 0, false},
		{"-3", 0, false},
		{"+3", 0, false},
		{"1.0.0", 0, false},
		{"1.0.0-dev", 0, false},
		{"07", 0, false},
		{"12345678901234567890", 0, false},
		{"latest", 0, false},
	} {
		n, ok := ParseRelease(c.in)
		if ok != c.ok || n != c.want {
			t.Errorf("ParseRelease(%q) = %d %v, want %d %v", c.in, n, ok, c.want, c.ok)
		}
	}
}

// a client tarball as npm pack writes it, optionally with the signed manifest (and its release number) next to it
func writeRelease(t *testing.T, dir string, counter int) string {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	pj := []byte(`{"name":"botlink","version":"1.0.0-dev"}`)
	_ = tw.WriteHeader(&tar.Header{Name: "package/package.json", Mode: 0o644, Size: int64(len(pj))})
	_, _ = tw.Write(pj)
	_ = tw.Close()
	_ = gz.Close()
	p := filepath.Join(dir, "botlink.tgz")
	if err := os.WriteFile(p, buf.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
	if counter > 0 {
		text, _ := json.Marshal(map[string]any{"v": 1, "name": "botlink", "version": "1.0.0-dev", "counter": counter})
		doc, _ := json.Marshal(map[string]any{"manifest": string(text), "sig": "x", "key": "y"})
		if err := os.WriteFile(filepath.Join(dir, "botlink.manifest.json"), doc, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return p
}

func TestNewestRelease(t *testing.T) {
	dir := t.TempDir()
	p := writeRelease(t, dir, 0)
	if _, _, err := NewestRelease(p); err == nil {
		t.Fatal("a tarball with no signed manifest has no release number: want an error")
	}
	p = writeRelease(t, dir, 12)
	if n, src, err := NewestRelease(p); err != nil || n != 12 || !strings.Contains(src, "manifest") {
		t.Fatalf("manifest: %d %q %v", n, src, err)
	}
	if _, _, err := NewestRelease(""); err == nil {
		t.Fatal("no tarball configured: want an error")
	}
	if _, _, err := NewestRelease(filepath.Join(t.TempDir(), "missing.tgz")); err == nil {
		t.Fatal("missing tarball: want an error")
	}
}

func TestNewRefusesBadOrUnreachableMinimum(t *testing.T) {
	tgz := writeRelease(t, t.TempDir(), 12)
	for _, off := range []string{"", "   ", "0"} {
		if g, err := New(off, false, tgz); err != nil || g.On() {
			t.Fatalf("%q is off: %v %v", off, g, err)
		}
	}
	for _, bad := range []string{"1.2.0", "-3", "twelve", "07"} {
		if _, err := New(bad, false, tgz); err == nil || !strings.Contains(err.Error(), "BOTLINK_MIN_CLIENT_RELEASE") {
			t.Fatalf("bad value %q: want a start error naming the setting, got %v", bad, err)
		}
	}
	// above the newest published release: no client could ever be let in or update to one that is
	_, err := New("13", false, tgz)
	if err == nil || !strings.Contains(err.Error(), "newest published client") || !strings.Contains(err.Error(), "12") {
		t.Fatalf("min above newest: want a start error, got %v", err)
	}
	if g, err := New("12", false, tgz); err != nil || !g.On() {
		t.Fatalf("min equal to newest: %v", err)
	}
	if g, err := New("3", false, tgz); err != nil || !g.On() {
		t.Fatalf("min below newest: %v", err)
	}
	// no release number to compare with (no tarball, or one with no signed manifest): allowed, with a loud warning
	if g, err := New("12", false, ""); err != nil || !g.On() {
		t.Fatalf("unknown newest: %v", err)
	}
	if g, err := New("12", false, writeRelease(t, t.TempDir(), 0)); err != nil || !g.On() {
		t.Fatalf("unsigned tarball: %v", err)
	}
}

func TestGate(t *testing.T) {
	tgz := writeRelease(t, t.TempDir(), 12)
	ok := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) })
	call := func(h http.Handler, path, release string) *httptest.ResponseRecorder {
		req := httptest.NewRequest("GET", path, nil)
		if release != "" {
			req.Header.Set(Header, release)
		}
		req.Header.Set(VersionHeader, "1.0.0-dev")
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec
	}

	off, _ := New("", false, tgz)
	if rec := call(off.Wrap(ok), "/api/v1/me", ""); rec.Code != 204 {
		t.Fatalf("off: a client that sends no release passes, got %d", rec.Code)
	}

	for _, env := range []struct {
		name string
		dev  bool
	}{{"prod", false}, {"dev", true}} {
		g, err := New("5", env.dev, tgz)
		if err != nil {
			t.Fatal(err)
		}
		h := g.Wrap(ok)
		noNumber := 426 // prod: no release number is never taken for a new client
		if env.dev {
			noNumber = 204 // a development build (no release number) is not locked out of a dev server
		}
		for _, c := range []struct {
			path, release string
			want          int
		}{
			{"/api/v1/me", "", noNumber},        // a client from before the header, a checkout, an npm install
			{"/api/v1/me", "garbage", noNumber}, // unreadable: no number
			{"/api/v1/me", "4", 426},            // a numbered release below the minimum: refused everywhere
			{"/api/v1/me", "5", 204},            // equal
			{"/api/v1/me", "12", 204},           // above
			{"/api/v1/join-requests", "1", 426},
			{"/api/v1/health", "", 204}, // exempt: a health probe is not a client
		} {
			rec := call(h, c.path, c.release)
			if rec.Code != c.want {
				t.Errorf("%s: %s with release %q: %d, want %d", env.name, c.path, c.release, rec.Code, c.want)
				continue
			}
			if rec.Code != 426 {
				continue
			}
			var body struct {
				Error struct {
					Code    string         `json:"code"`
					Message string         `json:"message"`
					Details map[string]any `json:"details"`
				} `json:"error"`
			}
			if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
				t.Fatalf("426 body: %v %s", err, rec.Body.String())
			}
			if body.Error.Code != "client_too_old" || body.Error.Details["min_release"] != float64(5) {
				t.Errorf("426 body: %s", rec.Body.String())
			}
			// an old client shows this sentence as it is: plain, names the minimum and the command that fixes it
			m := body.Error.Message
			if !strings.Contains(m, "too old") || !strings.Contains(m, "release 5") || !strings.Contains(m, "botlink update") || strings.Contains(m, "—") {
				t.Errorf("message: %q", m)
			}
			if rec.Header().Get("Retry-After") != "" {
				t.Errorf("426 must not invite a retry")
			}
		}
	}
}
