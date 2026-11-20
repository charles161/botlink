package pages

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

// The client lane's signed releases: the client checks GET /dl/botlink.manifest.json, a file signed offline and
// written next to the tarball (deploy/release-sign.mjs). Served byte for byte, no-cache, 404 when absent; the
// tarball's real path decides "next to" (a `current` symlink follows deploys), like deploy/lib/dl-server.py.
func TestManifestServedByteForByte(t *testing.T) {
	dir := t.TempDir()
	rel := filepath.Join(dir, "releases", "r1")
	if err := os.MkdirAll(rel, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(rel, "botlink.tgz"), []byte("tgz"), 0o644); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "botlink.tgz")
	if err := os.Symlink(filepath.Join(rel, "botlink.tgz"), link); err != nil {
		t.Fatal(err)
	}
	h := NewClientFile(link).Manifest()
	get := func(method string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest(method, "/dl/botlink.manifest.json", nil))
		return w
	}
	if w := get("GET"); w.Code != 404 {
		t.Fatalf("no manifest: %d", w.Code)
	}
	body := "{\"manifest\":\"{\\\"v\\\":1}\",\"sig\":\"AAAA\",\"key\":\"k1\"}\n"
	if err := os.WriteFile(filepath.Join(rel, "botlink.manifest.json"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	w := get("GET")
	if w.Code != 200 || w.Body.String() != body || w.Header().Get("Content-Type") != "application/json" || w.Header().Get("Cache-Control") != "no-cache" {
		t.Fatalf("manifest: %d %q %v", w.Code, w.Body.String(), w.Header())
	}
	if w := get("HEAD"); w.Code != 200 || w.Body.Len() != 0 {
		t.Fatalf("HEAD: %d %d", w.Code, w.Body.Len())
	}
	if w := get("POST"); w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST: %d", w.Code)
	}
}
