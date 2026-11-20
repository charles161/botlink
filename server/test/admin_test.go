package test

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/cookiejar"
	"strings"
	"testing"
	"time"

	"github.com/charles161/botlink/server/internal/config"
	"github.com/charles161/botlink/server/internal/testkit"
	"github.com/charles161/botlink/server/internal/wire"
)

// adminRoutes: every admin operation (method, path, body).
var adminRoutes = []struct {
	method, path string
	body         any
}{
	{"GET", "/app/v1/admin/overview", nil},
	{"GET", "/app/v1/admin/status", nil},
	{"POST", "/app/v1/admin/human-check", map[string]any{}},
	{"POST", "/app/v1/admin/unlock", map[string]any{"human_check": map[string]any{"id": "01933b6e-0000-7000-8000-000000000001", "stub": true}}},
	{"POST", "/app/v1/admin/lock", nil},
}

func withAdmins(emails ...string) func(*config.Config) {
	return func(c *config.Config) { c.AdminEmails = emails }
}

// newPersonEmail is NewPerson with a chosen email (admin lists are configured before the copy starts).
func newPersonEmail(t testing.TB, c *Copy, name, email string) *Person {
	t.Helper()
	jar, _ := cookiejar.New(nil)
	p := &Person{t: t, C: c, Client: &http.Client{Jar: jar, Timeout: 30 * time.Second}, Name: name, Email: email, Dev: testkit.NewKey()}
	r := p.Do("POST", "/app/v1/auth/dev-login", map[string]any{"email": email, "display_name": name})
	if r.Status != 200 {
		t.Fatalf("dev-login: %s", r)
	}
	p.CSRF = r.Str("csrf_token")
	p.AccountID = r.J["account"].(map[string]any)["id"].(string)
	p.DevID = wire.NewV7().String()
	if r := p.Do("POST", "/app/v1/devices", map[string]any{"id": p.DevID, "ed25519_pk": p.Dev.Hex(), "label": name + "'s browser"}); r.Status != 201 {
		t.Fatalf("register device: %s", r)
	}
	return p
}

// rawDo sends a request without contract validation (unknown routes aren't in openapi.yaml) and returns status + body.
func rawDo(t testing.TB, client *http.Client, c *Copy, method, path string, body any, csrf string) (int, string) {
	t.Helper()
	req, _ := http.NewRequest(method, c.URL+path, bytes.NewReader(mustJSON(body)))
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if method != "GET" {
		req.Header.Set("Origin", c.URL)
		if csrf != "" {
			req.Header.Set("X-CSRF-Token", csrf)
		}
	}
	res, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	return res.StatusCode, string(b)
}

// unlockAdmin runs the stub human check and unlocks the admin area for p's session.
func unlockAdmin(t *testing.T, p *Person) {
	t.Helper()
	hc := p.Do("POST", "/app/v1/admin/human-check", map[string]any{})
	if hc.Status != 200 || hc.Str("mode") != "stub" {
		t.Fatalf("admin human-check: %s", hc)
	}
	r := p.Do("POST", "/app/v1/admin/unlock", map[string]any{"human_check": map[string]any{"id": hc.Str("id"), "stub": true}})
	if r.Status != 200 || r.Str("unlocked_until") == "" {
		t.Fatalf("unlock: %s", r)
	}
}

// Non-admins (signed in or out) and everyone when the feature is off get exactly the unknown-route answer.
func TestAdminHiddenFromNonAdmins(t *testing.T) {
	db := NewDB(t)
	c := StartCopy(t, db, "A", withAdmins("boss@admin.test"))
	eve := NewPerson(t, c, "Eve")
	if r := eve.Do("GET", "/app/v1/me", nil); r.Status != 200 || r.J["is_admin"] != nil {
		t.Fatalf("non-admin /me must not carry is_admin: %s", r)
	}
	anon := &http.Client{Timeout: 10 * time.Second}
	wantS, want := rawDo(t, eve.Client, c, "GET", "/app/v1/no-such-route", nil, "")
	if wantS != 404 {
		t.Fatalf("unknown route: %d %s", wantS, want)
	}
	anonS, anonBody := rawDo(t, anon, c, "GET", "/app/v1/no-such-route", nil, "")
	for _, rt := range adminRoutes {
		for _, path := range []string{rt.path, rt.path + "/x"} {
			if s, b := rawDo(t, eve.Client, c, rt.method, path, rt.body, eve.CSRF); s != wantS || b != want {
				t.Errorf("non-admin %s %s: %d %s (want %d %s)", rt.method, path, s, b, wantS, want)
			}
			if s, b := rawDo(t, eve.Client, c, rt.method, path, rt.body, ""); s != wantS || b != want {
				t.Errorf("non-admin no csrf %s %s: %d %s", rt.method, path, s, b)
			}
			if s, b := rawDo(t, anon, c, rt.method, path, rt.body, ""); s != anonS || b != anonBody {
				t.Errorf("signed out %s %s: %d %s (want %d %s)", rt.method, path, s, b, anonS, anonBody)
			}
		}
		eve.Do(rt.method, rt.path, rt.body) // contract: the 404 matches openapi.yaml
	}
	// a non-admin's human check can't be for the admin action
	if r := eve.Do("POST", "/app/v1/human-check", map[string]any{"action": "admin"}); r.Status != 400 {
		t.Fatalf("public human-check accepted action admin: %s", r)
	}

	// feature off: even the configured email is nobody
	off := StartCopy(t, db, "OFF")
	boss := newPersonEmail(t, off, "Boss", "boss@admin.test")
	if r := boss.Do("GET", "/app/v1/me", nil); r.J["is_admin"] != nil {
		t.Fatalf("feature off: is_admin on /me: %s", r)
	}
	wantS, want = rawDo(t, boss.Client, off, "GET", "/app/v1/no-such-route", nil, "")
	for _, rt := range adminRoutes {
		if s, b := rawDo(t, boss.Client, off, rt.method, rt.path, rt.body, boss.CSRF); s != wantS || b != want {
			t.Errorf("feature off %s %s: %d %s", rt.method, rt.path, s, b)
		}
	}
}

