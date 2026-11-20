package server

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// `botlink check-config` (deploy.sh runs it with the new binary and the env file BEFORE backup, migration and switch):
// every start-time refusal that needs no database and no network, the same code New runs, and never a secret.
func cleanEnv(t *testing.T, kv map[string]string) {
	t.Helper()
	for _, e := range os.Environ() {
		if k, _, _ := strings.Cut(e, "="); strings.HasPrefix(k, "BOTLINK_") {
			t.Setenv(k, "")
			os.Unsetenv(k)
		}
	}
	for k, v := range kv {
		t.Setenv(k, v)
	}
}

// secret-looking values that must never be printed
var secrets = map[string]string{
	"BOTLINK_DATABASE_URL":         "postgres://botlink_prod:SECRET-DB-PW-1@127.0.0.1:5432/botlink_prod?sslmode=disable",
	"BOTLINK_TURNSTILE_SECRET":     "SECRET-TS-2",
	"BOTLINK_GITHUB_CLIENT_ID":     "SECRET-GHID-3",
	"BOTLINK_GITHUB_CLIENT_SECRET": "SECRET-GHS-4",
	"BOTLINK_GOOGLE_CLIENT_ID":     "SECRET-GOID-5",
	"BOTLINK_GOOGLE_CLIENT_SECRET": "SECRET-GOS-6",
	"BOTLINK_ANALYTICS_HASH_KEY":   "SECRET-HASH-7-0123456789abcdef0123456789",
	"BOTLINK_POSTHOG_KEY":          "SECRET-PH-8",
	"BOTLINK_DODO_API_KEY":         "SECRET-DODO-9",
	"BOTLINK_DODO_WEBHOOK_KEY":     "SECRET-WH-10",
	"BOTLINK_TURNSTILE_SITE_KEY":   "sitekey-public",
	"BOTLINK_LISTEN_URL":           "postgres://x:SECRET-LISTEN-11@127.0.0.1:1/x",
}

func prodShaped() map[string]string {
	m := map[string]string{"BOTLINK_ENV": "prod", "BOTLINK_ADDR": "127.0.0.1:8811", "BOTLINK_APP_ORIGIN": "https://app.botlink.dev",
		"BOTLINK_APP_HOST": "app.botlink.dev", "BOTLINK_API_HOST": "api.botlink.dev", "BOTLINK_WEBAUTHN_RP_ID": "app.botlink.dev",
		"BOTLINK_WEBAUTHN_ORIGIN": "https://app.botlink.dev", "BOTLINK_HUMAN_CHECK": "real", "BOTLINK_TRUST_CF": "1", "BOTLINK_DEV_LOGIN": "0"}
	for k, v := range secrets {
		m[k] = v
	}
	return m
}

func run(t *testing.T, kv map[string]string) (string, int) {
	t.Helper()
	cleanEnv(t, kv)
	var b bytes.Buffer
	code := CheckConfig(&b)
	return b.String(), code
}

func hasLine(out, want string) bool {
	for _, l := range strings.Split(out, "\n") {
		if l == want {
			return true
		}
	}
	return false
}

func noSecret(t *testing.T, name, out string) {
	t.Helper()
	for k, v := range secrets {
		if strings.HasPrefix(v, "sitekey") {
			continue
		}
		for _, frag := range []string{v, "SECRET-"} {
			if strings.Contains(out, frag) {
				t.Errorf("%s: the output shows %s (%q): %s", name, k, frag, out)
			}
		}
	}
}

func TestCheckConfigPassesAProdShapedConfig(t *testing.T) {
	out, code := run(t, prodShaped())
	if code != 0 || !hasLine(out, "config ok (env=prod, hosts: app=app.botlink.dev api=api.botlink.dev, paywall off, human check real)") {
		t.Fatalf("prod-shaped config: exit %d: %s", code, out)
	}
	noSecret(t, "ok", out)
	one, code := run(t, map[string]string{"BOTLINK_ENV": "staging", "BOTLINK_APP_ORIGIN": "https://test.botlink.dev", "BOTLINK_DEV_LOGIN": "1",
		"BOTLINK_TURNSTILE_SITE_KEY": "1x00000000000000000000AA", "BOTLINK_TURNSTILE_SECRET": "1x0000000000000000000000000000000AA"})
	if code != 0 || !hasLine(one, "config ok (env=staging, hosts: one host test.botlink.dev, paywall off, human check real)") {
		t.Fatalf("staging template shape: exit %d: %s", code, one)
	}
}

