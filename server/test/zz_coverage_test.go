package test

import (
	"os"
	"strings"
	"testing"
)

// Pages: SPA routes return the dashboard, assets are cacheable, unknown paths 404, invite pages exist.
func TestPagesServing(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A")
	for _, p := range []string{"/", "/login", "/rooms", "/rooms/01933b6e-0000-7000-8000-000000000001", "/new", "/p/ABCDEFGHJKLMNPQR", "/devices", "/docs", "/help/lost-passkey"} {
		r := doRaw(t, mustReq("GET", c.URL+p))
		if r.Status != 200 || !strings.HasPrefix(r.Header.Get("Content-Type"), "text/html") || !strings.Contains(string(r.Body), "<html") {
			t.Errorf("GET %s: %d %s", p, r.Status, r.Header.Get("Content-Type"))
		}
		if (p == "/") != (r.Header.Get("X-Robots-Tag") == "") {
			t.Errorf("GET %s: X-Robots-Tag %q", p, r.Header.Get("X-Robots-Tag"))
		}
	}
	if _, err := os.Stat("../../web/public/assets/app.css"); err == nil {
		r := doRaw(t, mustReq("GET", c.URL+"/assets/app.css"))
		if r.Status != 200 || r.Header.Get("Cache-Control") != "public, max-age=300" {
			t.Errorf("app.css: %d %s", r.Status, r.Header.Get("Cache-Control"))
		}
	}
	for _, p := range []string{"/nope", "/assets/nope.js", "/assets/../index.html", "/.gitkeep"} {
		if r := doRaw(t, mustReq("GET", c.URL+p)); r.Status != 404 {
			t.Errorf("GET %s: %d", p, r.Status)
		}
	}
	for _, p := range []string{"/agents.md", "/llms.txt", "/envelope.md", "/api/openapi.yaml", "/healthz", "/readyz"} {
		if r := doRaw(t, mustReq("GET", c.URL+p)); r.Status != 200 {
			t.Errorf("GET %s: %d", p, r.Status)
		}
	}
}

func TestSmallAppRoutes(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A")
	adam := NewPerson(t, c, "Adam")
	room := adam.CreateRoom("small")
	if r := adam.Do("PATCH", "/app/v1/rooms/"+room.ID, map[string]any{"purpose": "new purpose"}); r.Status != 200 {
		t.Fatal(r)
	}
	adam.Do("POST", "/app/v1/rooms/"+room.ID+"/person-invites", map[string]any{"id": newID()})
	if r := adam.Do("GET", "/app/v1/rooms/"+room.ID+"/person-invites", nil); r.Status != 200 || len(r.J["invites"].([]any)) != 1 {
		t.Fatal(r)
	}
	a := adam.Member(c, room, "asker")
	a.Do(c, "POST", "/api/v1/me/ask-human", map[string]any{"reason": "cannot_wake"})
	att := adam.Do("GET", "/app/v1/needs-you", nil).J["attention"].([]any)
	if len(att) != 1 || att[0].(map[string]any)["kind"] != "cannot_wake" {
		t.Fatal(att)
	}
	if r := adam.Do("POST", "/app/v1/attention/"+att[0].(map[string]any)["id"].(string)+"/dismiss", nil); r.Status != 200 {
		t.Fatal(r)
	}
	if r := adam.Do("POST", "/app/v1/auth/logout", nil); r.Status != 200 {
		t.Fatal(r)
	}
	if r := adam.Do("GET", "/app/v1/me", nil); r.Status != 401 {
		t.Fatal(r)
	}
}
