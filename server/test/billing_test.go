package test

// Payments (lane D1): the gateway behind config, event signatures, idempotency, ordering, the fake gateway end to
// end, and the Dodo gateway against a local stand-in of its API (it has never run against Dodo itself).

import (
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/charles161/botlink/server/internal/billing"
	"github.com/charles161/botlink/server/internal/config"
	"github.com/charles161/botlink/server/internal/wire"
)

func newWhsec() string {
	b := make([]byte, 32)
	_, _ = rand.Read(b)
	return "whsec_" + base64.StdEncoding.EncodeToString(b)
}

func withFake(secret string, pack int64) func(*config.Config) {
	return func(c *config.Config) {
		c.Plans.EditPaid(func(p *config.PaidSettings) { p.Gateway, p.FakeKey, p.CreditsPackSize = "fake", secret, pack })
	}
}

// postEvent signs body with secret (webhook-timestamp = ts) and posts it to the gateway's event route.
func postEvent(t *testing.T, c *Copy, gw, secret, id string, ts time.Time, body []byte) *Resp {
	t.Helper()
	key, err := billing.DecodeKey(secret)
	if err != nil {
		t.Fatal(err)
	}
	req, _ := http.NewRequest("POST", c.URL+"/app/v1/billing/events/"+gw, bytes.NewReader(body))
	req.Header = billing.Headers(key, id, ts.Unix(), body)
	return doRaw(t, req)
}

func evID() string { return "evt_" + wire.NewV7().String() }

func billingOf(t testing.TB, p *Person) map[string]any {
	t.Helper()
	return myPlan(t, p).J["billing"].(map[string]any)
}

func TestBillingOff(t *testing.T) {
	c := startPaid(t, NewDB(t), "A")
	ann := NewPerson(t, c, "Ann")
	if r := ann.Do("POST", "/app/v1/billing/checkout", map[string]any{"product": "pro_monthly"}); r.Status != 409 || r.Code() != "billing_off" {
		t.Fatal(r)
	}
	if r := ann.Do("POST", "/app/v1/billing/portal", map[string]any{}); r.Status != 409 || r.Code() != "billing_off" {
		t.Fatal(r)
	}
	if r := ann.Do("POST", "/app/v1/billing/fake/pay", map[string]any{"checkout_id": newID()}); r.Status != 404 {
		t.Fatal(r)
	}
	if r := postEvent(t, c, "dodo", newWhsec(), evID(), time.Now(), []byte(`{"type":"x","data":{}}`)); r.Status != 404 {
		t.Fatal(r)
	}
}

