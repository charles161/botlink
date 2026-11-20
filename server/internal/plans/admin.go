package plans

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/charles161/botlink/server/internal/httpx"
	"github.com/charles161/botlink/server/internal/store"
	"github.com/charles161/botlink/server/internal/wire"
)

// Plan is one plan row as the admin page shows it.
type Plan struct {
	ID             string    `json:"id"`
	Name           string    `json:"name"`
	Rooms          int       `json:"rooms"`
	AgentsPerRoom  int       `json:"agents_per_room"`
	PeoplePerRoom  int       `json:"people_per_room"`
	HistoryDays    int       `json:"history_days"`
	StorageMB      int       `json:"storage_mb"`
	ForSale        bool      `json:"for_sale"`
	PriceMonth     int       `json:"price_month_usd_cents"`
	PriceYearMonth int       `json:"price_year_month_usd_cents"`
	Accounts       int       `json:"accounts"`
	UpdatedAt      time.Time `json:"updated_at"`
}

// planSelect: a plan row plus how many accounts are on it now (no billing row or an ended paid plan = free).
const planSelect = `select p.id, p.name, p.rooms, p.agents_per_room, p.people_per_room, p.history_days, p.storage_mb, p.for_sale,
	p.price_month_usd_cents, p.price_year_month_usd_cents, p.updated_at,
	(select count(*) from accounts a left join account_billing b on b.account_id = a.id where a.deleted_at is null and
	   coalesce(case when b.plan_id <> 'free' and (b.paid_until is null or b.paid_until > now()) then b.plan_id end, 'free') = p.id)
	from plans p`

func scanPlan(row pgx.Row) (Plan, error) {
	var p Plan
	err := row.Scan(&p.ID, &p.Name, &p.Rooms, &p.AgentsPerRoom, &p.PeoplePerRoom, &p.HistoryDays, &p.StorageMB, &p.ForSale, &p.PriceMonth,
		&p.PriceYearMonth, &p.UpdatedAt, &p.Accounts)
	p.UpdatedAt = p.UpdatedAt.UTC()
	return p, err
}

