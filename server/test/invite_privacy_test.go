package test

import (
	"io"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"testing"
)

// Hotfix: an invite link can leak (forwarded, logged, pasted), so anyone holding it must not learn who is in
// the room. Unauthenticated invite views show the room name, a member count, the expiry and how to join; nothing about
// the inviter, the members or the purpose. Invalid invites (unknown, expired, turned off) all look the same.

// leakWords are the per-room details that must not reach someone who only holds the link.
var leakWords = []string{"Adamsecret", "Purposesecret", "membersecret", "test job for"}

func assertNoLeak(t *testing.T, what, body string) {
	t.Helper()
	for _, w := range leakWords {
		if strings.Contains(body, w) {
			t.Errorf("%s discloses %q:\n%s", what, w, body)
		}
	}
}

func getWith(t *testing.T, url, accept string) (int, http.Header, string) {
	t.Helper()
	req, _ := http.NewRequest("GET", url, nil)
	if accept != "" {
		req.Header.Set("Accept", accept)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	return res.StatusCode, res.Header, string(b)
}

func TestChatInviteDisclosesNoRoster(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A")
	adam := NewPerson(t, c, "Adamsecret Inviter")
	room := adam.CreateRoom("acme")
	exec(t, c, `update rooms set purpose = 'Purposesecret launch plan' where id = $1`, room.ID)
	adam.Member(c, room, "membersecret")
	inv := adam.Invite(room)
	code := inv[strings.LastIndex(inv, "/")+1:]

	// agent JSON preview: room name, member count, expiry; nothing else
	r := doRaw(t, mustReq("GET", c.URL+"/api/v1/invites/"+code))
	if r.Status != 200 {
		t.Fatalf("preview: %s", r)
	}
	assertNoLeak(t, "GET /api/v1/invites", string(r.Body))
	var keys []string
	for k := range r.J {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	if strings.Join(keys, ",") != "expires_at,member_count,room" {
		t.Errorf("preview fields %v, want only room, member_count, expires_at", keys)
	}
	if rm, _ := r.J["room"].(map[string]any); len(rm) != 1 || rm["name"] != "acme" {
		t.Errorf("preview room %v, want only the name", r.J["room"])
	}
	if r.J["member_count"] != float64(1) {
		t.Errorf("member_count %v", r.J["member_count"])
	}
	if cc := r.Header.Get("Cache-Control"); cc != "no-store" {
		t.Errorf("preview Cache-Control %q", cc)
	}

	// invite page, HTML and Markdown
	meta := regexp.MustCompile(`(?i)<meta[^>]+(og:|twitter:|name="description")`)
	for _, accept := range []string{"text/html", "text/markdown"} {
		st, h, body := getWith(t, c.URL+"/i/"+code, accept)
		if st != 200 {
			t.Fatalf("%s page: %d %s", accept, st, body)
		}
		assertNoLeak(t, accept+" invite page", body)
		for _, want := range []string{"acme", "1 AI chat in this room", "invited one of their AI chats", "join " + inv, "works until"} {
			if !strings.Contains(body, want) {
				t.Errorf("%s page lacks %q:\n%s", accept, want, body)
			}
		}
		if h.Get("Cache-Control") != "no-store" || h.Get("X-Robots-Tag") != "noindex" {
			t.Errorf("%s page headers: Cache-Control %q X-Robots-Tag %q", accept, h.Get("Cache-Control"), h.Get("X-Robots-Tag"))
		}
		if accept == "text/html" {
			if meta.MatchString(body) {
				t.Errorf("html invite page carries preview meta tags:\n%s", body)
			}
			if !strings.Contains(body, `<meta name="robots" content="noindex`) {
				t.Errorf("html invite page lacks robots noindex meta:\n%s", body)
			}
		}
	}

	// invalid invites: unknown, turned off, expired, room gone → identical responses, no room details
	type view struct {
		status       int
		ctype, cache string
		body         string
	}
	look := func(path string) map[string]view {
		out := map[string]view{}
		for _, accept := range []string{"text/html", "text/markdown", ""} {
			url := c.URL + "/i/" + path
			if accept == "" {
				url = c.URL + "/api/v1/invites/" + path
			}
			st, h, body := getWith(t, url, accept)
			assertNoLeak(t, "invalid invite "+url, body)
			if strings.Contains(body, "acme") {
				t.Errorf("invalid invite %s echoes the room name:\n%s", url, body)
			}
			out[accept] = view{st, h.Get("Content-Type"), h.Get("Cache-Control"), body}
		}
		return out
	}
	unknown := look("acme-ZZZZZZZZZZ")
	if unknown["text/html"].status != 404 || unknown["text/html"].cache != "no-store" || unknown[""].cache != "no-store" {
		t.Errorf("unknown invite: %+v", unknown)
	}
	same := func(name string, got map[string]view) {
		t.Helper()
		for k, v := range unknown {
			if got[k] != v {
				t.Errorf("%s invite (%q) differs from an unknown one:\n got  %+v\n want %+v", name, k, got[k], v)
			}
		}
	}
	exec(t, c, `update invites set off = true where code = $1`, code[strings.LastIndex(code, "-")+1:])
	same("turned-off", look(code))
	exec(t, c, `update invites set off = false, expires_at = now() - interval '1 second' where code = $1`, code[strings.LastIndex(code, "-")+1:])
	same("expired", look(code))
}

func TestPersonInviteDisclosesNoRosterBeforeApproval(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A")
	adam := NewPerson(t, c, "Adam")
	room := adam.CreateRoom("lumen")
	adam.Member(c, room, "membersecret")
	pi := adam.Do("POST", "/app/v1/rooms/"+room.ID+"/person-invites", map[string]any{"id": newID()})
	if pi.Status != 201 {
		t.Fatal(pi)
	}
	code := pi.Str("url")[strings.LastIndex(pi.Str("url"), "/")+1:]

	// signed out: the page is the static dashboard shell, nothing about the room
	st, h, body := getWith(t, c.URL+"/p/"+code, "text/html")
	if st != 200 {
		t.Fatalf("/p page: %d", st)
	}
	for _, w := range []string{"lumen", "Adam", "membersecret"} {
		if strings.Contains(body, w) {
			t.Errorf("signed-out /p page discloses %q", w)
		}
	}
	if h.Get("Cache-Control") != "no-store" || h.Get("X-Robots-Tag") != "noindex" {
		t.Errorf("/p headers: Cache-Control %q X-Robots-Tag %q", h.Get("Cache-Control"), h.Get("X-Robots-Tag"))
	}
	if r := doRaw(t, mustReq("GET", c.URL+"/app/v1/person-invites/"+code)); r.Status != 401 {
		t.Errorf("signed-out preview: %s", r)
	}

	// signed in, not yet approved: who invited you and how many chats, but no member names
	priya := NewPerson(t, c, "Priya")
	r := priya.Do("GET", "/app/v1/person-invites/"+code, nil)
	if r.Status != 200 || r.J["owner_name"] != "Adam" {
		t.Fatal(r)
	}
	if _, ok := r.J["member_names"]; ok || strings.Contains(string(r.Body), "membersecret") {
		t.Errorf("person invite preview discloses member names: %s", r)
	}
	if rm, _ := r.J["room"].(map[string]any); rm["member_count"] != float64(1) {
		t.Errorf("person invite preview member_count: %s", r)
	}
	if r.Header.Get("Cache-Control") != "no-store" {
		t.Errorf("person invite preview Cache-Control %q", r.Header.Get("Cache-Control"))
	}
}
