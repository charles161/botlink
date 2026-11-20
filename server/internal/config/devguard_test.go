package config

import (
	"os"
	"strings"
	"testing"
)

// Fourth security pass, findings 1 and 2. A missing BOTLINK_ENV means dev, and dev drops Secure cookies, HSTS and the
// real human check: so dev starts only when every origin and host it is given is this computer. And outside dev, dev
// sign-in (any email) never runs next to admin emails (it would sign anyone in as the admin).
func envOnly(t *testing.T, kv map[string]string) (*Config, error) {
	t.Helper()
	for _, k := range []string{"BOTLINK_ENV", "BOTLINK_APP_ORIGIN", "BOTLINK_APP_HOST", "BOTLINK_API_HOST", "BOTLINK_SITE_HOST",
		"BOTLINK_WEBAUTHN_ORIGIN", "BOTLINK_WEBAUTHN_RP_ID", "BOTLINK_DEV_LOGIN", "BOTLINK_ADMIN_EMAILS", "BOTLINK_HUMAN_CHECK",
		"BOTLINK_TURNSTILE_SITE_KEY", "BOTLINK_TURNSTILE_SECRET"} {
		t.Setenv(k, "")
		os.Unsetenv(k)
	}
	for k, v := range kv {
		t.Setenv(k, v)
	}
	return FromEnv()
}

func TestDevOnlyOnThisComputer(t *testing.T) {
	refuse := func(name string, kv map[string]string, setting string) {
		t.Helper()
		_, err := envOnly(t, kv)
		if err == nil || !strings.Contains(err.Error(), setting) || !strings.Contains(err.Error(), "set BOTLINK_ENV=prod (or staging)") {
			t.Errorf("%s: %v, want a refusal naming %s and saying set BOTLINK_ENV=prod (or staging)", name, err, setting)
		}
	}
	start := func(name string, kv map[string]string) {
		t.Helper()
		if _, err := envOnly(t, kv); err != nil {
			t.Errorf("%s: refused (%v), want it to start", name, err)
		}
	}
	refuse("BOTLINK_ENV missing, real origin", map[string]string{"BOTLINK_APP_ORIGIN": "https://app.example.com"}, "BOTLINK_APP_ORIGIN")
	start("BOTLINK_ENV missing, localhost origin", map[string]string{"BOTLINK_APP_ORIGIN": "http://localhost:8826"})
	start("BOTLINK_ENV missing, nothing set (make run's default origin)", map[string]string{})
	start("dev on 127.0.0.1", map[string]string{"BOTLINK_ENV": "dev", "BOTLINK_APP_ORIGIN": "http://127.0.0.1:9000"})
	start("dev on [::1]", map[string]string{"BOTLINK_ENV": "dev", "BOTLINK_APP_ORIGIN": "http://[::1]:9000"})
	start("dev with *.localhost hosts (web/test/test_domains.py)", map[string]string{"BOTLINK_ENV": "dev", "BOTLINK_APP_ORIGIN": "http://app.localhost:9780",
		"BOTLINK_APP_HOST": "app.localhost", "BOTLINK_API_HOST": "127.0.0.1", "BOTLINK_SITE_HOST": "localhost", "BOTLINK_WEBAUTHN_RP_ID": "app.localhost"})
	local := map[string]string{"BOTLINK_ENV": "dev", "BOTLINK_APP_ORIGIN": "http://localhost:9000"}
	with := func(k, v string) map[string]string {
		m := map[string]string{k: v}
		for a, b := range local {
			if _, ok := m[a]; !ok {
				m[a] = b
			}
		}
		return m
	}
	refuse("dev, real app host", map[string]string{"BOTLINK_ENV": "dev", "BOTLINK_APP_ORIGIN": "http://localhost:9000", "BOTLINK_APP_HOST": "app.example.com", "BOTLINK_API_HOST": "127.0.0.1"}, "BOTLINK_APP_HOST")
	refuse("dev, real API host", map[string]string{"BOTLINK_ENV": "dev", "BOTLINK_APP_ORIGIN": "http://localhost:9000", "BOTLINK_APP_HOST": "localhost", "BOTLINK_API_HOST": "api.example.com"}, "BOTLINK_API_HOST")
	refuse("dev, real site host", map[string]string{"BOTLINK_ENV": "dev", "BOTLINK_APP_ORIGIN": "http://app.localhost:9000", "BOTLINK_APP_HOST": "app.localhost",
		"BOTLINK_API_HOST": "127.0.0.1", "BOTLINK_SITE_HOST": "example.com", "BOTLINK_WEBAUTHN_RP_ID": "app.localhost"}, "BOTLINK_SITE_HOST")
	refuse("dev, real passkey origin", with("BOTLINK_WEBAUTHN_ORIGIN", "https://app.example.com"), "BOTLINK_WEBAUTHN_ORIGIN")
	refuse("dev, real passkey RP ID", with("BOTLINK_WEBAUTHN_RP_ID", "example.com"), "BOTLINK_WEBAUTHN_RP_ID")
	refuse("dev, a name that only starts like localhost", with("BOTLINK_APP_ORIGIN", "http://localhost.example.com"), "BOTLINK_APP_ORIGIN")
}

func TestDevSignInNeverWithAdminsOutsideDev(t *testing.T) {
	base := map[string]string{"BOTLINK_ENV": "staging", "BOTLINK_APP_ORIGIN": "https://test.botlink.dev", "BOTLINK_HUMAN_CHECK": "real",
		"BOTLINK_TURNSTILE_SITE_KEY": "k", "BOTLINK_TURNSTILE_SECRET": "s", "BOTLINK_DEV_LOGIN": "1"}
	if _, err := envOnly(t, base); err != nil {
		t.Fatalf("staging with dev sign-in and no admin: %v", err)
	}
	base["BOTLINK_ADMIN_EMAILS"] = "ops@example.com"
	_, err := envOnly(t, base)
	if err == nil || !strings.Contains(err.Error(), "BOTLINK_DEV_LOGIN") || !strings.Contains(err.Error(), "BOTLINK_ADMIN_EMAILS") {
		t.Fatalf("staging with dev sign-in and an admin email: %v, want a refusal naming both settings", err)
	}
	// dev keeps both (the web tests' admin pass signs in with dev sign-in on localhost)
	if _, err := envOnly(t, map[string]string{"BOTLINK_ENV": "dev", "BOTLINK_APP_ORIGIN": "http://localhost:1", "BOTLINK_DEV_LOGIN": "1", "BOTLINK_ADMIN_EMAILS": "ops@botlink.test"}); err != nil {
		t.Fatalf("dev with dev sign-in and an admin: %v", err)
	}
	// prod unchanged: a real origin starts; dev sign-in is refused as before
	prod := map[string]string{"BOTLINK_ENV": "prod", "BOTLINK_APP_ORIGIN": "https://app.botlink.dev", "BOTLINK_HUMAN_CHECK": "real",
		"BOTLINK_TURNSTILE_SITE_KEY": "k", "BOTLINK_TURNSTILE_SECRET": "s"}
	if _, err := envOnly(t, prod); err != nil {
		t.Fatalf("prod: %v", err)
	}
	prod["BOTLINK_DEV_LOGIN"] = "1"
	if _, err := envOnly(t, prod); err == nil || !strings.Contains(err.Error(), "BOTLINK_DEV_LOGIN=1 is not allowed with BOTLINK_ENV=prod") {
		t.Fatalf("prod with dev sign-in: %v", err)
	}
}
