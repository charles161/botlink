package auth

// Sign-up limits (fix-all blocker 8): how many NEW accounts are made per source address and in total, per hour and
// per day. Checked inside the sign-in transaction only when that sign-in would create an account (LoginLimited), so
// signing in to an existing account is never limited, and a refused sign-up rolls back without counting.
//
// The refusal says nothing about the email: the same page for every refusal, and it never names the email. The
// check runs only after the provider vouched for the email, so only the email's owner can reach it at all.

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/charles161/botlink/server/internal/config"
	"github.com/charles161/botlink/server/internal/httpx"
	"github.com/charles161/botlink/server/internal/ratelimit"
)

// ErrSignupLimited: a sign-up refused by a limit (no account was made).
var ErrSignupLimited = errors.New("sign-up limited")

// SignupLimitedText is the page a refused sign-up sees: one text for every limit, nothing about the email.
const SignupLimitedText = "bot-link can't make a new account right now: too many were made recently. Try again in an hour."

// SignupLimits holds the numbers (config.SignupConfig with defaults applied) and the clock.
type SignupLimits struct {
	PerAddrHour, PerAddrDay, GlobalHour, GlobalDay int
	Now                                            func() time.Time // the window's clock; time.Now unless a test sets it
}

// NewSignupLimits applies the defaults (ratelimit.Signup*) to a config.
func NewSignupLimits(c config.SignupConfig) *SignupLimits {
	pick := func(v int, l ratelimit.Limit) int {
		if v > 0 {
			return v
		}
		return l.Max
	}
	return &SignupLimits{PerAddrHour: pick(c.PerAddrHour, ratelimit.SignupAddrHour), PerAddrDay: pick(c.PerAddrDay, ratelimit.SignupAddrDay),
		GlobalHour: pick(c.GlobalHour, ratelimit.SignupHour), GlobalDay: pick(c.GlobalDay, ratelimit.SignupDay), Now: time.Now}
}

// SignupSourceKey is what one "address" is: an IPv4 address, or the /64 network of an IPv6 address (one customer
// network usually holds a whole /64, so counting single IPv6 addresses would limit nothing).
func SignupSourceKey(ip string) string {
	p := net.ParseIP(ip)
	if p == nil {
		return ip
	}
	if v4 := p.To4(); v4 != nil {
		return v4.String()
	}
	n := &net.IPNet{IP: p.Mask(net.CIDRMask(64, 128)), Mask: net.CIDRMask(64, 128)}
	return n.String()
}

// Check returns the function LoginLimited runs before it creates an account: it counts one new account for the
// source address and in total, inside the sign-in transaction, and refuses with ErrSignupLimited over any limit.
func (s *SignupLimits) Check(sourceIP string) func(ctx context.Context, tx pgx.Tx) error {
	return func(ctx context.Context, tx pgx.Tx) error {
		now := time.Now()
		if s.Now != nil {
			now = s.Now()
		}
		src := SignupSourceKey(sourceIP)
		for _, c := range []struct {
			l   ratelimit.Limit
			max int
			key string
		}{
			{ratelimit.SignupAddrHour, s.PerAddrHour, src}, {ratelimit.SignupAddrDay, s.PerAddrDay, src},
			{ratelimit.SignupHour, s.GlobalHour, "all"}, {ratelimit.SignupDay, s.GlobalDay, "all"},
		} {
			l := c.l
			if c.max > 0 {
				l.Max = c.max
			}
			if err := ratelimit.HitAt(ctx, tx, l, c.key, now); err != nil {
				var he *httpx.Error
				if errors.As(err, &he) && he.Status == 429 {
					// seen: botlink_rate_limited_total{limit} (HitAt marks the request) and this line; no email, no address
					slog.WarnContext(ctx, "sign-up refused by a limit", "limit", l.Name, "max", l.Max, "window", l.Window.String(),
						"request_id", httpx.RequestID(ctx))
					return ErrSignupLimited
				}
				return err
			}
		}
		return nil
	}
}