// ListPlans returns every plan in display order.
func ListPlans(ctx context.Context, q store.Q) ([]Plan, error) {
	rows, err := q.Query(ctx, planSelect+` order by p.sort, p.id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Plan{}
	for rows.Next() {
		p, err := scanPlan(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// GetPlan returns one plan (404 if unknown).
func GetPlan(ctx context.Context, q store.Q, id string) (Plan, error) {
	p, err := scanPlan(q.QueryRow(ctx, planSelect+` where p.id = $1`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return p, httpx.E(404, "not_found", "No plan with that id.")
	}
	return p, err
}

// Change is one changed number.
type Change struct {
	Limit string `json:"limit"`
	From  int    `json:"from"`
	To    int    `json:"to"`
}

// CheckReason validates a change reason.
func CheckReason(r string) (string, error) {
	r = strings.TrimSpace(r)
	if r == "" {
		return "", httpx.BadRequest("Give a reason.")
	}
	if len([]rune(r)) > 300 {
		return "", httpx.BadRequest("Keep the reason under 300 characters.")
	}
	return r, nil
}

func checkValue(v int) error {
	if v < 1 || v > MaxLimit {
		return httpx.BadRequest("Limits must be whole numbers from 1 to 10000.")
	}
	return nil
}

func logChange(ctx context.Context, q store.Q, actorKind string, actor *string, target string, plan, account *string, key, from, to, reason string) error {
	_, err := q.Exec(ctx, `insert into limit_changes (actor_kind, actor_account_id, target, plan_id, account_id, limit_key, from_value, to_value, reason)
		values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`, actorKind, actor, target, plan, account, key, from, to, reason)
	return err
}

// LogPlanChange records an account's plan moving (payment events).
func LogPlanChange(ctx context.Context, q store.Q, account, from, to, reason string) error {
	p := to
	return logChange(ctx, q, "payment", nil, "account_plan", &p, &account, "plan", from, to, reason)
}

// LogStatusChange records an account's payment status moving (payment events).
func LogStatusChange(ctx context.Context, q store.Q, account, from, to, reason string) error {
	return logChange(ctx, q, "payment", nil, "account_plan", nil, &account, "billing_status", from, to, reason)
}

// UpdatePlan changes a plan's numbers. A raise lifts every account's snapshot of the plan in the same transaction. A
// lowering first writes the old numbers for every existing account without a snapshot of this plan, so the lower
// numbers reach only accounts created afterwards. Returns the plan, the changes, how many snapshots were lifted and
// whether anything was lowered.
func UpdatePlan(ctx context.Context, pool *pgxpool.Pool, actor, planID string, set map[string]int, reason string) (Plan, []Change, int64, bool, error) {
	var out Plan
	changes := []Change{}
	var lifted int64
	lowered := false
	reason, err := CheckReason(reason)
	if err != nil {
		return out, nil, 0, false, err
	}
	for k, v := range set {
		if !ValidKey(k) {
			return out, nil, 0, false, httpx.BadRequest("Pick rooms, agents_per_room, people_per_room, history_days or storage_mb.")
		}
		if err := checkValue(v); err != nil {
			return out, nil, 0, false, err
		}
	}
	err = pgx.BeginTxFunc(ctx, pool, pgx.TxOptions{IsoLevel: pgx.ReadCommitted}, func(tx pgx.Tx) error {
		var old Limits
		err := tx.QueryRow(ctx, `select rooms, agents_per_room, people_per_room, history_days, storage_mb from plans where id = $1 for update`, planID).
			Scan(&old.Rooms, &old.AgentsPerRoom, &old.PeoplePerRoom, &old.HistoryDays, &old.StorageMB)
		if errors.Is(err, pgx.ErrNoRows) {
			return httpx.E(404, "not_found", "No plan with that id.")
		}
		if err != nil {
			return err
		}
		var raised []string
		var raisedTo []any
		for _, k := range Keys {
			v, ok := set[k]
			if !ok || v == old.Get(k) {
				continue
			}
			changes = append(changes, Change{Limit: k, From: old.Get(k), To: v})
			if v < old.Get(k) {
				lowered = true
			} else {
				raised = append(raised, k)
				raisedTo = append(raisedTo, v)
			}
		}
		if len(changes) == 0 {
			return httpx.BadRequest("Nothing to change.")
		}
		if lowered {
			// existing accounts keep the old numbers: write them for every account without a snapshot of this plan
			if _, err := tx.Exec(ctx, `insert into account_plan_limits (account_id, plan_id, rooms, agents_per_room, people_per_room, history_days, storage_mb)
				select a.id, $1, $2, $3, $4, $5, $6 from accounts a where a.deleted_at is null
				on conflict (account_id, plan_id) do nothing`, planID, old.Rooms, old.AgentsPerRoom, old.PeoplePerRoom, old.HistoryDays, old.StorageMB); err != nil {
				return err
			}
			// snapshots from before migration 0045 have no storage_mb (= the plan's): they keep the old number too
			if _, err := tx.Exec(ctx, `update account_plan_limits set storage_mb = $2 where plan_id = $1 and storage_mb is null`, planID, old.StorageMB); err != nil {
				return err
			}
		}
		for _, c := range changes {
			// column names come from the fixed Keys list, never from input
			if _, err := tx.Exec(ctx, `update plans set `+c.Limit+` = $2, updated_at = now() where id = $1`, planID, c.To); err != nil {
				return err
			}
			if err := logChange(ctx, tx, "admin", &actor, "plan", &planID, nil, c.Limit, strconv.Itoa(c.From), strconv.Itoa(c.To), reason); err != nil {
				return err
			}
		}
		if len(raised) > 0 {
			sets, where := []string{}, []string{}
			for i, k := range raised {
				sets = append(sets, fmt.Sprintf("%s = greatest(%s, $%d)", k, k, i+2))
				where = append(where, fmt.Sprintf("%s < $%d", k, i+2))
			}
			args := append([]any{planID}, raisedTo...)
			tag, err := tx.Exec(ctx, `update account_plan_limits set `+strings.Join(sets, ", ")+`, updated_at = now()
				where plan_id = $1 and (`+strings.Join(where, " or ")+`)`, args...)
			if err != nil {
				return err
			}
			lifted = tag.RowsAffected()
		}
		return nil
	})
	if err != nil {
		return out, nil, 0, false, err
	}
	out, err = GetPlan(ctx, pool, planID)
	return out, changes, lifted, lowered, err
}

func lockAccount(ctx context.Context, tx pgx.Tx, account string) error {
	if !wire.IsUUID(account) {
		return httpx.E(404, "not_found", "No account with that id.")
	}
	var one int
	err := tx.QueryRow(ctx, `select 1 from accounts where id = $1 and deleted_at is null for update`, account).Scan(&one)
	if errors.Is(err, pgx.ErrNoRows) {
		return httpx.E(404, "not_found", "No account with that id.")
	}
	return err
}

func onlyUp(msg string, current int) *httpx.Error {
	return httpx.E(409, "only_up", msg).With("current", current)
}

// Raise sets a per-account raise. It must be above the account's current permanent value (the higher of its plan
// snapshot and any earlier raise); the server refuses an equal or lower value.
func Raise(ctx context.Context, pool *pgxpool.Pool, actor, account, key string, value int, reason string) error {
	reason, err := CheckReason(reason)
	if err != nil {
		return err
	}
	if !ValidKey(key) {
		return httpx.BadRequest("Pick rooms, agents_per_room, people_per_room, history_days or storage_mb.")
	}
	if err := checkValue(value); err != nil {
		return err
	}
	return pgx.BeginTxFunc(ctx, pool, pgx.TxOptions{IsoLevel: pgx.ReadCommitted}, func(tx pgx.Tx) error {
		if err := lockAccount(ctx, tx, account); err != nil {
			return err
		}
		st, err := Effective(ctx, tx, account)
		if err != nil {
			return err
		}
		cur := st.Snapshot.Get(key)
		if r := st.Raises[key]; r != nil && *r > cur {
			cur = *r
		}
		if value <= cur {
			return onlyUp(fmt.Sprintf("A limit can only go up. This account already has %d.", cur), cur)
		}
		if _, err := tx.Exec(ctx, `insert into account_raises (account_id, `+key+`) values ($1, $2)
			on conflict (account_id) do update set `+key+` = excluded.`+key+`, updated_at = now()`, account, value); err != nil {
			return err
		}
		return logChange(ctx, tx, "admin", &actor, "account", nil, &account, key, strconv.Itoa(cur), strconv.Itoa(value), reason)
	})
}

// AddBoost adds a temporary raise with a visible end date (in the future, at most 366 days away). Its value must be
// above the account's current permanent value.
func AddBoost(ctx context.Context, pool *pgxpool.Pool, actor, account, key string, value int, endsAt time.Time, reason string) (string, error) {
	reason, err := CheckReason(reason)
	if err != nil {
		return "", err
	}
	if !ValidKey(key) {
		return "", httpx.BadRequest("Pick rooms, agents_per_room, people_per_room, history_days or storage_mb.")
	}
	if err := checkValue(value); err != nil {
		return "", err
	}
	id := wire.NewV7().String()
	err = pgx.BeginTxFunc(ctx, pool, pgx.TxOptions{IsoLevel: pgx.ReadCommitted}, func(tx pgx.Tx) error {
		if err := lockAccount(ctx, tx, account); err != nil {
			return err
		}
		var okEnd bool
		if err := tx.QueryRow(ctx, `select $1::timestamptz > now() and $1::timestamptz <= now() + interval '366 days'`, endsAt).Scan(&okEnd); err != nil {
			return err
		}
		if !okEnd {
			return httpx.BadRequest("The end date must be in the future and within a year.")
		}
		st, err := Effective(ctx, tx, account)
		if err != nil {
			return err
		}
		perm := st.Snapshot.Get(key)
		if r := st.Raises[key]; r != nil && *r > perm {
			perm = *r
		}
		if value <= perm {
			return onlyUp(fmt.Sprintf("A boost must be above the current limit of %d.", perm), perm)
		}
		if _, err := tx.Exec(ctx, `insert into limit_boosts (id, account_id, limit_key, value, ends_at, reason, created_by) values ($1,$2,$3,$4,$5,$6,$7)`,
			id, account, key, value, endsAt, reason, actor); err != nil {
			return err
		}
		return logChange(ctx, tx, "admin", &actor, "boost", nil, &account, key, strconv.Itoa(perm),
			fmt.Sprintf("%d until %s", value, endsAt.UTC().Format("2006-01-02")), reason)
	})
	return id, err
}

// ChangeRow is one change log entry.
type ChangeRow struct {
	ID        int64          `json:"id"`
	At        time.Time      `json:"at"`
	ActorKind string         `json:"actor_kind"`
	Actor     map[string]any `json:"actor"`
	Target    string         `json:"target"`
	PlanID    *string        `json:"plan_id"`
	AccountID *string        `json:"account_id"`
	Limit     string         `json:"limit"`
	From      *string        `json:"from"`
	To        *string        `json:"to"`
	Reason    string         `json:"reason"`
}

// Changes lists the change log, newest first, optionally for one account or plan.
func Changes(ctx context.Context, q store.Q, account, plan string, limit int) ([]ChangeRow, error) {
	var acc, pl *string
	if account != "" {
		acc = &account
	}
	if plan != "" {
		pl = &plan
	}
	rows, err := q.Query(ctx, `select c.id, c.at, c.actor_kind, c.actor_account_id, a.display_name, c.target, c.plan_id, c.account_id,
		c.limit_key, c.from_value, c.to_value, c.reason
		from limit_changes c left join accounts a on a.id = c.actor_account_id
		where ($1::uuid is null or c.account_id = $1) and ($2::text is null or c.plan_id = $2)
		order by c.id desc limit $3`, acc, pl, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ChangeRow{}
	for rows.Next() {
		var c ChangeRow
		var actorID, actorName *string
		if err := rows.Scan(&c.ID, &c.At, &c.ActorKind, &actorID, &actorName, &c.Target, &c.PlanID, &c.AccountID, &c.Limit, &c.From, &c.To, &c.Reason); err != nil {
			return nil, err
		}
		c.At = c.At.UTC()
		if actorID != nil {
			n := ""
			if actorName != nil {
				n = *actorName
			}
			c.Actor = map[string]any{"account_id": *actorID, "display_name": n}
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// RoomCount is one owned room's counts.
type RoomCount struct {
	ID      string   `json:"id"`
	Name    string   `json:"name"`
	Members int      `json:"members"`
	People  int      `json:"people"`
	Over    []string `json:"over"`
}

// OwnedRooms lists the account's rooms with member and people counts.
func OwnedRooms(ctx context.Context, q store.Q, account string) ([]RoomCount, error) {
	rows, err := q.Query(ctx, `select r.id, r.name,
		(select count(*) from members m where m.room_id = r.id and m.removed_at is null),
		(select count(*) from room_people p where p.room_id = r.id and p.removed_at is null)
		from rooms r where r.owner_account_id = $1 and r.deleted_at is null order by r.created_at, r.id`, account)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []RoomCount{}
	for rows.Next() {
		var r RoomCount
		if err := rows.Scan(&r.ID, &r.Name, &r.Members, &r.People); err != nil {
			return nil, err
		}
		r.Over = []string{}
		out = append(out, r)
	}
	return out, rows.Err()
}

// Over is one limit an account is over now.
type Over struct {
	Limit    string  `json:"limit"`
	Used     int     `json:"used"`
	Value    int     `json:"value"`
	RoomID   *string `json:"room_id"`
	RoomName *string `json:"room_name"`
}

// OverNow lists what the account is over right now (live counts against effective limits).
func OverNow(st *State, rooms []RoomCount) []Over {
	out := []Over{}
	if n := len(rooms); n > st.Limits[Rooms].Value {
		out = append(out, Over{Limit: Rooms, Used: n, Value: st.Limits[Rooms].Value})
	}
	for i := range rooms {
		r := &rooms[i]
		if r.Members > st.Limits[AgentsPerRoom].Value {
			r.Over = append(r.Over, AgentsPerRoom)
			out = append(out, Over{Limit: AgentsPerRoom, Used: r.Members, Value: st.Limits[AgentsPerRoom].Value, RoomID: &r.ID, RoomName: &r.Name})
		}
		if r.People > st.Limits[PeoplePerRoom].Value {
			r.Over = append(r.Over, PeoplePerRoom)
			out = append(out, Over{Limit: PeoplePerRoom, Used: r.People, Value: st.Limits[PeoplePerRoom].Value, RoomID: &r.ID, RoomName: &r.Name})
		}
	}
	return out
}

// OverAccount is one account over a limit now.
type OverAccount struct {
	AccountID   string `json:"account_id"`
	DisplayName string `json:"display_name"`
	Email       string `json:"email"`
	PlanID      string `json:"plan_id"`
	Over        []Over `json:"over"`
}

// OverEvent is one recorded time an add went over.
type OverEvent struct {
	At          time.Time `json:"at"`
	AccountID   string    `json:"account_id"`
	DisplayName string    `json:"display_name"`
	Limit       string    `json:"limit"`
	RoomID      *string   `json:"room_id"`
	Used        int       `json:"used"`
	Value       int       `json:"value"`
	Refused     bool      `json:"refused"`
	Attempts    int       `json:"attempts"` // adds that went over that day (one row per account, limit, room, day)
}

// OverLimit lists accounts over a limit now (live) and the recent over events, each capped at max. Only accounts
// whose counts exceed the lowest limit any plan or snapshot holds are checked one by one.
func OverLimit(ctx context.Context, q store.Q, max int, mask func(string) string) ([]OverAccount, []OverEvent, error) {
	rows, err := q.Query(ctx, `with lo as (
		  select least((select min(rooms) from plans), coalesce((select min(rooms) from account_plan_limits), 2147483647)) r,
		         least((select min(agents_per_room) from plans), coalesce((select min(agents_per_room) from account_plan_limits), 2147483647)) m,
		         least((select min(people_per_room) from plans), coalesce((select min(people_per_room) from account_plan_limits), 2147483647)) p),
		owned as (
		  select r.owner_account_id a, count(*) n,
		         max((select count(*) from members m where m.room_id = r.id and m.removed_at is null)) mm,
		         max((select count(*) from room_people x where x.room_id = r.id and x.removed_at is null)) pp
		  from rooms r where r.deleted_at is null group by r.owner_account_id)
		select o.a, a.display_name, a.email from owned o join accounts a on a.id = o.a, lo
		where a.deleted_at is null and (o.n > lo.r or o.mm > lo.m or o.pp > lo.p) order by a.created_at limit $1`, max)
	if err != nil {
		return nil, nil, err
	}
	type cand struct{ id, name, email string }
	var cands []cand
	for rows.Next() {
		var c cand
		if err := rows.Scan(&c.id, &c.name, &c.email); err != nil {
			rows.Close()
			return nil, nil, err
		}
		cands = append(cands, c)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}
	accounts := []OverAccount{}
	for _, c := range cands {
		st, err := Effective(ctx, q, c.id)
		if err != nil {
			return nil, nil, err
		}
		rs, err := OwnedRooms(ctx, q, c.id)
		if err != nil {
			return nil, nil, err
		}
		if o := OverNow(st, rs); len(o) > 0 {
			accounts = append(accounts, OverAccount{AccountID: c.id, DisplayName: c.name, Email: mask(c.email), PlanID: st.PlanID, Over: o})
		}
	}
	erows, err := q.Query(ctx, `select e.at, e.account_id, a.display_name, e.limit_key, e.room_id, e.used, e.value, e.refused, e.attempts
		from limit_events e join accounts a on a.id = e.account_id order by e.at desc, e.id desc limit $1`, max)
	if err != nil {
		return nil, nil, err
	}
	defer erows.Close()
	events := []OverEvent{}
	for erows.Next() {
		var e OverEvent
		if err := erows.Scan(&e.At, &e.AccountID, &e.DisplayName, &e.Limit, &e.RoomID, &e.Used, &e.Value, &e.Refused, &e.Attempts); err != nil {
			return nil, nil, err
		}
		e.At = e.At.UTC()
		events = append(events, e)
	}
	return accounts, events, erows.Err()
}