func TestAdminUnlockFlow(t *testing.T) {
	db := NewDB(t)
	// case-insensitive, trimmed list
	c := StartCopy(t, db, "A", withAdmins(config.ParseEmails(" Other@x.test , BOSS@Admin.test")...))
	boss := newPersonEmail(t, c, "Boss", "boss@admin.test")
	if r := boss.Do("GET", "/app/v1/me", nil); r.J["is_admin"] != true {
		t.Fatalf("admin /me: %s", r)
	}
	// locked until the human check
	if r := boss.Do("GET", "/app/v1/admin/status", nil); r.Status != 200 || r.J["unlocked"] != false || r.J["unlock_minutes"].(float64) != 30 {
		t.Fatalf("status: %s", r)
	}
	r := boss.Do("GET", "/app/v1/admin/overview", nil)
	if r.Status != 403 || r.Code() != "admin_locked" {
		t.Fatalf("locked overview: %s", r)
	}
	// CSRF + Origin on every POST
	for _, rt := range adminRoutes[2:] {
		if s, b := rawDo(t, boss.Client, c, rt.method, rt.path, rt.body, ""); s != 403 || !strings.Contains(b, `"csrf_failed"`) {
			t.Errorf("%s without csrf: %d %s", rt.path, s, b)
		}
	}
	req, _ := http.NewRequest("POST", c.URL+"/app/v1/admin/unlock", strings.NewReader(`{}`))
	req.Header.Set("X-CSRF-Token", boss.CSRF)
	req.Header.Set("Origin", "http://evil.test")
	if res, err := boss.Client.Do(req); err != nil || res.StatusCode != 403 {
		t.Fatalf("wrong origin: %v %v", res, err)
	}
	// a wrong proof doesn't unlock
	hc := boss.Do("POST", "/app/v1/admin/human-check", nil)
	if r := boss.Do("POST", "/app/v1/admin/unlock", map[string]any{"human_check": map[string]any{"id": hc.Str("id"), "stub": false}}); r.Status != 403 || r.Code() != "human_check_failed" {
		t.Fatalf("bad proof: %s", r)
	}
	// an approve's check can't unlock admin
	if r := boss.Do("POST", "/app/v1/admin/unlock", map[string]any{"human_check": map[string]any{"id": boss.Check("webauthn_register", ""), "stub": true}}); r.Status != 403 {
		t.Fatalf("other action's check unlocked admin: %s", r)
	}
	if r := boss.Do("POST", "/app/v1/admin/unlock", map[string]any{"human_check": map[string]any{"id": hc.Str("id"), "stub": true}}); r.Status != 200 {
		t.Fatalf("unlock: %s", r)
	}
	// single use
	if r := boss.Do("POST", "/app/v1/admin/unlock", map[string]any{"human_check": map[string]any{"id": hc.Str("id"), "stub": true}}); r.Status != 403 {
		t.Fatalf("reused check: %s", r)
	}
	if r := boss.Do("GET", "/app/v1/admin/status", nil); r.J["unlocked"] != true || r.Str("unlocked_until") == "" {
		t.Fatalf("status after unlock: %s", r)
	}
	ov := boss.Do("GET", "/app/v1/admin/overview", nil)
	if ov.Status != 200 {
		t.Fatalf("overview: %s", ov)
	}
	for _, k := range []string{"totals", "accounts", "rooms", "members", "copies", "push", "rate_limits", "server", "errors"} {
		if ov.J[k] == nil {
			t.Errorf("overview missing %s", k)
		}
	}
	if srv := ov.J["server"].(map[string]any); srv["copy_id"] != c.ID || srv["ready"] != true || srv["listen_connected"] != true {
		t.Errorf("server: %v", srv)
	}

	// the unlock lives in Postgres: another copy honours it, and a second browser session of the same admin doesn't get it
	c2 := StartCopy(t, db, "B", withAdmins("boss@admin.test"))
	if r := boss.On(c2).Do("GET", "/app/v1/admin/overview", nil); r.Status != 200 || r.J["server"].(map[string]any)["copy_id"] != c2.ID {
		t.Fatalf("copy B overview: %s", r)
	}
	other := newPersonEmail(t, c2, "Boss", "boss@admin.test")
	if r := other.Do("GET", "/app/v1/admin/overview", nil); r.Status != 403 || r.Code() != "admin_locked" {
		t.Fatalf("second session: %s", r)
	}
	// lock on copy B → locked on copy A
	if r := boss.On(c2).Do("POST", "/app/v1/admin/lock", nil); r.Status != 200 {
		t.Fatalf("lock: %s", r)
	}
	if r := boss.Do("GET", "/app/v1/admin/overview", nil); r.Status != 403 || r.Code() != "admin_locked" {
		t.Fatalf("after lock: %s", r)
	}
	// expiry is Postgres time
	unlockAdmin(t, boss)
	exec(t, c, `update web_sessions set admin_until = now() - interval '1 second' where account_id = $1`, boss.AccountID)
	if r := boss.Do("GET", "/app/v1/admin/overview", nil); r.Status != 403 || r.Code() != "admin_locked" {
		t.Fatalf("expired unlock: %s", r)
	}
}

