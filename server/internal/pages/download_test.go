package pages

import "testing"

func TestVersionedURL(t *testing.T) {
	sha := "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	for _, c := range []struct{ base, sha, want string }{
		{"https://api.botlink.dev/dl/botlink.tgz", sha, "https://api.botlink.dev/dl/botlink-0123456789abcdef.tgz"},
		{"http://127.0.0.1:8811/dl/botlink.tgz", sha, "http://127.0.0.1:8811/dl/botlink-0123456789abcdef.tgz"},
		{"https://cdn.example/x/client.tgz", sha, "https://cdn.example/x/client.tgz?v=0123456789abcdef"},
		{"https://cdn.example/c.tgz?a=1", sha, "https://cdn.example/c.tgz?a=1&v=0123456789abcdef"},
		{"https://api.botlink.dev/dl/botlink.tgz", "", "https://api.botlink.dev/dl/botlink.tgz"},
		{"", sha, ""},
	} {
		if got := VersionedURL(c.base, c.sha); got != c.want {
			t.Errorf("VersionedURL(%q) = %q, want %q", c.base, got, c.want)
		}
	}
	var nilFile *ClientFile
	if got := nilFile.CurrentURL("https://x/dl/botlink.tgz"); got != "https://x/dl/botlink.tgz" {
		t.Errorf("nil CurrentURL = %q", got)
	}
	if got := NewClientFile("/nonexistent/botlink.tgz").CurrentURL("https://x/dl/botlink.tgz"); got != "https://x/dl/botlink.tgz" {
		t.Errorf("missing file CurrentURL = %q", got)
	}
}
