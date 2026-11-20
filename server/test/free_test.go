package test

// Lane FREE (founder, 16 Nov 2026: "we are gonna release without a paywall"): with BOTLINK_PAYWALL at its default
// (off) nothing a person or a chat does is refused, slowed, counted or charged for a plan, every paid route answers
// exactly like a route that does not exist, and the fair-use limits still refuse as before.

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/charles161/botlink/server/internal/config"
	"github.com/charles161/botlink/server/internal/pages"
	"github.com/charles161/botlink/server/internal/testkit"
)

// paidCodes: error codes a person could read as "pay". None may be answered while the paywall is off.
var paidCodes = []string{"plan_limit", "plan_renews", "already_on_plan", "no_billing_account", "payment_unavailable", "billing_off", "not_for_sale"}

// paidText: words no answer may carry while the paywall is off.
var paidText = regexp.MustCompile(`(?i)\b(plans?|credits?|upgrade[sd]?|prices?|pricing|billing|paid|payments?)\b`)

// paidPaths are the routes that exist only with the paywall on. A route whose path names a plan, usage, credits,
// billing or pricing must be listed here (TestFreeEveryPaidRouteIsUnknown fails on one that is not).
var paidPaths = []struct{ method, path string }{
	{"GET", "/app/v1/plan"}, {"GET", "/app/v1/usage"}, {"GET", "/app/v1/credits"},
	{"POST", "/app/v1/billing/checkout"}, {"POST", "/app/v1/billing/portal"}, {"POST", "/app/v1/billing/fake/pay"},
	{"POST", "/app/v1/billing/events/fake"}, {"POST", "/app/v1/billing/events/dodo"}, {"GET", "/app/v1/pricing"},
	{"GET", "/app/v1/admin/plans"}, {"POST", "/app/v1/admin/plans/update"}, {"GET", "/app/v1/admin/account"},
	{"POST", "/app/v1/admin/account/raise"}, {"POST", "/app/v1/admin/account/boost"}, {"POST", "/app/v1/admin/credits/grant"},
	{"GET", "/app/v1/admin/limit-changes"}, {"GET", "/app/v1/admin/over-limit"},
	{"GET", "/usage"}, {"GET", "/billing"}, {"GET", "/billing/fake"}, {"GET", "/billing/fake/portal"},
	{"GET", "/pricing.html"}, {"GET", "/pricing.css"},
}

var paidWordInPath = regexp.MustCompile(`(?i)(plan|usage|credit|billing|pricing|price|pay)`)

// rawReq sends a request with p's cookie (or none when p is nil) and the dashboard's origin and CSRF token.
func rawReq(t *testing.T, c *Copy, p *Person, method, path string) (int, string, []byte) {
	t.Helper()
	req, _ := http.NewRequest(method, c.URL+path, strings.NewReader("{}"))
	req.Header.Set("Content-Type", "application/json")
	client := http.DefaultClient
	if p != nil {
		client = p.Client
		if method != "GET" {
			req.Header.Set("Origin", c.URL)
			req.Header.Set("X-CSRF-Token", p.CSRF)
		}
	}
	res, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	return res.StatusCode, res.Header.Get("Content-Type"), b
}

// unknownAnswer is what a route that does not exist answers (status, content type, error code and message).
func unknownAnswer(t *testing.T, c *Copy, p *Person, method, path string) string {
	t.Helper()
	st, ct, b := rawReq(t, c, p, method, path)
	var e struct {
		Error struct{ Code, Message string } `json:"error"`
	}
	_ = json.Unmarshal(b, &e)
	return fmt.Sprintf("%d %s %s %q", st, ct, e.Error.Code, e.Error.Message)
}

