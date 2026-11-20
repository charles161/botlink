package plans

import (
	"context"
	"log/slog"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/charles161/botlink/server/internal/httpx"
	"github.com/charles161/botlink/server/internal/store"
)

// Entry is one credit ledger row with the balance after it.
type Entry struct {
	ID           int64     `json:"id"`
	At           time.Time `json:"at"`
	Kind         string    `json:"kind"`
	Amount       int64     `json:"amount"`
	Reason       string    `json:"reason"`
	BalanceAfter int64     `json:"balance_after"`
}

// Balance is the sum of the account's ledger.
func Balance(ctx context.Context, q store.Q, account string) (int64, error) {
	var b int64
	err := q.QueryRow(ctx, `select coalesce(sum(amount), 0)::bigint from credit_ledger where account_id = $1`, account).Scan(&b)
	return b, err
}

// Ledger lists the newest entries with the running balance after each.
func Ledger(ctx context.Context, q store.Q, account string, limit int) ([]Entry, error) {
	rows, err := q.Query(ctx, `select id, at, kind, amount, reason, bal from (
		  select id, at, kind, amount, reason, sum(amount) over (order by id)::bigint bal from credit_ledger where account_id = $1) x
		order by id desc limit $2`, account, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Entry{}
	for rows.Next() {
		var e Entry
		if err := rows.Scan(&e.ID, &e.At, &e.Kind, &e.Amount, &e.Reason, &e.BalanceAfter); err != nil {
			return nil, err
		}
		e.At = e.At.UTC()
		out = append(out, e)
	}
	return out, rows.Err()
}

func entryByID(ctx context.Context, q store.Q, account string, id int64) (Entry, error) {
	var e Entry
	err := q.QueryRow(ctx, `select id, at, kind, amount, reason, bal from (
		  select id, at, kind, amount, reason, sum(amount) over (order by id)::bigint bal from credit_ledger where account_id = $1) x
		where id = $2`, account, id).Scan(&e.ID, &e.At, &e.Kind, &e.Amount, &e.Reason, &e.BalanceAfter)
	e.At = e.At.UTC()
	return e, err
}

// Grant adds free credits from an admin, with a reason the person sees.
func Grant(ctx context.Context, pool *pgxpool.Pool, actor, account string, amount int64, reason string) (Entry, error) {
	var e Entry
	reason, err := CheckReason(reason)
	if err != nil {
		return e, err
	}
	if amount < 1 || amount > 1_000_000 {
		return e, httpx.BadRequest("Credits must be a whole number from 1 to 1000000.")
	}
	var id int64
	err = pgx.BeginTxFunc(ctx, pool, pgx.TxOptions{IsoLevel: pgx.ReadCommitted}, func(tx pgx.Tx) error {
		if err := lockAccount(ctx, tx, account); err != nil {
			return err
		}
		before, err := Balance(ctx, tx, account)
		if err != nil {
			return err
		}
		if err := tx.QueryRow(ctx, `insert into credit_ledger (account_id, kind, amount, reason, actor_account_id) values ($1, 'grant', $2, $3, $4) returning id`,
			account, amount, reason, actor).Scan(&id); err != nil {
			return err
		}
		return logChange(ctx, tx, "admin", &actor, "credits", nil, &account, "credits",
			strconv.FormatInt(before, 10), strconv.FormatInt(before+amount, 10), reason)
	})
	if err != nil {
		return e, err
	}
	return entryByID(ctx, pool, account, id)
}

// AddPaid records a bought top-up (kind topup, positive) or a refund (kind refund, negative), once per ref. Returns
// whether a row was added (false = this ref was recorded before).
func AddPaid(ctx context.Context, q store.Q, account, kind string, amount int64, reason, ref string) (bool, error) {
	tag, err := q.Exec(ctx, `insert into credit_ledger (account_id, kind, amount, reason, ref) values ($1, $2, $3, $4, $5)
		on conflict (ref) where ref is not null do nothing`, account, kind, amount, reason, ref)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() == 1, nil
}

// Prices are credits per unit of daily usage (config; 0 = free).
type Prices struct {
	Message, ChatDay, Wake int64
}

// On reports whether any price is above zero (only then is anything debited).
func (p Prices) On() bool { return p.Message > 0 || p.ChatDay > 0 || p.Wake > 0 }

// Rollup recomputes daily usage from metadata (messages, read copies, wake jobs) for yesterday and today (UTC), for
// one account or all (account ""). Counts never go down (the sweeper may already have deleted old source rows), and a
// day is final once it is over. Idempotent: every copy may run it.
func Rollup(ctx context.Context, q store.Q, account string) error {
	var acc *string
	if account != "" {
		acc = &account
	}
	_, err := q.Exec(ctx, `with
		since as (select ((now() at time zone 'UTC')::date - 1) d),
		since_ts as (select (d::timestamp at time zone 'UTC') t from since),
		sent as (
		  select mem.account_id a, (m.created_at at time zone 'UTC')::date d, count(*) n
		  from messages m join members mem on mem.id = m.from_member, since_ts
		  where m.created_at >= since_ts.t and ($1::uuid is null or mem.account_id = $1) group by 1, 2),
		act as (
		  select mem.account_id a, (m.created_at at time zone 'UTC')::date d, m.from_member mid
		  from messages m join members mem on mem.id = m.from_member, since_ts
		  where m.created_at >= since_ts.t and ($1::uuid is null or mem.account_id = $1)
		  union
		  select mem.account_id, (dl.shown_at at time zone 'UTC')::date, dl.member_id
		  from deliveries dl join members mem on mem.id = dl.member_id, since_ts
		  where dl.shown_at >= since_ts.t and ($1::uuid is null or mem.account_id = $1)),
		active as (select a, d, count(distinct mid) n from act group by 1, 2),
		wk as (
		  select mem.account_id a, (pj.created_at at time zone 'UTC')::date d, count(*) n
		  from push_jobs pj join members mem on mem.id = pj.member_id, since_ts
		  where pj.done and not pj.failed and pj.created_at >= since_ts.t and ($1::uuid is null or mem.account_id = $1) group by 1, 2
		  union all
		  select mem.account_id, (ej.created_at at time zone 'UTC')::date, count(*)
		  from event_jobs ej join event_subscriptions s on s.id = ej.subscription_id join members mem on mem.id = s.member_id, since_ts
		  where ej.done and not ej.failed and ej.created_at >= since_ts.t and ($1::uuid is null or mem.account_id = $1) group by 1, 2),
		wakes as (select a, d, sum(n)::int n from wk group by 1, 2),
		k as (select a, d from sent union select a, d from active union select a, d from wakes)
		insert into usage_daily (account_id, day, messages_sent, chats_active, wakes, final)
		select k.a, k.d, coalesce(sent.n, 0), coalesce(active.n, 0), coalesce(wakes.n, 0), k.d < (now() at time zone 'UTC')::date
		from k left join sent on sent.a = k.a and sent.d = k.d left join active on active.a = k.a and active.d = k.d
		left join wakes on wakes.a = k.a and wakes.d = k.d
		on conflict (account_id, day) do update set
		  messages_sent = greatest(usage_daily.messages_sent, excluded.messages_sent),
		  chats_active = greatest(usage_daily.chats_active, excluded.chats_active),
		  wakes = greatest(usage_daily.wakes, excluded.wakes),
		  final = usage_daily.final or excluded.final,
		  updated_at = now()`, acc)
	if err != nil {
		return err
	}
	// a day that had activity only before yesterday's recompute stays non-final otherwise
	_, err = q.Exec(ctx, `update usage_daily set final = true where not final and day < (now() at time zone 'UTC')::date
		and ($1::uuid is null or account_id = $1)`, acc)
	return err
}

// Debit charges final, not yet charged days at the given prices, once per account and day (ledger ref). With every
// price at zero (the default) it does nothing.
func Debit(ctx context.Context, q store.Q, p Prices) (int64, error) {
	if !p.On() {
		return 0, nil
	}
	tag, err := q.Exec(ctx, `with due as (
		  select account_id, day, (messages_sent * $1 + chats_active * $2 + wakes * $3)::bigint cost from usage_daily
		  where final and credits_used = 0 and (messages_sent * $1 + chats_active * $2 + wakes * $3) > 0 limit 5000),
		ins as (
		  insert into credit_ledger (account_id, kind, amount, reason, ref)
		  select account_id, 'usage', -cost, 'Usage on ' || to_char(day, 'YYYY-MM-DD'), 'usage:' || account_id || ':' || to_char(day, 'YYYY-MM-DD')
		  from due on conflict (ref) where ref is not null do nothing)
		update usage_daily u set credits_used = due.cost from due where u.account_id = due.account_id and u.day = due.day`,
		p.Message, p.ChatDay, p.Wake)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

// Day is one day of usage.
type Day struct {
	Day          string `json:"day"`
	MessagesSent int    `json:"messages_sent"`
	ChatsActive  int    `json:"chats_active"`
	Wakes        int    `json:"wakes"`
	CreditsUsed  int64  `json:"credits_used"`
}

// Usage returns the last n days (newest first, zeros included).
func Usage(ctx context.Context, q store.Q, account string, n int) ([]Day, error) {
	rows, err := q.Query(ctx, `select to_char(g.d, 'YYYY-MM-DD'), coalesce(u.messages_sent, 0), coalesce(u.chats_active, 0), coalesce(u.wakes, 0),
		coalesce(u.credits_used, 0)
		from generate_series((now() at time zone 'UTC')::date - ($2::int - 1), (now() at time zone 'UTC')::date, interval '1 day') g(d)
		left join usage_daily u on u.account_id = $1 and u.day = g.d::date order by g.d desc`, account, n)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Day{}
	for rows.Next() {
		var d Day
		if err := rows.Scan(&d.Day, &d.MessagesSent, &d.ChatsActive, &d.Wakes, &d.CreditsUsed); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

const usageLock = `select pg_try_advisory_lock(hashtext('botlink-usage'))`
const usageUnlock = `select pg_advisory_unlock(hashtext('botlink-usage'))`

// RunUsage rolls up every account's usage and debits (if prices are set) every `every`, on the copy that holds the
// advisory lock. Running it twice is harmless (Rollup and Debit are idempotent).
func RunUsage(ctx context.Context, pool *pgxpool.Pool, p Prices, every time.Duration) {
	if every == 0 {
		every = 10 * time.Minute
	}
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		if err := usageOnce(ctx, pool, p); err != nil && ctx.Err() == nil {
			slog.Warn("usage rollup failed", "err", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

func usageOnce(ctx context.Context, pool *pgxpool.Pool, p Prices) error {
	conn, err := pool.Acquire(ctx)
	if err != nil {
		return err
	}
	defer conn.Release()
	var got bool
	if err := conn.QueryRow(ctx, usageLock).Scan(&got); err != nil || !got {
		return err
	}
	defer conn.Exec(context.Background(), usageUnlock) //nolint:errcheck
	if err := Rollup(ctx, conn, ""); err != nil {
		return err
	}
	_, err = Debit(ctx, conn, p)
	return err
}
