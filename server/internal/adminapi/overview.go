package adminapi

import (
	"context"
	"net/http"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/charles161/botlink/server/internal/auth"
	"github.com/charles161/botlink/server/internal/httpx"
	"github.com/charles161/botlink/server/internal/metrics"
	"github.com/charles161/botlink/server/internal/ratelimit"
	"github.com/charles161/botlink/server/internal/store"
)

// copyStates maps deliveries.state to the words the admin page uses (SPEC §1: never the internal names).
var copyStates = []struct{ db, key string }{
	{"queued", "waiting"}, {"shown", "shown"}, {"done", "done"}, {"stuck", "stuck"}, {"needs_resend", "needs_resend"}, {"expired", "expired"},
}

func emptyStates() map[string]int64 {
	m := make(map[string]int64, len(copyStates))
	for _, s := range copyStates {
		m[s.key] = 0
	}
	return m
}

func stateKey(db string) string {
	for _, s := range copyStates {
		if s.db == db {
			return s.key
		}
	}
	return db
}

// MaskEmail keeps the first two characters of the local part and the domain: "adam@acme.dev" → "ad•••@acme.dev".
func MaskEmail(e string) string {
	local, domain, ok := strings.Cut(e, "@")
	if !ok {
		return "•••"
	}
	r := []rune(local)
	if len(r) > 2 {
		r = r[:2]
	}
	return string(r) + "•••@" + domain
}

// PushErrorClass reduces a stored push error to a fixed class. The raw text can contain the member's
// URL (and its query string), so it never leaves the server.
func PushErrorClass(msg string) string {
	m := strings.ToLower(msg)
	switch {
	case m == "url blocked":
		return "blocked"
	case strings.HasPrefix(m, "status "):
		if code, err := strconv.Atoi(strings.TrimPrefix(m, "status ")); err == nil {
			switch {
			case code >= 500:
				return "http_5xx"
			case code >= 400:
				return "http_4xx"
			}
			return "http_other"
		}
		return "http_other"
	case strings.Contains(m, "timeout"), strings.Contains(m, "deadline exceeded"):
		return "timeout"
	case strings.Contains(m, "connection refused"):
		return "refused"
	case strings.Contains(m, "no such host"), strings.Contains(m, "lookup "):
		return "dns"
	case strings.Contains(m, "tls"), strings.Contains(m, "x509"), strings.Contains(m, "certificate"):
		return "tls"
	}
	return "network"
}

func utc(t *time.Time) any {
	if t == nil {
		return nil
	}
	return t.UTC()
}

func (a *API) getOverview(w http.ResponseWriter, r *http.Request, s *auth.Session) error {
	ctx := r.Context()
	until, err := a.unlockedUntil(ctx, s)
	if err != nil {
		return err
	}
	out := map[string]any{"generated_at": time.Now().UTC(), "unlocked_until": utc(until)}
	steps := []struct {
		key string
		f   func(context.Context) (any, error)
	}{
		{"totals", a.totals}, {"accounts", a.accounts}, {"rooms", a.rooms}, {"members", a.members},
		{"copies", a.copies}, {"push", a.push}, {"rate_limits", a.rateLimits},
	}
	for _, st := range steps {
		v, err := st.f(ctx)
		if err != nil {
			return err
		}
		out[st.key] = v
	}
	out["server"] = a.server(ctx)
	items, total := a.Errors.Recent()
	out["errors"] = map[string]any{"scope": "this_copy", "copy_id": a.Cfg.CopyID, "total": total, "items": items}
	httpx.WriteJSON(w, 200, out)
	return nil
}

func (a *API) totals(ctx context.Context) (any, error) {
	var accounts, rooms, members, msgs24, self24, sessions24 int64
	err := a.Pool.QueryRow(ctx, `select
		(select count(*) from accounts where deleted_at is null),
		(select count(*) from rooms where deleted_at is null),
		(select count(*) from members m join rooms r on r.id = m.room_id where m.removed_at is null and r.deleted_at is null),
		(select count(*) from messages where created_at > now() - interval '24 hours' and scope <> 'self'),
		(select count(*) from messages where created_at > now() - interval '24 hours' and scope = 'self'),
		(select count(distinct account_id) from web_sessions where expires_at > now() and last_seen_at > now() - interval '24 hours')`).
		Scan(&accounts, &rooms, &members, &msgs24, &self24, &sessions24)
	if err != nil {
		return nil, err
	}
	return map[string]any{"accounts": accounts, "rooms": rooms, "members": members, "messages_24h": msgs24, "self_tests_24h": self24,
		"people_active_24h": sessions24}, nil
}