// Every paid route answers, to a signed-out visitor, a person and the unlocked admin, exactly what a route that does
// not exist answers. The list is checked against every route the server documents (api/openapi.yaml) and every page
// route and root file it serves, so a new paid route cannot be left out of it.
func TestFreeEveryPaidRouteIsUnknown(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A", withAdmins("root@example.com"))
	root := newPersonEmail(t, c, "Root", "root@example.com")
	unlockAdmin(t, root)
	ann := NewPerson(t, c, "Ann")

	listed := map[string]bool{}
	for _, r := range paidPaths {
		listed[r.method+" "+r.path] = true
	}
	// every documented route, page route and root file whose path names something paid must be listed
	loadSpec(t)
	var all []string
	for _, r := range routes {
		all = append(all, r.method+" "+r.path)
	}
	for _, p := range append(append([]string{}, pages.SPARoutes...), append(pages.PaidSPARoutes, pages.FakeBillingRoutes...)...) {
		all = append(all, "GET "+p)
	}
	files, _ := os.ReadDir(filepath.Join("..", "..", "web", "public"))
	for _, f := range files {
		if !f.IsDir() {
			all = append(all, "GET /"+f.Name())
		}
	}
	for _, r := range all {
		path := strings.SplitN(r, " ", 2)[1]
		if strings.Contains(path, "{gateway}") {
			continue // listed per gateway
		}
		if (paidWordInPath.MatchString(path) || strings.HasPrefix(path, "/app/v1/admin/account") && path != "/app/v1/admin/account/sends") && !listed[r] {
			t.Errorf("%s names something paid but is not in paidPaths: add it there and make it exist only with the paywall on (BOTLINK_PAYWALL)", r)
		}
	}
	for _, r := range paidPaths {
		for who, p := range map[string]*Person{"signed out": nil, "person": ann, "admin": root} {
			unknownPath := strings.Replace(r.path, "/app/v1/", "/app/v1/no-such-", 1)
			if !strings.HasPrefix(r.path, "/app/") {
				unknownPath = "/no-such-page" + strings.TrimPrefix(r.path, "/")
			}
			if strings.HasPrefix(r.path, "/app/v1/admin/") {
				unknownPath = "/app/v1/admin/no-such-route"
			}
			want := unknownAnswer(t, c, p, r.method, unknownPath)
			if got := unknownAnswer(t, c, p, r.method, r.path); got != want {
				t.Errorf("%s %s (%s) answers %s; a route that does not exist answers %s. With BOTLINK_PAYWALL off the route "+
					"must not be registered (config.PlansConfig.Paywall())", r.method, r.path, who, got, want)
			}
		}
	}
	// the dashboard is told, in the answer it fetches at start
	if me := ann.Do("GET", "/app/v1/me", nil); me.J["paywall"] != false {
		t.Errorf("GET /app/v1/me must say \"paywall\": false so the dashboard hides every paid screen: %s", me)
	}
}

