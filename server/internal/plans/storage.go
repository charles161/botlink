package plans

// Stored bytes per account (fix-all blocker 8: one account must not fill the disk). db/migrations/0046 charges every
// stored copy of a message to the account of the member that SENT it: StorageOverhead bytes for the row while it
// exists, plus the sealed copy's bytes while the server holds them. Triggers on deliveries append signed deltas to
// account_storage_log; CompactStorage (the sweeper, once a minute) folds them into account_storage.
//
// Two limits apply at send time (CheckStorage):
//   - the plan limit storage_mb (MB), counted or refused like every plan limit (BOTLINK_LIMITS_MODE);
//   - a server-wide safety ceiling per account (BOTLINK_STORAGE_CEILING_MB), refused in EVERY mode, off included,
//     because the disk is finite.

import (
	"context"
	"fmt"
	"strconv"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/charles161/botlink/server/internal/config"
	"github.com/charles161/botlink/server/internal/httpx"
	"github.com/charles161/botlink/server/internal/store"
)

// StorageMB is the plan limit key for stored messages, in MB (MiB).
const StorageMB = "storage_mb"

// StorageOverhead is what one stored copy costs besides its sealed bytes (the row, its indexes, its share of the
// message row). It must equal the 256 in db/migrations/0046_account_storage.sql.
const StorageOverhead = 256

// MiB is one MB as limits count it.
const MiB = 1 << 20

// DefaultStorageCeilingMB is the safety ceiling per account when BOTLINK_STORAGE_CEILING_MB is unset (security review
// finding 3: 8192 / 64 = 128 free accounts to fill the server-wide total). A free account never exceeds it; an account
// on a PAID plan gets the larger of it and its plan's storage_mb (PaidCeilingMB).
const DefaultStorageCeilingMB = 64

// DefaultStorageTotalMB is the server-wide ceiling on stored message bytes across all accounts when
// BOTLINK_STORAGE_TOTAL_MB is unset.
const DefaultStorageTotalMB = 8192

// totalLockMargin: within this of the server-wide ceiling, sends of all accounts serialise on one lock so parallel
// accounts cannot overshoot together; below it the total is read without a lock (overshoot then cannot reach it).
const totalLockMargin = 64 * MiB

// CopyBytes is what one stored copy with an envelope of n bytes counts.
func CopyBytes(n int) int64 { return StorageOverhead + int64(n) }

// ToMB rounds bytes up to whole MB (1 byte over 1 MB is 2 MB, so "used <= limit" is exact).
func ToMB(b int64) int {
	if b <= 0 {
		return 0
	}
	return int((b + MiB - 1) / MiB)
}

// StorageUsed is the bytes the account has stored now: the folded total plus the deltas not folded yet (one statement,
// one snapshot, so a concurrent fold never counts a delta twice or not at all).
func StorageUsed(ctx context.Context, q store.Q, account string) (int64, error) {
	var n int64
	err := q.QueryRow(ctx, `select coalesce((select bytes from account_storage where account_id = $1), 0)
		+ coalesce((select sum(delta) from account_storage_log where account_id = $1), 0)::bigint`, account).Scan(&n)
	return n, err
}

// StorageUsedTotal is the bytes stored across all accounts now: the folded total (one row) plus every pending delta.
// Cost: one primary-key read plus a scan of the pending log, which holds about the last minute of deltas.
func StorageUsedTotal(ctx context.Context, q store.Q) (int64, error) {
	var n int64
	err := q.QueryRow(ctx, `select coalesce((select bytes from storage_total), 0)
		+ coalesce((select sum(delta) from account_storage_log), 0)::bigint`).Scan(&n)
	return n, err
}

// CompactStorage folds the pending deltas into the per-account totals and the server-wide total in one statement
// (the sweeper calls it; harmless to run twice), then drops per-account rows that reached 0 (a missing row is 0, so
// a deleted account leaves nothing behind). Returns the server-wide total after the fold.
func CompactStorage(ctx context.Context, q store.Q) (int64, error) {
	if _, err := q.Exec(ctx, `with d as (delete from account_storage_log returning account_id, delta),
		s as (select account_id, sum(delta)::bigint b from d group by account_id),
		t as (update storage_total set bytes = bytes + coalesce((select sum(b) from s), 0), updated_at = now() where one)
		insert into account_storage (account_id, bytes) select account_id, b from s
		on conflict (account_id) do update set bytes = account_storage.bytes + excluded.bytes, updated_at = now()`); err != nil {
		return 0, err
	}
	if _, err := q.Exec(ctx, `delete from account_storage where bytes = 0`); err != nil {
		return 0, err
	}
	return StorageUsedTotal(ctx, q)
}

