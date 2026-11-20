package test

// Lane D1 follow-up: public pricing, the plan pages, the event route's body cap and rate limit, and over-limit
// records bounded per account, limit, room and day.

import (
	"bytes"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/charles161/botlink/server/internal/appapi"
	"github.com/charles161/botlink/server/internal/testkit"
)

// Public pricing: no session, the live numbers, nothing about any account.
func TestPublicPricing(t *testing.T) {
	c := startPaid(t, NewDB(t), "A", withAdmins("root@example.com"))
	root := planAdmin(t, c, "root@example.com")
	get := func() *Resp {
		t.Helper()
		r := doRaw(t, mustReq("GET", c.URL+"/app/v1/pricing"))
		if r.Status != 200 {
			t.Fatalf("pricing: %s", r)
		}
		return r
	}
	r := get()
	if cc := r.Header.Get("Cache-Control"); cc != "public, max-age=60" {
		t.Fatalf("cache: %q", cc)
	}
	if r.J["mode"] != "count" {
		t.Fatal(r)
	}
	ps := r.J["plans"].([]any)
	if len(ps) != 3 {
		t.Fatalf("plans: %s", r)
	}
	byID := map[string]map[string]any{}
	for _, x := range ps {
		p := x.(map[string]any)
		byID[p["id"].(string)] = p
		for k := range p {
			switch k {
			case "id", "name", "rooms", "agents_per_room", "people_per_room", "history_days", "for_sale", "prices":
			default:
				t.Errorf("unexpected field %q (no account data, no counts)", k)
			}
		}
	}
	free, pro, team := byID["free"], byID["pro"], byID["team"]
	if num(free["rooms"]) != 3 || num(free["history_days"]) != 7 || free["for_sale"] != false || len(free["prices"].([]any)) != 0 {
		t.Fatalf("free: %v", free)
	}
	if team["for_sale"] != false || len(team["prices"].([]any)) != 0 {
		t.Fatalf("team: %v", team)
	}
	prices := pro["prices"].([]any)
	m, y := prices[0].(map[string]any), prices[1].(map[string]any)
	if pro["for_sale"] != true || m["product"] != "pro_monthly" || num(m["usd_cents"]) != 1500 || num(m["total_usd_cents"]) != 1500 ||
		y["product"] != "pro_yearly" || num(y["usd_cents"]) != 1200 || num(y["total_usd_cents"]) != 14400 || y["billed"] != "yearly" {
		t.Fatalf("pro prices: %v", prices)
	}
	if strings.Contains(string(r.Body), root.Email) || strings.Contains(string(r.Body), root.AccountID) || strings.Contains(string(r.Body), "accounts") {
		t.Fatalf("account data: %s", r.Body)
	}
	if up := root.Do("POST", "/app/v1/admin/plans/update", map[string]any{"plan_id": "free", "limits": map[string]any{"rooms": 4}, "reason": "x"}); up.Status != 200 {
		t.Fatal(up)
	}
	for _, x := range get().J["plans"].([]any) {
		if p := x.(map[string]any); p["id"] == "free" && num(p["rooms"]) != 4 {
			t.Fatalf("after admin change: %v", p)
		}
	}
}

// Full page loads of the plan pages return the dashboard; the fake pages only with the fake gateway in dev.
func TestPlanPages(t *testing.T) {
	check := func(c *Copy, path string, want int) {
		t.Helper()
		r := doRaw(t, mustReq("GET", c.URL+path))
		if r.Status != want {
			t.Fatalf("GET %s: %d", path, r.Status)
		}
		if want == 200 && (!strings.HasPrefix(r.Header.Get("Content-Type"), "text/html") || !strings.Contains(string(r.Body), "<html")) {
			t.Fatalf("GET %s: not the app shell", path)
		}
	}
	off := startPaid(t, NewDB(t), "A")
	check(off, "/usage", 200)
	check(off, "/billing", 200)
	check(off, "/billing?checkout=0193", 200)
	check(off, "/billing/fake", 404)
	check(off, "/billing/fake/portal", 404)
	fake := startPaid(t, NewDB(t), "B", withFake(newWhsec(), 0))
	check(fake, "/billing/fake", 200)
	check(fake, "/billing/fake/portal?customer=x", 200)
}

// The event route: the body is capped before it is read and hashed, and calls are limited per client IP.
func TestBillingEventCapAndLimit(t *testing.T) {
	secret := newWhsec()
	c := startPaid(t, NewDB(t), "A", withFake(secret, 0))
	big := bytes.Repeat([]byte("a"), appapi.MaxEventBody+1)
	req, _ := http.NewRequest("POST", c.URL+"/app/v1/billing/events/fake", bytes.NewReader(big))
	req.Header.Set("Content-Type", "application/json")
	if r := doRaw(t, req); r.Status != 413 || r.Code() != "too_large" {
		t.Fatalf("over the cap: %s", r)
	}
	old := appapi.BillingEventsPerIP.Max
	appapi.BillingEventsPerIP.Max = 5
	t.Cleanup(func() { appapi.BillingEventsPerIP.Max = old })
	for i := 0; i < 5; i++ { // the oversized call above counted too: 4 more pass the limit, then 429
		req, _ := http.NewRequest("POST", c.URL+"/app/v1/billing/events/fake", strings.NewReader(`{}`))
		r := doRaw(t, req)
		if i < 4 && r.Code() != "bad_signature" {
			t.Fatalf("call %d: %s", i, r)
		}
		if i == 4 && (r.Status != 429 || r.Header.Get("Retry-After") == "") {
			t.Fatalf("over the limit: %s", r)
		}
	}
	// a correctly signed event from the same address is limited too (the limit comes before any work)
	body := []byte(`{"type":"x","data":{}}`)
	if r := postEvent(t, c, "fake", secret, evID(), time.Now(), body); r.Status != 429 {
		t.Fatalf("signed, over the limit: %s", r)
	}
}

// Refused attempts in block mode are one row per account, limit, room and day, with a count.
func TestOverLimitEventsBounded(t *testing.T) {
	c := startPaid(t, NewDB(t), "A", withAdmins("root@example.com"), withMode("block"))
	root := planAdmin(t, c, "root@example.com")
	ann := NewPerson(t, c, "Ann")
	for i := 0; i < 3; i++ {
		ann.CreateRoom("r" + string(rune('a'+i)))
	}
	for i := 0; i < 6; i++ {
		id := newID()
		l := testkit.NewLog(id)
		g := l.Build("genesis", ann.Dev, map[string]any{"name": "over", "owner": ann.AccountID, "device": ann.Dev.Hex()})
		if r := ann.Do("POST", "/app/v1/rooms", map[string]any{"id": id, "name": "over", "purpose": "x", "genesis": g}); r.Code() != "plan_limit" {
			t.Fatal(r)
		}
	}
	if n := count(t, c, `select count(*) from limit_events where account_id = $1`, ann.AccountID); n != 1 {
		t.Fatalf("rows: %d", n)
	}
	ol := root.Do("GET", "/app/v1/admin/over-limit", nil)
	rec := ol.J["recent"].([]any)
	if len(rec) != 1 || num(rec[0].(map[string]any)["attempts"]) != 6 || rec[0].(map[string]any)["refused"] != true {
		b, _ := json.Marshal(rec)
		t.Fatalf("recent: %s", b)
	}
}