// The fake gateway end to end: checkout, pay, Pro, portal, a credits pack, cancellation, the paid period ending
// (back to Free, rooms still readable), a refund taking the pack back.
func TestFakeGatewayEndToEnd(t *testing.T) {
	secret := newWhsec()
	c := startPaid(t, NewDB(t), "A", withAdmins("root@example.com"), withFake(secret, 500))
	root := planAdmin(t, c, "root@example.com")
	ann := NewPerson(t, c, "Ann")
	if r := ann.Do("POST", "/app/v1/billing/portal", map[string]any{}); r.Code() != "no_billing_account" {
		t.Fatal(r)
	}
	if r := ann.Do("POST", "/app/v1/billing/checkout", map[string]any{"product": "team"}); r.Status != 400 {
		t.Fatal(r)
	}
	co := ann.Do("POST", "/app/v1/billing/checkout", map[string]any{"product": "pro_monthly"})
	if co.Status != 200 || !strings.HasPrefix(co.Str("checkout_url"), c.URL+"/billing/fake?checkout=") {
		t.Fatal(co)
	}
	if b := billingOf(t, ann); b["status"] != "none" { // nothing changes before the signed event
		t.Fatal(b)
	}
	eve := NewPerson(t, c, "Eve")
	if r := eve.Do("POST", "/app/v1/billing/fake/pay", map[string]any{"checkout_id": co.Str("checkout_id")}); r.Status != 404 {
		t.Fatalf("someone else's checkout: %s", r)
	}
	pay := ann.Do("POST", "/app/v1/billing/fake/pay", map[string]any{"checkout_id": co.Str("checkout_id")})
	if pay.Status != 200 || pay.Str("event_type") != "subscription.active" {
		t.Fatal(pay)
	}
	p := myPlan(t, ann)
	b := p.J["billing"].(map[string]any)
	if p.J["plan"].(map[string]any)["id"] != "pro" || b["status"] != "active" || b["interval"] != "month" || b["can_open_portal"] != true {
		t.Fatalf("after pay: %s", p)
	}
	pu, _ := time.Parse(time.RFC3339, b["paid_until"].(string))
	if d := time.Until(pu); d < 27*24*time.Hour || d > 32*24*time.Hour {
		t.Fatalf("paid_until %v", pu)
	}
	if l := limitOf(t, p, "rooms"); num(l["value"]) != 20 || num(limitOf(t, p, "history_days")["value"]) != 30 {
		t.Fatalf("pro limits: %v", p.J["limits"])
	}
	if len(p.J["for_sale"].([]any)) != 0 {
		t.Fatalf("for sale on Pro: %v", p.J["for_sale"])
	}
	if r := ann.Do("POST", "/app/v1/billing/checkout", map[string]any{"product": "pro_yearly"}); r.Code() != "already_on_plan" {
		t.Fatal(r)
	}
	if r := ann.Do("POST", "/app/v1/billing/portal", map[string]any{}); r.Status != 200 || !strings.Contains(r.Str("portal_url"), billing.FakeCustomer(ann.AccountID)) {
		t.Fatal(r)
	}
	if r := ann.Do("POST", "/app/v1/billing/fake/pay", map[string]any{"checkout_id": co.Str("checkout_id")}); r.Status != 404 {
		t.Fatalf("paid twice: %s", r)
	}
	// a credits pack
	cp := ann.Do("POST", "/app/v1/billing/checkout", map[string]any{"product": "credits_pack"})
	if cp.Status != 200 {
		t.Fatal(cp)
	}
	if r := ann.Do("POST", "/app/v1/billing/fake/pay", map[string]any{"checkout_id": cp.Str("checkout_id")}); r.Status != 200 || r.Str("event_type") != "payment.succeeded" {
		t.Fatal(r)
	}
	if r := ann.Do("GET", "/app/v1/credits", nil); num(r.J["balance"]) != 500 || r.J["entries"].([]any)[0].(map[string]any)["kind"] != "topup" {
		t.Fatalf("credits: %s", r)
	}
	// the plan move is logged as a payment change
	log := root.Do("GET", "/app/v1/admin/limit-changes?account_id="+ann.AccountID, nil)
	var moved bool
	for _, x := range log.J["changes"].([]any) {
		ch := x.(map[string]any)
		if ch["actor_kind"] == "payment" && ch["target"] == "account_plan" && ch["from"] == "free" && ch["to"] == "pro" {
			moved = true
		}
	}
	if !moved {
		t.Fatalf("plan move not logged: %s", log)
	}
	// rooms made while on Pro
	var rooms []*Room
	for i := 0; i < 5; i++ {
		rooms = append(rooms, ann.CreateRoom("pro"+string(rune('a'+i))))
	}
	// cancelled: still Pro until the end of the paid period, with a heads-up
	sub := "sub_fake_" + co.Str("checkout_id")
	body := billing.FakeEvent("subscription.cancelled", time.Now(),
		billing.FakeSubscription(ann.AccountID, co.Str("checkout_id"), sub, billing.ProMonthly, "cancelled", pu, true))
	if r := postEvent(t, c, "fake", secret, evID(), time.Now(), body); r.Status != 200 || r.J["duplicate"] != false {
		t.Fatal(r)
	}
	p = myPlan(t, ann)
	if p.J["plan"].(map[string]any)["id"] != "pro" || p.J["billing"].(map[string]any)["status"] != "cancelled" {
		t.Fatalf("after cancel: %s", p)
	}
	var ending bool
	for _, n := range p.J["notices"].([]any) {
		if n.(map[string]any)["kind"] == "plan_ending" {
			ending = true
		}
	}
	if !ending {
		t.Fatalf("no plan_ending notice: %v", p.J["notices"])
	}
	// the paid period ends: Free, rooms stay readable, shown over
	exec(t, c, `update account_billing set paid_until = now() - interval '1 second' where account_id = $1`, ann.AccountID)
	p = myPlan(t, ann)
	if p.J["plan"].(map[string]any)["id"] != "free" || p.J["over_limit"] != true || num(limitOf(t, p, "rooms")["used"]) != 5 {
		t.Fatalf("after the period: %s", p)
	}
	for _, rm := range rooms {
		if r := ann.Do("GET", "/app/v1/rooms/"+rm.ID, nil); r.Status != 200 {
			t.Fatalf("room not readable after downgrade: %s", r)
		}
	}
	// a refund of the pack takes its credits back, once
	refund := billing.FakeEvent("refund.succeeded", time.Now(), map[string]any{"payload_type": "Refund", "refund_id": "rfd_1", "payment_id": "pay_fake_" + cp.Str("checkout_id")})
	for i := 0; i < 2; i++ {
		if r := postEvent(t, c, "fake", secret, evID(), time.Now(), refund); r.Status != 200 {
			t.Fatal(r)
		}
	}
	if r := ann.Do("GET", "/app/v1/credits", nil); num(r.J["balance"]) != 0 {
		t.Fatalf("after refund: %s", r)
	}
}

