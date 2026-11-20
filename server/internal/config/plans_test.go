package config

import (
	"encoding/base64"
	"strings"
	"testing"
)

func TestPlansConfigValidate(t *testing.T) {
	// built at run time so no key-shaped literal sits in the repository (the public-repo secret scan)
	key := "whsec_" + base64.StdEncoding.EncodeToString([]byte("test-key-only"))
	dodo := PaidSettings{Gateway: "dodo", DodoMode: "test", DodoAPIKey: "k", DodoWebhookKey: key, DodoProductProMonthly: "m", DodoProductProYearly: "y"}
	ok := []struct {
		env string
		p   PaidSettings
	}{
		{"prod", PaidSettings{}},
		{"prod", PaidSettings{LimitsMode: "block"}},
		{"dev", PaidSettings{Gateway: "fake", FakeKey: key}},
		{"prod", dodo},
	}
	for i, c := range ok {
		if err := c.p.validate(c.env); err != nil {
			t.Errorf("ok %d: %v", i, err)
		}
	}
	noKeys := dodo
	noKeys.DodoAPIKey = ""
	noProducts := dodo
	noProducts.DodoProductProYearly = ""
	override := dodo
	override.DodoAPIBase = "http://127.0.0.1:1"
	badMode := dodo
	badMode.DodoMode = "sandbox"
	bad := []struct {
		env, want string
		p         PaidSettings
	}{
		{"dev", "BOTLINK_LIMITS_MODE", PaidSettings{LimitsMode: "strict"}},
		{"prod", "needs BOTLINK_ENV=dev", PaidSettings{Gateway: "fake", FakeKey: key}},
		{"dev", "BOTLINK_BILLING_FAKE_KEY", PaidSettings{Gateway: "fake"}},
		{"prod", "BOTLINK_DODO_API_KEY", noKeys},
		{"prod", "BOTLINK_DODO_PRODUCT_PRO_YEARLY", noProducts},
		{"prod", "BOTLINK_DODO_API_BASE", override},
		{"prod", "BOTLINK_DODO_MODE", badMode},
		{"prod", "BOTLINK_BILLING_GATEWAY", PaidSettings{Gateway: "stripe"}},
	}
	for _, c := range bad {
		if err := c.p.validate(c.env); err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s: %v", c.want, err)
		}
	}
	if (PaidSettings{}).Mode() != "count" || (PaidSettings{}).GatewayName() != "off" {
		t.Error("paid defaults: count mode, gateway off")
	}
	// the paywall's default is off, and off reads as the switched-off settings whatever is stored
	var off PlansConfig
	off.EditPaid(func(s *PaidSettings) { *s = dodo; s.LimitsMode = "block"; s.PriceWake = 5 })
	if off.Paywall() || off.Mode() != "off" || off.GatewayName() != "off" || off.Paid().PriceWake != 0 || off.validate("prod") != nil {
		t.Errorf("paywall off must hide every paid setting: %+v", off.Paid())
	}
	on := off
	on.SetPaywall(true)
	if on.Mode() != "block" || on.GatewayName() != "dodo" || on.Paid().PriceWake != 5 {
		t.Errorf("paywall on must give the stored settings: %+v", on.Paid())
	}
}

func TestPlansFromEnv(t *testing.T) {
	t.Setenv("BOTLINK_PAYWALL", "on")
	t.Setenv("BOTLINK_CREDIT_PRICE_MESSAGE", "-1")
	if _, err := plansFromEnv(); err == nil {
		t.Fatal("negative price accepted")
	}
	t.Setenv("BOTLINK_CREDIT_PRICE_MESSAGE", "2")
	t.Setenv("BOTLINK_CREDITS_PACK_SIZE", "500")
	t.Setenv("BOTLINK_LIMITS_MODE", "block")
	p, err := plansFromEnv()
	if err != nil || p.Paid().PriceMessage != 2 || p.Paid().CreditsPackSize != 500 || p.Mode() != "block" || p.Paid().DodoMode != "test" {
		t.Fatalf("%+v %v", p, err)
	}
}
