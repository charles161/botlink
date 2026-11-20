// Package plans: plans, live limits, per-account snapshots (only up), temporary boosts, enforcement, the change
// log, credits and daily usage (CONTRACT-PLANS.md, SPEC §9, db/migrations/0021_plans.sql).
//
// Every rule lives in Postgres, so any number of server copies agree:
//   - an account's snapshot of a plan (account_plan_limits) is written the first time it is needed, from the plan's
//     numbers at that time; a plan raise lifts every snapshot of that plan in the same transaction; a lowering writes
//     the OLD numbers for every existing account that had no snapshot yet, then changes the plan, so only accounts
//     created afterwards get the lower numbers;
//   - a per-account raise must be above the account's current permanent value (the server refuses lower);
//   - a boost is a raise with an end date (Postgres now() decides whether it is active);
//   - effective value = max(snapshot, raise, active boost), capped by today's hard caps (Ceiling).
package plans

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/charles161/botlink/server/internal/analytics"
	"github.com/charles161/botlink/server/internal/config"
	"github.com/charles161/botlink/server/internal/httpx"
	"github.com/charles161/botlink/server/internal/store"
)

// Limit keys (JSON and limit_key values).
const (
	Rooms         = "rooms"
	AgentsPerRoom = "agents_per_room"
	PeoplePerRoom = "people_per_room"
	HistoryDays   = "history_days"
)

// FreeHistoryDays: the days of room reports a chat keeps while the paywall is off (GET /api/v1/me history_days). 7 is
// what every shipped client keeps by default (client/src/archive.ts DEFAULT_HISTORY_DAYS) and the free plan's number,
// so the free launch changes nothing for anyone; the history lives on the chat's own machine, not on the server.
const FreeHistoryDays = 7

// Keys in display order.
var Keys = []string{Rooms, AgentsPerRoom, PeoplePerRoom, HistoryDays, StorageMB}

// Ceiling is today's hard caps (SPEC §9), still enforced where they always were: rooms owned per account
// (appapi/rooms.go), members per room (agentapi/join.go, appapi/approve.go), people per room (appapi/approve.go).
// A plan or account value above it is stored, but the effective value is capped. History has no ceiling.
var Ceiling = map[string]int{Rooms: 20, AgentsPerRoom: 20, PeoplePerRoom: 10}

// MaxLimit bounds every stored limit.
const MaxLimit = 10000

// HeadsUp: how long before a boost ends the person is told.
const HeadsUp = 7 * 24 * time.Hour

// Modes (config BOTLINK_LIMITS_MODE).
const (
	ModeOff   = "off"
	ModeCount = "count"
	ModeBlock = "block"
)

// Label is the word people see for a limit key.
func Label(k string) string {
	switch k {
	case Rooms:
		return "rooms"
	case AgentsPerRoom:
		return "members per room"
	case PeoplePerRoom:
		return "people per room"
	case HistoryDays:
		return "days of history"
	case StorageMB:
		return "MB of stored messages"
	}
	return k
}

// ValidKey reports whether k is a limit key.
func ValidKey(k string) bool {
	for _, x := range Keys {
		if x == k {
			return true
		}
	}
	return false
}

// Limits is one set of the plan numbers.
type Limits struct {
	Rooms, AgentsPerRoom, PeoplePerRoom, HistoryDays, StorageMB int
}

// Get returns the value for key k.
func (l Limits) Get(k string) int {
	switch k {
	case Rooms:
		return l.Rooms
	case AgentsPerRoom:
		return l.AgentsPerRoom
	case PeoplePerRoom:
		return l.PeoplePerRoom
	case HistoryDays:
		return l.HistoryDays
	case StorageMB:
		return l.StorageMB
	}
	return 0
}

// Raises are per-account raises; nil = none.
type Raises map[string]*int

// Boost is an active or past temporary raise.
type Boost struct {
	ID        string    `json:"id"`
	Limit     string    `json:"limit"`
	Value     int       `json:"value"`
	StartsAt  time.Time `json:"starts_at"`
	EndsAt    time.Time `json:"ends_at"`
	Active    bool      `json:"active"`
	Reason    string    `json:"reason"`
	By        *string   `json:"by"`
	permanent int       // the permanent value it raises (set by State)
}

// BoostRef is what a limit view shows of the boost that sets it.
type BoostRef struct {
	ID     string    `json:"id"`
	Value  int       `json:"value"`
	EndsAt time.Time `json:"ends_at"`
}

