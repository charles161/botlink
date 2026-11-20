package billing

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/charles161/botlink/server/internal/plans"
	"github.com/charles161/botlink/server/internal/store"
	"github.com/charles161/botlink/server/internal/wire"
)

// ErrBadEvent: verified, but not an event we can read (400).
var ErrBadEvent = errors.New("bad event")

type customer struct {
	CustomerID string `json:"customer_id"`
}

type event struct {
	Type      string          `json:"type"`
	Timestamp time.Time       `json:"timestamp"`
	Data      json.RawMessage `json:"data"`
}

type subData struct {
	SubscriptionID  string         `json:"subscription_id"`
	Status          string         `json:"status"`
	ProductID       string         `json:"product_id"`
	NextBillingDate *time.Time     `json:"next_billing_date"`
	CancelAtNext    bool           `json:"cancel_at_next_billing_date"`
	Interval        string         `json:"payment_frequency_interval"`
	Customer        customer       `json:"customer"`
	Metadata        map[string]any `json:"metadata"`
}

type payData struct {
	PaymentID         string         `json:"payment_id"`
	SubscriptionID    *string        `json:"subscription_id"`
	CheckoutSessionID *string        `json:"checkout_session_id"`
	Customer          customer       `json:"customer"`
	Metadata          map[string]any `json:"metadata"`
	ProductCart       []struct {
		ProductID string `json:"product_id"`
		Quantity  int    `json:"quantity"`
	} `json:"product_cart"`
}

type refundData struct {
	RefundID  string `json:"refund_id"`
	PaymentID string `json:"payment_id"`
}

// Events that mean "paid and active" (when the subscription's status is active).
var positive = map[string]bool{
	"subscription.active": true, "subscription.renewed": true, "subscription.updated": true,
	"subscription.plan_changed": true, "subscription.unpaused": true,
}

// Event types that end the paid plan at the end of the paid period, and the status each leaves.
var negative = map[string]string{
	"subscription.on_hold": "on_hold", "subscription.past_due": "past_due", "subscription.failed": "failed",
	"subscription.cancelled": "cancelled", "subscription.expired": "expired", "subscription.paused": "paused",
}

// Statuses a subscription.updated may carry that end the plan at period end.
var negStatus = map[string]bool{"on_hold": true, "past_due": true, "failed": true, "cancelled": true, "expired": true, "paused": true}

// Result says what an event did.
type Result struct {
	Duplicate bool
	Applied   bool
	Note      string
	// Set when this event moved the account's current plan (the caller sends analytics plan_changed after commit).
	Account, PlanFrom, PlanTo string
}

// Apply runs one verified event in one transaction. The event id is recorded in the same transaction, so a retry of
// an event that failed half way runs again, and an event that succeeded never runs twice (any server copy).
func Apply(ctx context.Context, pool *pgxpool.Pool, gw Gateway, eventID string, body []byte, packSize int64) (Result, error) {
	var ev event
	if err := json.Unmarshal(body, &ev); err != nil || ev.Type == "" || len(ev.Data) == 0 {
		return Result{}, ErrBadEvent
	}
	if ev.Timestamp.IsZero() {
		ev.Timestamp = time.Now()
	}
	var res Result
	err := pgx.BeginTxFunc(ctx, pool, pgx.TxOptions{IsoLevel: pgx.ReadCommitted}, func(tx pgx.Tx) error {
		res = Result{}
		tag, err := tx.Exec(ctx, `insert into billing_events (gateway, event_id, type, event_at, applied) values ($1, $2, $3, $4, false)
			on conflict (gateway, event_id) do nothing`, gw.Name(), eventID, trunc(ev.Type, 80), ev.Timestamp)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			res.Duplicate = true
			return nil
		}
		var account string
		switch {
		case strings.HasPrefix(ev.Type, "subscription."):
			account, err = applySubscription(ctx, tx, gw, ev, &res)
		case ev.Type == "payment.succeeded":
			account, err = applyPayment(ctx, tx, gw, ev, packSize, &res)
		case ev.Type == "refund.succeeded":
			account, err = applyRefund(ctx, tx, gw, ev, &res)
		default:
			res.Note = "event type not used"
		}
		if err != nil {
			return err
		}
		var acc *string
		if account != "" {
			acc = &account
		}
		_, err = tx.Exec(ctx, `update billing_events set applied = $3, account_id = $4, note = $5 where gateway = $1 and event_id = $2`,
			gw.Name(), eventID, res.Applied, acc, nilIfEmpty(trunc(res.Note, 200)))
		return err
	})
	if err == nil && res.Note != "" && !res.Applied && !res.Duplicate {
		slog.Info("billing event not applied", "gateway", gw.Name(), "type", ev.Type, "note", res.Note)
	}
	return res, err
}

