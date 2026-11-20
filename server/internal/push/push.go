// Package push is the always-on side (SPEC §6.9, ENVELOPE §7): an SSRF-guarded HTTP client (resolve,
// check, dial the checked IP; no redirects; 5 s; 4 KiB of response), HMAC-signed content-free bodies,
// the URL ownership challenge, and the per-copy worker over push_jobs.
package push

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// ErrBlocked means the URL or one of its addresses is not allowed (422 push_url_blocked).
var ErrBlocked = errors.New("push url blocked")

var blocked = func() []netip.Prefix {
	var out []netip.Prefix
	for _, s := range []string{
		"0.0.0.0/8",       // "this network", incl. unspecified
		"10.0.0.0/8",      // private
		"100.64.0.0/10",   // CGNAT
		"127.0.0.0/8",     // loopback
		"169.254.0.0/16",  // link-local, incl. metadata 169.254.169.254
		"172.16.0.0/12",   // private
		"192.0.0.0/24",    // IETF protocol assignments
		"192.0.2.0/24",    // TEST-NET-1
		"192.168.0.0/16",  // private
		"198.18.0.0/15",   // benchmarking
		"198.51.100.0/24", // TEST-NET-2
		"203.0.113.0/24",  // TEST-NET-3
		"224.0.0.0/4",     // multicast
		"240.0.0.0/4",     // reserved, incl. broadcast
		"::/128",          // unspecified
		"::1/128",         // loopback
		"64:ff9b::/96",    // NAT64 (can reach private v4)
		"64:ff9b:1::/48",  // local-use NAT64
		"100::/64",        // discard
		"2001:db8::/32",   // documentation
		"fc00::/7",        // ULA
		"fe80::/10",       // link-local
		"fec0::/10",       // site-local (deprecated)
		"ff00::/8",        // multicast
	} {
		out = append(out, netip.MustParsePrefix(s))
	}
	return out
}()

// Allowed reports whether ip may be dialed. allowLoopback (dev/test only) admits 127/8 and ::1.
func Allowed(ip netip.Addr, allowLoopback bool) bool {
	// a zoned address ("::1%lo", "fe80::1%eth0") matches no prefix (netip.Prefix.Contains is false for zones), so it
	// would slip past the list below: never dial one (checked before Unmap, which drops the zone)
	if !ip.IsValid() || ip.Zone() != "" {
		return false
	}
	ip = ip.Unmap()
	if allowLoopback && ip.IsLoopback() {
		return true
	}
	for _, p := range blocked {
		if p.Contains(ip) {
			return false
		}
	}
	return true
}

type Client struct {
	HTTP          *http.Client
	AllowHTTP     bool // dev only
	AllowLoopback bool // dev/test only
	Resolver      *net.Resolver
}

// NewClient builds the guarded client. The dialer resolves the host itself, refuses if ANY address is
// blocked, then dials the checked IP; a Control hook re-checks the address actually connected to.
func NewClient(allowHTTP, allowLoopback bool) *Client {
	c := &Client{AllowHTTP: allowHTTP, AllowLoopback: allowLoopback, Resolver: net.DefaultResolver}
	dialer := &net.Dialer{
		Timeout: 5 * time.Second,
		Control: func(network, address string, _ syscall.RawConn) error {
			ap, err := netip.ParseAddrPort(address)
			if err != nil || !Allowed(ap.Addr(), c.AllowLoopback) {
				return ErrBlocked
			}
			return nil
		},
	}
	tr := &http.Transport{
		Proxy: nil,
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			host, port, err := net.SplitHostPort(addr)
			if err != nil {
				return nil, err
			}
			ips, err := c.resolve(ctx, host)
			if err != nil {
				return nil, err
			}
			return dialer.DialContext(ctx, network, net.JoinHostPort(ips[0].String(), port))
		},
		TLSHandshakeTimeout:   5 * time.Second,
		ResponseHeaderTimeout: 5 * time.Second,
		MaxIdleConns:          20,
		IdleConnTimeout:       30 * time.Second,
		ForceAttemptHTTP2:     true,
	}
	c.HTTP = &http.Client{
		Transport: tr,
		Timeout:   5 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse // no redirects: a 3xx is a failure
		},
	}
	return c
}