// Limit is one effective limit and where it comes from.
type Limit struct {
	Value     int       `json:"value"`
	Source    string    `json:"source"` // plan | raise | boost | ceiling
	PlanValue int       `json:"plan_value"`
	Raise     *int      `json:"raise"`
	Boost     *BoostRef `json:"boost"`
	Ceiling   *int      `json:"ceiling"`
	Permanent int       `json:"-"` // max(plan snapshot, raise), capped: what remains when boosts end
}

// State is an account's plan and effective limits.
type State struct {
	AccountID string
	PlanID    string
	PlanName  string
	Snapshot  Limits
	Raises    Raises
	Boosts    []Boost // active only
	Limits    map[string]*Limit
}

// CurrentPlan is the account's plan now: its paid plan while paid_until is in the future (Postgres clock), else free.
func CurrentPlan(ctx context.Context, q store.Q, account string) (id, name string, err error) {
	err = q.QueryRow(ctx, `select p.id, p.name from plans p where p.id = coalesce((
		select case when b.plan_id <> 'free' and (b.paid_until is null or b.paid_until > now()) then b.plan_id else 'free' end
		from account_billing b where b.account_id = $1), 'free')`, account).Scan(&id, &name)
	return id, name, err
}

// OnPaidPlan reports whether the account is on a paid plan now. Always false while the paywall is off: then every
// account is free, whatever account_billing holds, and nothing is looked up.
func OnPaidPlan(ctx context.Context, q store.Q, cfg config.PlansConfig, account string) (bool, error) {
	if !cfg.Paywall() {
		return false, nil
	}
	id, _, err := CurrentPlan(ctx, q, account)
	return err == nil && id != "free", err
}

// Snapshot returns the account's snapshot of a plan, writing it from the plan's current numbers if it has none.
func Snapshot(ctx context.Context, q store.Q, account, plan string) (Limits, error) {
	var l Limits
	// storage_mb NULL: a snapshot from before migration 0045 takes the plan's number
	sel := `select a.rooms, a.agents_per_room, a.people_per_room, a.history_days, coalesce(a.storage_mb, p.storage_mb)
		from account_plan_limits a join plans p on p.id = a.plan_id where a.account_id = $1 and a.plan_id = $2`
	err := q.QueryRow(ctx, sel, account, plan).Scan(&l.Rooms, &l.AgentsPerRoom, &l.PeoplePerRoom, &l.HistoryDays, &l.StorageMB)
	if err == nil {
		return l, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return l, err
	}
	if _, err := q.Exec(ctx, `insert into account_plan_limits (account_id, plan_id, rooms, agents_per_room, people_per_room, history_days, storage_mb)
		select $1, id, rooms, agents_per_room, people_per_room, history_days, storage_mb from plans where id = $2
		on conflict (account_id, plan_id) do nothing`, account, plan); err != nil {
		return l, err
	}
	err = q.QueryRow(ctx, sel, account, plan).Scan(&l.Rooms, &l.AgentsPerRoom, &l.PeoplePerRoom, &l.HistoryDays, &l.StorageMB)
	return l, err
}

func loadRaises(ctx context.Context, q store.Q, account string) (Raises, error) {
	r := Raises{}
	var a, b, c, d, e *int
	err := q.QueryRow(ctx, `select rooms, agents_per_room, people_per_room, history_days, storage_mb from account_raises where account_id = $1`, account).
		Scan(&a, &b, &c, &d, &e)
	if errors.Is(err, pgx.ErrNoRows) {
		return r, nil
	}
	if err != nil {
		return nil, err
	}
	r[Rooms], r[AgentsPerRoom], r[PeoplePerRoom], r[HistoryDays], r[StorageMB] = a, b, c, d, e
	return r, nil
}

// Boosts lists an account's boosts: active ones only, or also those ended in the last 90 days.
func Boosts(ctx context.Context, q store.Q, account string, withEnded bool) ([]Boost, error) {
	rows, err := q.Query(ctx, `select b.id, b.limit_key, b.value, b.starts_at, b.ends_at, b.starts_at <= now() and b.ends_at > now(), b.reason, a.display_name
		from limit_boosts b left join accounts a on a.id = b.created_by
		where b.account_id = $1 and (b.starts_at <= now() and b.ends_at > now() or ($2 and b.ends_at > now() - interval '90 days'))
		order by b.ends_at desc`, account, withEnded)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Boost{}
	for rows.Next() {
		var b Boost
		if err := rows.Scan(&b.ID, &b.Limit, &b.Value, &b.StartsAt, &b.EndsAt, &b.Active, &b.Reason, &b.By); err != nil {
			return nil, err
		}
		b.StartsAt, b.EndsAt = b.StartsAt.UTC(), b.EndsAt.UTC()
		out = append(out, b)
	}
	return out, rows.Err()
}

