package config

import (
	"fmt"
	"regexp"
)

// sourceURLForm: the only shape BOTLINK_SOURCE_URL takes, https://github.com/<owner>/<repository>. The site renders it
// as a link on public pages ("Self-host it"), so anything else (another host, http, a path, a query, credentials,
// spaces or markup) refuses to start rather than becoming a link people follow from bot-link's own pages.
var sourceURLForm = regexp.MustCompile(`^https://github\.com/[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})/[A-Za-z0-9._-]{1,100}$`)

// validSourceURL: "" (no link anywhere, the default) or a plain repository address on github.com.
func validSourceURL(s string) error {
	if s == "" || sourceURLForm.MatchString(s) {
		return nil
	}
	return fmt.Errorf("refusing to start: BOTLINK_SOURCE_URL must be empty (no link) or https://github.com/<owner>/<repository> exactly (got %q)", s)
}
