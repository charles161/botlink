package test

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/charles161/botlink/server/internal/clientgate"
	"github.com/charles161/botlink/server/internal/config"
	"github.com/charles161/botlink/server/internal/wire"
)

// a published client of this version: botlink.tgz + the signed manifest next to it; returns the path and the
// tarball's sha256 (its versioned URL is /dl/botlink-<first 16 hex>.tgz)
func publishVersion(t *testing.T, version string, counter int) (string, string) {
	t.Helper()
	dir := t.TempDir()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	pj := []byte(`{"name":"botlink","version":"` + version + `"}`)
	_ = tw.WriteHeader(&tar.Header{Name: "package/package.json", Mode: 0o644, Size: int64(len(pj))})
	_, _ = tw.Write(pj)
	_ = tw.Close()
	_ = gz.Close()
	tgz := filepath.Join(dir, "botlink.tgz")
	if err := os.WriteFile(tgz, buf.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
	text, _ := json.Marshal(map[string]any{"v": 1, "name": "botlink", "version": version, "counter": counter})
	doc, _ := json.Marshal(map[string]any{"manifest": string(text), "sig": "AAAA", "key": "k"})
	if err := os.WriteFile(filepath.Join(dir, "botlink.manifest.json"), doc, 0o644); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(buf.Bytes())
	return tgz, hex.EncodeToString(sum[:])
}

// joinWith: a join request with the client headers an npx copy sends (headers are not part of the signature)
func joinWith(t *testing.T, c *Copy, a *Agent, invite string, h map[string]string) *Resp {
	t.Helper()
	return joinFrom(t, c, a, invite, "~/Documents/Default Project", h)
}

func joinFrom(t *testing.T, c *Copy, a *Agent, invite, folder string, h map[string]string) *Resp {
	t.Helper()
	a.ReqID = wire.NewV7().String()
	req := a.Req(c, "POST", "/api/v1/join-requests", map[string]any{"id": a.ReqID, "kind": "join", "invite": invite, "name": a.Name,
		"job": "job", "app": "other", "app_name": "OpenCode", "machine": "Charless-MacBook-Air.local", "folder": folder, "turn": "on_turn",
		"ed25519_pk": a.Key.Hex(), "x25519_pk": hex.EncodeToString(a.X)}, nil)
	for k, v := range h {
		req.Header.Set(k, v)
	}
	return doRaw(t, req)
}

func doWith(t *testing.T, c *Copy, a *Agent, method, path string, body any, h map[string]string) *Resp {
	t.Helper()
	req := a.Req(c, method, path, body, nil)
	for k, v := range h {
		req.Header.Set(k, v)
	}
	return doRaw(t, req)
}

// Incident 21 Nov 2026: the founder's OpenCode ran last release's client (1.0.0) from npx's cache, asked to join
// #neon as deepseek with the old code (no session), and nothing told the chat or its human the client was old.
// With BOTLINK_MIN_JOIN_CLIENT_VERSION=1.0.1 that join is refused with the exact command and nothing is created;
// the old client keeps reading and sending as a member.
func TestOutdatedClientCannotJoinButKeepsMessaging(t *testing.T) {
	t.Setenv("BOTLINK_MIN_JOIN_CLIENT_VERSION", " 1.0.1 ")
	if lc, err := config.FromEnv(); err != nil || lc.MinJoinClientVersion != "1.0.1" {
		t.Fatalf("config: %q %v", lc.MinJoinClientVersion, err)
	}
	db := NewDB(t)
	tgz, sha := publishVersion(t, "1.0.1", 5)
	c := StartCopy(t, db, "A", func(cfg *config.Config) {
		cfg.Env = "staging"
		cfg.ClientTGZ = tgz
		cfg.MinJoinClientVersion = "1.0.1"
	})
	url := c.URL + "/dl/botlink-" + sha[:16] + ".tgz"
	adam := NewPerson(t, c, "Adam")
	room := adam.CreateRoom("neon")
	inv := adam.Invite(room)

	old := map[string]string{clientgate.VersionHeader: "1.0.0"}
	for _, h := range []map[string]string{old, {}, {clientgate.VersionHeader: "1.0.0-dev"}} {
		r := joinWith(t, c, NewAgentKeys(t, "deepseek"), inv, h)
		if r.Status != 409 || r.Code() != "client_outdated" {
			t.Fatalf("old client %v: %s", h, r)
		}
		msg := r.J["error"].(map[string]any)["message"].(string)
		if !strings.Contains(msg, "Run exactly: npx -y --allow-remote=all "+url+" <the same command and arguments>") || !strings.Contains(msg, "Do not retry the old command") || len(msg) > 240 {
			t.Fatalf("message: %q", msg)
		}
		if d := details(r); d["current_version"] != "1.0.1" || d["url"] != url || d["min_version"] != "1.0.1" {
			t.Fatalf("details: %v", d)
		}
		if r.Header.Get(clientgate.CurrentHeader) != "1.0.1" || r.Header.Get(clientgate.CurrentURLHeader) != url || r.Header.Get(clientgate.CurrentReleaseHeader) != "5" {
			t.Fatalf("headers: %v", r.Header)
		}
	}
	if n := count(t, c, `select count(*) from join_requests`); n != 0 {
		t.Fatalf("%d join requests from refused clients", n)
	}

	// the current client joins; then, as a member, an old copy of it reads and sends: never refused for its age
	cur := map[string]string{clientgate.VersionHeader: "1.0.1", clientgate.StaleHeader: "refuse"}
	a := NewAgentKeys(t, "deepseek")
	if r := joinWith(t, c, a, inv, cur); r.Status != 201 {
		t.Fatalf("current client: %s", r)
	}
	if r := adam.Approve(room, a); r.Status != 200 {
		t.Fatalf("approve: %s", r)
	}
	b := NewAgentKeys(t, "other")
	if r := joinFrom(t, c, b, inv, "~/other", cur); r.Status != 201 {
		t.Fatalf("second member: %s", r)
	}
	if r := adam.Approve(room, b); r.Status != 200 {
		t.Fatalf("approve: %s", r)
	}
	if r := doWith(t, c, a, "GET", "/api/v1/me", nil, old); r.Status != 200 {
		t.Fatalf("old client reading: %s", r)
	}
	if r := doWith(t, c, a, "POST", "/api/v1/me/inbox/lease", map[string]any{"wait_s": 0}, old); r.Status != 200 {
		t.Fatalf("old client lease: %s", r)
	}
	id := wire.NewV7().String()
	if r := doWith(t, c, a, "POST", "/api/v1/messages", a.SendBody(id, false, []*Agent{b}, nil), old); r.Status >= 300 {
		t.Fatalf("old client sending: %s", r)
	}
	// moving the member to another chat with the old client: refused like a join
	if r := doWith(t, c, a, "POST", "/api/v1/me/claim", map[string]any{"session_id": "sess-new"}, old); r.Code() != "client_outdated" {
		t.Fatalf("old client claim: %s", r)
	}
}

// From 1.0.1 on a client asks to be refused when it is behind the client the server hands out (no setting needed):
// a cached 1.0.1 against a server that hands out 1.0.2 can't join; 1.0.2 can; reading is never refused.
func TestBehindClientAsksToBeRefused(t *testing.T) {
	db := NewDB(t)
	tgz, sha := publishVersion(t, "1.0.2", 6)
	c := StartCopy(t, db, "A", func(cfg *config.Config) { cfg.Env = "staging"; cfg.ClientTGZ = tgz })
	adam := NewPerson(t, c, "Adam")
	room := adam.CreateRoom("neon")
	inv := adam.Invite(room)
	r := joinWith(t, c, NewAgentKeys(t, "deepseek"), inv, map[string]string{clientgate.VersionHeader: "1.0.1", clientgate.StaleHeader: "refuse"})
	if r.Status != 409 || r.Code() != "client_outdated" || details(r)["reason"] != "behind_current" || details(r)["url"] != c.URL+"/dl/botlink-"+sha[:16]+".tgz" {
		t.Fatalf("behind client: %s", r)
	}
	// a client from before 1.0.1 does not ask: without a minimum it is not refused (the setting is for those)
	if r := joinFrom(t, c, NewAgentKeys(t, "old"), inv, "~/old", map[string]string{clientgate.VersionHeader: "1.0.0"}); r.Status != 201 {
		t.Fatalf("old client, no minimum: %s", r)
	}
	if r := joinFrom(t, c, NewAgentKeys(t, "fresh"), inv, "~/fresh", map[string]string{clientgate.VersionHeader: "1.0.2", clientgate.StaleHeader: "refuse"}); r.Status != 201 {
		t.Fatalf("current client: %s", r)
	}
	inv2 := doRaw(t, mustReq("GET", c.URL+"/api/v1/invites/"+inv[strings.LastIndex(inv, "-")+1:]))
	if inv2.Header.Get(clientgate.CurrentHeader) != "1.0.2" {
		t.Fatalf("invite preview headers: %v", inv2.Header)
	}
}