// Event signature good / bad / old / replayed; malformed JSON.
func TestBillingEventSignatures(t *testing.T) {
	secret := newWhsec()
	c := startPaid(t, NewDB(t), "A", withFake(secret, 100))
	ann := NewPerson(t, c, "Ann")
	body := billing.FakeEvent("payment.succeeded", time.Now(), billing.FakePayment(ann.AccountID, newID(), "pay_sig_1"))
	id := evID()
	if r := postEvent(t, c, "fake", newWhsec(), id, time.Now(), body); r.Status != 401 || r.Code() != "bad_signature" {
		t.Fatalf("wrong key: %s", r)
	}
	if r := postEvent(t, c, "fake", secret, id, time.Now().Add(-10*time.Minute), body); r.Status != 401 || r.Code() != "stale_timestamp" {
		t.Fatalf("old: %s", r)
	}
	req, _ := http.NewRequest("POST", c.URL+"/app/v1/billing/events/fake", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if r := doRaw(t, req); r.Status != 401 || r.Code() != "bad_signature" {
		t.Fatalf("unsigned: %s", r)
	}
	if r := postEvent(t, c, "dodo", secret, id, time.Now(), body); r.Status != 404 {
		t.Fatalf("unconfigured gateway: %s", r)
	}
	if n := count(t, c, `select count(*) from credit_ledger where account_id = $1`, ann.AccountID); n != 0 {
		t.Fatalf("a refused event changed credits: %d", n)
	}
	if r := postEvent(t, c, "fake", secret, id, time.Now(), body); r.Status != 200 || r.J["duplicate"] != false {
		t.Fatalf("good: %s", r)
	}
	if r := postEvent(t, c, "fake", secret, id, time.Now(), body); r.Status != 200 || r.J["duplicate"] != true {
		t.Fatalf("replayed: %s", r)
	}
	// the same payment under a new event id (a gateway retry with a new id) still counts once
	if r := postEvent(t, c, "fake", secret, evID(), time.Now(), body); r.Status != 200 {
		t.Fatal(r)
	}
	if r := ann.Do("GET", "/app/v1/credits", nil); num(r.J["balance"]) != 100 {
		t.Fatalf("balance: %s", r)
	}
	if r := postEvent(t, c, "fake", secret, evID(), time.Now(), []byte(`not json`)); r.Status != 400 {
		t.Fatalf("bad json: %s", r)
	}
}

// Out-of-order events never downgrade a paying account; an older subscription's late events are ignored.
func TestBillingEventOrdering(t *testing.T) {
	secret := newWhsec()
	c := startPaid(t, NewDB(t), "A", withFake(secret, 0))
	ann := NewPerson(t, c, "Ann")
	t0 := time.Now().Add(-time.Hour)
	send := func(typ string, at time.Time, sub, status string, next time.Time) {
		t.Helper()
		body := billing.FakeEvent(typ, at, billing.FakeSubscription(ann.AccountID, newID(), sub, billing.ProYearly, status, next, false))
		if r := postEvent(t, c, "fake", secret, evID(), time.Now(), body); r.Status != 200 {
			t.Fatalf("%s: %s", typ, r)
		}
	}
	y1 := time.Now().AddDate(1, 0, 0).UTC().Truncate(time.Second)
	y2 := y1.AddDate(1, 0, 0)
	send("subscription.active", t0, "sub_1", "active", y1)
	send("subscription.renewed", t0.Add(20*time.Minute), "sub_1", "active", y2)
	// late: an on_hold from before the renewal
	send("subscription.on_hold", t0.Add(10*time.Minute), "sub_1", "on_hold", y1)
	b := billingOf(t, ann)
	if b["status"] != "active" || b["paid_until"] != y2.Format(time.RFC3339) || b["interval"] != "year" {
		t.Fatalf("late on_hold downgraded: %v", b)
	}
	// late: the first active again (an old paid_until never moves the period back)
	send("subscription.active", t0, "sub_1", "active", y1)
	if b := billingOf(t, ann); b["paid_until"] != y2.Format(time.RFC3339) {
		t.Fatalf("paid period moved back: %v", b)
	}
	// newer cancellation applies; a late renewal before it does not undo it
	send("subscription.cancelled", t0.Add(30*time.Minute), "sub_1", "cancelled", y2)
	send("subscription.renewed", t0.Add(25*time.Minute), "sub_1", "active", y2)
	b = billingOf(t, ann)
	if b["status"] != "cancelled" || myPlan(t, ann).J["plan"].(map[string]any)["id"] != "pro" {
		t.Fatalf("after cancel: %v", b)
	}
	// a new subscription; the old one's expiry (newer timestamp) must not touch it
	send("subscription.active", t0.Add(40*time.Minute), "sub_2", "active", y2)
	send("subscription.expired", t0.Add(50*time.Minute), "sub_1", "expired", y2)
	if b := billingOf(t, ann); b["status"] != "active" {
		t.Fatalf("old subscription's event touched the new one: %v", b)
	}
	// the same event to two copies at once: applied once
	db := NewDB(t)
	a1 := startPaid(t, db, "A", withFake(secret, 50))
	a2 := startPaid(t, db, "B", withFake(secret, 50))
	bob := NewPerson(t, a1, "Bob")
	body := billing.FakeEvent("payment.succeeded", time.Now(), billing.FakePayment(bob.AccountID, newID(), "pay_two"))
	id := evID()
	var wg sync.WaitGroup
	dups := make([]any, 2)
	for i, cp := range []*Copy{a1, a2} {
		wg.Add(1)
		go func(i int, cp *Copy) {
			defer wg.Done()
			dups[i] = postEvent(t, cp, "fake", secret, id, time.Now(), body).J["duplicate"]
		}(i, cp)
	}
	wg.Wait()
	if (dups[0] == true) == (dups[1] == true) {
		t.Fatalf("duplicate flags: %v", dups)
	}
	if r := bob.Do("GET", "/app/v1/credits", nil); num(r.J["balance"]) != 50 {
		t.Fatalf("two copies: %s", r)
	}
}

// The Dodo gateway against a local stand-in of Dodo's API: request shapes, keys from config, errors, events.
func TestDodoGatewayAgainstStandIn(t *testing.T) {
	var mu sync.Mutex
	var seen []map[string]any
	fail := false
	stand := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		var body map[string]any
		_ = json.Unmarshal(b, &body)
		mu.Lock()
		seen = append(seen, map[string]any{"method": r.Method, "path": r.URL.Path, "query": r.URL.RawQuery, "auth": r.Header.Get("Authorization"), "body": body})
		f := fail
		mu.Unlock()
		if f {
			w.WriteHeader(500)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == "POST" && r.URL.Path == "/checkouts":
			_, _ = w.Write([]byte(`{"session_id":"cks_123","checkout_url":"https://test.checkout.dodopayments.com/session/cks_123"}`))
		case r.Method == "POST" && strings.HasSuffix(r.URL.Path, "/customer-portal/session"):
			_, _ = w.Write([]byte(`{"link":"https://customer.dodopayments.com/session/abc"}`))
		default:
			w.WriteHeader(404)
		}
	}))
	defer stand.Close()
	whsec := newWhsec()
	c := startPaid(t, NewDB(t), "A", func(cfg *config.Config) {
		cfg.Plans.EditPaid(func(p *config.PaidSettings) {
			p.Gateway, p.DodoMode, p.DodoAPIKey, p.DodoWebhookKey = "dodo", "test", "dodo_test_key", whsec
			p.DodoProductProMonthly, p.DodoProductProYearly, p.DodoAPIBase = "pdt_month", "pdt_year", stand.URL
		})
	})
	ann := NewPerson(t, c, "Ann")
	if r := ann.Do("POST", "/app/v1/billing/checkout", map[string]any{"product": "credits_pack"}); r.Code() != "not_for_sale" {
		t.Fatalf("pack without a product id: %s", r)
	}
	co := ann.Do("POST", "/app/v1/billing/checkout", map[string]any{"product": "pro_yearly"})
	if co.Status != 200 || co.Str("checkout_url") != "https://test.checkout.dodopayments.com/session/cks_123" {
		t.Fatal(co)
	}
	mu.Lock()
	req := seen[0]
	mu.Unlock()
	body := req["body"].(map[string]any)
	cart := body["product_cart"].([]any)[0].(map[string]any)
	meta := body["metadata"].(map[string]any)
	if req["auth"] != "Bearer dodo_test_key" || cart["product_id"] != "pdt_year" || num(cart["quantity"]) != 1 ||
		meta["botlink_account"] != ann.AccountID || meta["botlink_checkout"] != co.Str("checkout_id") ||
		body["customer"].(map[string]any)["email"] != ann.Email || body["return_url"] != c.URL+"/billing?checkout="+co.Str("checkout_id") {
		t.Fatalf("checkout request: %v", req)
	}
	// Dodo's subscription events (shape from its docs). The first carries our metadata; later ones may not.
	next := time.Now().AddDate(1, 0, 0).UTC().Truncate(time.Second)
	dodoEv := func(typ, status string, at time.Time, meta map[string]any) []byte {
		b, _ := json.Marshal(map[string]any{"business_id": "bus_1", "type": typ, "timestamp": at.UTC().Format(time.RFC3339),
			"data": map[string]any{"payload_type": "Subscription", "subscription_id": "sub_d1", "status": status, "product_id": "pdt_year",
				"next_billing_date": next.Format(time.RFC3339), "cancel_at_next_billing_date": false,
				"customer": map[string]any{"customer_id": "cus_d1", "email": ann.Email, "name": "Ann"}, "metadata": meta}})
		return b
	}
	t0 := time.Now()
	ev2 := dodoEv("subscription.active", "active", t0, map[string]any{"botlink_account": ann.AccountID})
	if r := postEvent(t, c, "dodo", whsec, evID(), time.Now(), ev2); r.Status != 200 {
		t.Fatal(r)
	}
	b := billingOf(t, ann)
	if b["status"] != "active" || b["interval"] != "year" || b["paid_until"] != next.Format(time.RFC3339) || b["gateway"] != "dodo" {
		t.Fatalf("dodo active: %v", b)
	}
	// a later event without our metadata is matched by the stored subscription id
	if r := postEvent(t, c, "dodo", whsec, evID(), time.Now(), dodoEv("subscription.on_hold", "on_hold", t0.Add(time.Minute), map[string]any{})); r.Status != 200 {
		t.Fatal(r)
	}
	if b := billingOf(t, ann); b["status"] != "on_hold" {
		t.Fatalf("matched by subscription id: %v", b)
	}
	pr := ann.Do("POST", "/app/v1/billing/portal", map[string]any{})
	if pr.Status != 200 || pr.Str("portal_url") != "https://customer.dodopayments.com/session/abc" {
		t.Fatal(pr)
	}
	mu.Lock()
	last := seen[len(seen)-1]
	fail = true
	mu.Unlock()
	if last["path"] != "/customers/cus_d1/customer-portal/session" || !strings.Contains(last["query"].(string), "return_url=") || last["auth"] != "Bearer dodo_test_key" {
		t.Fatalf("portal request: %v", last)
	}
	if r := ann.Do("POST", "/app/v1/billing/portal", map[string]any{}); r.Status != 502 || r.Code() != "payment_unavailable" {
		t.Fatalf("dodo down: %s", r)
	}
	// a signature made with another key is refused on the dodo route
	if r := postEvent(t, c, "dodo", newWhsec(), evID(), time.Now(), ev2); r.Code() != "bad_signature" {
		t.Fatal(r)
	}
}
