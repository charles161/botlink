package appapi

// Plans, limits, usage, credits and billing for the person (CONTRACT-PLANS.md, lane D1), plus the payment gateway's
// event route. Routes are registered by server.go through PlansAPI.Routes.

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/charles161/botlink/server/internal/analytics"
	"github.com/charles161/botlink/server/internal/auth"
	"github.com/charles161/botlink/server/internal/billing"
	"github.com/charles161/botlink/server/internal/httpx"
	"github.com/charles161/botlink/server/internal/plans"
	"github.com/charles161/botlink/server/internal/ratelimit"
	"github.com/charles161/botlink/server/internal/wire"
)

// MaxEventBody caps a gateway event's body (Dodo's events are a few KB). Read through a limited reader before any
// HMAC work; larger → 413 too_large.
const MaxEventBody = 256 << 10

// BillingEventsPerIP limits event route calls per client IP (Postgres counter, shared by every copy), before the body
// is read: an unsigned flood costs one counter bump per call, no HMAC and no row. Generous: Dodo sends a handful a
// minute from a pool of addresses.
var BillingEventsPerIP = ratelimit.BillingEvents // listed in ratelimit.All, so the admin rate-limit panel shows it

// PlansAPI serves the plan routes. GW is nil when payments are off.
type PlansAPI struct {
	*API
	GW billing.Gateway
}

// Routes registers the plan routes only while the paywall is on; while it is off they do not exist (404 like any
// unknown route).
func (p *PlansAPI) Routes(mux *http.ServeMux) {
	if !p.Cfg.Plans.Paywall() {
		return
	}
	mux.Handle("GET /app/v1/plan", p.sess(p.getPlan))
	mux.Handle("GET /app/v1/usage", p.sess(p.getUsage))
	mux.Handle("GET /app/v1/credits", p.sess(p.getCredits))
	mux.Handle("POST /app/v1/billing/checkout", p.sess(p.postCheckout))
	mux.Handle("POST /app/v1/billing/portal", p.sess(p.postPortal))
	mux.Handle("POST /app/v1/billing/fake/pay", p.sess(p.postFakePay))
	mux.Handle("POST /app/v1/billing/events/{gateway}", httpx.Handler(p.postEvent))
	mux.Handle("GET /app/v1/pricing", httpx.Handler(p.getPricing))
}

// GET /app/v1/pricing: public (no session), cacheable for a minute. The live plan numbers and prices only.
func (p *PlansAPI) getPricing(w http.ResponseWriter, r *http.Request) error {
	ps, err := plans.Pricing(r.Context(), p.St.Pool)
	if err != nil {
		return err
	}
	b, err := json.Marshal(map[string]any{"mode": p.Cfg.Plans.Mode(), "plans": ps})
	if err != nil {
		return err
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "public, max-age=60")
	_, _ = w.Write(b)
	return nil
}

func (p *PlansAPI) gatewayName() string {
	if p.GW == nil {
		return "off"
	}
	return p.GW.Name()
}

func (p *PlansAPI) viewOpts() plans.ViewOpts {
	c := p.Cfg.Plans.Paid()
	o := plans.ViewOpts{Mode: c.Mode(), Gateway: p.gatewayName(), PackSize: c.CreditsPackSize, StorageCeilingMB: p.Cfg.Plans.StorageCeiling()}
	o.PackOn = p.GW != nil && p.GW.ProductID(billing.CreditsPack) != ""
	return o
}

func (p *PlansAPI) prices() plans.Prices {
	c := p.Cfg.Plans.Paid()
	return plans.Prices{Message: c.PriceMessage, ChatDay: c.PriceChatDay, Wake: c.PriceWake}
}

func (p *PlansAPI) getPlan(w http.ResponseWriter, r *http.Request, s *auth.Session) error {
	v, err := plans.View(r.Context(), p.St.Pool, s.AccountID, p.viewOpts())
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, 200, v)
	return nil
}

func intParam(r *http.Request, name string, def, lo, hi int) (int, error) {
	v := r.URL.Query().Get(name)
	if v == "" {
		return def, nil
	}
	n, err := strconv.Atoi(v)
	if err != nil || n < lo || n > hi {
		return 0, httpx.BadRequest(name + " must be a whole number from " + strconv.Itoa(lo) + " to " + strconv.Itoa(hi) + ".")
	}
	return n, nil
}