// ServerFull is the server-wide ceiling's refusal (every limits mode). It does not blame the sender.
func ServerFull() *httpx.Error {
	return httpx.E(409, "server_full", "bot-link's server is full for now and can't store new messages. Try again later, "+
		"and tell your human if this lasts.")
}

// StorageFull is the safety ceiling's refusal (every limits mode). The chat reads it; it says what to do.
func StorageFull(ceilingMB int) *httpx.Error {
	return httpx.E(409, "storage_full", fmt.Sprintf("This account already has %d MB of messages stored on bot-link, the most one "+
		"account can have. Wait until older messages are read or expire, then send again. Tell your human if this keeps happening.", ceilingMB)).
		With("limit", "storage_ceiling").With("value", ceilingMB)
}

// CheckStorage runs inside the send transaction, before the copies are written. add is the bytes the send would store
// (CopyBytes per copy). Sends of one account are serialised here (a transaction advisory lock on the account), so
// parallel sends from many rooms cannot overshoot together. Order, all but the last in every limits mode: the
// server-wide ceiling (409 server_full), the account's safety ceiling (409 storage_full), then the plan limit through
// Enforce (off: nothing; count: recorded; block: 409 plan_limit). Returns the server-wide total it read (metrics).
// Cost per send: two lock-free reads (the account's row + its pending deltas; the total row + the pending log), plus a
// shared lock only within 64 MB of the server-wide ceiling.
func CheckStorage(ctx context.Context, tx store.Q, pool store.Q, cfg config.PlansConfig, account string, add int64) (int64, error) {
	mode, ceilingMB, totalMB := cfg.Mode(), cfg.StorageCeiling(), cfg.StorageTotal()
	if _, err := tx.Exec(ctx, `select pg_advisory_xact_lock(hashtextextended('botlink-storage:' || $1::text, 0))`, account); err != nil {
		return 0, err
	}
	var refused bool
	if err := tx.QueryRow(ctx, `select sends_refused_at is not null from accounts where id = $1`, account).Scan(&refused); err != nil {
		return 0, err
	}
	if refused {
		return 0, SendsRefused()
	}
	limit := int64(totalMB) * MiB
	total, err := StorageUsedTotal(ctx, tx)
	if err != nil {
		return 0, err
	}
	if total+add > limit-totalLockMargin { // near the top: one at a time (always after the account lock: no cycles)
		if _, err := tx.Exec(ctx, `select pg_advisory_xact_lock(hashtextextended('botlink-storage-total', 0))`); err != nil {
			return 0, err
		}
		if total, err = StorageUsedTotal(ctx, tx); err != nil {
			return 0, err
		}
	}
	if total+add > limit {
		return total, ServerFull()
	}
	used, err := StorageUsed(ctx, tx, account)
	if err != nil {
		return total, err
	}
	after := used + add
	if after > int64(ceilingMB)*MiB { // over the config ceiling: a paid plan may allow more (looked up only here)
		if ceilingMB, err = PaidCeilingMB(ctx, tx, cfg, account, ceilingMB); err != nil {
			return total, err
		}
		if after > int64(ceilingMB)*MiB {
			return total, StorageFull(ceilingMB)
		}
	}
	return total, Enforce(ctx, tx, pool, mode, StorageMB, account, "", ToMB(after), nil)
}

// PaidCeilingMB is the account's own safety ceiling: the config ceiling, or (paywall on) for an account on a paid plan
// the larger of it and the plan's effective storage_mb. While the paywall is off every account gets the config ceiling.
func PaidCeilingMB(ctx context.Context, q store.Q, cfg config.PlansConfig, account string, ceilingMB int) (int, error) {
	paid, err := OnPaidPlan(ctx, q, cfg, account)
	if err != nil || !paid {
		return ceilingMB, err
	}
	st, err := Effective(ctx, q, account)
	if err != nil {
		return ceilingMB, err
	}
	if v := st.Limits[StorageMB].Value; v > ceilingMB {
		return v, nil
	}
	return ceilingMB, nil
}

