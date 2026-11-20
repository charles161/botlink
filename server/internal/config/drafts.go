package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
)

// DraftConfig caps room drafts, the rooms a chat asks for (docs/protocol/room-drafts.md §5). Every cap is counted in
// Postgres. Per caller IP = the address the invite lookup limit counts (httpx.ClientIP). 0 = the default.
type DraftConfig struct {
	OpenPerIP     int // BOTLINK_DRAFT_OPEN_PER_IP, default 5: open drafts made from one address
	PerIPHour     int // BOTLINK_DRAFT_PER_IP_HOUR, default 30: drafts made from one address per hour
	OpenTotal     int // BOTLINK_DRAFT_OPEN_TOTAL, default 20000: open drafts on the whole server
	OpenPerPerson int // BOTLINK_DRAFT_OPEN_PER_PERSON, default 3: open drafts one account has claimed
}

// Draft cap defaults.
const (
	DefaultDraftOpenPerIP     = 5
	DefaultDraftPerIPHour     = 30
	DefaultDraftOpenTotal     = 20000
	DefaultDraftOpenPerPerson = 3
)

func orDefault(v, def int) int {
	if v <= 0 {
		return def
	}
	return v
}

func (d DraftConfig) OpenPerIPMax() int { return orDefault(d.OpenPerIP, DefaultDraftOpenPerIP) }
func (d DraftConfig) PerIPHourMax() int { return orDefault(d.PerIPHour, DefaultDraftPerIPHour) }
func (d DraftConfig) OpenTotalMax() int { return orDefault(d.OpenTotal, DefaultDraftOpenTotal) }
func (d DraftConfig) OpenPerPersonMax() int {
	return orDefault(d.OpenPerPerson, DefaultDraftOpenPerPerson)
}

func draftsFromEnv() (DraftConfig, error) {
	var d DraftConfig
	for _, f := range []struct {
		env string
		dst *int
	}{
		{"BOTLINK_DRAFT_OPEN_PER_IP", &d.OpenPerIP},
		{"BOTLINK_DRAFT_PER_IP_HOUR", &d.PerIPHour},
		{"BOTLINK_DRAFT_OPEN_TOTAL", &d.OpenTotal},
		{"BOTLINK_DRAFT_OPEN_PER_PERSON", &d.OpenPerPerson},
	} {
		v := strings.TrimSpace(os.Getenv(f.env))
		if v == "" {
			continue
		}
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 || n > 1000000 {
			return d, fmt.Errorf("%s must be a whole number from 1 to 1000000 (got %q)", f.env, v)
		}
		*f.dst = n
	}
	return d, nil
}