func (a *API) accounts(ctx context.Context) (any, error) {
	rows, err := a.Pool.Query(ctx, `
		select a.id, a.display_name, a.email, a.created_at,
		  (select max(s.last_seen_at) from web_sessions s where s.account_id = a.id),
		  (select count(*) from room_people p join rooms r on r.id = p.room_id
		     where p.account_id = a.id and p.removed_at is null and r.deleted_at is null),
		  count(*) over ()
		from accounts a where a.deleted_at is null
		order by a.created_at desc limit $1`, ListCap)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []map[string]any{}
	var total int64
	for rows.Next() {
		var id, name, email string
		var created time.Time
		var seen *time.Time
		var nrooms int64
		if err := rows.Scan(&id, &name, &email, &created, &seen, &nrooms, &total); err != nil {
			return nil, err
		}
		admin := a.Cfg.IsAdmin(email)
		shown := MaskEmail(email)
		if admin {
			shown = email
		}
		items = append(items, map[string]any{"id": id, "display_name": name, "email": shown, "is_admin": admin,
			"created_at": created.UTC(), "last_seen_at": utc(seen), "rooms": nrooms})
	}
	return map[string]any{"total": total, "items": items}, rows.Err()
}

func (a *API) rooms(ctx context.Context) (any, error) {
	rows, err := a.Pool.Query(ctx, `
		select r.id, r.name, o.display_name, r.created_at,
		  (select count(*) from members m where m.room_id = r.id and m.removed_at is null),
		  (select count(*) from room_people p where p.room_id = r.id and p.removed_at is null),
		  count(*) over ()
		from rooms r join accounts o on o.id = r.owner_account_id
		where r.deleted_at is null
		order by r.created_at desc limit $1`, ListCap)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []map[string]any{}
	var total int64
	for rows.Next() {
		var id, name, owner string
		var created time.Time
		var nm, np int64
		if err := rows.Scan(&id, &name, &owner, &created, &nm, &np, &total); err != nil {
			return nil, err
		}
		items = append(items, map[string]any{"id": id, "name": name, "owner_name": owner, "created_at": created.UTC(),
			"member_count": nm, "people_count": np})
	}
	return map[string]any{"total": total, "items": items}, rows.Err()
}

func (a *API) members(ctx context.Context) (any, error) {
	rows, err := a.Pool.Query(ctx, `
		select m.id, m.room_id, r.name, m.name, m.app, m.app_name, m.turn, a.display_name,
		  greatest(m.last_poll_at, m.last_wait_at, m.last_seen_at),
		  `+store.PresenceSQL+`,
		  m.holder_session is not null, m.joined_at, m.removed_at,
		  exists (select 1 from deliveries d where d.member_id = m.id and d.state = 'stuck'),
		  m.wake_verified_at is not null,
		  count(*) over ()
		from members m join rooms r on r.id = m.room_id join accounts a on a.id = m.account_id
		where r.deleted_at is null
		order by m.removed_at is not null, greatest(m.last_poll_at, m.last_wait_at, m.last_seen_at) desc nulls last, m.joined_at desc
		limit $1`, ListCap)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []map[string]any{}
	var total int64
	for rows.Next() {
		var id, roomID, roomName, name, app, turn, person string
		var appName *string
		var last, removed *time.Time
		var joined time.Time
		var p store.Presence
		var holder, stuck, verified bool
		if err := rows.Scan(&id, &roomID, &roomName, &name, &app, &appName, &turn, &person, &last, &p.WaitFresh, &p.PollFresh, &p.Active, &p.PollPath, &p.WaitRecent3m, &p.WaitRecent24h, &p.PollRecent24h,
			&holder, &joined, &removed, &stuck, &verified, &total); err != nil {
			return nil, err
		}
		// Same rule as store.ActiveMembers (the room page), computed for every room in one query.
		p.WakeVerified = verified && !stuck
		seenFresh := p.WaitFresh || p.PollFresh
		label := store.TurnLabel(turn, p)
		if removed != nil {
			label = "removed"
		}
		items = append(items, map[string]any{"id": id, "room_id": roomID, "room_name": roomName, "name": name, "app": app,
			"app_name": appName, "turn": turn, "turn_label": label, "person_name": person, "last_active_at": utc(last),
			"listening": seenFresh && removed == nil, "holder_present": holder && removed == nil, "stuck": stuck,
			"joined_at": joined.UTC(), "removed": removed != nil, "removed_at": utc(removed)})
	}
	return map[string]any{"total": total, "items": items}, rows.Err()
}

