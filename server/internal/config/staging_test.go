package config

import (
	"strings"
	"testing"
	"time"
)

// A staging server keeps every prod rule but lets a tester reach the end of a wait: the passkey reset and account
// delete waits go down to 5 minutes there (prod keeps its 24 h floor; 0 stays dev only), and a join request can live
// as little as 30 seconds (BOTLINK_JOIN_TTL; prod runs only the default 15 minutes).
func validBase(env string) *Config {
	origin := "https://test.botlink.dev"
	if env == "dev" {
		origin = "http://localhost:1" // dev runs only for this computer (devguard_test.go)
	}
	return &Config{Env: env, HumanCheck: "real", TurnstileSiteKey: "k", TurnstileSecret: "s", AppOrigin: origin}
}

func TestStagingShortWaits(t *testing.T) {
	set := map[string]func(c *Config, d time.Duration){
		"BOTLINK_PASSKEY_RESET_DELAY": func(c *Config, d time.Duration) { c.PasskeyResetDelay = d },
		"BOTLINK_ACCOUNT_DELETE_DELAY": func(c *Config, d time.Duration) {
			c.AccountDeleteDelay, c.AccountDeleteNoWait = d, d == 0
		},
		"BOTLINK_ACCOUNT_DELETE_ASK_HOLD": func(c *Config, d time.Duration) {
			c.AccountDeleteAskHold, c.AccountDeleteAskHoldOff = d, d == 0
		},
	}
	cases := []struct {
		env string
		d   string
		ok  bool
	}{
		{"staging", "5m", true}, {"staging", "23h", true}, {"staging", "72h", true},
		{"staging", "4m59s", false}, {"staging", "0", false},
		{"prod", "5m", false}, {"prod", "23h", false}, {"prod", "24h", true}, {"prod", "0", false},
		{"dev", "1m", true},
	}
	for name, apply := range set {
		for _, k := range cases {
			if k.d == "0" && name == "BOTLINK_PASSKEY_RESET_DELAY" {
				continue // 0 means the 72 h default for this one (config.go ResetDelay)
			}
			c := validBase(k.env)
			if k.env == "dev" {
				c.HumanCheck = "stub"
			}
			apply(c, mustDur(t, k.d))
			err := c.Validate()
			if k.ok && err != nil {
				t.Errorf("%s=%s with BOTLINK_ENV=%s: refused (%v), want accepted", name, k.d, k.env, err)
			}
			if !k.ok && (err == nil || !strings.Contains(err.Error(), name)) {
				t.Errorf("%s=%s with BOTLINK_ENV=%s: %v, want a refusal naming %s", name, k.d, k.env, err, name)
			}
		}
	}
}

func TestJoinTTL(t *testing.T) {
	t.Setenv("BOTLINK_ENV", "prod")
	t.Setenv("BOTLINK_HUMAN_CHECK", "real")
	t.Setenv("BOTLINK_TURNSTILE_SITE_KEY", "k")
	t.Setenv("BOTLINK_TURNSTILE_SECRET", "s")
	t.Setenv("BOTLINK_APP_ORIGIN", "https://app.botlink.dev")
	c, err := FromEnv()
	if err != nil {
		t.Fatal(err)
	}
	if c.JoinTTL != 15*time.Minute {
		t.Fatalf("default join TTL %v, want 15m", c.JoinTTL)
	}
	t.Setenv("BOTLINK_JOIN_TTL", "soon")
	if _, err := FromEnv(); err == nil || !strings.Contains(err.Error(), "BOTLINK_JOIN_TTL") {
		t.Fatalf("unparsable join TTL: %v", err)
	}
	cases := []struct {
		env string
		d   string
		ok  bool
	}{
		{"prod", "15m", true}, {"prod", "14m", false}, {"prod", "30s", false}, {"prod", "1h", false},
		{"staging", "30s", true}, {"staging", "2m", true}, {"staging", "15m", true}, {"staging", "29s", false}, {"staging", "16m", false},
		{"dev", "30s", true}, {"dev", "10s", false},
	}
	for _, k := range cases {
		c := validBase(k.env)
		c.JoinTTL = mustDur(t, k.d)
		err := c.Validate()
		if k.ok != (err == nil) || (!k.ok && !strings.Contains(err.Error(), "BOTLINK_JOIN_TTL")) {
			t.Errorf("BOTLINK_JOIN_TTL=%s with BOTLINK_ENV=%s: %v (want accepted=%v)", k.d, k.env, err, k.ok)
		}
	}
}

// Dev sign-in signs in as any email: prod refuses to start with it; staging (a tester's only way in) may have it.
func TestDevLoginOnlyOutsideProd(t *testing.T) {
	c := validBase("prod")
	c.DevLogin = true
	if err := c.Validate(); err == nil || !strings.Contains(err.Error(), "BOTLINK_DEV_LOGIN") {
		t.Fatalf("prod with dev sign-in: %v, want a refusal", err)
	}
	c = validBase("staging")
	c.DevLogin = true
	if err := c.Validate(); err != nil {
		t.Fatalf("staging with dev sign-in: %v", err)
	}
}
