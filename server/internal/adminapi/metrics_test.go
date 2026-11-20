package adminapi

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	metricsql "github.com/charles161/botlink/db/metrics"
	"github.com/charles161/botlink/server/internal/auth"
	"github.com/charles161/botlink/server/internal/config"
	"github.com/charles161/botlink/server/internal/migrate"
	"github.com/charles161/botlink/server/internal/wire"
)

// ── a fresh migrated database per test (the server/test harness lives in another package)

var dbSeq atomic.Int64

func newPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	u := os.Getenv("BOTLINK_TEST_DATABASE_URL")
	if u == "" {
		u = "postgres://botlink@127.0.0.1:55432/botlink_test_server"
	}
	cluster := u[:strings.LastIndex(u, "/")]
	name := fmt.Sprintf("blmetrics_%d_%d", os.Getpid(), dbSeq.Add(1))
	ctx := context.Background()
	admin := func(sql string) error {
		c, err := pgx.Connect(ctx, cluster+"/postgres")
		if err != nil {
			return err
		}
		defer c.Close(ctx)
		_, err = c.Exec(ctx, sql)
		return err
	}
	if err := admin("create database " + name); err != nil {
		t.Fatal(err)
	}
	pool, err := pgxpool.New(ctx, cluster+"/"+name)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		pool.Close()
		_ = admin(fmt.Sprintf("drop database if exists %s with (force)", name))
	})
	if _, err := migrate.Up(ctx, pool); err != nil {
		t.Fatal(err)
	}
	return pool
}

// ── seeding (direct rows; every NOT NULL column gets a valid throwaway value)

type seed struct {
	t    *testing.T
	pool *pgxpool.Pool
}

func rnd(n int) []byte {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return b
}

func code(n int) string {
	const a = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
	b := rnd(n)
	for i := range b {
		b[i] = a[int(b[i])%len(a)]
	}
	return string(b)
}

func (s *seed) exec(q string, args ...any) {
	s.t.Helper()
	if _, err := s.pool.Exec(context.Background(), q, args...); err != nil {
		s.t.Fatalf("%v\n%s", err, q)
	}
}

func (s *seed) account(email string, at time.Time) string {
	id := wire.NewV7().String()
	s.exec(`insert into accounts (id, email, display_name, created_at) values ($1,$2,$3,$4)`, id, email, "Person "+email[:3], at)
	return id
}

func (s *seed) room(owner string, at time.Time) string {
	id := wire.NewV7().String()
	s.exec(`insert into rooms (id, owner_account_id, name, genesis_hash, created_at) values ($1,$2,$3,$4,$5)`,
		id, owner, "r-"+strings.ToLower(code(8)), rnd(32), at)
	s.exec(`insert into room_people (room_id, account_id, role, added_at) values ($1,$2,'owner',$3)`, id, owner, at)
	return id
}

func (s *seed) person(room, account string, at time.Time) {
	s.exec(`insert into room_people (room_id, account_id, role, added_at) values ($1,$2,'person',$3)`, room, account, at)
}

func (s *seed) member(room, account string, at time.Time) string {
	id := wire.NewV7().String()
	s.exec(`insert into members (id, room_id, account_id, name, app, turn, ed25519_pk, x25519_pk, joined_at)
		values ($1,$2,$3,$4,'claude-code','wake',$5,$6,$7)`, id, room, account, "m-"+strings.ToLower(code(6)), rnd(32), rnd(32), at)
	return id
}

// msg: a room-scope message from member `from` at `at`, with a shown copy for each of `to` (wakes on the copy).
func (s *seed) msg(room, from string, at time.Time, inReplyTo *string, wakes int, to ...string) string {
	id := wire.NewV7().String()
	s.exec(`insert into messages (id, room_id, from_member, scope, in_reply_to, request_hash, recipients, created_at, expires_at)
		values ($1,$2,$3,'room',$4,$5,$6,$7::timestamptz,$7::timestamptz + interval '30 days')`, id, room, from, inReplyTo, rnd(32), max(1, len(to)), at)
	for _, m := range to {
		s.exec(`insert into deliveries (message_id, member_id, key_epoch, state, shown_at, wakes, expires_at)
			values ($1,$2,1,'shown',$3::timestamptz,$4,$3::timestamptz + interval '30 days')`, id, m, at, wakes)
	}
	return id
}