// Every counted action, driven well past the old free plan's numbers (3 rooms, 5 chats and 4 people per room, 256 MB),
// is refused only by a fair-use limit, never for a plan; even with BOTLINK_LIMITS_MODE=block set, it is ignored.
func TestFreeNothingRefusedForAPlan(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A", func(cfg *config.Config) { ignorePaidSetting(cfg, "block") })
	ann := NewPerson(t, c, "Ann")
	bad := func(what string, r *Resp) {
		t.Helper()
		if r.Status == 402 || r.Status >= 400 {
			t.Errorf("%s refused with the paywall off: %s", what, r)
		}
		for _, code := range paidCodes {
			if r.Code() == code {
				t.Errorf("%s answered %s with the paywall off: %s", what, code, r)
			}
		}
		if m := paidText.FindString(string(r.Body)); m != "" && r.Status >= 400 {
			t.Errorf("%s: error text mentions %q: %s", what, m, r)
		}
	}
	var rooms []*Room
	for i := 0; i < 6; i++ { // old free plan: 3
		id := newID()
		l := testkit.NewLog(id)
		name := fmt.Sprintf("room%d", i)
		g := l.Build("genesis", ann.Dev, map[string]any{"name": name, "owner": ann.AccountID, "device": ann.Dev.Hex()})
		r := ann.Do("POST", "/app/v1/rooms", map[string]any{"id": id, "name": name, "purpose": "x", "genesis": g})
		bad("room "+name, r)
		if r.Status == 201 {
			l.Push(g)
			rooms = append(rooms, &Room{ID: id, Name: name, Log: l})
		}
	}
	var members []*Agent
	for i := 0; i < 8; i++ { // old free plan: 5
		a := NewAgentKeys(t, fmt.Sprintf("bot%d", i))
		j := a.Join(c, ann.Invite(rooms[0]))
		bad("join "+a.Name, j)
		if j.Status != 201 {
			continue
		}
		bad("approve "+a.Name, ann.Approve(rooms[0], a))
		members = append(members, a)
	}
	for i := 0; i < 6; i++ { // old free plan: 4 (the owner counts)
		bad(fmt.Sprintf("person %d", i), planAddPerson(t, c, ann, rooms[1], fmt.Sprintf("Guest %d", i)))
	}
	for i := 0; i < 20 && len(members) > 1; i++ {
		_, r := members[i%len(members)].Send(c, members[(i+1)%len(members)])
		bad("send", r)
	}
	for _, q := range []string{"limit_events", "limit_reached_days", "account_plan_limits", "usage_daily", "credit_ledger", "account_billing"} {
		if n := count(t, c, "select count(*) from "+q); n != 0 {
			t.Errorf("%d rows in %s with the paywall off: nothing may be counted, snapshotted or charged for a plan", n, q)
		}
	}
	// the chat is told nothing about a plan; it gets the fair-use history length
	me := members[0].Do(c, "GET", "/api/v1/me", nil)
	if _, ok := me.J["plan"]; ok || me.J["paywall"] != false || num(me.J["history_days"]) != 7 {
		t.Errorf("GET /api/v1/me with the paywall off: want no plan, paywall false, history_days 7: %s", me)
	}
	// account delete asks nothing about a plan
	if d := ann.Do("GET", "/app/v1/me/delete", nil); d.Status != 200 || strings.Contains(string(d.Body), "plan") {
		t.Errorf("GET /app/v1/me/delete mentions a plan with the paywall off: %s", d)
	}
	// the export has no plan, credit or payment section
	if ex := ann.Do("GET", "/app/v1/me/export", nil); ex.Status != 200 || ex.J["plan"] != nil {
		t.Errorf("export with the paywall off has a plan section: %d %v", ex.Status, ex.J["plan"])
	}
}

// A leftover paid-plan row cannot give an account more (or less) than the free per-account ceiling while off, and a
// renewing plan does not stop an account delete.
func TestFreeLeftoverPaidRowChangesNothing(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A", func(cfg *config.Config) { cfg.Plans.StorageCeilingMB = 1 })
	ann := NewPerson(t, c, "Ann")
	room := ann.CreateRoom("r")
	a, b := ann.Member(c, room, "a"), ann.Member(c, room, "b")
	exec(t, c, `insert into account_billing (account_id, plan_id, paid_until, status, gateway) values ($1, 'pro', now() + interval '30 days', 'active', 'dodo')`, ann.AccountID)
	r := fillUntilRefused(t, c, [][2]*Agent{{a, b}})
	if r.Status != 409 || r.Code() != "storage_full" || num(r.J["error"].(map[string]any)["details"].(map[string]any)["value"]) != 1 {
		t.Fatalf("with the paywall off a paid-plan row must not lift the 1 MB ceiling: %s", r)
	}
	if d := ann.Do("GET", "/app/v1/me/delete", nil); strings.Contains(string(d.Body), "plan_renews") {
		t.Errorf("delete plan names plan_renews with the paywall off: %s", d)
	}
	askDelete(t, ann) // fails the test on plan_renews
}

