package adminapi

import (
	"context"
	"net/http"
	"time"

	metricsql "github.com/charles161/botlink/db/metrics"
	"github.com/charles161/botlink/server/internal/auth"
	"github.com/charles161/botlink/server/internal/httpx"
)

// Threshold statuses.
const (
	Met      = "met"
	NotMet   = "not_met"
	TooEarly = "too_early"
)

// Threshold is one line of KILL-CRITERIA.md, evaluated now against the saved queries.
type Threshold struct {
	ID     string   `json:"id"`
	When   string   `json:"when"`   // when it is read
	Label  string   `json:"label"`  // what has to be true
	Goal   float64  `json:"goal"`   // met when value >= goal
	Unit   string   `json:"unit"`   // "rooms" | "pct" | "yes" (a yes/no criterion)
	Value  *float64 `json:"value"`  // the number so far (nil: no data yet)
	Status string   `json:"status"` // met | not_met | too_early
	Then   string   `json:"then"`   // what happens either way
	Source string   `json:"source"` // which report the threshold comes from
	Query  string   `json:"query"`  // the saved query and column that produce the value
}

// getMetrics: GET /app/v1/admin/metrics?since=<RFC 3339 or YYYY-MM-DD>. since = the launch moment (default: 7 days
// ago). Runs every saved query (db/metrics/*.sql) read-only and returns their rows plus the kill-criteria
// thresholds evaluated against them. Counts only; no email address, domain or name can be in a result (metricsql).
func (a *API) getMetrics(w http.ResponseWriter, r *http.Request, _ *auth.Session) error {
	ctx := r.Context()
	now := time.Now().UTC()
	since := now.Add(-7 * 24 * time.Hour).Truncate(time.Minute)
	if v := r.URL.Query().Get("since"); v != "" {
		t, err := time.Parse(time.RFC3339, v)
		if err != nil {
			t, err = time.Parse("2006-01-02", v)
		}
		if err != nil {
			return httpx.BadRequest("since must be a time like 2026-11-24T15:00:00Z or a date like 2026-11-24.")
		}
		if t.After(now) || t.Before(now.AddDate(-2, 0, 0)) {
			return httpx.BadRequest("since must be in the last two years, not in the future.")
		}
		since = t.UTC()
	}
	out, err := Metrics(ctx, a, since, now)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, 200, out)
	return nil
}

// Metrics runs the saved queries for the launch moment since and evaluates the thresholds as of now.
func Metrics(ctx context.Context, a *API, since, now time.Time) (map[string]any, error) {
	day := 24 * time.Hour
	run := func(name string, args ...any) ([]metricsql.Row, error) {
		return metricsql.Run(ctx, a.Pool, name, args...)
	}
	launch, err := run(metricsql.Launch, since)
	if err != nil {
		return nil, err
	}
	week1, err := run(metricsql.Funnel, since, since.Add(7*day))
	if err != nil {
		return nil, err
	}
	day30, err := run(metricsql.Funnel, since, since.Add(30*day))
	if err != nil {
		return nil, err
	}
	weekly, err := run(metricsql.Weekly)
	if err != nil {
		return nil, err
	}
	activation, err := run(metricsql.Activation)
	if err != nil {
		return nil, err
	}
	retention, err := run(metricsql.Retention)
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"generated_at": now,
		"since":        since,
		"launch":       launch[0],
		"funnel_week1": week1[0],
		"funnel_day30": day30[0],
		"weekly":       weekly,
		"activation":   activation,
		"retention":    retention,
		"thresholds":   Thresholds(since, now, launch[0], week1[0], day30[0], weekly, retention),
	}, nil
}

func num(v any) *float64 {
	var f float64
	switch x := v.(type) {
	case int64:
		f = float64(x)
	case float64:
		f = x
	default:
		return nil
	}
	return &f
}

func status(value *float64, goal float64, readyAt, now time.Time) string {
	switch {
	case now.Before(readyAt):
		return TooEarly
	case value != nil && *value >= goal:
		return Met
	}
	return NotMet
}

func pct(part, whole float64) *float64 {
	if whole == 0 {
		return nil
	}
	v := float64(int(1000*part/whole+0.5)) / 10
	return &v
}

