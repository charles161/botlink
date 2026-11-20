package config

import (
	"strings"
	"testing"
	"time"
)

// Account delete waits: 0 (no wait) or under 24 h only in dev; unset means 72 h, and the window 7 days.
func TestAccountDeleteDelay(t *testing.T) {
	t.Setenv("BOTLINK_ACCOUNT_DELETE_DELAY", "0")
	t.Setenv("BOTLINK_ENV", "dev")
	t.Setenv("BOTLINK_HUMAN_CHECK", "stub")
	t.Setenv("BOTLINK_DATABASE_URL", "postgres://x@127.0.0.1:1/x")
	t.Setenv("BOTLINK_APP_ORIGIN", "http://localhost:1")
	c, err := FromEnv()
	if err != nil {
		t.Fatalf("dev with no wait: %v", err)
	}
	if c.DeleteDelay() != 0 || c.DeleteWindow() != 7*24*time.Hour {
		t.Fatalf("dev: delay %v window %v", c.DeleteDelay(), c.DeleteWindow())
	}
	for env, ds := range map[string][]string{"staging": {"0", "4m"}, "prod": {"0", "23h"}} { // staging floor: 5m (staging_test.go)
		for _, d := range ds {
			c := &Config{Env: env, HumanCheck: "real", TurnstileSiteKey: "k", TurnstileSecret: "s", AccountDeleteDelay: mustDur(t, d), AccountDeleteNoWait: d == "0"}
			if err := c.Validate(); err == nil || !strings.Contains(err.Error(), "BOTLINK_ACCOUNT_DELETE_DELAY") {
				t.Errorf("%s with delay %s: %v", env, d, err)
			}
		}
	}
	var zero Config
	if zero.DeleteDelay() != 72*time.Hour {
		t.Errorf("unset delay: %v", zero.DeleteDelay())
	}
}

func mustDur(t *testing.T, s string) time.Duration {
	d, err := time.ParseDuration(s)
	if err != nil {
		t.Fatal(err)
	}
	return d
}

// The pause on delete asks after a browser removal or "sign out other browsers": 0 or under 24 h only in dev; unset
// means 24 h (third security pass).
func TestAccountDeleteAskHold(t *testing.T) {
	t.Setenv("BOTLINK_ACCOUNT_DELETE_ASK_HOLD", "0")
	t.Setenv("BOTLINK_ENV", "dev")
	t.Setenv("BOTLINK_HUMAN_CHECK", "stub")
	t.Setenv("BOTLINK_DATABASE_URL", "postgres://x@127.0.0.1:1/x")
	t.Setenv("BOTLINK_APP_ORIGIN", "http://localhost:1")
	c, err := FromEnv()
	if err != nil {
		t.Fatalf("dev with no pause: %v", err)
	}
	if c.DeleteAskHold() != 0 {
		t.Fatalf("dev: hold %v", c.DeleteAskHold())
	}
	for env, ds := range map[string][]string{"staging": {"0", "4m"}, "prod": {"0", "23h"}} { // staging floor: 5m (staging_test.go)
		for _, d := range ds {
			c := &Config{Env: env, HumanCheck: "real", TurnstileSiteKey: "k", TurnstileSecret: "s", AccountDeleteAskHold: mustDur(t, d), AccountDeleteAskHoldOff: d == "0"}
			if err := c.Validate(); err == nil || !strings.Contains(err.Error(), "BOTLINK_ACCOUNT_DELETE_ASK_HOLD") {
				t.Errorf("%s with hold %s: %v", env, d, err)
			}
		}
	}
	var zero Config
	if zero.DeleteAskHold() != 24*time.Hour {
		t.Errorf("unset hold: %v", zero.DeleteAskHold())
	}
}