// The overview is metadata only: no message bytes, no push URL/secret, no session ids, no other people's emails.
func TestAdminOverviewMetadataOnly(t *testing.T) {
	db := NewDB(t)
	c := StartCopy(t, db, "A", withAdmins("boss@admin.test"))
	boss := newPersonEmail(t, c, "Boss", "boss@admin.test")
	adam := newPersonEmail(t, c, "Adam", "adam.secret-local@acme.test")
	room := adam.CreateRoom("acme")
	a := adam.Member(c, room, "builder")
	b := adam.Member(c, room, "deployer")
	if _, r := a.Send(c, b); r.Status != 201 && r.Status != 200 {
		t.Fatalf("send: %s", r)
	}
	var env string
	if err := c.Pool.QueryRow(t.Context(), `select envelope from deliveries where member_id = $1`, b.ID).Scan(&env); err != nil {
		t.Fatal(err)
	}
	var envObj map[string]any
	_ = json.Unmarshal([]byte(env), &envObj)
	ct, _ := envObj["ct"].(string)
	if len(ct) < 20 {
		t.Fatalf("envelope ct: %q", env)
	}
	// make b always on with a push URL + secret, and a failed push job whose error text holds the URL
	secret := wire.RandBytes(32)
	pushURL := "https://hooks.example.test/wake?token=QSECRET123"
	exec(t, c, `update members set turn = 'always_on', push_url = $2, push_secret = $3, push_verified_at = now() where id = $1`, b.ID, pushURL, secret)
	var msgID string
	if err := c.Pool.QueryRow(t.Context(), `select message_id from deliveries where member_id = $1`, b.ID).Scan(&msgID); err != nil {
		t.Fatal(err)
	}
	exec(t, c, `insert into push_jobs (member_id, message_id, tries, done, failed, last_error) values ($1, $2, 8, true, true, $3)
		on conflict (member_id, message_id) do update set tries = 8, done = true, failed = true, last_error = $3`,
		b.ID, msgID, `Post "`+pushURL+`": dial tcp: connection refused`)
	// one stuck copy, a session holder, and a quota that hit its limit
	if _, r := b.Send(c, a); r.Status != 201 && r.Status != 200 {
		t.Fatalf("send 2: %s", r)
	}
	exec(t, c, `update deliveries set state = 'stuck', stuck_reason = 'attempts' where member_id = $1`, a.ID)
	exec(t, c, `update members set holder_session = 'sess-holder-XYZ', last_seen_at = now() where id = $1`, a.ID)
	exec(t, c, `insert into rate_counters values ('send:m:`+a.ID+`:1m0s', now(), 35)`)

	unlockAdmin(t, boss)
	ov := boss.Do("GET", "/app/v1/admin/overview", nil)
	if ov.Status != 200 {
		t.Fatalf("overview: %s", ov)
	}
	body := string(ov.Body)
	var holder string
	_ = c.Pool.QueryRow(t.Context(), `select holder_session from members where id = $1`, a.ID).Scan(&holder)
	for what, s := range map[string]string{"ciphertext": ct, "envelope": env, "push url host": "hooks.example.test", "push query": "QSECRET123",
		"push secret": hex.EncodeToString(secret), "holder session": holder, "other email": "adam.secret-local", "adam csrf": adam.CSRF,
		"boss csrf": boss.CSRF, "member key": a.Key.Hex(), "x key": hex.EncodeToString(a.X)} {
		if s != "" && strings.Contains(body, s) {
			t.Errorf("overview leaks %s (%q)", what, s)
		}
	}
	tot := ov.J["totals"].(map[string]any)
	if tot["members"].(float64) != 2 || tot["rooms"].(float64) != 1 || tot["accounts"].(float64) != 2 || tot["messages_24h"].(float64) != 2 {
		t.Errorf("totals: %v", tot)
	}
	var adamRow, bossRow map[string]any
	for _, it := range ov.J["accounts"].(map[string]any)["items"].([]any) {
		m := it.(map[string]any)
		switch m["display_name"] {
		case "Adam":
			adamRow = m
		case "Boss":
			bossRow = m
		}
	}
	if adamRow["email"] != "ad•••@acme.test" || adamRow["rooms"].(float64) != 1 || bossRow["email"] != "boss@admin.test" || bossRow["is_admin"] != true {
		t.Errorf("accounts: %v / %v", adamRow, bossRow)
	}
	copies := ov.J["copies"].(map[string]any)
	if st := copies["total"].(map[string]any); st["stuck"].(float64) != 1 || st["waiting"].(float64) != 1 {
		t.Errorf("copies total: %v", st)
	}
	if pr := copies["per_room"].([]any); len(pr) != 1 || pr[0].(map[string]any)["room_name"] != "acme" {
		t.Errorf("per room: %v", pr)
	}
	if copies["stuck_reasons"].(map[string]any)["attempts"].(float64) != 1 {
		t.Errorf("stuck reasons: %v", copies["stuck_reasons"])
	}
	push := ov.J["push"].(map[string]any)
	if push["failed"].(float64) != 1 || push["always_on_members"].(float64) != 1 {
		t.Errorf("push: %v", push)
	}
	if rf := push["recent_failures"].([]any); len(rf) != 1 || rf[0].(map[string]any)["error_class"] != "refused" {
		t.Errorf("push failures: %v", rf)
	}
	found := false
	for _, it := range ov.J["rate_limits"].([]any) {
		m := it.(map[string]any)
		if m["limit"] == "send:m" {
			found = m["windows_at_limit_24h"].(float64) == 1 && m["turned_away_24h"].(float64) == 5
		}
	}
	if !found {
		t.Errorf("rate limits: %v", ov.J["rate_limits"])
	}
	for _, it := range ov.J["members"].(map[string]any)["items"].([]any) {
		m := it.(map[string]any)
		if m["name"] == "builder" && (m["holder_present"] != true || m["stuck"] != true || m["last_active_at"] == nil) {
			t.Errorf("builder row: %v", m)
		}
		if m["name"] == "deployer" && m["turn_label"] != "always on" {
			t.Errorf("deployer row: %v", m)
		}
	}
}

