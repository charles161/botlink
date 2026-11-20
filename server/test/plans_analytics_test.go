package test

// Plans meet analytics (integration of lanes C and D1): limit_reached once per account, limit and day; plan_changed
// on a paid upgrade; only hashed ids, fixed names and counts leave the server.

import (
	"context"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/charles161/botlink/server/internal/billing"
	"github.com/charles161/botlink/server/internal/config"
	"github.com/charles161/botlink/server/internal/plans"
	"github.com/charles161/botlink/server/internal/testkit"
)

func withPostHog(url string) func(*config.Config) {
	return func(cfg *config.Config) {
		cfg.PostHogKey, cfg.PostHogHost, cfg.AnalyticsHashKey = "phc_test", url, "test-only-hash-key-0123456789abcdef0123"
	}
}

func TestPlanAnalyticsEvents(t *testing.T) {
	fake := &fakePostHog{}
	ph := httptestServer(fake)
	defer ph.Close()
	secret := newWhsec()
	c := startPaid(t, NewDB(t), "A", withPostHog(ph.URL), withMode("block"), withFake(secret, 0))
	ann := NewPerson(t, c, "Ann Secretname")
	for i := 0; i < 3; i++ {
		ann.CreateRoom("hidden-room-" + string(rune('a'+i)))
	}
	for i := 0; i < 4; i++ { // four refused attempts on one day: one event
		id := newID()
		l := testkit.NewLog(id)
		g := l.Build("genesis", ann.Dev, map[string]any{"name": "over", "owner": ann.AccountID, "device": ann.Dev.Hex()})
		if r := ann.Do("POST", "/app/v1/rooms", map[string]any{"id": id, "name": "over", "purpose": "x", "genesis": g}); r.Code() != "plan_limit" {
			t.Fatal(r)
		}
	}
	// a paid upgrade: plan_changed (plan pro)
	co := ann.Do("POST", "/app/v1/billing/checkout", map[string]any{"product": "pro_monthly"})
	if r := ann.Do("POST", "/app/v1/billing/fake/pay", map[string]any{"checkout_id": co.Str("checkout_id")}); r.Status != 200 {
		t.Fatal(r)
	}
	// a replay of the same subscription (another event id) changes nothing: no second plan_changed
	body := billing.FakeEvent("subscription.renewed", time.Now(), billing.FakeSubscription(ann.AccountID, co.Str("checkout_id"),
		"sub_fake_"+co.Str("checkout_id"), billing.ProMonthly, "active", time.Now().AddDate(0, 2, 0), false))
	if r := postEvent(t, c, "fake", secret, evID(), time.Now(), body); r.Status != 200 {
		t.Fatal(r)
	}
	time.Sleep(200 * time.Millisecond)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c.S.Analytics.Close(ctx)

	got := fake.names()
	if got["limit_reached"] != 1 || got["plan_changed"] != 1 {
		t.Fatalf("events: %v", got)
	}
	hex32 := regexp.MustCompile(`^[0-9a-f]{32}$`)
	for _, e := range fake.events {
		switch e["event"] {
		case "limit_reached", "plan_changed":
		default:
			continue
		}
		if !hex32.MatchString(e["distinct_id"].(string)) {
			t.Errorf("distinct_id %v", e["distinct_id"])
		}
		p := e["properties"].(map[string]any)
		want := map[string]any{"limit": "rooms", "count": float64(4)}
		if e["event"] == "plan_changed" {
			want = map[string]any{"plan": "pro"}
		}
		for k, v := range want {
			if p[k] != v {
				t.Errorf("%s: %s = %v, want %v", e["event"], k, p[k], v)
			}
		}
		for k := range p {
			if _, ok := want[k]; !ok && !strings.HasPrefix(k, "$") {
				t.Errorf("%s: unexpected property %s", e["event"], k)
			}
		}
	}
	raw := strings.Join(fake.raw, "\n")
	for _, bad := range []string{ann.Email, ann.AccountID, "Secretname", "hidden-room", co.Str("checkout_id"), "cus_fake"} {
		if strings.Contains(raw, bad) {
			t.Errorf("%q left the server", bad)
		}
	}
	// the price (1500 cents) must not leave either, as a value of its own: a random id or timestamp that happens to
	// contain the digits "1500" is not the price (this assertion failed once on such an id, 17 Nov 2026)
	if regexp.MustCompile(`(^|[^0-9A-Za-z-])1500([^0-9A-Za-z-]|$)`).MatchString(raw) {
		t.Errorf("the price 1500 left the server")
	}
	if n := count(t, c, `select count(*) from limit_reached_days where account_id = $1`, ann.AccountID); n != 1 {
		t.Fatalf("days: %d", n)
	}
}