func (p *PlansAPI) getUsage(w http.ResponseWriter, r *http.Request, s *auth.Session) error {
	ctx := r.Context()
	n, err := intParam(r, "days", 30, 1, 90)
	if err != nil {
		return err
	}
	if err := plans.Rollup(ctx, p.St.Pool, s.AccountID); err != nil {
		return err
	}
	days, err := plans.Usage(ctx, p.St.Pool, s.AccountID, n)
	if err != nil {
		return err
	}
	var msgs, wakes, maxChats int
	var used int64
	for _, d := range days {
		msgs += d.MessagesSent
		wakes += d.Wakes
		used += d.CreditsUsed
		if d.ChatsActive > maxChats {
			maxChats = d.ChatsActive
		}
	}
	pr := p.prices()
	httpx.WriteJSON(w, 200, map[string]any{
		"days":      days,
		"totals":    map[string]any{"messages_sent": msgs, "chats_active_max": maxChats, "wakes": wakes, "credits_used": used},
		"prices":    map[string]any{"message": pr.Message, "chat_day": pr.ChatDay, "wake": pr.Wake},
		"debits_on": pr.On(),
	})
	return nil
}

func (p *PlansAPI) getCredits(w http.ResponseWriter, r *http.Request, s *auth.Session) error {
	ctx := r.Context()
	n, err := intParam(r, "limit", 50, 1, 200)
	if err != nil {
		return err
	}
	bal, err := plans.Balance(ctx, p.St.Pool, s.AccountID)
	if err != nil {
		return err
	}
	es, err := plans.Ledger(ctx, p.St.Pool, s.AccountID, n)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, 200, map[string]any{"balance": bal, "entries": es})
	return nil
}

func billingOff() *httpx.Error { return httpx.E(409, "billing_off", "Payments are not on yet.") }

func paymentUnavailable(err error) *httpx.Error {
	slog.Warn("payment gateway call failed", "err", err)
	return httpx.E(502, "payment_unavailable", "The payment service did not answer. Try again in a minute.")
}

func (p *PlansAPI) postCheckout(w http.ResponseWriter, r *http.Request, s *auth.Session) error {
	ctx := r.Context()
	body, err := httpx.ReadBody(r)
	if err != nil {
		return err
	}
	var b struct {
		Product string `json:"product"`
	}
	if err := httpx.DecodeStrict(body, &b); err != nil {
		return err
	}
	if p.GW == nil {
		return billingOff()
	}
	if !billing.ValidProduct(b.Product) {
		return httpx.BadRequest("Pick pro_monthly, pro_yearly or credits_pack.")
	}
	if p.GW.ProductID(b.Product) == "" || (b.Product == billing.CreditsPack && p.Cfg.Plans.Paid().CreditsPackSize <= 0) {
		return httpx.E(409, "not_for_sale", "That is not for sale right now.")
	}
	bill, err := plans.LoadBilling(ctx, p.St.Pool, s.AccountID, p.gatewayName())
	if err != nil {
		return err
	}
	if b.Product != billing.CreditsPack {
		plan, _, err := plans.CurrentPlan(ctx, p.St.Pool, s.AccountID)
		if err != nil {
			return err
		}
		if plan != "free" && bill.Status == "active" && !bill.CancelAtPeriodEnd {
			return httpx.E(409, "already_on_plan", "You already have Pro. Use Manage billing to change it.")
		}
	}
	id := wire.NewV7().String()
	if _, err := p.St.Pool.Exec(ctx, `insert into billing_checkouts (id, account_id, gateway, product) values ($1, $2, $3, $4)`,
		id, s.AccountID, p.GW.Name(), b.Product); err != nil {
		return err
	}
	cust := ""
	if bill.CanOpenPortal && bill.CustomerID != nil {
		cust = *bill.CustomerID
	}
	session, url, err := p.GW.CreateCheckout(ctx, billing.CheckoutReq{CheckoutID: id, AccountID: s.AccountID, Email: s.Email,
		Name: s.DisplayName, Product: b.Product, CustomerID: cust, ReturnURL: p.Cfg.AppOrigin + "/billing?checkout=" + id})
	if err != nil {
		return paymentUnavailable(err)
	}
	if _, err := p.St.Pool.Exec(ctx, `update billing_checkouts set session_id = $2 where id = $1`, id, session); err != nil {
		return err
	}
	httpx.WriteJSON(w, 200, map[string]any{"checkout_id": id, "checkout_url": url})
	return nil
}