// a person invite in room by owner, used by account (approved at `at`), and that account's chat joining (approved).
func (s *seed) invited(room, owner, account, member string, at time.Time) {
	inv := wire.NewV7().String()
	s.exec(`insert into invites (id, room_id, kind, account_id, code, expires_at, used_by_account_id, used_at, created_at)
		values ($1,$2,'person',$3,$4,$5::timestamptz + interval '7 days',$6,$5,$5)`, inv, room, owner, code(16), at, account)
	s.exec(`insert into person_requests (id, room_id, invite_id, account_id, device_pk, status, created_at, expires_at, decided_at, decided_by)
		values ($1,$2,$3,$4,$5,'approved',$6::timestamptz,$6::timestamptz + interval '1 day',$6,$7)`, wire.NewV7().String(), room, inv, account, rnd(32), at, owner)
	chat := wire.NewV7().String()
	s.exec(`insert into invites (id, room_id, kind, account_id, code, expires_at, created_at) values ($1,$2,'chat',$3,$4,$5::timestamptz + interval '1 day',$5)`,
		chat, room, account, code(10), at)
	s.exec(`insert into join_requests (id, kind, room_id, invite_id, for_account_id, member_id, name, app, turn, ed25519_pk, x25519_pk,
		match_code, request_hash, status, created_at, expires_at, decided_at, decided_by)
		values ($1,'join',$2,$3,$4,$5,$6,'codex','wake',$7,$8,$9,$10,'approved',$11::timestamptz,$11::timestamptz + interval '1 hour',$11,$4)`,
		wire.NewV7().String(), room, chat, account, member, "j-"+strings.ToLower(code(6)), rnd(32), rnd(32), code(6), rnd(32), at)
}

func monday(t time.Time) time.Time {
	t = t.UTC().Truncate(24 * time.Hour)
	return t.AddDate(0, 0, -((int(t.Weekday()) + 6) % 7))
}

type world struct {
	B, L time.Time // an old cohort week (6 weeks back) and last week
}

// seedWorld builds rooms with known answers (see the expectations in TestMetricsSeeded).
func seedWorld(t *testing.T, pool *pgxpool.Pool) world {
	s := &seed{t: t, pool: pool}
	w0 := monday(time.Now())
	B, L := w0.AddDate(0, 0, -42), w0.AddDate(0, 0, -7)
	h := func(base time.Time, hours float64) time.Time {
		return base.Add(time.Duration(hours * float64(time.Hour)))
	}
	early := B.AddDate(0, 0, -30)

	alice := s.account("alice@acme.dev", early)
	bob := s.account("bob@acme.dev", early)
	carol := s.account("carol@beta.io", early)
	dan := s.account("dan@gmail.com", early)
	erin := s.account("erin@gmail.com", early)

	// week B: R1 alice+carol (2 domains), R2 dan+erin (gmail: 1 domain, 2 free-mail addresses), R3 alice+bob (acme),
	// R4 alice alone with two chats. R1-R3 have both sides talking.
	r1 := s.room(alice, h(B, 1))
	s.person(r1, carol, h(B, 2))
	a1, c1 := s.member(r1, alice, h(B, 2)), s.member(r1, carol, h(B, 3))
	s.msg(r1, a1, h(B, 4), nil, 0, c1)
	s.msg(r1, c1, h(B, 5), nil, 0, a1)
	r2 := s.room(dan, h(B, 1))
	s.person(r2, erin, h(B, 2))
	d2, e2 := s.member(r2, dan, h(B, 2)), s.member(r2, erin, h(B, 3))
	s.msg(r2, d2, h(B, 4), nil, 0, e2)
	s.msg(r2, e2, h(B, 5), nil, 0, d2)
	r3 := s.room(alice, h(B, 1))
	s.person(r3, bob, h(B, 2))
	a3, b3 := s.member(r3, alice, h(B, 2)), s.member(r3, bob, h(B, 3))
	s.msg(r3, a3, h(B, 4), nil, 0, b3)
	s.msg(r3, b3, h(B, 5), nil, 0, a3)
	r4 := s.room(alice, h(B, 1))
	x4, y4 := s.member(r4, alice, h(B, 2)), s.member(r4, alice, h(B, 3))
	s.msg(r4, x4, h(B, 4), nil, 0, y4)
	s.msg(r4, y4, h(B, 5), nil, 0, x4)
	// a join hello and a self-test never count
	s.exec(`insert into messages (id, room_id, from_member, scope, request_hash, recipients, created_at, expires_at, intro)
		values ($1,$2,$3,'room',$4,1,$5::timestamptz,$5::timestamptz + interval '1 day', true)`, wire.NewV7().String(), r4, x4, rnd(32), h(B, 6))
	s.exec(`insert into messages (id, room_id, from_member, scope, to_member, request_hash, recipients, created_at, expires_at)
		values ($1,$2,$3,'self',$3,$4,1,$5::timestamptz,$5::timestamptz + interval '1 day')`, wire.NewV7().String(), r4, x4, rnd(32), h(B, 6))
	// week B+1: R1 (alice) and R2 (dan) come back; week B+4: R1 (carol)
	s.msg(r1, a1, h(B.AddDate(0, 0, 7), 10), nil, 0, c1)
	s.msg(r2, d2, h(B.AddDate(0, 0, 8), 10), nil, 0, e2)
	s.msg(r1, c1, h(B.AddDate(0, 0, 29), 10), nil, 0, a1)

	// last week L: frank signs up (gmail) and gina signs up and does nothing.
	// R5 carol+frank: carol's message is answered by frank while idle (the copy counted a wake).
	// R7 carol+alice: an answer, but not while idle.
	frank := s.account("frank@gmail.com", h(L, 1))
	s.account("gina@zeta.dev", h(L, 1))
	r5 := s.room(carol, h(L, 2))
	c5 := s.member(r5, carol, h(L, 3))
	f5 := s.member(r5, frank, h(L, 5))
	s.person(r5, frank, h(L, 4))
	s.invited(r5, carol, frank, f5, h(L, 4))
	m5 := s.msg(r5, c5, h(L, 6), nil, 1, f5)
	s.msg(r5, f5, h(L, 7), &m5, 0, c5)
	r7 := s.room(carol, h(L, 2))
	s.person(r7, alice, h(L, 3))
	c7, a7 := s.member(r7, carol, h(L, 3)), s.member(r7, alice, h(L, 4))
	m7 := s.msg(r7, c7, h(L, 6), nil, 0, a7)
	s.msg(r7, a7, h(L, 8), &m7, 0, c7)
	return world{B: B, L: L}
}