// The fair-use limits still refuse with the paywall off: the per-account ceiling and the server-wide ceiling. (Sign-ups,
// the wait cap, rate limits, rooms per day and the hard caps are proven at the default config, which is off, by
// signup_limit_test.go, waitcap_test.go and TestFreeHardCaps.)
func TestFreeFairUseStillRefuses(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A", func(cfg *config.Config) { cfg.Plans.StorageCeilingMB = 1 })
	ann := NewPerson(t, c, "Ann")
	room := ann.CreateRoom("r")
	a, b := ann.Member(c, room, "a"), ann.Member(c, room, "b")
	if r := fillUntilRefused(t, c, [][2]*Agent{{a, b}}); r.Code() != "storage_full" {
		t.Fatalf("ceiling: %s", r)
	}
	c2 := StartCopy(t, NewDB(t), "B", func(cfg *config.Config) { cfg.Plans.StorageTotalMB = 1 })
	bob := NewPerson(t, c2, "Bob")
	room2 := bob.CreateRoom("r")
	x, y := bob.Member(c2, room2, "x"), bob.Member(c2, room2, "y")
	if r := fillUntilRefused(t, c2, [][2]*Agent{{x, y}}); r.Code() != "server_full" {
		t.Fatalf("server-wide ceiling: %s", r)
	}
}

// The hard caps refuse with the paywall off as they always did: 20 rooms owned, 20 chats per room.
func TestFreeHardCaps(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A")
	ann := NewPerson(t, c, "Ann")
	for i := 0; i < 20; i++ {
		ann.CreateRoom(fmt.Sprintf("cap%d", i))
	}
	id := newID()
	l := testkit.NewLog(id)
	g := l.Build("genesis", ann.Dev, map[string]any{"name": "cap20", "owner": ann.AccountID, "device": ann.Dev.Hex()})
	if r := ann.Do("POST", "/app/v1/rooms", map[string]any{"id": id, "name": "cap20", "purpose": "x", "genesis": g}); r.Status != 429 || r.Code() != "quota_exceeded" || paidText.MatchString(string(r.Body)) {
		t.Fatalf("21st room: %s", r)
	}
}

// With the paywall off the daily usage rollup does not run (nothing is counted against a balance); with it on it does.
func TestFreeNoUsageRollup(t *testing.T) {
	db := NewDB(t)
	c := StartCopy(t, db, "A")
	ann := NewPerson(t, c, "Ann")
	room := ann.CreateRoom("r")
	a, b := ann.Member(c, room, "a"), ann.Member(c, room, "b")
	if _, r := a.Send(c, b); r.Status != 201 {
		t.Fatal(r)
	}
	StartCopy(t, db, "B", func(cfg *config.Config) { cfg.DisableSweeper = false })
	time.Sleep(1500 * time.Millisecond)
	if n := count(t, c, `select count(*) from usage_daily`); n != 0 {
		t.Fatalf("%d usage rows with the paywall off: the usage rollup must not run (server.Start)", n)
	}
	on := StartCopy(t, db, "C", func(cfg *config.Config) { cfg.DisableSweeper = false; paywallOn(cfg) })
	deadline := time.Now().Add(10 * time.Second)
	for count(t, on, `select count(*) from usage_daily`) == 0 {
		if time.Now().After(deadline) {
			t.Fatal("with the paywall on the usage rollup should run (the check above would prove nothing)")
		}
		time.Sleep(100 * time.Millisecond)
	}
}

// paywallOn: a copy with BOTLINK_PAYWALL=on (the plan and billing tests run this way: the paid code is kept, not deleted).
func paywallOn(cfg *config.Config) { cfg.Plans.SetPaywall(true) }

// startPaid is StartCopy with the paywall on.
func startPaid(t testing.TB, dbURL, id string, mods ...func(*config.Config)) *Copy {
	t.Helper()
	return StartCopy(t, dbURL, id, append([]func(*config.Config){paywallOn}, mods...)...)
}

// ignorePaidSetting stores a limits mode without turning the paywall on (as BOTLINK_LIMITS_MODE does while it is off).
func ignorePaidSetting(cfg *config.Config, mode string) {
	cfg.Plans.EditPaid(func(s *config.PaidSettings) { s.LimitsMode = mode })
}
