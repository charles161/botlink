package config

import (
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
)

// PlansConfig: the paywall switch, the paid settings behind it, and the fair-use storage limits (CONTRACT-PLANS.md).
//
// BOTLINK_PAYWALL (on | off, default off; founder, 16 Nov 2026: launch without a paywall). The paid settings are
// unexported and readable ONLY through Paid(): while the paywall is off it returns the switched-off settings (limits
// mode off, gateway off, no prices, no pack), so no plan limit, credit balance or gateway can refuse, slow, count or
// charge anything, whatever the environment says. The fair-use fields below apply in both modes.
type PlansConfig struct {
	paywall bool
	paid    PaidSettings
	// ignored: paid settings found in the environment while the paywall is off (names only; IgnoredWarning)
	ignored []string
	// StorageCeilingMB (BOTLINK_STORAGE_CEILING_MB, 1..1000000, default 64): the safety ceiling on what one account's
	// chats may have stored (MB). It refuses in EVERY limits mode, off and count included: the disk is finite. A free
	// account never exceeds it; with the paywall on, an account on a paid plan gets the larger of it and its plan's
	// storage_mb. 0 = default.
	StorageCeilingMB int
	// FreeCopyHours (BOTLINK_FREE_COPY_HOURS, 1..168; 0 = unset = as long as the sender asked, at most 7 days): how long
	// the server keeps a copy sent by a FREE account (every account while the paywall is off) that nobody has read.
	FreeCopyHours int
	// StorageTotalMB (BOTLINK_STORAGE_TOTAL_MB, 1..10000000, default 8192): the ceiling on stored message bytes across
	// ALL accounts (MB), refused in every limits mode. 0 = the default.
	StorageTotalMB int
}

// PaidSettings: plan limits enforcement, credits prices and the payment gateway. No secret has a default. Limits
// themselves are in Postgres (live, admin-edited), not here. Read them only through PlansConfig.Paid().
type PaidSettings struct {
	// LimitsMode (BOTLINK_LIMITS_MODE): off | count | block. Empty means count (the default). count records and
	// shows an account going over a plan limit and refuses nothing; block refuses with a plain message. The hard
	// caps (SPEC §9) refuse in every mode.
	LimitsMode string
	// Gateway (BOTLINK_BILLING_GATEWAY): off | fake | dodo. Empty means off. fake needs BOTLINK_ENV=dev.
	Gateway string
	// FakeKey (BOTLINK_BILLING_FAKE_KEY, whsec_<base64>): signs and verifies the fake gateway's events.
	FakeKey string
	// Dodo Payments (docs.dodopayments.com). Mode test | live picks the API host.
	DodoMode              string // BOTLINK_DODO_MODE, default test
	DodoAPIKey            string // BOTLINK_DODO_API_KEY
	DodoWebhookKey        string // BOTLINK_DODO_WEBHOOK_KEY (whsec_…)
	DodoProductProMonthly string // BOTLINK_DODO_PRODUCT_PRO_MONTHLY
	DodoProductProYearly  string // BOTLINK_DODO_PRODUCT_PRO_YEARLY
	DodoProductCredits    string // BOTLINK_DODO_PRODUCT_CREDITS_PACK (optional)
	DodoAPIBase           string // BOTLINK_DODO_API_BASE: override for tests only (dev)
	// CreditsPackSize (BOTLINK_CREDITS_PACK_SIZE): credits one pack adds. 0 = no pack for sale.
	CreditsPackSize int64
	// Credits per unit of daily usage. All 0 by default: what a credit buys is not decided, so nothing is debited.
	PriceMessage int64 // BOTLINK_CREDIT_PRICE_MESSAGE
	PriceChatDay int64 // BOTLINK_CREDIT_PRICE_CHAT_DAY
	PriceWake    int64 // BOTLINK_CREDIT_PRICE_WAKE
}

// switchedOff is what Paid() gives while the paywall is off.
var switchedOff = PaidSettings{LimitsMode: "off", Gateway: "off"}

// Paywall reports whether BOTLINK_PAYWALL is on.
func (p PlansConfig) Paywall() bool { return p.paywall }

// Paid is the one way to read a paid setting: the configured settings with the paywall on, the switched-off ones
// (limits mode off, gateway off, no prices, no pack) with it off.
func (p PlansConfig) Paid() PaidSettings {
	if !p.paywall {
		return switchedOff
	}
	return p.paid
}

