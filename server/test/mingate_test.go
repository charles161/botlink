package test

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/charles161/botlink/server/internal/clientgate"
	"github.com/charles161/botlink/server/internal/config"
	"github.com/charles161/botlink/server/internal/server"
)

// a published client release: botlink.tgz + the signed manifest next to it, which carries the release number
func publishClient(t *testing.T, counter int) string {
	t.Helper()
	dir := t.TempDir()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	pj := []byte(`{"name":"botlink","version":"1.0.0-dev"}`)
	_ = tw.WriteHeader(&tar.Header{Name: "package/package.json", Mode: 0o644, Size: int64(len(pj))})
	_, _ = tw.Write(pj)
	_ = tw.Close()
	_ = gz.Close()
	tgz := filepath.Join(dir, "botlink.tgz")
	if err := os.WriteFile(tgz, buf.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
	text, _ := json.Marshal(map[string]any{"v": 1, "name": "botlink", "version": "1.0.0-dev", "counter": counter})
	doc, _ := json.Marshal(map[string]any{"manifest": string(text), "sig": "AAAA", "key": "k"})
	if err := os.WriteFile(filepath.Join(dir, "botlink.manifest.json"), doc, 0o644); err != nil {
		t.Fatal(err)
	}
	return tgz
}

// Minimum client release (SPEC §7.6): off by default; when set, the agent API answers a client whose installed
// release number is below it 426 client_too_old. Outside dev, a client that sends no release number (a client from
// before the header, a checkout, an npm install) is refused too; on a dev server it passes. The download, the signed
// manifest and the health checks stay open (a too-old client must always be able to update); a minimum above the
// newest published release stops the server at start.
func TestMinimumClientRelease(t *testing.T) {
	t.Setenv("BOTLINK_MIN_CLIENT_RELEASE", " 7 ")
	if lc, err := config.FromEnv(); err != nil || lc.MinClientRelease != "7" {
		t.Fatalf("config: %q %v", lc.MinClientRelease, err)
	}

	db := NewDB(t)
	tgz := publishClient(t, 9)
	c := StartCopy(t, db, "A", func(cfg *config.Config) {
		cfg.Env = "staging"
		cfg.ClientTGZ = tgz
		cfg.MinClientRelease = "7"
	})
	for _, p := range []string{"/readyz", "/healthz", "/dl/botlink.manifest.json", "/dl/botlink.tgz", "/api/v1/health"} {
		if r := doRaw(t, mustReq("GET", c.URL+p)); r.Status != 200 {
			t.Errorf("GET %s without a client release: %d, want 200 (never behind the minimum)", p, r.Status)
		}
	}
	// no release number (outside dev), and a release below the minimum
	for _, v := range []string{"", "6", "1.0.0"} {
		req := mustReq("GET", c.URL+"/api/v1/me")
		if v != "" {
			req.Header.Set(clientgate.Header, v)
		}
		req.Header.Set(clientgate.VersionHeader, "1.0.0-dev")
		r := doRaw(t, req)
		if r.Status != 426 || r.J["error"].(map[string]any)["code"] != "client_too_old" {
			t.Fatalf("release %q: %d %s", v, r.Status, r.Body)
		}
		if msg := r.J["error"].(map[string]any)["message"].(string); !strings.Contains(msg, "botlink update") || !strings.Contains(msg, "release 7") {
			t.Fatalf("message: %q", msg)
		}
	}
	// at or above the minimum: the call reaches the API (unsigned here, so 401 from the API itself)
	for _, v := range []string{"7", "9"} {
		req := mustReq("GET", c.URL+"/api/v1/me")
		req.Header.Set(clientgate.Header, v)
		if r := doRaw(t, req); r.Status == 426 {
			t.Fatalf("release %s refused: %s", v, r.Body)
		}
	}

	// a dev server with a minimum: a development build (no release number) is not locked out; a numbered old one is
	dev := StartCopy(t, db, "D", func(cfg *config.Config) {
		cfg.ClientTGZ = tgz
		cfg.MinClientRelease = "7"
	})
	if r := doRaw(t, mustReq("GET", dev.URL+"/api/v1/me")); r.Status == 426 {
		t.Fatalf("dev server, no release number: %d", r.Status)
	}
	old := mustReq("GET", dev.URL+"/api/v1/me")
	old.Header.Set(clientgate.Header, "3")
	if r := doRaw(t, old); r.Status != 426 {
		t.Fatalf("dev server, release 3 below 7: %d", r.Status)
	}

	// off by default: a copy with no minimum lets a client without the header through
	off := StartCopy(t, db, "B", func(cfg *config.Config) { cfg.Env = "staging"; cfg.ClientTGZ = tgz })
	if r := doRaw(t, mustReq("GET", off.URL+"/api/v1/me")); r.Status == 426 {
		t.Fatalf("no minimum set: %d", r.Status)
	}

	// a minimum above the newest published release, or one that is not a release number: the server does not start
	for _, min := range []string{"10", "1.2.0"} {
		cfg := &config.Config{
			Env: "dev", Addr: "127.0.0.1:0", CopyID: "mingate-" + min, DatabaseURL: db, ListenURL: db,
			AppOrigin: "http://127.0.0.1:1", DevLogin: true, HumanCheck: "stub", TurnstileVerifyURL: "http://127.0.0.1:1/unused",
			WebAuthnRPID: "localhost", WebAuthnOrigin: "http://127.0.0.1:1", DisableSweeper: true,
			ClientTGZ: tgz, MinClientRelease: min,
		}
		s, err := server.New(context.Background(), cfg)
		if err == nil {
			s.Close()
			t.Fatalf("min %s: the server started", min)
		}
		if !strings.Contains(err.Error(), "BOTLINK_MIN_CLIENT_RELEASE") {
			t.Fatalf("min %s: %v", min, err)
		}
	}
}