// Thresholds evaluates KILL-CRITERIA.md. The reports: FUTURE = the internal test notes (12 Nov), LAUNCH =
// the internal test notes §4, ISB = an outside report, STRATEGY = the internal test notes
func Thresholds(since, now time.Time, launch, week1, day30 metricsql.Row, weekly, retention []metricsql.Row) []Threshold {
	day := 24 * time.Hour
	month6 := since.Add(183 * day)

	launchN := num(launch["rooms_between_people"])
	backPct := num(week1["back_next_week_pct"])
	crossPct := num(day30["cross_domain_pct"])

	// month 6: week-4 retention pooled over every cohort since the launch whose week 4 has ended
	var rooms, back float64
	for _, r := range retention {
		cw, _ := r["cohort_week"].(time.Time)
		b := num(r["week4_back"])
		if b == nil || cw.Before(since.Truncate(day).Add(-7*day)) {
			continue
		}
		rooms += *num(r["rooms"])
		back += *b
	}
	week4 := pct(back, rooms)
	// month 6: share of activated rooms spanning 2+ email domains, over the complete weeks still inside the 30 days
	var act, actCross float64
	for _, r := range weekly {
		a, c := num(r["rooms_activated"]), num(r["rooms_activated_2plus_domains"])
		if done, _ := r["week_complete"].(bool); !done || a == nil || c == nil {
			continue
		}
		act += *a
		actCross += *c
	}
	cross6 := pct(actCross, act)

	t := []Threshold{
		{ID: "launch_worked", When: "7 days after the launch post", Label: "Rooms between people in launch week", Goal: 40, Unit: "rooms",
			Value: launchN, Status: status(launchN, 40, since.Add(7*day), now),
			Then:   "Met: it worked. Under 40 but at least 10: 60 more days on the invite between two people, then decide.",
			Source: "LAUNCH-PLAN §4; REPORT-FUTURE A1", Query: "deploy/metrics.sql (launch.sql) rooms_between_people"},
		{ID: "launch_alarm", When: "7 days after the launch post", Label: "At least 10 rooms between people in launch week", Goal: 10, Unit: "rooms",
			Value: launchN, Status: status(launchN, 10, since.Add(7*day), now),
			Then:   "Not met: the invite between two people is broken; the next week goes to that, not to features. Do not raise.",
			Source: "LAUNCH-PLAN §4; REPORT-FUTURE decision 5", Query: "deploy/metrics.sql (launch.sql) rooms_between_people"},
		{ID: "launch_back", When: "14 days after the launch post", Label: "Rooms between people from launch week active again the week after", Goal: 25, Unit: "pct",
			Value: backPct, Status: status(backPct, 25, since.Add(14*day), now),
			Then:   "With 40+ in launch week: raise in Q1 2027. See KILL-CRITERIA.md.",
			Source: "REPORT-FUTURE A1 and decision 5 (LAUNCH-PLAN §4: 25 % day-7 retention of two-person rooms)",
			Query:  "db/metrics/funnel.sql (since, since + 7 days) back_next_week_pct"},
		{ID: "day30_cross_domain", When: "30 days after the launch post", Label: "Rooms between people spanning 2+ email domains", Goal: 12, Unit: "pct",
			Value: crossPct, Status: status(crossPct, 12, since.Add(30*day), now),
			Then:   "Met: build company identity for connections between companies. Not met: per-seat teams. Not both. (Nothing is charged while bot-link is free.)",
			Source: "REPORT-FUTURE decision 3", Query: "db/metrics/funnel.sql (since, since + 30 days) cross_domain_pct"},
		{ID: "month6_week4", When: "6 months after the launch post", Label: "Week-4 retention of rooms between people", Goal: 30, Unit: "pct",
			Value: week4, Status: status(week4, 30, month6, now),
			Then:   "Not met: pivot or sell.",
			Source: "ISB futures §0 point 5 (STRATEGY week 6: 30 % for activated rooms)",
			Query:  "db/metrics/retention.sql sum(week4_back) / sum(rooms), cohorts since the launch"},
		{ID: "month6_cross_domain", When: "6 months after the launch post", Label: "Activated rooms spanning 2+ email domains", Goal: 20, Unit: "pct",
			Value: cross6, Status: status(cross6, 20, month6, now),
			Then:   "Not met: pivot or sell.",
			Source: "ISB futures §0 point 5 and signposts",
			Query:  "db/metrics/weekly.sql sum(rooms_activated_2plus_domains) / sum(rooms_activated), complete weeks"},
	}
	// Raise or find a home: from the three launch lines above.
	raise := Threshold{ID: "raise", When: "14 days after the launch post", Label: "40+ rooms between people and 25 % back the week after", Goal: 1, Unit: "yes",
		Status: TooEarly, Then: "Met: raise. Under 10: do not raise; open it fully and find a home. Between: 60 more days, then decide.",
		Source: "REPORT-FUTURE decision 5", Query: "the launch_worked, launch_alarm and launch_back lines"}
	switch {
	case t[0].Status == TooEarly || t[2].Status == TooEarly:
		if t[1].Status == NotMet {
			raise.Status = NotMet
		}
	case t[0].Status == Met && t[2].Status == Met:
		raise.Status = Met
	default:
		raise.Status = NotMet
	}
	v := 0.0
	if raise.Status == Met {
		v = 1
	}
	if raise.Status != TooEarly {
		raise.Value = &v
	}
	return append(t, raise)
}