// Count mode: an add over the limit sends limit_reached once a day, even across rooms; an add that rolls back sends
// nothing.
func TestPlanAnalyticsCountModeOncePerDay(t *testing.T) {
	fake := &fakePostHog{}
	ph := httptestServer(fake)
	defer ph.Close()
	c := startPaid(t, NewDB(t), "A", withPostHog(ph.URL))
	ann := NewPerson(t, c, "Ann")
	for i := 0; i < 5; i++ { // Free: 3 rooms; rooms 4 and 5 are over, one event
		ann.CreateRoom("r" + string(rune('a'+i)))
	}
	time.Sleep(100 * time.Millisecond)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c.S.Analytics.Close(ctx)
	if got := fake.names(); got["limit_reached"] != 1 {
		t.Fatalf("events: %v", got)
	}
}

func httptestServer(h http.Handler) *httptest.Server { return httptest.NewServer(h) }

// The admin rate-limit panel lists the event route's per-IP limit; GET /app/v1/admin/metrics matches openapi.yaml.
func TestAdminPanelBillingLimitAndMetricsContract(t *testing.T) {
	c := startPaid(t, NewDB(t), "A", withAdmins("root@example.com"))
	root := planAdmin(t, c, "root@example.com")
	ov := root.Do("GET", "/app/v1/admin/overview", nil)
	found := false
	for _, x := range ov.J["rate_limits"].([]any) {
		if l := x.(map[string]any); l["limit"] == "billev:ip" && num(l["max"]) == 600 && num(l["window_s"]) == 60 {
			found = true
		}
	}
	if !found {
		t.Fatalf("billev:ip not in the panel: %v", ov.J["rate_limits"])
	}
	if r := root.Do("GET", "/app/v1/admin/metrics", nil); r.Status != 200 || r.J["thresholds"] == nil {
		t.Fatalf("metrics: %s", r)
	}
	if r := root.Do("GET", "/app/v1/admin/metrics?since=yesterday", nil); r.Status != 400 {
		t.Fatalf("metrics bad since: %s", r)
	}
}

// ClientPlan (GET /api/v1/me, one query) agrees with Effective for snapshots, raises, boosts, the ceiling and a
// lowered plan, and writes nothing.
func TestClientPlanMatchesEffective(t *testing.T) {
	c := startPaid(t, NewDB(t), "A", withAdmins("root@example.com"))
	root := planAdmin(t, c, "root@example.com")
	ann, bob := NewPerson(t, c, "Ann"), NewPerson(t, c, "Bob")
	ctx := context.Background()
	same := func(who *Person, label string) {
		t.Helper()
		before := count(t, c, `select count(*) from account_plan_limits`)
		cp, err := plans.ClientPlan(ctx, c.Pool, who.AccountID)
		if err != nil {
			t.Fatal(err)
		}
		if count(t, c, `select count(*) from account_plan_limits`) != before {
			t.Fatalf("%s: ClientPlan wrote a snapshot", label)
		}
		st, err := plans.Effective(ctx, c.Pool, who.AccountID)
		if err != nil {
			t.Fatal(err)
		}
		if cp["id"] != st.PlanID || cp["name"] != st.PlanName {
			t.Fatalf("%s: plan %v vs %s", label, cp, st.PlanID)
		}
		for _, k := range plans.Keys {
			if cp[k] != st.Limits[k].Value {
				t.Fatalf("%s: %s = %v, Effective %d", label, k, cp[k], st.Limits[k].Value)
			}
		}
	}
	same(bob, "fresh, no snapshot")
	root.Do("POST", "/app/v1/admin/account/raise", map[string]any{"account_id": ann.AccountID, "limit": "people_per_room", "value": 7, "reason": "x"})
	root.Do("POST", "/app/v1/admin/account/boost", map[string]any{"account_id": ann.AccountID, "limit": "agents_per_room", "value": 9, "ends_at": time.Now().Add(48 * time.Hour), "reason": "x"})
	root.Do("POST", "/app/v1/admin/account/raise", map[string]any{"account_id": ann.AccountID, "limit": "rooms", "value": 50, "reason": "above the ceiling"})
	same(ann, "raise, boost, ceiling")
	root.Do("POST", "/app/v1/admin/plans/update", map[string]any{"plan_id": "free", "limits": map[string]any{"history_days": 3, "agents_per_room": 2}, "reason": "lower"})
	same(bob, "plan lowered after bob existed")
	exec(t, c, `insert into account_billing (account_id, plan_id, status, paid_until) values ($1, 'pro', 'active', now() + interval '1 day')`, bob.AccountID)
	same(bob, "pro")
	exec(t, c, `update account_billing set paid_until = now() - interval '1 second' where account_id = $1`, bob.AccountID)
	same(bob, "pro ended")
}
