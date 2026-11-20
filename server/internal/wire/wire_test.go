package wire

import "testing"

func TestParseInviteCode(t *testing.T) {
	for in, want := range map[string]string{
		"https://app.botlink.dev/i/acme-K7Q2MX9PR4": "K7Q2MX9PR4",
		"acme-k7q2mx9pr4": "K7Q2MX9PR4",
		"K7Q2MX9PR4":      "K7Q2MX9PR4",
		"https://app.botlink.dev/i/my-room-K7Q2MX9PR4/?x=1": "K7Q2MX9PR4",
	} {
		if got, ok := ParseInviteCode(in, 10); !ok || got != want {
			t.Errorf("%q → %q %v", in, got, ok)
		}
	}
	for _, bad := range []string{"", "acme-K7Q2MX9PR", "acme-K7Q2MX9PR40", "acme-K7Q2MX9PRI", "acme-K7Q2MX9PR0"} {
		if _, ok := ParseInviteCode(bad, 10); ok {
			t.Errorf("%q accepted", bad)
		}
	}
}

func TestRandCodeAlphabet(t *testing.T) {
	seen := map[rune]bool{}
	for i := 0; i < 200; i++ {
		for _, r := range RandCode(16) {
			seen[r] = true
		}
	}
	for r := range seen {
		ok := false
		for _, a := range Alphabet {
			ok = ok || a == r
		}
		if !ok {
			t.Fatalf("%q outside alphabet", r)
		}
	}
	if len(seen) != 32 {
		t.Fatalf("only %d of 32 symbols seen", len(seen))
	}
}