func (p *PlansAPI) postPortal(w http.ResponseWriter, r *http.Request, s *auth.Session) error {
	ctx := r.Context()
	body, err := httpx.ReadBody(r)
	if err != nil {
		return err
	}
	if len(body) > 0 {
		var b struct{}
		if err := httpx.DecodeStrict(body, &b); err != nil {
			return err
		}
	}
	if p.GW == nil {
		return billingOff()
	}
	bill, err := plans.LoadBilling(ctx, p.St.Pool, s.AccountID, p.gatewayName())
	if err != nil {
		return err
	}
	if !bill.CanOpenPortal || bill.CustomerID == nil {
		return httpx.E(409, "no_billing_account", "You have not paid for anything yet, so there is nothing to manage.")
	}
	url, err := p.GW.Portal(ctx, *bill.CustomerID, p.Cfg.AppOrigin+"/billing")
	if err != nil {
		return paymentUnavailable(err)
	}
	httpx.WriteJSON(w, 200, map[string]any{"portal_url": url})
	return nil
}

// POST /app/v1/billing/fake/pay: dev only, fake gateway only. Sends our own event route a signed event.
func (p *PlansAPI) postFakePay(w http.ResponseWriter, r *http.Request, s *auth.Session) error {
	ctx := r.Context()
	fake, ok := p.GW.(*billing.Fake)
	if !ok || p.Cfg.Env != "dev" {
		return httpx.NotFound()
	}
	body, err := httpx.ReadBody(r)
	if err != nil {
		return err
	}
	var b struct {
		CheckoutID string `json:"checkout_id"`
	}
	if err := httpx.DecodeStrict(body, &b); err != nil {
		return err
	}
	if !wire.IsUUID(b.CheckoutID) {
		return httpx.NotFound()
	}
	var product string
	err = p.St.Pool.QueryRow(ctx, `select product from billing_checkouts where id = $1 and account_id = $2 and gateway = 'fake' and paid_at is null`,
		b.CheckoutID, s.AccountID).Scan(&product)
	if err != nil {
		return httpx.NotFound()
	}
	typ, err := fake.Pay(ctx, s.AccountID, b.CheckoutID, product)
	if err != nil {
		return paymentUnavailable(err)
	}
	if _, err := p.St.Pool.Exec(ctx, `update billing_checkouts set paid_at = coalesce(paid_at, now()) where id = $1`, b.CheckoutID); err != nil {
		return err
	}
	httpx.WriteJSON(w, 200, map[string]any{"ok": true, "event_type": typ})
	return nil
}

// POST /app/v1/billing/events/{gateway}: the gateway's signed event (Standard Webhooks). No session, no CSRF: the
// signature is the authentication. Only the configured gateway's path exists.
func (p *PlansAPI) postEvent(w http.ResponseWriter, r *http.Request) error {
	if p.GW == nil || r.PathValue("gateway") != p.GW.Name() {
		return httpx.NotFound()
	}
	// limit first (one counter bump), then a capped read, then the HMAC: an unsigned flood does no unbounded work
	if err := ratelimit.Hit(r.Context(), p.St.Pool, BillingEventsPerIP, httpx.ClientIP(r, p.Cfg.TrustCF)); err != nil {
		return err
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, MaxEventBody+1))
	if err != nil {
		return httpx.BadRequest("Could not read the request body.")
	}
	if len(body) > MaxEventBody {
		return httpx.E(413, "too_large", "The event is too large (256 KiB max).")
	}
	id, err := billing.Verify(p.GW.Key(), r.Header, body, time.Now())
	switch {
	case errors.Is(err, billing.ErrStale):
		return httpx.E(401, "stale_timestamp", "The event time is more than 5 minutes from now.")
	case err != nil:
		return httpx.E(401, "bad_signature", "The event signature does not match.")
	}
	res, err := billing.Apply(r.Context(), p.St.Pool, p.GW, id, body, p.Cfg.Plans.Paid().CreditsPackSize)
	if errors.Is(err, billing.ErrBadEvent) {
		return httpx.BadRequest("The event is not valid JSON.")
	}
	if err != nil {
		return err
	}
	if res.PlanTo != "" && res.PlanTo != res.PlanFrom { // committed: an upgrade by payment (a downgrade happens by time, unseen here)
		p.An.Capture(analytics.PlanChanged, p.An.ID(res.Account), analytics.Props{"plan": res.PlanTo})
	}
	httpx.WriteJSON(w, 200, map[string]any{"ok": true, "duplicate": res.Duplicate})
	return nil
}