func rowFor(t *testing.T, rows []metricsql.Row, col string, at time.Time) metricsql.Row {
	t.Helper()
	for _, r := range rows {
		if v, ok := r[col].(time.Time); ok && v.Equal(at) {
			return r
		}
	}
	t.Fatalf("no row with %s = %s in %v", col, at.Format("2006-01-02"), rows)
	return nil
}

func expect(t *testing.T, what string, r metricsql.Row, want map[string]any) {
	t.Helper()
	for k, v := range want {
		got, ok := r[k]
		if !ok {
			t.Errorf("%s: no column %s", what, k)
			continue
		}
		switch wv := v.(type) {
		case int:
			if g, ok := got.(int64); !ok || g != int64(wv) {
				t.Errorf("%s.%s = %v (%T), want %d", what, k, got, got, wv)
			}
		case float64:
			if g, ok := got.(float64); !ok || g != wv {
				t.Errorf("%s.%s = %v (%T), want %v", what, k, got, got, wv)
			}
		case nil:
			if got != nil {
				t.Errorf("%s.%s = %v, want NULL", what, k, got)
			}
		default:
			if got != v {
				t.Errorf("%s.%s = %v, want %v", what, k, got, v)
			}
		}
	}
}

func TestMetricsSeeded(t *testing.T) {
	pool := newPool(t)
	w := seedWorld(t, pool)
	ctx := context.Background()

	weekly, err := metricsql.Run(ctx, pool, metricsql.Weekly)
	if err != nil {
		t.Fatal(err)
	}
	if len(weekly) != 26 {
		t.Fatalf("weekly rows: %d", len(weekly))
	}
	expect(t, "weekly B", rowFor(t, weekly, "week", w.B), map[string]any{
		"rooms_active": 4, "rooms_2plus_people": 3, "rooms_2plus_domains": 1, "rooms_2plus_domains_split_freemail": 2,
		"rooms_between_people": 3, "rooms_between_people_2plus_domains": 1, "cross_domain_pct": 33.3,
		"rooms_activated": nil, "rooms_activated_2plus_domains": nil, "week_complete": true,
	})
	expect(t, "weekly B+1", rowFor(t, weekly, "week", w.B.AddDate(0, 0, 7)), map[string]any{
		"rooms_active": 2, "rooms_2plus_people": 2, "rooms_between_people": 0, "cross_domain_pct": nil,
	})
	expect(t, "weekly L", rowFor(t, weekly, "week", w.L), map[string]any{
		"rooms_active": 2, "rooms_2plus_people": 2, "rooms_2plus_domains": 2, "rooms_2plus_domains_split_freemail": 2,
		"rooms_between_people": 2, "rooms_between_people_2plus_domains": 2, "cross_domain_pct": 100.0,
		"rooms_activated": 1, "rooms_activated_2plus_domains": 1, "week_complete": true,
	})
	expect(t, "weekly now", weekly[25], map[string]any{"rooms_active": 0, "rooms_activated": 0, "week_complete": false})

	ret, err := metricsql.Run(ctx, pool, metricsql.Retention)
	if err != nil {
		t.Fatal(err)
	}
	expect(t, "retention B", rowFor(t, ret, "cohort_week", w.B), map[string]any{
		"rooms": 3, "week1_back": 2, "week1_pct": 66.7, "week4_back": 1, "week4_pct": 33.3,
	})
	expect(t, "retention L", rowFor(t, ret, "cohort_week", w.L), map[string]any{
		"rooms": 2, "week1_back": nil, "week1_pct": nil, "week4_back": nil, "week4_pct": nil,
	})

	act, err := metricsql.Run(ctx, pool, metricsql.Activation)
	if err != nil {
		t.Fatal(err)
	}
	expect(t, "activation L", rowFor(t, act, "signup_week", w.L), map[string]any{
		"accounts": 2, "in_room": 1, "chat_approved": 1, "first_message": 1, "between_people": 1, "complete": false,
	})

	fun, err := metricsql.Run(ctx, pool, metricsql.Funnel, w.L, w.L.AddDate(0, 0, 7))
	if err != nil {
		t.Fatal(err)
	}
	expect(t, "funnel L", fun[0], map[string]any{
		"signups": 2, "rooms_created": 2, "person_invites_made": 1, "person_requests": 1, "people_approved": 1,
		"chat_join_requests": 1, "chat_joins_approved": 1, "rooms_first_message": 2, "rooms_2plus_people": 2,
		"rooms_between_people": 2, "rooms_between_people_2plus_domains": 2, "rooms_between_people_2plus_domains_split_freemail": 2,
		"cross_domain_pct": 100.0, "rooms_idle_answer": 1, "back_next_week": nil, "back_next_week_pct": nil,
	})
	funB, err := metricsql.Run(ctx, pool, metricsql.Funnel, w.B, w.B.AddDate(0, 0, 7))
	if err != nil {
		t.Fatal(err)
	}
	expect(t, "funnel B", funB[0], map[string]any{
		"rooms_created": 4, "rooms_between_people": 3, "rooms_between_people_2plus_domains": 1,
		"rooms_between_people_2plus_domains_split_freemail": 2, "rooms_idle_answer": nil, "back_next_week": 2, "back_next_week_pct": 66.7,
	})

	// the launch query (unchanged) agrees with the funnel's one number
	launch, err := metricsql.Run(ctx, pool, metricsql.Launch, w.L)
	if err != nil {
		t.Fatal(err)
	}
	expect(t, "launch L", launch[0], map[string]any{
		"launch_rooms": 2, "rooms_2plus_people": 2, "rooms_between_people": 1, "rooms_between_people_any_answer": 2, "approved_joins": 1,
	})
}