// Effective computes the account's plan and effective limits.
func Effective(ctx context.Context, q store.Q, account string) (*State, error) {
	st := &State{AccountID: account, Limits: map[string]*Limit{}}
	var err error
	if st.PlanID, st.PlanName, err = CurrentPlan(ctx, q, account); err != nil {
		return nil, err
	}
	if st.Snapshot, err = Snapshot(ctx, q, account, st.PlanID); err != nil {
		return nil, err
	}
	if st.Raises, err = loadRaises(ctx, q, account); err != nil {
		return nil, err
	}
	if st.Boosts, err = Boosts(ctx, q, account, false); err != nil {
		return nil, err
	}
	for _, k := range Keys {
		st.Limits[k] = compute(k, st.Snapshot.Get(k), st.Raises[k], st.Boosts)
	}
	return st, nil
}

func compute(k string, plan int, raise *int, boosts []Boost) *Limit {
	l := &Limit{PlanValue: plan, Raise: raise, Value: plan, Source: "plan"}
	if raise != nil && *raise > l.Value {
		l.Value, l.Source = *raise, "raise"
	}
	perm := l.Value
	for _, b := range boosts {
		if b.Limit == k && b.Active && b.Value > l.Value {
			l.Value, l.Source = b.Value, "boost"
			l.Boost = &BoostRef{ID: b.ID, Value: b.Value, EndsAt: b.EndsAt}
		}
	}
	if c, ok := Ceiling[k]; ok {
		cc := c
		l.Ceiling = &cc
		if l.Value > c {
			l.Value, l.Source = c, "ceiling"
		}
		if perm > c {
			perm = c
		}
	}
	l.Permanent = perm
	return l
}

// ClientPlan is what a member's client gets in GET /api/v1/me: its person's plan and effective numbers, in ONE query
// that writes nothing. Reading coalesce(snapshot, plan) equals Effective: an account without a snapshot would take the
// plan's current numbers, and a lowering first writes the old numbers for every account without one (UpdatePlan).
func ClientPlan(ctx context.Context, q store.Q, account string) (map[string]any, error) {
	var id, name string
	var v [5]int
	err := q.QueryRow(ctx, `with p as (select * from plans where id = coalesce((select case when b.plan_id <> 'free' and
		  (b.paid_until is null or b.paid_until > now()) then b.plan_id end from account_billing b where b.account_id = $1), 'free')),
		s as (select coalesce(a.rooms, p.rooms) rooms, coalesce(a.agents_per_room, p.agents_per_room) agents_per_room,
		  coalesce(a.people_per_room, p.people_per_room) people_per_room, coalesce(a.history_days, p.history_days) history_days,
		  coalesce(a.storage_mb, p.storage_mb) storage_mb
		  from p left join account_plan_limits a on a.account_id = $1 and a.plan_id = p.id),
		r as (select * from account_raises where account_id = $1),
		b as (select limit_key k, max(value) v from limit_boosts where account_id = $1 and starts_at <= now() and ends_at > now() group by 1)
		select p.id, p.name,
		  least(greatest(s.rooms, (select rooms from r), (select v from b where k = 'rooms')), $2),
		  least(greatest(s.agents_per_room, (select agents_per_room from r), (select v from b where k = 'agents_per_room')), $3),
		  least(greatest(s.people_per_room, (select people_per_room from r), (select v from b where k = 'people_per_room')), $4),
		  greatest(s.history_days, (select history_days from r), (select v from b where k = 'history_days')),
		  greatest(s.storage_mb, (select storage_mb from r), (select v from b where k = 'storage_mb'))
		from p, s`, account, Ceiling[Rooms], Ceiling[AgentsPerRoom], Ceiling[PeoplePerRoom]).Scan(&id, &name, &v[0], &v[1], &v[2], &v[3], &v[4])
	if err != nil {
		return nil, err
	}
	return map[string]any{"id": id, "name": name, Rooms: v[0], AgentsPerRoom: v[1], PeoplePerRoom: v[2], HistoryDays: v[3], StorageMB: v[4]}, nil
}