func (c *Client) resolve(ctx context.Context, host string) ([]netip.Addr, error) {
	if ip, err := netip.ParseAddr(strings.Trim(host, "[]")); err == nil {
		if !Allowed(ip, c.AllowLoopback) {
			return nil, ErrBlocked
		}
		return []netip.Addr{ip}, nil
	}
	addrs, err := c.Resolver.LookupNetIP(ctx, "ip", host)
	if err != nil {
		return nil, fmt.Errorf("resolve %s: %w", host, err)
	}
	if len(addrs) == 0 {
		return nil, fmt.Errorf("resolve %s: no addresses", host)
	}
	for _, a := range addrs {
		if !Allowed(a, c.AllowLoopback) {
			return nil, ErrBlocked
		}
	}
	return addrs, nil
}

// CheckURL validates scheme/host/userinfo and resolves the host (every address must be allowed).
func (c *Client) CheckURL(ctx context.Context, raw string) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || u.User != nil || u.Fragment != "" || len(raw) > 500 {
		return nil, fmt.Errorf("%w: not a valid URL", ErrBlocked)
	}
	switch u.Scheme {
	case "https":
	case "http":
		if !c.AllowHTTP {
			return nil, fmt.Errorf("%w: https only", ErrBlocked)
		}
	default:
		return nil, fmt.Errorf("%w: https only", ErrBlocked)
	}
	if _, err := c.resolve(ctx, u.Hostname()); err != nil {
		return nil, err
	}
	return u, nil
}

// Signature computes the X-Botlink-Push-Signature value.
func Signature(secret []byte, t int64, body []byte) string {
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte("botlink-push-v1\n" + strconv.FormatInt(t, 10) + "\n"))
	mac.Write(body)
	return "t=" + strconv.FormatInt(t, 10) + ",v1=" + hex.EncodeToString(mac.Sum(nil))
}

// Result of one POST.
type Result struct {
	Status int
	Body   []byte // first 4 KiB
}

// Post sends one signed push. Errors include ErrBlocked when the guard refused.
func (c *Client) Post(ctx context.Context, rawURL string, secret []byte, pushID string, attempt int, body []byte) (*Result, error) {
	now := time.Now().Unix()
	return c.PostWith(ctx, rawURL, map[string]string{
		"User-Agent":               "botlink-push/1",
		"X-Botlink-Push-Id":        pushID,
		"X-Botlink-Attempt":        strconv.Itoa(attempt),
		"X-Botlink-Push-Signature": Signature(secret, now, body),
	}, body)
}

// PostWith sends one JSON POST through the guard (URL check, resolve, dial the checked IP, no redirects, 5 s, 4 KiB
// of the answer) with the caller's headers. The events worker signs with Standard Webhooks headers through it.
func (c *Client) PostWith(ctx context.Context, rawURL string, headers map[string]string, body []byte) (*Result, error) {
	// the whole attempt (the name lookup of the check included) is bounded: a slow resolver can't hold a worker
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if _, err := c.CheckURL(ctx, rawURL); err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, "POST", rawURL, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		if errors.Is(err, ErrBlocked) {
			return nil, ErrBlocked
		}
		return nil, err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	return &Result{Status: resp.StatusCode, Body: b}, nil
}

// Verify runs the ownership challenge: the URL must answer 200 {"challenge": same} within 5 s.
func (c *Client) Verify(ctx context.Context, rawURL, memberID string, secret []byte, pushID string, challenge string) error {
	body, _ := json.Marshal(map[string]any{"v": 1, "type": "verify", "member_id": memberID, "challenge": challenge,
		"push_id": pushID, "attempt": 1, "at": time.Now().Unix()})
	res, err := c.Post(ctx, rawURL, secret, pushID, 1, body)
	if err != nil {
		return err
	}
	if res.Status != 200 {
		return fmt.Errorf("verify answered %d", res.Status)
	}
	var got struct {
		Challenge string `json:"challenge"`
	}
	if err := json.Unmarshal(res.Body, &got); err != nil || got.Challenge != challenge {
		return errors.New("verify answer did not echo the challenge")
	}
	return nil
}
