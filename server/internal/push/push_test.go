package push

import (
	"context"
	"errors"
	"net/netip"
	"testing"
)

func TestAllowed(t *testing.T) {
	blockedIPs := []string{"127.0.0.1", "127.9.9.9", "10.0.0.1", "172.16.5.4", "172.31.255.255", "192.168.1.1", "169.254.169.254",
		"169.254.1.1", "100.64.0.1", "100.127.255.255", "0.0.0.0", "224.0.0.1", "255.255.255.255", "::1", "::", "fd00::1",
		"fc00::1", "fe80::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "64:ff9b::a00:1"}
	for _, s := range blockedIPs {
		if Allowed(netip.MustParseAddr(s), false) {
			t.Errorf("%s allowed", s)
		}
	}
	for _, s := range []string{"1.1.1.1", "8.8.8.8", "172.32.0.1", "100.128.0.1", "2606:4700:4700::1111"} {
		if !Allowed(netip.MustParseAddr(s), false) {
			t.Errorf("%s blocked", s)
		}
	}
	if !Allowed(netip.MustParseAddr("127.0.0.1"), true) || Allowed(netip.MustParseAddr("10.0.0.1"), true) {
		t.Error("loopback allowance must admit only loopback")
	}
}

func TestCheckURL(t *testing.T) {
	c := NewClient(false, false)
	for _, u := range []string{"http://example.com/x", "https://user:pw@example.com/", "https://127.0.0.1/", "https://localhost/x", "javascript:alert(1)", "https://[::1]/"} {
		if _, err := c.CheckURL(context.Background(), u); !errors.Is(err, ErrBlocked) {
			t.Errorf("%s: %v", u, err)
		}
	}
}

// A zoned IPv6 literal matches no prefix (netip.Prefix.Contains is false for zones): it must be refused outright,
// with or without the dev loopback switch.
func TestZonedAddressesNeverAllowed(t *testing.T) {
	for _, a := range []string{"::1%lo", "fe80::1%eth0", "fd00::1%eth0", "::ffff:127.0.0.1%lo"} {
		ip, err := netip.ParseAddr(a)
		if err != nil {
			t.Fatal(a, err)
		}
		if Allowed(ip, false) || Allowed(ip, true) {
			t.Errorf("%s allowed", a)
		}
	}
	c := NewClient(true, true)
	for _, u := range []string{"http://[::1%25lo]:9/x", "http://[fe80::1%25eth0]/x"} {
		if _, err := c.CheckURL(context.Background(), u); !errors.Is(err, ErrBlocked) {
			t.Errorf("%s: %v", u, err)
		}
	}
}