// LimitError is the block-mode refusal (409 plan_limit).
func LimitError(key string, value int) *httpx.Error {
	var msg string
	switch key {
	case Rooms:
		msg = fmt.Sprintf("You have %d rooms, the most your plan allows. Delete a room or upgrade to add another.", value)
	case AgentsPerRoom:
		msg = fmt.Sprintf("This room has %d members, the most its plan allows.", value)
	case StorageMB:
		msg = fmt.Sprintf("Your plan allows %d MB of messages stored on bot-link, and this account has reached it. "+
			"Wait until older messages are read or expire, or ask your human to upgrade.", value)
	default:
		msg = fmt.Sprintf("This room has %d people, the most its plan allows.", value)
	}
	return httpx.E(409, "plan_limit", msg).With("limit", key).With("value", value)
}

// Enforce checks one "add" against a plan limit, inside the caller's transaction, after the hard cap passed.
// newCount is the count after the add. The room's owner decides a room's limits (account "" = look it up).
//   - off: nothing.
//   - count: an add that goes over is recorded (limit_events, in tx) and allowed.
//   - block: it is recorded as refused (on pool, so the record survives the rollback) and refused with 409.
//
// Reading and leaving never call this: a room over a limit stays usable; only adding stops (block). Sending calls it
// only for storage_mb (CheckStorage): in block mode a full account sends again once older messages are read or expire.
//
// hit (may be nil) is filled the first time this account goes over this limit on this UTC day (limit_reached_days,
// migration 0023), so the caller can send analytics limit_reached at most once per account, limit and day.
func Enforce(ctx context.Context, tx store.Q, pool store.Q, mode, key, account, roomID string, newCount int, hit *Hit) error {
	if mode == "" {
		mode = ModeCount
	}
	if mode == ModeOff {
		return nil
	}
	var room *string
	if roomID != "" {
		room = &roomID
	}
	if account == "" {
		if err := tx.QueryRow(ctx, `select owner_account_id from rooms where id = $1`, roomID).Scan(&account); err != nil {
			return err
		}
	}
	st, err := Effective(ctx, tx, account)
	if err != nil {
		return err
	}
	v := st.Limits[key].Value
	if newCount <= v {
		return nil
	}
	// one row per account, limit, room, UTC day and outcome; repeats bump attempts (migration 0022)
	const ins = `insert into limit_events (account_id, limit_key, room_id, used, value, refused) values ($1, $2, $3, $4, $5, $6)
		on conflict (account_id, limit_key, coalesce(room_id, '00000000-0000-0000-0000-000000000000'::uuid), day, refused)
		do update set attempts = limit_events.attempts + 1, used = greatest(limit_events.used, excluded.used),
		value = excluded.value, at = now()`
	q := tx
	if mode == ModeBlock {
		q = pool // the record survives the refusal's rollback
	}
	if _, err := q.Exec(ctx, ins, account, key, room, newCount, v, mode == ModeBlock); err != nil {
		return err
	}
	tag, err := q.Exec(ctx, `insert into limit_reached_days (account_id, limit_key, day) values ($1, $2, (now() at time zone 'UTC')::date)
		on conflict do nothing`, account, key)
	if err != nil {
		return err
	}
	if hit != nil && tag.RowsAffected() == 1 {
		*hit = Hit{Account: account, Key: key, Used: newCount, Refused: mode == ModeBlock, set: true}
	}
	if mode == ModeBlock {
		return LimitError(key, v)
	}
	return nil
}

// Hit is an account's first time over a limit today (see Enforce).
type Hit struct {
	Account string
	Key     string
	Used    int
	Refused bool
	set     bool
}

// AnalyticsLimit names a limit key in analytics.Limits.
var AnalyticsLimit = map[string]string{Rooms: "rooms", AgentsPerRoom: "members", PeoplePerRoom: "people"}

// Report sends analytics limit_reached (hashed account id, the limit's name, the count) once the outcome is final:
// a refusal is committed on its own; an allowed add only counts if its transaction committed (txErr nil).
func (h *Hit) Report(an *analytics.Client, txErr error) {
	if h == nil || !h.set || (!h.Refused && txErr != nil) || !an.Enabled() {
		return
	}
	an.Capture(analytics.LimitReached, an.ID(h.Account), analytics.Props{"limit": AnalyticsLimit[h.Key], "count": h.Used})
}
