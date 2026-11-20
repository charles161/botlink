package billing

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/charles161/botlink/server/internal/wire"
)

// Fake is the test and local gateway (BOTLINK_ENV=dev only). A checkout is a row in billing_checkouts; "paying" it
// sends our own event route a correctly signed event in Dodo's shape, so the same event code runs as with Dodo.
type Fake struct {
	key    []byte
	origin string
	packOn bool
	client *http.Client
}

func (f *Fake) Name() string { return "fake" }
func (f *Fake) Key() []byte  { return f.key }

func (f *Fake) ProductID(product string) string {
	if product == CreditsPack && !f.packOn {
		return ""
	}
	return "fake_" + product
}

func (f *Fake) CreateCheckout(_ context.Context, r CheckoutReq) (string, string, error) {
	return "cks_fake_" + r.CheckoutID, f.origin + "/billing/fake?checkout=" + r.CheckoutID, nil
}

func (f *Fake) Portal(_ context.Context, customerID, _ string) (string, error) {
	return f.origin + "/billing/fake/portal?customer=" + customerID, nil
}

// FakeCustomer is the fake gateway's customer id for an account.
func FakeCustomer(account string) string { return "cus_fake_" + account }

// FakeEvent builds a Dodo-shaped event body for the fake gateway (tests use it to send renewals, cancellations and
// out-of-order events). For subscriptions: sub, product (ProMonthly | ProYearly), status and next billing date.
func FakeEvent(typ string, at time.Time, data map[string]any) []byte {
	b, _ := json.Marshal(map[string]any{"business_id": "bus_fake", "type": typ, "timestamp": at.UTC().Format(time.RFC3339Nano), "data": data})
	return b
}

// FakeSubscription is the data of a fake subscription event.
func FakeSubscription(account, checkout, sub, product, status string, next time.Time, cancelAtNext bool) map[string]any {
	interval := "Month"
	if product == ProYearly {
		interval = "Year"
	}
	return map[string]any{
		"payload_type": "Subscription", "subscription_id": sub, "status": status, "product_id": "fake_" + product,
		"next_billing_date": next.UTC().Format(time.RFC3339), "previous_billing_date": time.Now().UTC().Format(time.RFC3339),
		"cancel_at_next_billing_date": cancelAtNext, "payment_frequency_interval": interval,
		"customer": map[string]any{"customer_id": FakeCustomer(account), "email": "", "name": ""},
		"metadata": map[string]any{"botlink_account": account, "botlink_product": product, "botlink_checkout": checkout},
	}
}

// FakePayment is the data of a fake one-time payment event (a credits pack).
func FakePayment(account, checkout, payment string) map[string]any {
	return map[string]any{
		"payload_type": "Payment", "payment_id": payment, "status": "succeeded", "subscription_id": nil,
		"product_cart": []map[string]any{{"product_id": "fake_" + CreditsPack, "quantity": 1}},
		"customer":     map[string]any{"customer_id": FakeCustomer(account), "email": "", "name": ""},
		"metadata":     map[string]any{"botlink_account": account, "botlink_product": CreditsPack, "botlink_checkout": checkout},
	}
}

// Send signs body and posts it to our own event route, as the gateway would.
func (f *Fake) Send(ctx context.Context, body []byte) error {
	id := "evt_fake_" + wire.NewV7().String()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, f.origin+"/app/v1/billing/events/fake", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header = Headers(f.key, id, time.Now().Unix(), body)
	res, err := f.client.Do(req)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	res.Body.Close()
	if res.StatusCode != 200 {
		return fmt.Errorf("%w: our event route answered %d", ErrUnavailable, res.StatusCode)
	}
	return nil
}

// Pay pays a checkout: a subscription.active event for Pro (next billing in a month or a year) or a
// payment.succeeded event for a credits pack. Returns the event type.
func (f *Fake) Pay(ctx context.Context, account, checkout, product string) (string, error) {
	now := time.Now()
	var typ string
	var data map[string]any
	switch product {
	case CreditsPack:
		typ, data = "payment.succeeded", FakePayment(account, checkout, "pay_fake_"+checkout)
	case ProYearly:
		typ, data = "subscription.active", FakeSubscription(account, checkout, "sub_fake_"+checkout, product, "active", now.AddDate(1, 0, 0), false)
	default:
		typ, data = "subscription.active", FakeSubscription(account, checkout, "sub_fake_"+checkout, product, "active", now.AddDate(0, 1, 0), false)
	}
	return typ, f.Send(ctx, FakeEvent(typ, now, data))
}