// SendsRefused is the answer to a send from an account an admin stopped (SetSendsRefused).
func SendsRefused() *httpx.Error {
	return httpx.E(403, "sends_refused", "bot-link has paused sending for this account. Messages already sent are not "+
		"affected. Tell your human: they can ask bot-link's support why.")
}

// Storage levels of the server-wide total: ok under 50 %, warn from 50 %, high from 80 % (metric
// botlink_storage_total_level 0, 1, 2; admin over-limit view storage.level).
const (
	StorageWarnPct = 50
	StorageHighPct = 80
)

// StoragePct is total as a whole percentage of ceiling.
func StoragePct(total, ceiling int64) int64 {
	if ceiling <= 0 {
		return 0
	}
	return total * 100 / ceiling
}

// StorageLevelNum is 0 (ok), 1 (warn) or 2 (high).
func StorageLevelNum(total, ceiling int64) int64 {
	switch p := StoragePct(total, ceiling); {
	case p >= StorageHighPct:
		return 2
	case p >= StorageWarnPct:
		return 1
	}
	return 0
}

// StorageLevel is StorageLevelNum as a word.
func StorageLevel(total, ceiling int64) string {
	return [...]string{"ok", "warn", "high"}[StorageLevelNum(total, ceiling)]
}

// TopAccount is one account by stored bytes (admin over-limit view).
type TopAccount struct {
	AccountID    string `json:"account_id"`
	DisplayName  string `json:"display_name"`
	Email        string `json:"email"`
	Bytes        int64  `json:"bytes"`
	SendsRefused bool   `json:"sends_refused"`
}

// TopStorage lists the n accounts storing the most bytes now (folded totals plus pending deltas).
func TopStorage(ctx context.Context, q store.Q, n int, mask func(string) string) ([]TopAccount, error) {
	rows, err := q.Query(ctx, `with u as (select account_id, sum(b)::bigint b from (
			select account_id, bytes b from account_storage union all select account_id, delta from account_storage_log) x
			group by account_id)
		select u.account_id, a.display_name, a.email, u.b, a.sends_refused_at is not null
		from u join accounts a on a.id = u.account_id where u.b > 0 order by u.b desc, u.account_id limit $1`, n)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []TopAccount{}
	for rows.Next() {
		var x TopAccount
		if err := rows.Scan(&x.AccountID, &x.DisplayName, &x.Email, &x.Bytes, &x.SendsRefused); err != nil {
			return nil, err
		}
		x.Email = mask(x.Email)
		out = append(out, x)
	}
	return out, rows.Err()
}

// SetSendsRefused is the admin's stop for an abusive account (security review finding 3: one person ends a storage
// outage in a minute): refused = its sends get 403 sends_refused (CheckStorage); purge = its copies nobody has read
// yet are dropped now (their senders' chats see them as expired), and copies already read lose their bytes. Logged
// in limit_changes. Returns the bytes freed.
func SetSendsRefused(ctx context.Context, pool *pgxpool.Pool, actor, account string, refused, purge bool, reason string) (int64, error) {
	reason, err := CheckReason(reason)
	if err != nil {
		return 0, err
	}
	var freed int64
	err = pgx.BeginTxFunc(ctx, pool, pgx.TxOptions{IsoLevel: pgx.ReadCommitted}, func(tx pgx.Tx) error {
		if err := lockAccount(ctx, tx, account); err != nil {
			return err
		}
		var was bool
		if err := tx.QueryRow(ctx, `select sends_refused_at is not null from accounts where id = $1`, account).Scan(&was); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `update accounts set sends_refused_at = case when $2 then coalesce(sends_refused_at, now()) end where id = $1`,
			account, refused); err != nil {
			return err
		}
		if err := logChange(ctx, tx, "admin", &actor, "account", nil, &account, "sends_refused", strconv.FormatBool(was), strconv.FormatBool(refused), reason); err != nil {
			return err
		}
		if !purge {
			return nil
		}
		if err := tx.QueryRow(ctx, `select coalesce(sum(octet_length(envelope)), 0)::bigint from deliveries
			where charge_account = $1 and envelope is not null`, account).Scan(&freed); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `update deliveries set state = 'expired', envelope = null, lease_until = null, stuck_reason = null
			where charge_account = $1 and state in ('queued','stuck','needs_resend')`, account); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `update deliveries set envelope = null where charge_account = $1 and envelope is not null`, account)
		return err
	})
	return freed, err
}