func TestMetricsEmptyDatabase(t *testing.T) {
	pool := newPool(t)
	ctx := context.Background()
	now := time.Now().UTC()
	for _, name := range []string{metricsql.Weekly, metricsql.Activation, metricsql.Retention} {
		rows, err := metricsql.Run(ctx, pool, name)
		if err != nil || len(rows) != 26 {
			t.Fatalf("%s on an empty database: %d rows, %v", name, len(rows), err)
		}
	}
	for _, name := range []string{metricsql.Funnel} {
		rows, err := metricsql.Run(ctx, pool, name, now.AddDate(0, 0, -7), now)
		if err != nil || len(rows) != 1 || rows[0]["signups"] != int64(0) || rows[0]["cross_domain_pct"] != nil {
			t.Fatalf("%s on an empty database: %v, %v", name, rows, err)
		}
	}
	rows, err := metricsql.Run(ctx, pool, metricsql.Launch, now.AddDate(0, 0, -7))
	if err != nil || len(rows) != 1 || rows[0]["rooms_between_people"] != int64(0) {
		t.Fatalf("launch on an empty database: %v, %v", rows, err)
	}
}

// Metadata only: no saved query names a column that holds sealed text, keys, secrets or what people typed.
func TestMetricsReadNoSealedOrPersonalColumns(t *testing.T) {
	forbidden := regexp.MustCompile(`\b(envelope|handover_env|push_url|push_secret|secret|prev_secret|entry|sig|display_name|avatar_url|job|folder|machine|self_label|csrf_token|token_hash|challenge|user_agent|purpose|data)\b`)
	for _, name := range []string{metricsql.Launch, metricsql.Weekly, metricsql.Activation, metricsql.Retention, metricsql.Funnel} {
		q, _, err := metricsql.SQL(name)
		if err != nil {
			t.Fatal(err)
		}
		if m := forbidden.FindString(q); m != "" {
			t.Errorf("%s reads %q", name, m)
		}
	}
	// the helper functions in migration 0020 are held to the same rule
	b, err := os.ReadFile("../../../db/migrations/0020_room_weeks.sql")
	if err != nil {
		t.Fatal(err)
	}
	if m := forbidden.FindString(regexp.MustCompile(`(?m)--.*$`).ReplaceAllString(string(b), "")); m != "" {
		t.Errorf("0020 reads %q", m)
	}
}

