package config

import (
	"strings"
	"testing"
)

// BOTLINK_SOURCE_URL: the public repository the site links to ("Self-host it"). Empty = no link anywhere. The link is
// rendered on public pages, so the server takes only a plain https://github.com/<owner>/<repo> address and refuses to
// start on anything else (no other host, no http, no query, no credentials): a typo or a hostile value never becomes
// a link people follow from bot-link's own pages.
func TestSourceURL(t *testing.T) {
	for _, ok := range []string{"", "https://github.com/charles161/botlink", "https://github.com/some-org/bot.link_2"} {
		t.Setenv("BOTLINK_SOURCE_URL", ok)
		c, err := FromEnv()
		if err != nil {
			t.Fatalf("BOTLINK_SOURCE_URL=%q refused: %v", ok, err)
		}
		if c.SourceURL != ok {
			t.Errorf("BOTLINK_SOURCE_URL=%q: SourceURL = %q", ok, c.SourceURL)
		}
	}
	for _, bad := range []string{
		"http://github.com/charles161/botlink", "https://github.com.evil.example/charles161/botlink",
		"https://evil.example/charles161/botlink", "https://gist.github.com/charles161/botlink", "javascript:alert(1)",
		"https://user:pw@github.com/charles161/botlink", "https://github.com/charles161/botlink?ref=x",
		"https://github.com/charles161/botlink#x", "https://github.com/", "https://github.com/charles161",
		"https://github.com/charles161/botlink/tree/main", "//github.com/charles161/botlink", " https://github.com/a/b",
		"https://github.com:8443/charles161/botlink", "https://GitHub.com/charles161/botlink\"><script>",
	} {
		t.Setenv("BOTLINK_SOURCE_URL", bad)
		_, err := FromEnv()
		if err == nil {
			t.Errorf("BOTLINK_SOURCE_URL=%q: the server started; it must refuse", bad)
			continue
		}
		if !strings.Contains(err.Error(), "BOTLINK_SOURCE_URL") || !strings.Contains(err.Error(), "https://github.com/<owner>/<repository>") {
			t.Errorf("BOTLINK_SOURCE_URL=%q: the error must name the setting and the form it takes: %v", bad, err)
		}
	}
}
