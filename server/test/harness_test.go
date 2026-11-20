// Integration tests: real Postgres (private dev cluster), real server copies (in-process httptest
// servers, each with its own pool and LISTEN connection), real signed HTTP. Every response is validated
// against api/openapi.yaml (contract test).
package test

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/getkin/kin-openapi/openapi3"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	apispec "github.com/charles161/botlink/api"
	"github.com/charles161/botlink/server/internal/config"
	"github.com/charles161/botlink/server/internal/faults"
	"github.com/charles161/botlink/server/internal/migrate"
	"github.com/charles161/botlink/server/internal/roster"
	"github.com/charles161/botlink/server/internal/server"
	"github.com/charles161/botlink/server/internal/testkit"
	"github.com/charles161/botlink/server/internal/wire"
)

// ── database per test (template copy)

var (
	clusterURL string // postgres://botlink@127.0.0.1:55432
	tmplName   string
	dbSeq      atomic.Int64
)

func TestMain(m *testing.M) {
	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: logLevel()})))
	u := os.Getenv("BOTLINK_TEST_DATABASE_URL")
	if u == "" {
		u = "postgres://botlink@127.0.0.1:55432/botlink_test_server"
	}
	clusterURL = u[:strings.LastIndex(u, "/")]
	tmplName = fmt.Sprintf("bltmpl_%d", os.Getpid())
	if err := makeTemplate(); err != nil {
		fmt.Fprintln(os.Stderr, "test template:", err)
		os.Exit(1)
	}
	code := m.Run()
	adminExec(fmt.Sprintf("drop database if exists %s with (force)", tmplName))
	os.Exit(code)
}

func adminExec(sql string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	c, err := pgx.Connect(ctx, clusterURL+"/postgres")
	if err != nil {
		return err
	}
	defer c.Close(ctx)
	_, err = c.Exec(ctx, sql)
	return err
}

func makeTemplate() error {
	_ = adminExec(fmt.Sprintf("drop database if exists %s with (force)", tmplName))
	if err := adminExec("create database " + tmplName); err != nil {
		return err
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, clusterURL+"/"+tmplName)
	if err != nil {
		return err
	}
	defer pool.Close()
	_, err = migrate.Up(ctx, pool)
	return err
}

// NewDB returns the URL of a fresh, migrated database dropped at the end of the test.
func NewDB(t testing.TB) string {
	name := fmt.Sprintf("bltest_%d_%d", os.Getpid(), dbSeq.Add(1))
	if err := adminExec(fmt.Sprintf("create database %s template %s", name, tmplName)); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = adminExec(fmt.Sprintf("drop database if exists %s with (force)", name)) })
	return clusterURL + "/" + name
}

// ── server copies

type Copy struct {
	t    testing.TB
	S    *server.Server // nil for a separate process (two-copy process mode)
	Pool *pgxpool.Pool
	TS   *httptest.Server
	URL  string
	Host string
	ID   string
}

var copySeq atomic.Int64

