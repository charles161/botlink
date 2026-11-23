package clientcmd

import "testing"

func TestNpx(t *testing.T) {
	for in, want := range map[string]string{
		"https://api.botlink.dev/dl/botlink-0123456789abcdef.tgz": "npx -y --allow-remote=all https://api.botlink.dev/dl/botlink-0123456789abcdef.tgz",
		"http://127.0.0.1:8811/dl/botlink.tgz":                    "npx -y --allow-remote=all http://127.0.0.1:8811/dl/botlink.tgz",
		"@botlink/cli@1.0.1":                                      "npx -y @botlink/cli@1.0.1",
		"file:/tmp/botlink.tgz":                                   "npx -y file:/tmp/botlink.tgz",
	} {
		if got := Npx(in); got != want {
			t.Errorf("Npx(%q) = %q, want %q", in, got, want)
		}
	}
}