func TestCheckConfigRefusesEachStartupRefusal(t *testing.T) {
	dl := t.TempDir()
	os.WriteFile(filepath.Join(dl, "botlink.tgz"), []byte("x"), 0o644)
	os.WriteFile(filepath.Join(dl, "botlink.manifest.json"), []byte(`{"manifest":"{\"counter\":3}","sig":"x","key":"k"}`), 0o644)
	for _, k := range []struct {
		name, want string
		mod        map[string]string
	}{
		{"BOTLINK_ENV missing on a real origin", "set BOTLINK_ENV=prod (or staging)", map[string]string{"BOTLINK_ENV": ""}},
		{"dev sign-in with admin emails outside dev", "BOTLINK_ADMIN_EMAILS", map[string]string{"BOTLINK_ENV": "staging", "BOTLINK_DEV_LOGIN": "1", "BOTLINK_ADMIN_EMAILS": "ops@example.com"}},
		{"dev sign-in in prod", "BOTLINK_DEV_LOGIN=1 is not allowed", map[string]string{"BOTLINK_DEV_LOGIN": "1"}},
		{"a paywall value that is not on or off", "BOTLINK_PAYWALL", map[string]string{"BOTLINK_PAYWALL": "maybe"}},
		{"a join TTL in prod", "BOTLINK_JOIN_TTL", map[string]string{"BOTLINK_JOIN_TTL": "2m"}},
		{"a wait below prod's floor", "BOTLINK_ACCOUNT_DELETE_DELAY", map[string]string{"BOTLINK_ACCOUNT_DELETE_DELAY": "5m"}},
		{"human check real without the Turnstile secret", "BOTLINK_TURNSTILE_SECRET", map[string]string{"BOTLINK_TURNSTILE_SECRET": ""}},
		{"a minimum client release above the served manifest", "BOTLINK_MIN_CLIENT_RELEASE 5 is above", map[string]string{"BOTLINK_MIN_CLIENT_RELEASE": "5", "BOTLINK_DL_DIR": dl}},
		{"a minimum client release that is not a number", "BOTLINK_MIN_CLIENT_RELEASE", map[string]string{"BOTLINK_MIN_CLIENT_RELEASE": "soon"}},
		{"test faults outside dev", "BOTLINK_TEST_FAULTS", map[string]string{"BOTLINK_TEST_FAULTS": "x"}},
		{"a database URL that cannot be read", "BOTLINK_DATABASE_URL", map[string]string{"BOTLINK_DATABASE_URL": "postgres://u:SECRET-DB-PW-1@[bad"}},
		{"a payment gateway without its keys in shape (paywall on)", "BOTLINK_DODO_WEBHOOK_KEY", map[string]string{"BOTLINK_PAYWALL": "on", "BOTLINK_BILLING_GATEWAY": "dodo",
			"BOTLINK_DODO_PRODUCT_PRO_MONTHLY": "p1", "BOTLINK_DODO_PRODUCT_PRO_YEARLY": "p2"}},
	} {
		kv := prodShaped()
		for a, b := range k.mod {
			kv[a] = b
		}
		if kv["BOTLINK_ENV"] == "" {
			delete(kv, "BOTLINK_ENV")
		}
		out, code := run(t, kv)
		if code != 1 || !strings.Contains(out, "config refused: ") || !strings.Contains(out, k.want) {
			t.Errorf("%s: exit %d, want 1 with %q: %s", k.name, code, k.want, out)
		}
		noSecret(t, k.name, out)
	}
}
