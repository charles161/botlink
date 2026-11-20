package test

import (
	"bytes"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/charles161/botlink/server/internal/config"
	"github.com/charles161/botlink/server/internal/exportomit"
)

// BOTLINK_PAYWALL: on | off, default off; any other value refuses to start. While off the paid settings are ignored
// with one warning line at start that names each of them; even settings that would refuse to start with the paywall
// on (a fake gateway outside dev, a Dodo gateway without keys, a bad price) only warn.
func TestFreePaywallFlagAtStart(t *testing.T) {
	for _, v := range []string{"maybe", "ON", "true", "1"} {
		t.Setenv("BOTLINK_PAYWALL", v)
		if _, err := config.FromEnv(); err == nil || !strings.Contains(err.Error(), "BOTLINK_PAYWALL must be on or off") {
			t.Errorf("BOTLINK_PAYWALL=%s: want a refusal naming the setting, got %v", v, err)
		}
	}
	t.Setenv("BOTLINK_PAYWALL", "")
	os.Unsetenv("BOTLINK_PAYWALL")
	t.Setenv("BOTLINK_LIMITS_MODE", "block")
	t.Setenv("BOTLINK_BILLING_GATEWAY", "dodo")
	t.Setenv("BOTLINK_DODO_API_KEY", "x")
	t.Setenv("BOTLINK_CREDIT_PRICE_WAKE", "-3")
	var buf bytes.Buffer
	old := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, nil)))
	cfg, err := config.FromEnv()
	slog.SetDefault(old)
	if err != nil {
		t.Fatalf("paid settings with the paywall off must not stop the server: %v", err)
	}
	if cfg.Plans.Paywall() || cfg.Plans.Mode() != "off" || cfg.Plans.GatewayName() != "off" {
		t.Errorf("paywall off: want paywall false, mode off, gateway off; got %v %s %s", cfg.Plans.Paywall(), cfg.Plans.Mode(), cfg.Plans.GatewayName())
	}
	lines := strings.Split(strings.TrimSpace(buf.String()), "\n")
	warn := ""
	for _, l := range lines {
		if strings.Contains(l, "BOTLINK_PAYWALL") {
			if warn != "" {
				t.Errorf("more than one paywall warning line: %q", buf.String())
			}
			warn = l
		}
	}
	for _, k := range []string{"BOTLINK_LIMITS_MODE", "BOTLINK_BILLING_GATEWAY", "BOTLINK_DODO_API_KEY", "BOTLINK_CREDIT_PRICE_WAKE"} {
		if !strings.Contains(warn, k) {
			t.Errorf("the warning at start must name %s (ignored while BOTLINK_PAYWALL is off): %q", k, buf.String())
		}
	}
	if strings.Contains(warn, "=x") || strings.Contains(warn, "block") {
		t.Errorf("the warning names settings, never their values (a key could be one): %q", warn)
	}
	// on: today's rules, all of them
	t.Setenv("BOTLINK_PAYWALL", "on")
	if _, err := config.FromEnv(); err == nil || !strings.Contains(err.Error(), "BOTLINK_CREDIT_PRICE_WAKE") {
		t.Errorf("with the paywall on a bad price still refuses to start: %v", err)
	}
	t.Setenv("BOTLINK_CREDIT_PRICE_WAKE", "0")
	if _, err := config.FromEnv(); err == nil || !strings.Contains(err.Error(), "BOTLINK_DODO") {
		t.Errorf("with the paywall on a Dodo gateway without keys still refuses to start: %v", err)
	}
	t.Setenv("BOTLINK_BILLING_GATEWAY", "")
	cfg, err = config.FromEnv()
	if err != nil || !cfg.Plans.Paywall() || cfg.Plans.Mode() != "block" {
		t.Errorf("paywall on: want mode block from BOTLINK_LIMITS_MODE: %v %v", err, cfg)
	}
}

// The dashboard's mock server and the copy check use the same default as the server (off), so a test or a page check
// never runs against a paywall the product does not have.
func TestFreeDefaultsAgree(t *testing.T) {
	root := filepath.Join("..", "..")
	for file, re := range map[string]string{
		"web/scripts/copy-check.mjs":        `(?m)^export const PAYWALL = false;`,
		"web/test/fixtures/mock-server.mjs": `MOCK_PAYWALL`,
		"deploy/README.md":                  `BOTLINK_PAYWALL`,
		"SELF-HOSTING.md":                   "`BOTLINK_PAYWALL` stays `off`",
	} {
		b, err := os.ReadFile(filepath.Join(root, file))
		if err != nil {
			if why, ok := exportomit.Reason(root, file); ok {
				t.Logf("%s: not checked, left out of this public export (%s)", file, why)
				continue
			}
			t.Fatal(err)
		}
		if !regexp.MustCompile(re).Match(b) {
			t.Errorf("%s must match %s: the default is no paywall (BOTLINK_PAYWALL off)", file, re)
		}
	}
}