// SetPaywall turns the paywall on or off (FromEnv does it from BOTLINK_PAYWALL; tests call it).
func (p *PlansConfig) SetPaywall(on bool) { p.paywall = on }

// EditPaid changes the stored paid settings. They apply only while the paywall is on.
func (p *PlansConfig) EditPaid(f func(*PaidSettings)) { f(&p.paid) }

// IgnoredWarning is the one line logged at start when paid settings are set while the paywall is off ("" if none).
// It names the settings, never their values.
func (p PlansConfig) IgnoredWarning() string {
	if p.paywall || len(p.ignored) == 0 {
		return ""
	}
	return "BOTLINK_PAYWALL is off, so these settings are ignored: " + strings.Join(p.ignored, ", ") +
		". Everything is free; only the fair-use limits apply. Unset them, or set BOTLINK_PAYWALL=on."
}

// Mode is the limits mode in effect (Paid().Mode()).
func (p PlansConfig) Mode() string { return p.Paid().Mode() }

// GatewayName is the payment gateway in effect (Paid().GatewayName()).
func (p PlansConfig) GatewayName() string { return p.Paid().GatewayName() }

// StorageCeiling is StorageCeilingMB with the default applied.
func (p PlansConfig) StorageCeiling() int {
	if p.StorageCeilingMB <= 0 {
		return 64 // plans.DefaultStorageCeilingMB
	}
	return p.StorageCeilingMB
}

// StorageTotal is StorageTotalMB with the default applied.
func (p PlansConfig) StorageTotal() int {
	if p.StorageTotalMB <= 0 {
		return 8192 // plans.DefaultStorageTotalMB
	}
	return p.StorageTotalMB
}

// Mode is LimitsMode with the default applied.
func (p PaidSettings) Mode() string {
	if p.LimitsMode == "" {
		return "count"
	}
	return p.LimitsMode
}

// GatewayName is Gateway with the default applied.
func (p PaidSettings) GatewayName() string {
	if p.Gateway == "" {
		return "off"
	}
	return p.Gateway
}

func plansFromEnv() (PlansConfig, error) {
	var p PlansConfig
	switch v := os.Getenv("BOTLINK_PAYWALL"); v {
	case "", "off":
	case "on":
		p.paywall = true
	default:
		return p, fmt.Errorf("BOTLINK_PAYWALL must be on or off (got %q)", v)
	}
	if p.paywall {
		s, err := paidFromEnv()
		if err != nil {
			return p, err
		}
		p.paid = s
	} else {
		for _, k := range []string{"BOTLINK_LIMITS_MODE", "BOTLINK_BILLING_GATEWAY", "BOTLINK_BILLING_FAKE_KEY",
			"BOTLINK_DODO_MODE", "BOTLINK_DODO_API_KEY", "BOTLINK_DODO_WEBHOOK_KEY", "BOTLINK_DODO_PRODUCT_PRO_MONTHLY",
			"BOTLINK_DODO_PRODUCT_PRO_YEARLY", "BOTLINK_DODO_PRODUCT_CREDITS_PACK", "BOTLINK_DODO_API_BASE",
			"BOTLINK_CREDITS_PACK_SIZE", "BOTLINK_CREDIT_PRICE_MESSAGE", "BOTLINK_CREDIT_PRICE_CHAT_DAY",
			"BOTLINK_CREDIT_PRICE_WAKE"} { // every paid setting (paidFromEnv), named in the warning while off
			if _, set := os.LookupEnv(k); set {
				p.ignored = append(p.ignored, k)
			}
		}
	}
	if v := strings.TrimSpace(os.Getenv("BOTLINK_STORAGE_CEILING_MB")); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 || n > 1000000 {
			return p, fmt.Errorf("BOTLINK_STORAGE_CEILING_MB must be a whole number from 1 to 1000000 (got %q)", v)
		}
		p.StorageCeilingMB = n
	}
	if v := strings.TrimSpace(os.Getenv("BOTLINK_FREE_COPY_HOURS")); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 || n > 168 {
			return p, fmt.Errorf("BOTLINK_FREE_COPY_HOURS must be a whole number from 1 to 168 (got %q)", v)
		}
		p.FreeCopyHours = n
	}
	if v := strings.TrimSpace(os.Getenv("BOTLINK_STORAGE_TOTAL_MB")); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 || n > 10000000 {
			return p, fmt.Errorf("BOTLINK_STORAGE_TOTAL_MB must be a whole number from 1 to 10000000 (got %q)", v)
		}
		p.StorageTotalMB = n
	}
	return p, nil
}