// Every query runs in a read-only transaction; a result can never carry text (an email, a domain, a name).
func TestMetricsReadOnlyAndNumbersOnly(t *testing.T) {
	pool := newPool(t)
	ctx := context.Background()
	if _, err := metricsql.RunSQL(ctx, pool, "write", `insert into accounts (id, email, display_name) values (gen_random_uuid(), 'x@y.z', 'X')`); err == nil ||
		!strings.Contains(err.Error(), "read-only") {
		t.Fatalf("a write ran: %v", err)
	}
	if _, err := metricsql.RunSQL(ctx, pool, "text", `select split_part('a@acme.dev', '@', 2) as domain`); err == nil {
		t.Fatal("a text column was returned")
	}
	if _, err := metricsql.RunSQL(ctx, pool, "ok", `select 1::bigint as n, 2.5::numeric as p, true as b, now() as t, null::int as z`); err != nil {
		t.Fatal(err)
	}
}

// ── the admin route: hidden from non-admins, locked until the unlock, JSON with every part

func session(t *testing.T, pool *pgxpool.Pool, email string, unlocked bool) *http.Cookie {
	t.Helper()
	ctx := context.Background()
	var acct string
	if err := pool.QueryRow(ctx, `insert into accounts (id, email, display_name) values ($1,$2,'P') returning id`, wire.NewV7().String(), email).Scan(&acct); err != nil {
		t.Fatal(err)
	}
	val := hex.EncodeToString(rnd(24))
	h := sha256.Sum256([]byte(val))
	var until any
	if unlocked {
		until = time.Now().Add(10 * time.Minute)
	}
	if _, err := pool.Exec(ctx, `insert into web_sessions (token_hash, account_id, csrf_token, expires_at, admin_until)
		values ($1,$2,$3, now() + interval '1 day', $4)`, h[:], acct, hex.EncodeToString(rnd(24)), until); err != nil {
		t.Fatal(err)
	}
	return &http.Cookie{Name: auth.CookieName(false), Value: val}
}