func (a *API) copies(ctx context.Context) (any, error) {
	rows, err := a.Pool.Query(ctx, `
		select r.id, r.name, d.state, count(*)
		from deliveries d join messages m on m.id = d.message_id join rooms r on r.id = m.room_id
		group by r.id, r.name, d.state`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	total := emptyStates()
	type roomRow struct {
		id, name string
		states   map[string]int64
	}
	byRoom := map[string]*roomRow{}
	for rows.Next() {
		var id, name, state string
		var n int64
		if err := rows.Scan(&id, &name, &state, &n); err != nil {
			return nil, err
		}
		rr := byRoom[id]
		if rr == nil {
			rr = &roomRow{id: id, name: name, states: emptyStates()}
			byRoom[id] = rr
		}
		k := stateKey(state)
		rr.states[k] += n
		total[k] += n
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	perRoom := make([]map[string]any, 0, len(byRoom))
	for _, rr := range byRoom {
		perRoom = append(perRoom, map[string]any{"room_id": rr.id, "room_name": rr.name, "states": rr.states})
	}
	sort.Slice(perRoom, func(i, j int) bool {
		si, sj := perRoom[i]["states"].(map[string]int64), perRoom[j]["states"].(map[string]int64)
		if si["stuck"] != sj["stuck"] {
			return si["stuck"] > sj["stuck"]
		}
		if si["waiting"] != sj["waiting"] {
			return si["waiting"] > sj["waiting"]
		}
		return perRoom[i]["room_name"].(string) < perRoom[j]["room_name"].(string)
	})
	if len(perRoom) > ListCap {
		perRoom = perRoom[:ListCap]
	}
	reasons := map[string]int64{"attempts": 0, "wakes": 0, "undecryptable": 0, "bad_signature": 0, "cannot_wake": 0}
	rr, err := a.Pool.Query(ctx, `select stuck_reason, count(*) from deliveries where state = 'stuck' group by 1`)
	if err != nil {
		return nil, err
	}
	defer rr.Close()
	for rr.Next() {
		var reason string
		var n int64
		if err := rr.Scan(&reason, &n); err != nil {
			return nil, err
		}
		reasons[reason] += n
	}
	return map[string]any{"total": total, "per_room": perRoom, "stuck_reasons": reasons}, rr.Err()
}

func (a *API) push(ctx context.Context) (any, error) {
	var pending, retrying, failed, failed24, alwaysOn int64
	if err := a.Pool.QueryRow(ctx, `select
		count(*) filter (where not done), count(*) filter (where not done and tries > 0),
		count(*) filter (where failed), count(*) filter (where failed and created_at > now() - interval '24 hours'),
		(select count(*) from members where turn = 'always_on' and removed_at is null)
		from push_jobs`).Scan(&pending, &retrying, &failed, &failed24, &alwaysOn); err != nil {
		return nil, err
	}
	classes := map[string]int64{}
	rows, err := a.Pool.Query(ctx, `select last_error, count(*) from push_jobs where last_error is not null group by 1`)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var msg string
		var n int64
		if err := rows.Scan(&msg, &n); err != nil {
			rows.Close()
			return nil, err
		}
		classes[PushErrorClass(msg)] += n
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	errClasses := make([]map[string]any, 0, len(classes))
	for k, n := range classes {
		errClasses = append(errClasses, map[string]any{"class": k, "count": n})
	}
	sort.Slice(errClasses, func(i, j int) bool { return errClasses[i]["count"].(int64) > errClasses[j]["count"].(int64) })
	recent := []map[string]any{}
	rows, err = a.Pool.Query(ctx, `
		select r.name, m.name, p.tries, coalesce(p.last_error, ''), p.created_at
		from push_jobs p join members m on m.id = p.member_id join rooms r on r.id = m.room_id
		where p.failed order by p.id desc limit 20`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var room, member, msg string
		var tries int
		var at time.Time
		if err := rows.Scan(&room, &member, &tries, &msg, &at); err != nil {
			return nil, err
		}
		recent = append(recent, map[string]any{"room_name": room, "member_name": member, "tries": tries,
			"error_class": PushErrorClass(msg), "created_at": at.UTC()})
	}
	return map[string]any{"always_on_members": alwaysOn, "pending": pending, "retrying": retrying, "failed": failed,
		"failed_24h": failed24, "error_classes": errClasses, "recent_failures": recent}, rows.Err()
}

// rateLimits: per quota, the windows of the last 24 h that reached the limit, and roughly how many requests
// were turned away (Hit keeps counting past the limit; Over-style quotas stop at it). From rate_counters, so
// it covers every copy.
func (a *API) rateLimits(ctx context.Context) (any, error) {
	names, suffixes, maxes, windows := []string{}, []string{}, []int32{}, map[string]time.Duration{}
	for _, l := range ratelimit.All {
		names = append(names, l.Name)
		suffixes = append(suffixes, l.BucketSuffix())
		maxes = append(maxes, int32(l.Max))
		windows[l.Name] = l.Window
	}
	rows, err := a.Pool.Query(ctx, `
		select l.name, l.max,
		  count(rc.bucket) filter (where rc.count >= l.max),
		  coalesce(sum(greatest(rc.count - l.max, 0)), 0),
		  max(rc.window_start) filter (where rc.count >= l.max)
		from unnest($1::text[], $2::text[], $3::int[]) as l(name, suffix, max)
		left join rate_counters rc on starts_with(rc.bucket, l.name || ':') and right(rc.bucket, length(l.suffix)) = l.suffix
		  and rc.window_start > now() - interval '24 hours'
		group by l.name, l.max order by l.name`, names, suffixes, maxes)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []map[string]any{}
	for rows.Next() {
		var name string
		var max int32
		var hit, rejected int64
		var last *time.Time
		if err := rows.Scan(&name, &max, &hit, &rejected, &last); err != nil {
			return nil, err
		}
		items = append(items, map[string]any{"limit": name, "window_s": int(windows[name].Seconds()), "max": max,
			"windows_at_limit_24h": hit, "turned_away_24h": rejected, "last_at": utc(last),
			"turned_away_this_copy": a.M.RateLimited.Value(name)})
	}
	return items, rows.Err()
}

func (a *API) server(ctx context.Context) map[string]any {
	pctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	dbOK := a.Pool.Ping(pctx) == nil
	listen := a.Bus.Connected()
	var reqs, req5xx, req429, req4xx uint64
	for _, lv := range a.M.HTTPRequests.Labels() {
		if len(lv.Labels) != 2 {
			continue
		}
		reqs += lv.Value
		code, _ := strconv.Atoi(lv.Labels[1])
		switch {
		case code >= 500:
			req5xx += lv.Value
		case code == 429:
			req429 += lv.Value
		case code >= 400:
			req4xx += lv.Value
		}
	}
	push := map[string]uint64{}
	for _, lv := range a.M.Push.Labels() {
		if len(lv.Labels) == 1 {
			push[lv.Labels[0]] = lv.Value
		}
	}
	return map[string]any{
		"copy_id": a.Cfg.CopyID, "env": a.Cfg.Env, "started_at": a.Started.UTC(), "uptime_s": int64(time.Since(a.Started).Seconds()),
		"ready": dbOK && listen, "db_ok": dbOK, "listen_connected": listen,
		"open_polls": map[string]int64{"inbox": a.M.OpenPolls.Value("lease"), "wait": a.M.OpenPolls.Value("wait")},
		"goroutines": runtime.NumGoroutine(), "rss_bytes": metrics.ProcessRSS(),
		"counters": map[string]any{
			"http_requests": reqs, "http_4xx": req4xx, "http_429": req429, "http_5xx": req5xx,
			"stuck": a.M.Stuck.Value(), "inbox_retries": a.M.LeaseExpired.Value(), "listen_reconnects": a.M.ListenReconnects.Value(),
			"push": push,
		},
	}
}