func paidFromEnv() (PaidSettings, error) {
	p := PaidSettings{
		LimitsMode:            strings.TrimSpace(os.Getenv("BOTLINK_LIMITS_MODE")),
		Gateway:               strings.TrimSpace(os.Getenv("BOTLINK_BILLING_GATEWAY")),
		FakeKey:               os.Getenv("BOTLINK_BILLING_FAKE_KEY"),
		DodoMode:              getenv("BOTLINK_DODO_MODE", "test"),
		DodoAPIKey:            os.Getenv("BOTLINK_DODO_API_KEY"),
		DodoWebhookKey:        os.Getenv("BOTLINK_DODO_WEBHOOK_KEY"),
		DodoProductProMonthly: os.Getenv("BOTLINK_DODO_PRODUCT_PRO_MONTHLY"),
		DodoProductProYearly:  os.Getenv("BOTLINK_DODO_PRODUCT_PRO_YEARLY"),
		DodoProductCredits:    os.Getenv("BOTLINK_DODO_PRODUCT_CREDITS_PACK"),
		DodoAPIBase:           os.Getenv("BOTLINK_DODO_API_BASE"),
	}
	for _, f := range []struct {
		env string
		dst *int64
	}{
		{"BOTLINK_CREDITS_PACK_SIZE", &p.CreditsPackSize},
		{"BOTLINK_CREDIT_PRICE_MESSAGE", &p.PriceMessage},
		{"BOTLINK_CREDIT_PRICE_CHAT_DAY", &p.PriceChatDay},
		{"BOTLINK_CREDIT_PRICE_WAKE", &p.PriceWake},
	} {
		v, err := strconv.ParseInt(getenv(f.env, "0"), 10, 64)
		if err != nil || v < 0 {
			return p, fmt.Errorf("%s must be a whole number, 0 or more", f.env)
		}
		*f.dst = v
	}
	return p, nil
}

// validate checks the paid settings only while the paywall is on (off: they are ignored, IgnoredWarning).
func (p PlansConfig) validate(env string) error {
	if !p.paywall {
		return nil
	}
	return p.paid.validate(env)
}

func (p PaidSettings) validate(env string) error {
	switch p.LimitsMode {
	case "", "off", "count", "block":
	default:
		return fmt.Errorf("BOTLINK_LIMITS_MODE must be off, count or block (got %q)", p.LimitsMode)
	}
	switch p.Gateway {
	case "", "off":
	case "fake":
		if env != "dev" {
			return errors.New("refusing to start: BOTLINK_BILLING_GATEWAY=fake needs BOTLINK_ENV=dev")
		}
		if !strings.HasPrefix(p.FakeKey, "whsec_") {
			return errors.New("BOTLINK_BILLING_GATEWAY=fake needs BOTLINK_BILLING_FAKE_KEY (whsec_…)")
		}
	case "dodo":
		if p.DodoMode != "test" && p.DodoMode != "live" {
			return fmt.Errorf("BOTLINK_DODO_MODE must be test or live (got %q)", p.DodoMode)
		}
		if p.DodoAPIKey == "" || !strings.HasPrefix(p.DodoWebhookKey, "whsec_") {
			return errors.New("BOTLINK_BILLING_GATEWAY=dodo needs BOTLINK_DODO_API_KEY and BOTLINK_DODO_WEBHOOK_KEY (whsec_…)")
		}
		if p.DodoProductProMonthly == "" || p.DodoProductProYearly == "" {
			return errors.New("BOTLINK_BILLING_GATEWAY=dodo needs BOTLINK_DODO_PRODUCT_PRO_MONTHLY and BOTLINK_DODO_PRODUCT_PRO_YEARLY")
		}
		if p.DodoAPIBase != "" && env != "dev" {
			return errors.New("refusing to start: BOTLINK_DODO_API_BASE needs BOTLINK_ENV=dev")
		}
	default:
		return fmt.Errorf("BOTLINK_BILLING_GATEWAY must be off, fake or dodo (got %q)", p.Gateway)
	}
	return nil
}