// 5xx answers land in this copy's ring (route pattern + request id), and quota rejections are counted per copy.
func TestAdminErrorsAndRateLimitMetric(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A", withAdmins("boss@admin.test"))
	boss := newPersonEmail(t, c, "Boss", "boss@admin.test")
	c.S.Errors.Record("POST", "POST /api/v1/messages", 500, "rid-test-1")
	unlockAdmin(t, boss)
	// push the dashboard quota of a throwaway session over its limit once
	eve := NewPerson(t, c, "Eve")
	exec(t, c, `insert into rate_counters select bucket, window_start, 600 from rate_counters where bucket like 'dash:s:%' and count < 600
		on conflict (bucket, window_start) do update set count = 600`)
	if r := eve.Do("GET", "/app/v1/rooms", nil); r.Status != 429 {
		t.Fatalf("expected 429: %s", r)
	}
	exec(t, c, `delete from rate_counters where bucket like 'dash:s:%'`)
	ov := boss.Do("GET", "/app/v1/admin/overview", nil)
	if ov.Status != 200 {
		t.Fatalf("overview: %s", ov)
	}
	errs := ov.J["errors"].(map[string]any)
	items := errs["items"].([]any)
	if errs["scope"] != "this_copy" || len(items) != 1 || items[0].(map[string]any)["request_id"] != "rid-test-1" {
		t.Errorf("errors: %v", errs)
	}
	if v := c.S.M.RateLimited.Value("dash:s"); v < 1 {
		t.Errorf("botlink_rate_limited_total{limit=dash:s} = %d", v)
	}
	for _, it := range ov.J["rate_limits"].([]any) {
		m := it.(map[string]any)
		if m["limit"] == "dash:s" && m["turned_away_this_copy"].(float64) < 1 {
			t.Errorf("dash:s this copy: %v", m)
		}
	}
}
