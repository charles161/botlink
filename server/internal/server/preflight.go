package server

import (
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/url"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/charles161/botlink/server/internal/billing"
	"github.com/charles161/botlink/server/internal/clientgate"
	"github.com/charles161/botlink/server/internal/config"
	"github.com/charles161/botlink/server/internal/faults"
	"github.com/charles161/botlink/server/internal/humancheck"
)

// Checked is what Preflight built: New uses it as is, so `botlink check-config` and a starting server refuse the same
// configurations.
type Checked struct {
	HC   *humancheck.Checker
	GW   billing.Gateway
	Gate *clientgate.Gate
	// JoinGate refuses joins, room drafts and moves from outdated clients (clientgate/joingate.go)
	JoinGate *clientgate.JoinGate
}

// Preflight runs every start-time refusal that needs neither the database nor the network, in one place: the config
// rules (Validate), the test-fault hooks, the database URL's shape (parsed, never dialled), the human check, the
// payment gateway and the minimum client release against the manifest served next to the client tarball.
func Preflight(cfg *config.Config) (*Checked, error) {
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	if cfg.TestFaults != "" {
		if err := faults.FromEnv(cfg.TestFaults); err != nil {
			return nil, err
		}
	}
	if _, err := pgxpool.ParseConfig(cfg.DatabaseURL); err != nil {
		return nil, errors.New("BOTLINK_DATABASE_URL cannot be read as a Postgres address (its value is not shown)")
	}
	hc, err := humancheck.New(cfg.HumanCheck, cfg.TurnstileSiteKey, cfg.TurnstileSecret, cfg.TurnstileVerifyURL, cfg.WebAuthnRPID, cfg.WebAuthnOrigin)
	if err != nil {
		return nil, err
	}
	gw, err := billing.New(cfg)
	if err != nil {
		return nil, fmt.Errorf("the payment gateway (BOTLINK_BILLING_GATEWAY): %w", err)
	}
	gate, err := clientgate.New(cfg.MinClientRelease, cfg.Env == "dev", cfg.ClientTGZ)
	if err != nil {
		return nil, err
	}
	jg, err := clientgate.NewJoinGate(cfg.MinJoinClientVersion, cfg.Env == "dev", cfg.ClientTGZ)
	if err != nil {
		return nil, err
	}
	return &Checked{HC: hc, GW: gw, Gate: gate, JoinGate: jg}, nil
}

// CheckConfig is `botlink check-config`: the configuration from the environment, checked as a starting server checks
// it, without listening, connecting or migrating. Exit 0 and one line "config ok (...)" naming the environment, the
// hosts, the paywall and the human check; or exit 1 and "config refused: <why>". Names and non-secret values only.
func CheckConfig(w io.Writer) int {
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(w, &slog.HandlerOptions{Level: slog.LevelWarn})))
	defer slog.SetDefault(prev)
	cfg, err := config.FromEnv()
	if err == nil {
		_, err = Preflight(cfg)
	}
	if err != nil {
		fmt.Fprintf(w, "config refused: %v\n", err)
		return 1
	}
	hosts := "one host " + hostOf(cfg.AppOrigin)
	if cfg.AppHost != "" {
		hosts = "app=" + cfg.AppHost + " api=" + cfg.APIHost
		if cfg.SiteHost != "" {
			hosts += " site=" + cfg.SiteHost
		}
	}
	paywall := "off"
	if cfg.Plans.Paywall() {
		paywall = "on"
	}
	fmt.Fprintf(w, "config ok (env=%s, hosts: %s, paywall %s, human check %s)\n", cfg.Env, hosts, paywall, cfg.HumanCheck)
	return 0
}

func hostOf(origin string) string {
	if u, err := url.Parse(origin); err == nil {
		return u.Host
	}
	return "?"
}
