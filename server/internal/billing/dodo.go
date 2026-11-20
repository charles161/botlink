package billing

// Dodo Payments, written against their public docs (read 12 Nov 2026). It has NEVER run against Dodo: no test key
// existed when it was written. Sources:
//   - Create Checkout Session, POST /checkouts (one-time and subscription products in product_cart; customer is
//     {customer_id} for an existing customer or {email, name} for a new one; return_url; metadata; response
//     {session_id, checkout_url}): https://docs.dodopayments.com/api-reference/checkout-sessions/create
//     and https://docs.dodopayments.com/developer-resources/checkout-session
//   - Create Customer Portal Session, POST /customers/{customer_id}/customer-portal/session?return_url=… (response
//     {link}): https://docs.dodopayments.com/api-reference/customers/create-customer-portal-session
//   - Hosts: https://test.dodopayments.com (test mode), https://live.dodopayments.com (live mode); auth
//     "Authorization: Bearer <API key>": https://docs.dodopayments.com/api-reference/introduction
//   - Events: Standard Webhooks headers and signature (signature.go), payload {business_id, type, timestamp, data},
//     subscription and payment events: https://docs.dodopayments.com/developer-resources/webhooks and
//     https://docs.dodopayments.com/developer-resources/webhooks/intents/webhook-events-guide
//
// Not confirmed from the docs (check on the first test-mode run): that checkout session metadata is copied onto the
// subscription and payment objects in events (events.go also finds the account by subscription id, customer id and
// checkout session id, in that order), and the exact field that carries the checkout session id on a payment.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
)

// Dodo is the Dodo Payments gateway. Keys and product ids come from config only.
type Dodo struct {
	apiKey   string
	key      []byte
	base     string
	products map[string]string
	client   *http.Client
}

func (d *Dodo) Name() string                    { return "dodo" }
func (d *Dodo) Key() []byte                     { return d.key }
func (d *Dodo) ProductID(product string) string { return d.products[product] }

func (d *Dodo) call(ctx context.Context, method, path string, body any, out any) error {
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, d.base+path, rd)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+d.apiKey)
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := d.client.Do(req)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if res.StatusCode < 200 || res.StatusCode > 299 {
		// never log the body (it may echo customer details); the status is enough to start looking
		return fmt.Errorf("%w: dodo %s %s answered %d", ErrUnavailable, method, path, res.StatusCode)
	}
	if err := json.Unmarshal(b, out); err != nil {
		return fmt.Errorf("%w: dodo %s %s: unreadable answer", ErrUnavailable, method, path)
	}
	return nil
}

// CreateCheckout opens a hosted checkout: a subscription (Pro monthly or yearly) or a one-time payment (credits pack),
// both through POST /checkouts. Our ids go in metadata so the events name the account.
func (d *Dodo) CreateCheckout(ctx context.Context, r CheckoutReq) (string, string, error) {
	pid := d.products[r.Product]
	if pid == "" {
		return "", "", fmt.Errorf("%w: no product id for %s", ErrUnavailable, r.Product)
	}
	var customer map[string]any
	if r.CustomerID != "" {
		customer = map[string]any{"customer_id": r.CustomerID}
	} else {
		customer = map[string]any{"email": r.Email, "name": r.Name}
	}
	body := map[string]any{
		"product_cart": []map[string]any{{"product_id": pid, "quantity": 1}},
		"customer":     customer,
		"return_url":   r.ReturnURL,
		"metadata":     map[string]string{"botlink_account": r.AccountID, "botlink_product": r.Product, "botlink_checkout": r.CheckoutID},
	}
	var out struct {
		SessionID   string  `json:"session_id"`
		CheckoutURL *string `json:"checkout_url"`
	}
	if err := d.call(ctx, http.MethodPost, "/checkouts", body, &out); err != nil {
		return "", "", err
	}
	if out.SessionID == "" || out.CheckoutURL == nil || *out.CheckoutURL == "" {
		return "", "", fmt.Errorf("%w: dodo returned no checkout_url", ErrUnavailable)
	}
	return out.SessionID, *out.CheckoutURL, nil
}

// Portal returns a customer portal link (manage card, switch plan, cancel).
func (d *Dodo) Portal(ctx context.Context, customerID, returnURL string) (string, error) {
	var out struct {
		Link string `json:"link"`
	}
	path := "/customers/" + url.PathEscape(customerID) + "/customer-portal/session?return_url=" + url.QueryEscape(returnURL)
	if err := d.call(ctx, http.MethodPost, path, nil, &out); err != nil {
		return "", err
	}
	if out.Link == "" {
		return "", fmt.Errorf("%w: dodo returned no portal link", ErrUnavailable)
	}
	return out.Link, nil
}