func trunc(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}

func nilIfEmpty(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func metaString(m map[string]any, k string) string {
	if v, ok := m[k].(string); ok {
		return v
	}
	return ""
}

// findAccount names the account an event is about: our metadata first, then what we stored from earlier events.
func findAccount(ctx context.Context, q store.Q, gw string, meta map[string]any, sub, cust, session string) (string, error) {
	if a := metaString(meta, "botlink_account"); wire.IsUUID(a) {
		var ok bool
		if err := q.QueryRow(ctx, `select exists(select 1 from accounts where id = $1)`, a).Scan(&ok); err != nil {
			return "", err
		}
		if ok {
			return a, nil
		}
	}
	try := func(sql, v string) (string, error) {
		if v == "" {
			return "", nil
		}
		var a string
		err := q.QueryRow(ctx, sql, gw, v).Scan(&a)
		if errors.Is(err, pgx.ErrNoRows) {
			return "", nil
		}
		return a, err
	}
	for _, c := range []struct{ sql, v string }{
		{`select account_id from account_billing where gateway = $1 and subscription_id = $2 limit 1`, sub},
		{`select account_id from account_billing where gateway = $1 and customer_id = $2 limit 1`, cust},
		{`select account_id from billing_checkouts where gateway = $1 and session_id = $2 limit 1`, session},
	} {
		a, err := try(c.sql, c.v)
		if err != nil || a != "" {
			return a, err
		}
	}
	return "", nil
}

func (s subData) interval(gw Gateway) string {
	switch {
	case s.ProductID != "" && s.ProductID == gw.ProductID(ProYearly):
		return "year"
	case s.ProductID != "" && s.ProductID == gw.ProductID(ProMonthly):
		return "month"
	case metaString(s.Metadata, "botlink_product") == ProYearly:
		return "year"
	case metaString(s.Metadata, "botlink_product") == ProMonthly:
		return "month"
	}
	return ""
}

// applySubscription moves the account's paid plan. Rules:
//   - active/renewed (status active): Pro, paid until next_billing_date; the paid period only moves forward;
//   - on hold, past due, failed, cancelled, expired, paused: the status changes, Pro stays until paid_until, then
//     the account is on Free (CurrentPlan compares paid_until with now()); rooms are never touched;
//   - an event older than the newest one applied never changes the status (it may only move paid_until forward), so
//     out-of-order events cannot downgrade a paying account; neither can a stale event of an older subscription.
func applySubscription(ctx context.Context, tx pgx.Tx, gw Gateway, ev event, res *Result) (string, error) {
	var d subData
	if err := json.Unmarshal(ev.Data, &d); err != nil || d.SubscriptionID == "" {
		res.Note = "unreadable subscription"
		return "", nil
	}
	account, err := findAccount(ctx, tx, gw.Name(), d.Metadata, d.SubscriptionID, d.Customer.CustomerID, "")
	if err != nil || account == "" {
		res.Note = "no account for this subscription"
		return "", err
	}
	isPos := positive[ev.Type] && d.Status == "active"
	negTo, isNeg := negative[ev.Type]
	if ev.Type == "subscription.updated" && negStatus[d.Status] {
		negTo, isNeg = d.Status, true
	}
	if !isPos && !isNeg {
		res.Note = "no plan change for " + ev.Type + " with status " + d.Status
		return account, nil
	}
	interval := d.interval(gw)
	if isPos && interval == "" {
		res.Note = "unknown product " + d.ProductID
		return account, nil
	}
	fromPlan, _, err := plans.CurrentPlan(ctx, tx, account)
	if err != nil {
		return "", err
	}
	if _, err := tx.Exec(ctx, `insert into account_billing (account_id) values ($1) on conflict (account_id) do nothing`, account); err != nil {
		return "", err
	}
	var status string
	var sub *string
	var last *time.Time
	var live bool
	if err := tx.QueryRow(ctx, `select status, subscription_id, last_event_at, coalesce(paid_until > now(), false)
		from account_billing where account_id = $1 for update`, account).Scan(&status, &sub, &last, &live); err != nil {
		return "", err
	}
	newer := last == nil || ev.Timestamp.After(*last)
	cust := nilIfEmpty(d.Customer.CustomerID)
	if isPos {
		next := ev.Timestamp.AddDate(0, 1, 0)
		if interval == "year" {
			next = ev.Timestamp.AddDate(1, 0, 0)
		}
		if d.NextBillingDate != nil && d.NextBillingDate.After(ev.Timestamp.Add(-24*time.Hour)) {
			next = *d.NextBillingDate
		}
		if newer {
			_, err = tx.Exec(ctx, `update account_billing set plan_id = 'pro', status = 'active', billing_interval = $2,
				paid_until = greatest(coalesce(paid_until, $3), $3), cancel_at_period_end = $4, gateway = $5,
				customer_id = coalesce($6, customer_id), subscription_id = $7, last_event_at = $8, updated_at = now()
				where account_id = $1`, account, interval, next, d.CancelAtNext, gw.Name(), cust, d.SubscriptionID, ev.Timestamp)
		} else {
			res.Note = "older event: paid period only"
			_, err = tx.Exec(ctx, `update account_billing set plan_id = 'pro', paid_until = greatest(coalesce(paid_until, $2), $2),
				gateway = coalesce(gateway, $3), customer_id = coalesce(customer_id, $4), updated_at = now() where account_id = $1`,
				account, next, gw.Name(), cust)
		}
		if err != nil {
			return "", err
		}
		if _, err := plans.Snapshot(ctx, tx, account, "pro"); err != nil {
			return "", err
		}
	} else {
		otherSub := sub != nil && *sub != d.SubscriptionID && status == "active" && live
		switch {
		case !newer:
			res.Note = "older event: ignored"
			return account, nil
		case otherSub:
			res.Note = "event of an older subscription: ignored"
			return account, nil
		}
		if _, err := tx.Exec(ctx, `update account_billing set status = $2, cancel_at_period_end = (cancel_at_period_end or $3 or $2 = 'cancelled'),
			gateway = coalesce(gateway, $4), customer_id = coalesce(customer_id, $5), subscription_id = coalesce(subscription_id, $6),
			last_event_at = $7, updated_at = now() where account_id = $1`,
			account, negTo, d.CancelAtNext, gw.Name(), cust, d.SubscriptionID, ev.Timestamp); err != nil {
			return "", err
		}
	}
	res.Applied = true
	toPlan, _, err := plans.CurrentPlan(ctx, tx, account)
	if err != nil {
		return "", err
	}
	if toPlan != fromPlan {
		if err := plans.LogPlanChange(ctx, tx, account, fromPlan, toPlan, ev.Type); err != nil {
			return "", err
		}
		res.Account, res.PlanFrom, res.PlanTo = account, fromPlan, toPlan
	}
	var newStatus string
	if err := tx.QueryRow(ctx, `select status from account_billing where account_id = $1`, account).Scan(&newStatus); err != nil {
		return "", err
	}
	if newStatus != status {
		if err := plans.LogStatusChange(ctx, tx, account, status, newStatus, ev.Type); err != nil {
			return "", err
		}
	}
	return account, nil
}

// applyPayment adds a bought credits pack, once per payment. Subscription payments are handled by the
// subscription events.
func applyPayment(ctx context.Context, tx pgx.Tx, gw Gateway, ev event, packSize int64, res *Result) (string, error) {
	var d payData
	if err := json.Unmarshal(ev.Data, &d); err != nil || d.PaymentID == "" {
		res.Note = "unreadable payment"
		return "", nil
	}
	if d.SubscriptionID != nil && *d.SubscriptionID != "" {
		res.Note = "subscription payment"
		return "", nil
	}
	qty := 0
	packID := gw.ProductID(CreditsPack)
	for _, it := range d.ProductCart {
		if packID != "" && it.ProductID == packID {
			n := it.Quantity
			if n < 1 {
				n = 1
			}
			qty += n
		}
	}
	if qty == 0 && metaString(d.Metadata, "botlink_product") == CreditsPack {
		qty = 1
	}
	if qty == 0 {
		res.Note = "not a credits pack"
		return "", nil
	}
	session := ""
	if d.CheckoutSessionID != nil {
		session = *d.CheckoutSessionID
	}
	account, err := findAccount(ctx, tx, gw.Name(), d.Metadata, "", d.Customer.CustomerID, session)
	if err != nil || account == "" {
		res.Note = "no account for this payment"
		return "", err
	}
	if packSize <= 0 {
		res.Note = "credits pack size is not set (BOTLINK_CREDITS_PACK_SIZE)"
		return account, nil
	}
	added, err := plans.AddPaid(ctx, tx, account, "topup", packSize*int64(qty), "Credits pack", "payment:"+gw.Name()+":"+d.PaymentID)
	if err != nil {
		return "", err
	}
	if c := metaString(d.Metadata, "botlink_checkout"); wire.IsUUID(c) {
		if _, err := tx.Exec(ctx, `update billing_checkouts set paid_at = coalesce(paid_at, now()) where id = $1 and account_id = $2`, c, account); err != nil {
			return "", err
		}
	}
	if _, err := tx.Exec(ctx, `insert into account_billing (account_id, gateway, customer_id) values ($1, $2, $3)
		on conflict (account_id) do update set gateway = coalesce(account_billing.gateway, excluded.gateway),
		customer_id = coalesce(account_billing.customer_id, excluded.customer_id)`, account, gw.Name(), nilIfEmpty(d.Customer.CustomerID)); err != nil {
		return "", err
	}
	res.Applied = added
	if !added {
		res.Note = "payment already counted"
	}
	return account, nil
}

// applyRefund takes back the credits of a refunded pack, once per refund. A partial refund takes back the whole
// pack (the refund amount is not mapped to credits).
func applyRefund(ctx context.Context, tx pgx.Tx, gw Gateway, ev event, res *Result) (string, error) {
	var d refundData
	if err := json.Unmarshal(ev.Data, &d); err != nil || d.RefundID == "" || d.PaymentID == "" {
		res.Note = "unreadable refund"
		return "", nil
	}
	var account string
	var amount int64
	err := tx.QueryRow(ctx, `select account_id, amount from credit_ledger where ref = $1`, "payment:"+gw.Name()+":"+d.PaymentID).Scan(&account, &amount)
	if errors.Is(err, pgx.ErrNoRows) {
		res.Note = "refund of a payment that added no credits"
		return "", nil
	}
	if err != nil {
		return "", err
	}
	added, err := plans.AddPaid(ctx, tx, account, "refund", -amount, fmt.Sprintf("Refund of a credits pack (%d credits)", amount), "refund:"+gw.Name()+":"+d.RefundID)
	if err != nil {
		return "", err
	}
	res.Applied = added
	return account, nil
}
