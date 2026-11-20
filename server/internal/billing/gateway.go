package billing

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/charles161/botlink/server/internal/config"
)

// Products we sell. Priced per person (per account), never per member or per message.
const (
	ProMonthly  = "pro_monthly"
	ProYearly   = "pro_yearly"
	CreditsPack = "credits_pack"
)

// ValidProduct reports whether p is one of our products.
func ValidProduct(p string) bool { return p == ProMonthly || p == ProYearly || p == CreditsPack }

// CheckoutReq is what a gateway needs to open a hosted checkout.
type CheckoutReq struct {
	CheckoutID string // our billing_checkouts id (also in the event metadata)
	AccountID  string
	Email      string
	Name       string
	Product    string // ProMonthly | ProYearly | CreditsPack
	CustomerID string // the gateway's customer id if this account paid before, else ""
	ReturnURL  string
}

// Gateway is one payment provider. Implementations hold no state that copies must agree on.
type Gateway interface {
	Name() string                    // "fake" | "dodo"
	Key() []byte                     // event signing key (Standard Webhooks)
	ProductID(product string) string // the gateway's product id for one of ours ("" = not for sale)
	CreateCheckout(ctx context.Context, r CheckoutReq) (sessionID, url string, err error)
	Portal(ctx context.Context, customerID, returnURL string) (string, error)
}

// ErrUnavailable wraps gateway call failures (502 payment_unavailable).
var ErrUnavailable = errors.New("payment gateway unavailable")

// New builds the configured gateway; nil when payments are off, and always nil while the paywall is off (Paid()).
func New(cfg *config.Config) (Gateway, error) {
	p := cfg.Plans.Paid()
	switch p.GatewayName() {
	case "fake":
		k, err := DecodeKey(p.FakeKey)
		if err != nil {
			return nil, err
		}
		return &Fake{key: k, origin: cfg.AppOrigin, packOn: p.CreditsPackSize > 0, client: &http.Client{Timeout: 15 * time.Second}}, nil
	case "dodo":
		k, err := DecodeKey(p.DodoWebhookKey)
		if err != nil {
			return nil, err
		}
		base := "https://test.dodopayments.com"
		if p.DodoMode == "live" {
			base = "https://live.dodopayments.com"
		}
		if p.DodoAPIBase != "" {
			base = p.DodoAPIBase
		}
		return &Dodo{apiKey: p.DodoAPIKey, key: k, base: base, products: map[string]string{
			ProMonthly: p.DodoProductProMonthly, ProYearly: p.DodoProductProYearly, CreditsPack: p.DodoProductCredits,
		}, client: &http.Client{Timeout: 15 * time.Second}}, nil
	}
	return nil, nil
}
