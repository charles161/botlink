package events

import "testing"

// The dashboard refuses to offer Approve when its own parse of the URL (a browser's URL.hostname) gives another host
// than the card's: Host must give what a browser gives.
func TestHostIsWhatABrowserParses(t *testing.T) {
	for raw, want := range map[string]string{
		"https://Hooks.Example.COM:8443/t?k=1": "hooks.example.com",
		"https://[2606:4700::1111]:443/x":      "[2606:4700::1111]",
		"http://127.0.0.1:9/hook":              "127.0.0.1",
	} {
		if got := Host(raw); got != want {
			t.Errorf("Host(%q) = %q, want %q", raw, got, want)
		}
	}
}

// An address a person approves is shown large on the card and approved by eye, so its host must be one a person can
// read as written and a browser parses the same way (security review of fix-eventurl, 17 Nov 2026): letters, digits,
// dots and dashes with no punycode (xn--) label, or an IP address written out in full. Not a look-alike decoded from
// xn--, not a number a browser turns into an address (16843009 → 1.1.1.1), not a trailing dot.
func TestPlainHostForAnAddressAPersonApproves(t *testing.T) {
	for _, raw := range []string{
		"https://hooks.example.com/t?key=abc",
		"https://api.vendor-1.io:8443/x",
		"https://1.1.1.1/x",
		"https://[2606:4700::1111]/x",
		"http://127.0.0.1:9/hook",
		"https://HOOKS.Example.com/x",
		"https://a1.b2.example/x",
	} {
		if !PlainHost(raw) {
			t.Errorf("PlainHost(%q) = false, want true", raw)
		}
	}
	for _, raw := range []string{
		// look-alikes: punycode labels a browser decodes into another script
		"https://xn--80ak6aa92e.com/x",      // "аррӏе.com"
		"https://XN--80AK6AA92E.com/x",      // the same, upper case
		"https://login.xn--pple-43d.com/x",  // "аpple.com" one level down
		"https://xn--exmple-cua.com/x",      // "exämple.com"
		"https://paypal.xn--com-9o0a.net/x", // a label in the middle
		"https://exämple.com/x",             // Unicode as written
		"https://раураl.com/x",              // Cyrillic as written
		// numbers a browser turns into an address, and other forms Go keeps as names
		"https://16843009/x",
		"https://0x01010101/x",
		"https://1.1.257/x",
		"https://001.001.001.001/x",
		"https://0x7f.1/x",
		"https://1.0x1/x",
		"https://hooks.example.123/x",
		"https://0X1.example.0x1F/x",
		// a trailing dot, an empty label, odd characters
		"https://1.1.1.1./x",
		"https://hooks.example.com./x",
		"https://hooks..example.com/x",
		"https://hooks_example.com/x",
		"http://[fe80::1%25eth0]/x",
		"https://user@hooks.example.com/x",
	} {
		if PlainHost(raw) {
			t.Errorf("PlainHost(%q) = true: an address a person approves must have a plain host", raw)
		}
	}
}