func get(t *testing.T, srv *httptest.Server, path string, ck *http.Cookie) (int, map[string]any) {
	t.Helper()
	req, _ := http.NewRequest("GET", srv.URL+path, nil)
	if ck != nil {
		req.AddCookie(ck)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	var j map[string]any
	_ = json.Unmarshal(b, &j)
	return res.StatusCode, j
}

func TestAdminMetricsRoute(t *testing.T) {
	pool := newPool(t)
	w := seedWorld(t, pool)
	cfg := &config.Config{Env: "dev", AppOrigin: "http://localhost", AdminEmails: []string{"boss@admin.test"}}
	a := &API{Pool: pool, Cfg: cfg, Errors: NewErrorRing(10), Started: time.Now()}
	mux := http.NewServeMux()
	a.Routes(mux)
	srv := httptest.NewServer(mux)
	defer srv.Close()

	unknownS, unknown := get(t, srv, "/app/v1/admin/no-such-route", session(t, pool, "eve@x.test", true))
	if s, j := get(t, srv, "/app/v1/admin/metrics", session(t, pool, "eve2@x.test", true)); s != unknownS || fmt.Sprint(j) != fmt.Sprint(unknown) {
		t.Fatalf("non-admin: %d %v (want %d %v)", s, j, unknownS, unknown)
	}
	if s, _ := get(t, srv, "/app/v1/admin/metrics", nil); s != 404 {
		t.Fatalf("signed out: %d", s)
	}
	if s, j := get(t, srv, "/app/v1/admin/metrics", session(t, pool, "boss@admin.test", false)); s != 403 || j["error"].(map[string]any)["code"] != "admin_locked" {
		t.Fatalf("locked admin: %d %v", s, j)
	}
	boss := session(t, pool, "boss2@admin.test", true)
	cfg.AdminEmails = append(cfg.AdminEmails, "boss2@admin.test")
	if s, j := get(t, srv, "/app/v1/admin/metrics?since=yesterday", boss); s != 400 {
		t.Fatalf("bad since: %d %v", s, j)
	}
	s, j := get(t, srv, "/app/v1/admin/metrics?since="+w.L.Format(time.RFC3339), boss)
	if s != 200 {
		t.Fatalf("metrics: %d %v", s, j)
	}
	for _, k := range []string{"generated_at", "since", "launch", "funnel_week1", "funnel_day30", "weekly", "activation", "retention", "thresholds"} {
		if j[k] == nil {
			t.Errorf("metrics missing %s", k)
		}
	}
	if n := j["launch"].(map[string]any)["rooms_between_people"]; n != 1.0 {
		t.Errorf("launch rooms_between_people = %v", n)
	}
	th := map[string]map[string]any{}
	for _, x := range j["thresholds"].([]any) {
		m := x.(map[string]any)
		th[m["id"].(string)] = m
	}
	// launch week L ended (met/not met); the week after, day 30 and month 6 are too early
	for id, want := range map[string]string{"launch_worked": NotMet, "launch_alarm": NotMet, "launch_back": TooEarly,
		"day30_cross_domain": TooEarly, "month6_week4": TooEarly, "month6_cross_domain": TooEarly, "raise": NotMet} {
		if th[id] == nil || th[id]["status"] != want {
			t.Errorf("threshold %s: %v (want %s)", id, th[id], want)
		}
	}
	if th["day30_cross_domain"]["value"] != 100.0 {
		t.Errorf("day 30 value so far: %v", th["day30_cross_domain"]["value"])
	}
	// nothing in the answer is an email address or a domain
	b, _ := json.Marshal(j)
	for _, bad := range []string{"@", "acme.dev", "gmail", "beta.io"} {
		if strings.Contains(string(b), bad) {
			t.Errorf("metrics answer contains %q", bad)
		}
	}
}

func TestThresholdStatuses(t *testing.T) {
	since := time.Date(2026, 11, 24, 15, 0, 0, 0, time.UTC)
	launch := metricsql.Row{"rooms_between_people": int64(41)}
	week1 := metricsql.Row{"back_next_week_pct": 30.0}
	day30 := metricsql.Row{"cross_domain_pct": 11.9}
	ret := []metricsql.Row{{"cohort_week": monday(since), "rooms": int64(10), "week4_back": int64(3)}}
	weekly := []metricsql.Row{{"week_complete": true, "rooms_activated": int64(10), "rooms_activated_2plus_domains": int64(2)},
		{"week_complete": false, "rooms_activated": int64(100), "rooms_activated_2plus_domains": int64(0)}}
	at := func(days int) map[string]string {
		m := map[string]string{}
		for _, x := range Thresholds(since, since.AddDate(0, 0, days), launch, week1, day30, weekly, ret) {
			m[x.ID] = x.Status
		}
		return m
	}
	if s := at(3); s["launch_worked"] != TooEarly || s["raise"] != TooEarly {
		t.Errorf("day 3: %v", s)
	}
	if s := at(15); s["launch_worked"] != Met || s["launch_alarm"] != Met || s["launch_back"] != Met || s["raise"] != Met || s["day30_cross_domain"] != TooEarly {
		t.Errorf("day 15: %v", s)
	}
	if s := at(31); s["day30_cross_domain"] != NotMet || s["month6_week4"] != TooEarly {
		t.Errorf("day 31: %v", s)
	}
	if s := at(200); s["month6_week4"] != Met || s["month6_cross_domain"] != Met {
		t.Errorf("day 200: %v", s)
	}
	launch["rooms_between_people"] = int64(9)
	if s := at(8); s["launch_alarm"] != NotMet || s["raise"] != NotMet {
		t.Errorf("under 10 at day 8: %v", s)
	}
}