func StartCopy(t testing.TB, dbURL, id string, mods ...func(*config.Config)) *Copy {
	t.Helper()
	ts := httptest.NewUnstartedServer(nil)
	origin := "http://" + ts.Listener.Addr().String()
	cfg := &config.Config{
		Env: "dev", Addr: ts.Listener.Addr().String(),
		CopyID:      fmt.Sprintf("%s-%d-%d", id, os.Getpid(), copySeq.Add(1)),
		DatabaseURL: dbURL, ListenURL: dbURL, AppOrigin: origin, DevLogin: true, HumanCheck: "stub",
		TurnstileVerifyURL: "http://127.0.0.1:1/unused", WebAuthnRPID: "localhost", WebAuthnOrigin: origin,
		DisableSweeper: true, ClientURL: origin + "/dl/botlink.tgz",
	}
	for _, m := range mods {
		m(cfg)
	}
	ctx := context.Background()
	s, err := server.New(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	ts.Config.Handler = s.Handler
	ts.Start()
	s.Start(ctx)
	wctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := s.WaitReady(wctx); err != nil {
		t.Fatal(err)
	}
	c := &Copy{t: t, S: s, Pool: s.Pool, TS: ts, URL: origin, Host: ts.Listener.Addr().String(), ID: cfg.CopyID}
	t.Cleanup(func() {
		ts.CloseClientConnections()
		ts.Close()
		s.Close()
	})
	return c
}

// ── contract validation (every response checked against api/openapi.yaml)

type route struct {
	re     *regexp.Regexp
	path   string
	method string
	op     *openapi3.Operation
}

var (
	specOnce   sync.Once
	spec       *openapi3.T
	routes     []route
	contractMu sync.Mutex
	checked    = map[string]int{}
)

func loadSpec(t testing.TB) {
	specOnce.Do(func() {
		l := openapi3.NewLoader()
		doc, err := l.LoadFromData(apispec.OpenAPI)
		if err != nil {
			panic(err)
		}
		if err := doc.Validate(context.Background()); err != nil {
			panic(err)
		}
		spec = doc
		for p, item := range doc.Paths.Map() {
			re := regexp.MustCompile("^" + regexp.MustCompile(`\\\{[^}]+\\\}`).ReplaceAllString(regexp.QuoteMeta(p), `[^/]+`) + "$")
			for m, op := range item.Operations() {
				routes = append(routes, route{re: re, path: p, method: m, op: op})
			}
		}
	})
}

// validateResponse checks status + body against the spec. Undeclared ≥ 400 statuses use Error.
func validateResponse(t testing.TB, method, path string, status int, ctype string, body []byte) {
	t.Helper()
	loadSpec(t)
	path, _, _ = strings.Cut(path, "?")
	var rt *route
	for i := range routes {
		if routes[i].method == method && routes[i].re.MatchString(path) {
			if rt == nil || len(routes[i].path) > len(rt.path) {
				rt = &routes[i]
			}
		}
	}
	if rt == nil {
		if path == "/api/v1/health" || !(strings.HasPrefix(path, "/api/") || strings.HasPrefix(path, "/app/")) {
			return // pages and assets aren't API operations
		}
		t.Errorf("contract: %s %s is not in openapi.yaml", method, path)
		return
	}
	contractMu.Lock()
	checked[rt.method+" "+rt.path]++
	contractMu.Unlock()
	resp := rt.op.Responses.Value(strconv.Itoa(status))
	var schema *openapi3.Schema
	if resp == nil {
		if status >= 400 {
			schema = spec.Components.Schemas["Error"].Value
		} else {
			t.Errorf("contract: %s %s returned undeclared status %d: %s", method, rt.path, status, trunc(body))
			return
		}
	} else if mt := resp.Value.Content.Get("application/json"); mt != nil && mt.Schema != nil {
		schema = mt.Schema.Value
	} else if status >= 400 && strings.HasPrefix(ctype, "application/json") {
		schema = spec.Components.Schemas["Error"].Value
	}
	if schema == nil || !strings.HasPrefix(ctype, "application/json") {
		return
	}
	var v any
	if err := json.Unmarshal(body, &v); err != nil {
		t.Errorf("contract: %s %s %d: body is not JSON: %s", method, rt.path, status, trunc(body))
		return
	}
	if err := schema.VisitJSON(v, openapi3.EnableJSONSchema2020(), openapi3.MultiErrors()); err != nil {
		t.Errorf("contract: %s %s %d: %v\nbody: %s", method, rt.path, status, err, trunc(body))
	}
}

func trunc(b []byte) string {
	if len(b) > 600 {
		return string(b[:600]) + "…"
	}
	return string(b)
}

// Resp is a decoded response.
type Resp struct {
	Status int
	Body   []byte
	J      map[string]any
	Header http.Header
}

func (r *Resp) Code() string {
	if e, ok := r.J["error"].(map[string]any); ok {
		s, _ := e["code"].(string)
		return s
	}
	return ""
}

func (r *Resp) Str(k string) string { s, _ := r.J[k].(string); return s }

func (r *Resp) String() string { return fmt.Sprintf("%d %s", r.Status, trunc(r.Body)) }

var httpClient = &http.Client{Timeout: 70 * time.Second}

func doRaw(t testing.TB, req *http.Request) *Resp {
	t.Helper()
	res, err := httpClient.Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", req.Method, req.URL, err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	r := &Resp{Status: res.StatusCode, Body: b, Header: res.Header}
	if strings.HasPrefix(res.Header.Get("Content-Type"), "application/json") {
		_ = json.Unmarshal(b, &r.J)
	}
	validateResponse(t, req.Method, req.URL.RequestURI(), res.StatusCode, res.Header.Get("Content-Type"), b)
	return r
}

func mustJSON(v any) []byte {
	if v == nil {
		return nil
	}
	if b, ok := v.([]byte); ok {
		return b
	}
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return b
}

// ── people (browser)

type Person struct {
	t         testing.TB
	C         *Copy
	Client    *http.Client
	CSRF      string
	AccountID string
	Name      string
	Email     string
	Dev       testkit.Key
	DevID     string
}

func NewPerson(t testing.TB, c *Copy, name string) *Person {
	t.Helper()
	jar, _ := cookiejar.New(nil)
	p := &Person{t: t, C: c, Client: &http.Client{Jar: jar, Timeout: 30 * time.Second}, Name: name,
		Email: strings.ToLower(strings.ReplaceAll(name, " ", ".")) + fmt.Sprintf("+%d@example.com", copySeq.Add(1)), Dev: testkit.NewKey()}
	r := p.Do("POST", "/app/v1/auth/dev-login", map[string]any{"email": p.Email, "display_name": name})
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

// On returns a view of this person talking to another copy (same cookie, that copy's origin).
func (p *Person) On(c *Copy) *Person {
	q := *p
	q.C = c
	jar, _ := cookiejar.New(nil)
	for _, ck := range p.Client.Jar.Cookies(mustURL(p.C.URL)) {
		jar.SetCookies(mustURL(c.URL), []*http.Cookie{ck})
	}
	q.Client = &http.Client{Jar: jar, Timeout: 30 * time.Second}
	return &q
}

func (p *Person) Do(method, path string, body any) *Resp {
	p.t.Helper()
	req, _ := http.NewRequest(method, p.C.URL+path, bytes.NewReader(mustJSON(body)))
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if method != "GET" {
		req.Header.Set("Origin", p.C.URL)
		req.Header.Set("X-CSRF-Token", p.CSRF)
	}
	res, err := p.Client.Do(req)
	if err != nil {
		p.t.Fatalf("%s %s: %v", method, path, err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	r := &Resp{Status: res.StatusCode, Body: b, Header: res.Header}
	if strings.HasPrefix(res.Header.Get("Content-Type"), "application/json") {
		_ = json.Unmarshal(b, &r.J)
	}
	validateResponse(p.t, method, req.URL.RequestURI(), res.StatusCode, res.Header.Get("Content-Type"), b)
	return r
}

func (p *Person) Check(action, target string) string {
	p.t.Helper()
	body := map[string]any{"action": action}
	if target != "" {
		body["target_id"] = target
	}
	r := p.Do("POST", "/app/v1/human-check", body)
	if r.Status != 200 {
		p.t.Fatalf("human-check: %s", r)
	}
	return r.Str("id")
}

// Room is a room as one person's browser sees it.
type Room struct {
	ID   string
	Name string
	Log  *testkit.Log
}

func (p *Person) CreateRoom(name string) *Room {
	p.t.Helper()
	id := wire.NewV7().String()
	l := testkit.NewLog(id)
	g := l.Build("genesis", p.Dev, map[string]any{"name": name, "owner": p.AccountID, "device": p.Dev.Hex()})
	r := p.Do("POST", "/app/v1/rooms", map[string]any{"id": id, "name": name, "purpose": "testing " + name, "genesis": g})
	if r.Status != 201 {
		p.t.Fatalf("create room: %s", r)
	}
	l.Push(g)
	return &Room{ID: id, Name: name, Log: l}
}

// Sync refetches the roster so the next entry is built at the server's head.
func (p *Person) Sync(room *Room) {
	p.t.Helper()
	r := p.Do("GET", "/app/v1/rooms/"+room.ID+"/roster", nil)
	if r.Status != 200 {
		p.t.Fatalf("roster: %s", r)
	}
	var ws []roster.Wire
	_ = json.Unmarshal(mustJSON(r.J["entries"]), &ws)
	room.Log.Reset(ws)
}

func (p *Person) Invite(room *Room) string {
	p.t.Helper()
	r := p.Do("GET", "/app/v1/rooms/"+room.ID+"/chat-invite", nil)
	if r.Status != 200 {
		p.t.Fatalf("chat-invite: %s", r)
	}
	return r.Str("url")
}

// ── agents (signed requests)

type Agent struct {
	t       testing.TB
	Key     testkit.Key
	X       []byte
	ID      string // member id once approved
	Room    string
	Name    string
	Session string
	ReqID   string
}

func NewAgentKeys(t testing.TB, name string) *Agent {
	return &Agent{t: t, Key: testkit.NewKey(), X: wire.RandBytes(32), Name: name, Session: "sess-" + strings.ToLower(wire.RandCode(8))}
}

func (a *Agent) FP() string { return wire.MemberFP(a.Key.Pub, a.X) }

type SignOpts struct {
	Time    int64
	Nonce   string
	Session *string
	Key     *testkit.Key
}

// Req builds a signed request (not sent).
func (a *Agent) Req(c *Copy, method, path string, body any, o *SignOpts) *http.Request {
	raw := mustJSON(body)
	req, _ := http.NewRequest(method, c.URL+path, bytes.NewReader(raw))
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	key := a.Key
	ts := time.Now().Unix()
	nonce := hex.EncodeToString(wire.RandBytes(16))
	session := a.Session
	if o != nil {
		if o.Time != 0 {
			ts = o.Time
		}
		if o.Nonce != "" {
			nonce = o.Nonce
		}
		if o.Session != nil {
			session = *o.Session
		}
		if o.Key != nil {
			key = *o.Key
		}
	}
	tsStr := strconv.FormatInt(ts, 10)
	msg := wire.ReqStringToSign(method, c.Host, req.URL.RequestURI(), wire.SHA256Hex(raw), tsStr, nonce, key.Hex(), session)
	sig := ed25519.Sign(key.Priv, msg)
	req.Header.Set("X-Botlink-Key", key.Hex())
	req.Header.Set("X-Botlink-Time", tsStr)
	req.Header.Set("X-Botlink-Nonce", nonce)
	if session != "" {
		req.Header.Set("X-Botlink-Session", session)
	}
	req.Header.Set("X-Botlink-Signature", hex.EncodeToString(sig))
	return req
}

func (a *Agent) Do(c *Copy, method, path string, body any) *Resp {
	a.t.Helper()
	return doRaw(a.t, a.Req(c, method, path, body, nil))
}

// Join asks to join with invite; returns the request view.
func (a *Agent) Join(c *Copy, invite string) *Resp {
	a.t.Helper()
	a.ReqID = wire.NewV7().String()
	return a.Do(c, "POST", "/api/v1/join-requests", map[string]any{"id": a.ReqID, "kind": "join", "invite": invite, "name": a.Name,
		"job": "test job for " + a.Name, "app": "claude-code", "machine": "box", "folder": "~/acme", "turn": "wake",
		"session_id": a.Session, "ed25519_pk": a.Key.Hex(), "x25519_pk": hex.EncodeToString(a.X)})
}

// Approve approves the agent's pending request as person p (member_add at the current head).
func (p *Person) Approve(room *Room, a *Agent) *Resp {
	p.t.Helper()
	p.Sync(room)
	ny := p.Do("GET", "/app/v1/needs-you", nil)
	var card map[string]any
	for _, j := range ny.J["join_requests"].([]any) {
		if j.(map[string]any)["id"] == a.ReqID {
			card = j.(map[string]any)
		}
	}
	if card == nil {
		p.t.Fatalf("join request %s not in needs-you: %s", a.ReqID, ny)
	}
	hc := p.Check("approve_join", a.ReqID)
	var entry roster.Wire
	if card["kind"] == "join" {
		entry = room.Log.Build("member_add", p.Dev, map[string]any{"member": card["member_id"], "account": p.AccountID, "name": card["name"],
			"app": card["app"], "ed": card["ed25519_pk"], "x": card["x25519_pk"]})
	} else {
		entry = room.Log.Build("member_rekey", p.Dev, map[string]any{"member": card["member_id"], "ed": card["ed25519_pk"], "x": card["x25519_pk"]})
	}
	r := p.Do("POST", "/app/v1/join-requests/"+a.ReqID+"/approve", map[string]any{"human_check": map[string]any{"id": hc, "stub": true}, "roster_entry": entry})
	if r.Status == 200 {
		room.Log.Push(entry)
		a.ID = r.Str("id")
		a.Room = room.ID
	}
	return r
}

// Member joins a fresh agent into room via p's invite, approved by p.
func (p *Person) Member(c *Copy, room *Room, name string) *Agent {
	p.t.Helper()
	a := NewAgentKeys(p.t, name)
	if r := a.Join(c, p.Invite(room)); r.Status != 201 {
		p.t.Fatalf("join %s: %s", name, r)
	}
	if r := p.Approve(room, a); r.Status != 200 {
		p.t.Fatalf("approve %s: %s", name, r)
	}
	return a
}

// ── envelopes

// Envelope builds a v3 envelope from a to (toID, toFP) with random ciphertext.
func (a *Agent) Envelope(msgID, scope, toID, toFP string, inReplyTo *string, expires int64) map[string]any {
	ct := wire.RandBytes(48)
	h := map[string]any{"v": 3, "id": msgID, "room": a.Room, "from": a.ID, "from_fp": a.FP(), "to": toID, "to_fp": toFP,
		"scope": scope, "in_reply_to": inReplyTo, "sent_at": time.Now().Unix(), "expires_at": expires,
		"ct_sha256": wire.SHA256Hex(ct)}
	hb := mustJSON(h)
	sig := wire.Sign(a.Key.Priv, "botlink-env-v1", hb)
	return map[string]any{"v": 3, "h": wire.B64URL(hb), "ct": b64std(ct), "sig": hex.EncodeToString(sig)}
}

func b64std(b []byte) string { return base64.StdEncoding.EncodeToString(b) }

// SendBody builds a send request to the given recipients (scope room if len(to) > 1 or room = true).
func (a *Agent) SendBody(id string, room bool, to []*Agent, inReplyTo *string) map[string]any {
	scope := "member"
	if room {
		scope = "room"
	}
	exp := time.Now().Unix() + 3600
	var envs []map[string]any
	for _, r := range to {
		envs = append(envs, map[string]any{"to_member": r.ID, "to_fp": r.FP(), "envelope": a.Envelope(id, scope, r.ID, r.FP(), inReplyTo, exp)})
	}
	b := map[string]any{"id": id, "room_id": a.Room, "scope": scope, "in_reply_to": inReplyTo, "envelopes": envs}
	if !room {
		b["to_member"] = to[0].ID
	}
	return b
}

func (a *Agent) Send(c *Copy, to *Agent) (string, *Resp) {
	id := wire.NewV7().String()
	return id, a.Do(c, "POST", "/api/v1/messages", a.SendBody(id, false, []*Agent{to}, nil))
}

func (a *Agent) Lease(c *Copy, waitS int) *Resp {
	return a.Do(c, "POST", "/api/v1/me/inbox/lease", map[string]any{"wait_s": waitS})
}

// AckNotices acks every notice in a lease response.
func (a *Agent) AckNotices(c *Copy, lr *Resp) {
	var ns []int64
	for _, n := range lr.J["notices"].([]any) {
		ns = append(ns, int64(n.(map[string]any)["id"].(float64)))
	}
	if len(ns) > 0 {
		if r := a.Do(c, "POST", "/api/v1/me/inbox/ack", map[string]any{"notice_ids": ns}); r.Status != 200 {
			a.t.Fatalf("ack notices: %s", r)
		}
	}
}

// Drain acks all open notices (roster_changed etc.) so long-polls only return on messages.
func (a *Agent) Drain(c *Copy) {
	a.AckNotices(c, a.Do(c, "POST", "/api/v1/me/inbox/lease", map[string]any{"wait_s": 0, "max": 1}))
	exec(a.t, c, `update notices set acked_at = now() where member_id = $1 and acked_at is null`, a.ID)
	exec(a.t, c, `update deliveries set lease_until = null where member_id = $1 and state = 'queued'`, a.ID)
}

func deliveries(r *Resp) []map[string]any {
	var out []map[string]any
	for _, d := range r.J["deliveries"].([]any) {
		out = append(out, d.(map[string]any))
	}
	return out
}

func mustURL(s string) *url.URL { u, _ := url.Parse(s); return u }

func count(t testing.TB, c *Copy, sql string, args ...any) int {
	t.Helper()
	var n int
	if err := c.Pool.QueryRow(context.Background(), sql, args...).Scan(&n); err != nil {
		t.Fatalf("%s: %v", sql, err)
	}
	return n
}

func exec(t testing.TB, c *Copy, sql string, args ...any) {
	t.Helper()
	if _, err := c.Pool.Exec(context.Background(), sql, args...); err != nil {
		t.Fatalf("%s: %v", sql, err)
	}
}

func resetFaults(t testing.TB) { t.Cleanup(faults.Reset) }

// TestContractCoverage runs last (alphabetically "Z…" would be cleaner; we print coverage instead).
func reportCoverage(t *testing.T) {
	contractMu.Lock()
	defer contractMu.Unlock()
	loadSpec(t)
	var missing []string
	for _, r := range routes {
		if checked[r.method+" "+r.path] == 0 {
			missing = append(missing, r.method+" "+r.path)
		}
	}
	t.Logf("contract: %d operations exercised, %d not: %v", len(routes)-len(missing), len(missing), missing)
}

func logLevel() slog.Level {
	if os.Getenv("BOTLINK_TEST_DEBUG") == "1" {
		return slog.LevelDebug
	}
	return slog.LevelError
}

func jsonUnmarshal(b []byte, v any) error { return json.Unmarshal(b, v) }
