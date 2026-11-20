package test

// Blocker 8 (fix-all lane LIMITS): one account cannot fill the disk. Every stored copy of a message is charged to the
// sender's account (db/migrations/0046); the plan limit storage_mb counts or blocks like the other plan limits, and a
// server-wide safety ceiling per account (BOTLINK_STORAGE_CEILING_MB) refuses in every limits mode.

import (
	"context"
	"encoding/hex"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/charles161/botlink/server/internal/config"
	"github.com/charles161/botlink/server/internal/plans"
	"github.com/charles161/botlink/server/internal/ratelimit"
	"github.com/charles161/botlink/server/internal/sweeper"
	"github.com/charles161/botlink/server/internal/testkit"
	"github.com/charles161/botlink/server/internal/wire"
)

// bigCT: ciphertext bytes per copy; base64 makes each copy about 61 KB, under the 64 KiB envelope cap.
const bigCT = 45000

// bigEnvelope is Agent.Envelope with n bytes of ciphertext.
func (a *Agent) bigEnvelope(msgID, scope, toID, toFP string, n int) map[string]any {
	ct := wire.RandBytes(n)
	h := map[string]any{"v": 3, "id": msgID, "room": a.Room, "from": a.ID, "from_fp": a.FP(), "to": toID, "to_fp": toFP,
		"scope": scope, "in_reply_to": nil, "sent_at": time.Now().Unix(), "expires_at": time.Now().Unix() + 3600,
		"ct_sha256": wire.SHA256Hex(ct)}
	hb := mustJSON(h)
	sig := wire.Sign(a.Key.Priv, "botlink-env-v1", hb)
	return map[string]any{"v": 3, "h": wire.B64URL(hb), "ct": b64std(ct), "sig": hex.EncodeToString(sig)}
}

// bigSend sends one message of about 61 KB per copy to every recipient (scope room when there are several).
func (a *Agent) bigSend(c *Copy, to ...*Agent) *Resp {
	a.t.Helper()
	id := wire.NewV7().String()
	scope := "member"
	if len(to) > 1 {
		scope = "room"
	}
	var envs []map[string]any
	for _, r := range to {
		envs = append(envs, map[string]any{"to_member": r.ID, "to_fp": r.FP(), "envelope": a.bigEnvelope(id, scope, r.ID, r.FP(), bigCT)})
	}
	b := map[string]any{"id": id, "room_id": a.Room, "scope": scope, "envelopes": envs}
	if scope == "member" {
		b["to_member"] = to[0].ID
	}
	return a.Do(c, "POST", "/api/v1/messages", b)
}

func storedBytes(t testing.TB, c *Copy, account string) int64 {
	t.Helper()
	n, err := plans.StorageUsed(context.Background(), c.Pool, account)
	if err != nil {
		t.Fatal(err)
	}
	return n
}

// truth recomputes an account's stored bytes from the copies themselves.
func truth(t testing.TB, c *Copy, account string) int64 {
	t.Helper()
	var n int64
	if err := c.Pool.QueryRow(context.Background(), `select coalesce(sum($2::int + coalesce(octet_length(envelope), 0)), 0)::bigint
		from deliveries where charge_account = $1`, account, plans.StorageOverhead).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func sweepNow(t testing.TB, c *Copy) {
	t.Helper()
	if ran, err := (&sweeper.Sweeper{Pool: c.Pool}).Once(context.Background()); err != nil || !ran {
		t.Fatalf("sweep ran=%v err=%v", ran, err)
	}
}

// fillUntilRefused sends from each sender in turn until a send is refused; returns the refusal.
func fillUntilRefused(t *testing.T, c *Copy, pairs [][2]*Agent) *Resp {
	t.Helper()
	for i := 0; i < 60; i++ {
		p := pairs[i%len(pairs)]
		r := p[0].bigSend(c, p[1])
		if r.Status != 201 {
			return r
		}
	}
	t.Fatal("never refused")
	return nil
}

// The safety ceiling holds in every limits mode, whether the account sends in one room or in many; a second account
// is not affected; the refusal is plain and says what to do.
func TestStorageCeilingEveryModeOneRoomOrMany(t *testing.T) {
	for _, mode := range []string{"off", "count", "block"} {
		t.Run(mode, func(t *testing.T) {
			c := StartCopy(t, NewDB(t), "A", func(cfg *config.Config) {
				ignorePaidSetting(cfg, mode)
				paywallOn(cfg)
				cfg.Plans.StorageCeilingMB = 1
			})
			// a plan limit far above the ceiling, so only the ceiling can refuse
			exec(t, c, `update plans set storage_mb = 10000`)
			adam := NewPerson(t, c, "Adam")
			bob := NewPerson(t, c, "Bob")
			r1, r2 := adam.CreateRoom("one"), adam.CreateRoom("two")
			a1, b1 := adam.Member(c, r1, "a1"), adam.Member(c, r1, "b1")
			a2, b2 := adam.Member(c, r2, "a2"), adam.Member(c, r2, "b2")
			br := bob.CreateRoom("bobs")
			bs, bt := bob.Member(c, br, "bs"), bob.Member(c, br, "bt")
			pairs := [][2]*Agent{{a1, b1}}
			if mode != "count" { // count: one room; off and block: two rooms, the same account
				pairs = append(pairs, [2]*Agent{a2, b2})
			}
			r := fillUntilRefused(t, c, pairs)
			if r.Status != 409 || r.Code() != "storage_full" {
				t.Fatalf("refusal: %s", r)
			}
			msg := r.J["error"].(map[string]any)["message"].(string)
			for _, want := range []string{"1 MB", "Wait until", "read or expire"} {
				if !strings.Contains(msg, want) {
					t.Fatalf("refusal text %q lacks %q", msg, want)
				}
			}
			for _, bad := range []string{"deliver", "envelope", "receipt", "lease", "epoch", "—"} {
				if strings.Contains(strings.ToLower(msg), bad) {
					t.Fatalf("refusal text %q uses %q", msg, bad)
				}
			}
			used := storedBytes(t, c, adam.AccountID)
			if used > 1<<20 || used != truth(t, c, adam.AccountID) {
				t.Fatalf("stored %d (truth %d), ceiling %d", used, truth(t, c, adam.AccountID), 1<<20)
			}
			if used < 1<<20-2*70000 {
				t.Fatalf("refused too early: %d", used)
			}
			// the other room of the same account is refused too
			if r := a2.bigSend(c, b2); r.Status != 409 || r.Code() != "storage_full" {
				t.Fatalf("other room: %s", r)
			}
			// a second account is not affected
			if r := bs.bigSend(c, bt); r.Status != 201 {
				t.Fatalf("second account: %s", r)
			}
			if storedBytes(t, c, adam.AccountID) != used {
				t.Fatal("the second account's send was charged to the first")
			}
		})
	}
}

// Sending to many members at once: one room-wide message is charged once per copy.
func TestStorageChargedPerCopyToSender(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A")
	adam := NewPerson(t, c, "Adam")
	bob := NewPerson(t, c, "Bob")
	room := adam.CreateRoom("fan")
	lead := adam.Member(c, room, "lead")
	x, y := adam.Member(c, room, "x"), adam.Member(c, room, "y")
	if r := lead.bigSend(c, x, y); r.Status != 201 {
		t.Fatal(r)
	}
	used := storedBytes(t, c, adam.AccountID)
	if used < 2*bigCT || used != truth(t, c, adam.AccountID) {
		t.Fatalf("stored %d, truth %d", used, truth(t, c, adam.AccountID))
	}
	if storedBytes(t, c, bob.AccountID) != 0 {
		t.Fatal("another account was charged")
	}
}

// Counters go down when stored data is removed or expires: read and purged, replied to, expired, member removed,
// message deleted after 30 days. Folding the log into the totals (the sweeper) never changes the number.
func TestStorageCountersGoDown(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A")
	adam := NewPerson(t, c, "Adam")
	room := adam.CreateRoom("down")
	s := adam.Member(c, room, "s")
	r := adam.Member(c, room, "r")
	gone := adam.Member(c, room, "gone")
	s.Drain(c)
	r.Drain(c)
	check := func(label string) int64 {
		t.Helper()
		got, want := storedBytes(t, c, adam.AccountID), truth(t, c, adam.AccountID)
		if got != want {
			t.Fatalf("%s: stored %d, truth %d", label, got, want)
		}
		return got
	}
	var ids []string
	for i := 0; i < 4; i++ {
		res := s.bigSend(c, r)
		if res.Status != 201 {
			t.Fatal(res)
		}
		ids = append(ids, res.Str("id"))
	}
	if res := s.bigSend(c, gone); res.Status != 201 {
		t.Fatal(res)
	}
	full := check("after sends")
	sweepNow(t, c)
	if check("after the sweeper folded the log") != full {
		t.Fatal("folding changed the total")
	}
	// expired
	exec(t, c, `update deliveries set expires_at = now() - interval '1 second' where message_id = $1`, ids[0])
	sweepNow(t, c)
	afterExpire := check("expired")
	if afterExpire > full-bigCT {
		t.Fatalf("expiry did not lower: %d -> %d", full, afterExpire)
	}
	// read, then purged 24 h later
	exec(t, c, `update deliveries set state = 'shown', shown_at = now(), purge_after = now() - interval '1 second' where message_id = $1`, ids[1])
	sweepNow(t, c)
	afterPurge := check("purged")
	if afterPurge > afterExpire-bigCT {
		t.Fatalf("purge did not lower: %d -> %d", afterExpire, afterPurge)
	}
	// a member leaves: its waiting copies go
	adam.Sync(room)
	leave := room.Log.Build("member_remove", gone.Key, map[string]any{"member": gone.ID})
	if res := gone.Do(c, "DELETE", "/api/v1/me", map[string]any{"roster_entry": leave}); res.Status != 200 {
		t.Fatalf("leave: %s", res)
	}
	afterRemove := check("member removed")
	if afterRemove > afterPurge-bigCT {
		t.Fatalf("removal did not lower: %d -> %d", afterPurge, afterRemove)
	}
	// messages deleted after 30 days: the rows go, and with them their 256 bytes each
	exec(t, c, `update messages set created_at = now() - interval '31 days' where from_member = $1`, s.ID)
	sweepNow(t, c)
	if got := check("messages deleted"); got != 0 {
		t.Fatalf("after every message is gone: %d", got)
	}
}

// The plan limit storage_mb follows BOTLINK_LIMITS_MODE: off ignores it, count records going over and refuses
// nothing, block refuses with 409 plan_limit. Shown in GET /app/v1/plan with its use.
func TestStoragePlanLimitModes(t *testing.T) {
	for _, mode := range []string{"off", "count", "block"} {
		t.Run(mode, func(t *testing.T) {
			c := StartCopy(t, NewDB(t), "A", func(cfg *config.Config) { ignorePaidSetting(cfg, mode); paywallOn(cfg) })
			exec(t, c, `update plans set storage_mb = 1 where id = 'free'`)
			adam := NewPerson(t, c, "Adam")
			room := adam.CreateRoom("plan")
			s, r := adam.Member(c, room, "s"), adam.Member(c, room, "r")
			var refused *Resp
			for i := 0; i < 24; i++ {
				res := s.bigSend(c, r)
				if res.Status != 201 {
					refused = res
					break
				}
			}
			over := count(t, c, `select count(*) from limit_events where account_id = $1 and limit_key = 'storage_mb'`, adam.AccountID)
			switch mode {
			case "off":
				if refused != nil || over != 0 {
					t.Fatalf("off: refused %v, events %d", refused, over)
				}
			case "count":
				if refused != nil || over != 1 || count(t, c, `select count(*) from limit_events where account_id = $1 and limit_key = 'storage_mb' and not refused and attempts > 1`, adam.AccountID) != 1 {
					t.Fatalf("count: refused %v, events %d", refused, over)
				}
			case "block":
				if refused == nil || refused.Status != 409 || refused.Code() != "plan_limit" {
					t.Fatalf("block: %v", refused)
				}
				d := refused.J["error"].(map[string]any)["details"].(map[string]any)
				if d["limit"] != "storage_mb" || num(d["value"]) != 1 {
					t.Fatalf("details: %v", d)
				}
				if msg := refused.J["error"].(map[string]any)["message"].(string); !strings.Contains(msg, "1 MB") || !strings.Contains(msg, "upgrade") {
					t.Fatalf("text: %q", msg)
				}
				if storedBytes(t, c, adam.AccountID) > 1<<20 {
					t.Fatal("over the plan limit in block mode")
				}
			}
			l := limitOf(t, myPlan(t, adam), "storage_mb")
			if num(l["value"]) != 1 || l["source"] != "plan" || num(l["used"]) < 1 || num(l["ceiling"]) != plans.DefaultStorageCeilingMB {
				t.Fatalf("plan view: %v", l)
			}
			if (mode != "block") != (l["over"] == true) {
				t.Fatalf("over in %s: %v", mode, l)
			}
		})
	}
}

// Rooms are soft-deleted (their rows and signed roster entries stay), so creating and deleting rooms in a loop filled
// the disk at the dashboard rate (600 a minute). New rooms per account per day are limited; deleting does not give
// the count back.
func TestRoomsCreatedPerDayLimited(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A")
	adam := NewPerson(t, c, "Adam")
	bob := NewPerson(t, c, "Bob")
	for i := 0; i < ratelimit.RoomsCreatedDay.Max; i++ {
		room := adam.CreateRoom(fmt.Sprintf("churn-%d", i))
		if r := adam.Do("DELETE", "/app/v1/rooms/"+room.ID, nil); r.Status != 200 {
			t.Fatalf("delete: %s", r)
		}
	}
	id := wire.NewV7().String()
	g := testkit.NewLog(id).Build("genesis", adam.Dev, map[string]any{"name": "one-more", "owner": adam.AccountID, "device": adam.Dev.Hex()})
	r := adam.Do("POST", "/app/v1/rooms", map[string]any{"id": id, "name": "one-more", "purpose": "x", "genesis": g})
	if r.Status != 429 || r.Code() != "quota_exceeded" || r.Header.Get("Retry-After") == "" {
		t.Fatalf("room %d of the day: %s", ratelimit.RoomsCreatedDay.Max+1, r)
	}
	bob.CreateRoom("not-affected")
}

func totalBytes(t testing.TB, c *Copy) int64 {
	t.Helper()
	n, err := plans.StorageUsedTotal(context.Background(), c.Pool)
	if err != nil {
		t.Fatal(err)
	}
	return n
}

func totalTruth(t testing.TB, c *Copy) int64 {
	t.Helper()
	var n int64
	if err := c.Pool.QueryRow(context.Background(), `select coalesce(sum($1::int + coalesce(octet_length(envelope), 0)), 0)::bigint
		from deliveries where charge_account is not null`, plans.StorageOverhead).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// A server-wide ceiling on stored bytes across all accounts (overseer review): several accounts, each under its own
// ceiling, together hit it. The refusal is the same text in off, count and block, blames no account, and clears when
// copies are read or expire. The metrics show the total and the ceiling.
func TestStorageTotalCeilingEveryMode(t *testing.T) {
	var texts []string
	for _, mode := range []string{"off", "count", "block"} {
		t.Run(mode, func(t *testing.T) {
			c := StartCopy(t, NewDB(t), "A", func(cfg *config.Config) {
				ignorePaidSetting(cfg, mode)
				paywallOn(cfg)
				cfg.Plans.StorageCeilingMB = 2
				cfg.Plans.StorageTotalMB = 3
			})
			exec(t, c, `update plans set storage_mb = 10000`)
			var pairs [][2]*Agent // two senders per person (30 sends a minute each)
			var people []*Person
			for _, n := range []string{"Ann", "Ben", "Cat"} {
				p := NewPerson(t, c, n)
				room := p.CreateRoom("r-" + strings.ToLower(n))
				r := p.Member(c, room, "r")
				pairs = append(pairs, [2]*Agent{p.Member(c, room, "s"), r}, [2]*Agent{p.Member(c, room, "s2"), r})
				people = append(people, p)
			}
			// Ann fills her own 2 MB
			r := fillUntilRefused(t, c, pairs[0:2])
			if r.Code() != "storage_full" {
				t.Fatalf("ann: %s", r)
			}
			// Ben, under his own 2 MB, meets the 3 MB total
			r = fillUntilRefused(t, c, pairs[2:4])
			if r.Status != 409 || r.Code() != "server_full" {
				t.Fatalf("ben: %s", r)
			}
			if b := storedBytes(t, c, people[1].AccountID); b >= 2<<20 {
				t.Fatalf("ben was at his own ceiling: %d", b)
			}
			// Cat, who stored nothing, is refused too
			if r := pairs[4][0].bigSend(c, pairs[4][1]); r.Code() != "server_full" {
				t.Fatalf("cat: %s", r)
			}
			total := totalBytes(t, c)
			if total > 3<<20 || total != totalTruth(t, c) {
				t.Fatalf("total %d, truth %d", total, totalTruth(t, c))
			}
			if c.S.M.StorageTotal.Value() < total-70000 || c.S.M.StorageTotalCeiling.Value() != 3<<20 || c.S.M.StorageAccountCeiling.Value() != 2<<20 {
				t.Fatalf("gauges: total %d (db %d), ceiling %d, account %d", c.S.M.StorageTotal.Value(), total,
					c.S.M.StorageTotalCeiling.Value(), c.S.M.StorageAccountCeiling.Value())
			}
			msg := r.J["error"].(map[string]any)["message"].(string)
			if !strings.Contains(msg, "full") || !strings.Contains(msg, "Try again later") || strings.Contains(strings.ToLower(msg), "account") {
				t.Fatalf("text: %q", msg)
			}
			texts = append(texts, msg)
			// it clears when copies expire
			exec(t, c, `update deliveries set expires_at = now() - interval '1 second' where charge_account = $1`, people[0].AccountID)
			sweepNow(t, c)
			if r := pairs[4][0].bigSend(c, pairs[4][1]); r.Status != 201 {
				t.Fatalf("after expiry: %s", r)
			}
			if totalBytes(t, c) != totalTruth(t, c) {
				t.Fatal("total drifted")
			}
		})
	}
	if len(texts) != 3 || texts[0] != texts[1] || texts[1] != texts[2] {
		t.Fatalf("texts differ by mode: %q", texts)
	}
}

// The rule (security review finding 3): a free account never exceeds the config ceiling (default 64 MB); an account
// on a PAID plan gets the larger of the config ceiling and its plan's storage_mb.
func TestStorageCeilingPaidPlanRule(t *testing.T) {
	c := startPaid(t, NewDB(t), "A")
	ann := NewPerson(t, c, "Ann")
	if l := limitOf(t, myPlan(t, ann), "storage_mb"); num(l["value"]) != 64 || l["source"] != "ceiling" || num(l["ceiling"]) != 64 {
		t.Fatalf("free under the default ceiling: %v", l)
	}
	ben := NewPerson(t, c, "Ben")
	exec(t, c, `insert into account_billing (account_id, plan_id, status, paid_until) values ($1, 'pro', 'active', now() + interval '1 day')`, ben.AccountID)
	if l := limitOf(t, myPlan(t, ben), "storage_mb"); num(l["value"]) != 1024 || l["source"] != "plan" || num(l["ceiling"]) != 1024 {
		t.Fatalf("pro: %v", l)
	}
	// enforced at send: ceiling 1 MB, free plan 10000 MB, pro plan 2 MB
	c2 := startPaid(t, NewDB(t), "B", func(cfg *config.Config) { cfg.Plans.StorageCeilingMB = 1 })
	exec(t, c2, `update plans set storage_mb = case id when 'pro' then 2 else 10000 end`)
	free, paid := NewPerson(t, c2, "Free"), NewPerson(t, c2, "Paid")
	exec(t, c2, `insert into account_billing (account_id, plan_id, status, paid_until) values ($1, 'pro', 'active', now() + interval '1 day')`, paid.AccountID)
	for _, x := range []struct {
		p    *Person
		want int64
	}{{free, 1 << 20}, {paid, 2 << 20}} {
		room := x.p.CreateRoom("r")
		r := x.p.Member(c2, room, "r")
		pairs := [][2]*Agent{{x.p.Member(c2, room, "s"), r}, {x.p.Member(c2, room, "s2"), r}}
		if res := fillUntilRefused(t, c2, pairs); res.Code() != "storage_full" {
			t.Fatalf("%s: %s", x.p.Name, res)
		}
		if got := storedBytes(t, c2, x.p.AccountID); got > x.want || got < x.want-2*70000 {
			t.Fatalf("%s stored %d, ceiling %d", x.p.Name, got, x.want)
		}
	}
}

// Free accounts: BOTLINK_FREE_COPY_HOURS shortens how long the server keeps an unread copy's bytes; paid accounts
// keep the sender's expiry (up to 7 days).
func TestStorageFreeCopyHours(t *testing.T) {
	c := startPaid(t, NewDB(t), "A", func(cfg *config.Config) { cfg.Plans.FreeCopyHours = 2 })
	free, paid := NewPerson(t, c, "Free"), NewPerson(t, c, "Paid")
	exec(t, c, `insert into account_billing (account_id, plan_id, status, paid_until) values ($1, 'pro', 'active', now() + interval '1 day')`, paid.AccountID)
	hours := func(p *Person) float64 {
		room := p.CreateRoom("r")
		s, r := p.Member(c, room, "s"), p.Member(c, room, "r")
		res := s.sendExp(c, r, time.Now().Unix()+3*86400)
		if res.Status != 201 {
			t.Fatal(res)
		}
		var h float64
		if err := c.Pool.QueryRow(context.Background(), `select extract(epoch from expires_at - now()) / 3600 from deliveries where message_id = $1`, res.Str("id")).Scan(&h); err != nil {
			t.Fatal(err)
		}
		return h
	}
	if h := hours(free); h > 2.01 || h < 1.9 {
		t.Fatalf("free copy lives %.2f h", h)
	}
	if h := hours(paid); h < 71 {
		t.Fatalf("paid copy lives %.2f h", h)
	}
}

// sendExp sends one small message whose envelope expires at exp.
func (a *Agent) sendExp(c *Copy, to *Agent, exp int64) *Resp {
	a.t.Helper()
	id := wire.NewV7().String()
	env := a.Envelope(id, "member", to.ID, to.FP(), nil, exp)
	return a.Do(c, "POST", "/api/v1/messages", map[string]any{"id": id, "room_id": a.Room, "scope": "member", "to_member": to.ID,
		"envelopes": []map[string]any{{"to_member": to.ID, "to_fp": to.FP(), "envelope": env}}})
}

// The admin sees the top accounts by stored bytes and the server-wide level, and can end an outage in one call:
// refuse an account's sends and drop its unread copies. Undone the same way.
// The abuse tools exist with the paywall off (GET /app/v1/admin/storage) and on (also in over-limit, as before).
func TestStorageAdminTopAndRefuseSends(t *testing.T) {
	for _, paywall := range []bool{false, true} {
		t.Run(map[bool]string{false: "paywall off", true: "paywall on"}[paywall], func(t *testing.T) { storageAdminTopAndRefuseSends(t, paywall) })
	}
}

func storageAdminTopAndRefuseSends(t *testing.T, paywall bool) {
	c := StartCopy(t, NewDB(t), "A", withAdmins("root@example.com"), func(cfg *config.Config) {
		cfg.Plans.StorageCeilingMB = 4
		cfg.Plans.StorageTotalMB = 2
		cfg.Plans.SetPaywall(paywall)
	})
	root := planAdmin(t, c, "root@example.com")
	bad, ok := NewPerson(t, c, "Bad"), NewPerson(t, c, "Ok")
	br := bad.CreateRoom("b")
	bs, bs2, bt := bad.Member(c, br, "s"), bad.Member(c, br, "s2"), bad.Member(c, br, "t")
	or := ok.CreateRoom("o")
	os1, ot := ok.Member(c, or, "s"), ok.Member(c, or, "t")
	if r := fillUntilRefused(t, c, [][2]*Agent{{bs, bt}, {bs2, bt}}); r.Code() != "server_full" {
		t.Fatalf("fill: %s", r)
	}
	if r := os1.bigSend(c, ot); r.Code() != "server_full" {
		t.Fatalf("the outage: %s", r)
	}
	view := "/app/v1/admin/storage"
	if paywall {
		view = "/app/v1/admin/over-limit"
	}
	v := root.Do("GET", view, nil)
	st, _ := v.J["storage"].(map[string]any)
	if st == nil {
		t.Fatalf("%s: %s", view, v)
	}
	top := st["top"].([]any)[0].(map[string]any)
	if top["account_id"] != bad.AccountID || num(top["bytes"]) < 1<<20 || st["level"] != "high" || num(st["pct"]) < 80 ||
		num(st["ceiling_bytes"]) != 2<<20 || top["sends_refused"] != false {
		t.Fatalf("admin storage view: %v", st)
	}
	if c.S.M.StorageTotalPct.Value() < 80 {
		t.Fatalf("pct gauge %d", c.S.M.StorageTotalPct.Value())
	}
	// one call ends it
	r := root.Do("POST", "/app/v1/admin/account/sends", map[string]any{"account_id": bad.AccountID, "refused": true, "purge": true, "reason": "filling the disk"})
	if r.Status != 200 || num(r.J["freed_bytes"]) < 1<<20 {
		t.Fatalf("refuse: %s", r)
	}
	if res := os1.bigSend(c, ot); res.Status != 201 {
		t.Fatalf("after the purge: %s", res)
	}
	res := bs.bigSend(c, bt)
	if res.Status != 403 || res.Code() != "sends_refused" || !strings.Contains(res.J["error"].(map[string]any)["message"].(string), "Tell your human") {
		t.Fatalf("refused account: %s", res)
	}
	if count(t, c, `select count(*) from limit_changes where account_id = $1 and limit_key = 'sends_refused'`, bad.AccountID) != 1 {
		t.Fatal("not logged")
	}
	if totalBytes(t, c) != totalTruth(t, c) {
		t.Fatal("total drifted")
	}
	// undone
	if r := root.Do("POST", "/app/v1/admin/account/sends", map[string]any{"account_id": bad.AccountID, "refused": false, "reason": "talked to them"}); r.Status != 200 {
		t.Fatal(r)
	}
	if res := bs.sendExp(c, bt, time.Now().Unix()+3600); res.Status != 201 {
		t.Fatalf("after undo: %s", res)
	}
	// a non-admin cannot
	if r := ok.Do("POST", "/app/v1/admin/account/sends", map[string]any{"account_id": bad.AccountID, "refused": true, "reason": "x"}); r.Status != 404 {
		t.Fatalf("non-admin: %s", r)
	}
}

// Warning before the wall: the level is ok under 50 %, warn from 50 %, high from 80 % of the server-wide ceiling.
func TestStorageTotalLevels(t *testing.T) {
	for pct, want := range map[int]string{0: "ok", 49: "ok", 50: "warn", 79: "warn", 80: "high", 100: "high"} {
		if got := plans.StorageLevel(int64(pct), 100); got != want {
			t.Errorf("%d%%: %s, want %s", pct, got, want)
		}
	}
}

// Account deletion: the counters have no foreign key to accounts and the triggers never look an account up, so a
// deleted account row breaks nothing; its counters reach 0 as its copies go, and the total stays exact. Both ways:
// the row deleted outright, and the tombstone (account kept, copies outliving it).
func TestStorageAccountDeleted(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A")
	adam := NewPerson(t, c, "Adam")
	bob := NewPerson(t, c, "Bob")
	carl := NewPerson(t, c, "Carl")
	ar := adam.CreateRoom("adams")
	as, at := adam.Member(c, ar, "s"), adam.Member(c, ar, "t")
	br := bob.CreateRoom("bobs")
	bs, bt := bob.Member(c, br, "bs"), bob.Member(c, br, "bt")
	cr := carl.CreateRoom("carls")
	cs, ct := carl.Member(c, cr, "cs"), carl.Member(c, cr, "ct")
	for i := 0; i < 3; i++ {
		if r := as.bigSend(c, at); r.Status != 201 {
			t.Fatal(r)
		}
		if r := cs.bigSend(c, ct); r.Status != 201 {
			t.Fatal(r)
		}
	}
	if r := bs.bigSend(c, bt); r.Status != 201 {
		t.Fatal(r)
	}
	sweepNow(t, c)
	// 1. Adam's account row deleted outright (his rooms first; they hold his chats and their messages)
	exec(t, c, `delete from rooms where owner_account_id = $1`, adam.AccountID)
	exec(t, c, `delete from accounts where id = $1`, adam.AccountID)
	sweepNow(t, c)
	if storedBytes(t, c, adam.AccountID) != 0 || count(t, c, `select count(*) from account_storage where account_id = $1`, adam.AccountID) != 0 {
		t.Fatalf("adam's counter after delete: %d", storedBytes(t, c, adam.AccountID))
	}
	// 2. Carl tombstoned; the copies he sent outlive him, then expire
	exec(t, c, `update accounts set deleted_at = now(), email = 'deleted-' || id::text || '@deleted.invalid' where id = $1`, carl.AccountID)
	if storedBytes(t, c, carl.AccountID) == 0 {
		t.Fatal("carl's copies vanished from the count while they still exist")
	}
	exec(t, c, `update deliveries set expires_at = now() - interval '1 second' where charge_account = $1`, carl.AccountID)
	exec(t, c, `update messages set created_at = now() - interval '31 days' where from_member = $1`, cs.ID)
	sweepNow(t, c)
	if storedBytes(t, c, carl.AccountID) != 0 {
		t.Fatalf("carl: %d", storedBytes(t, c, carl.AccountID))
	}
	if got, want := totalBytes(t, c), totalTruth(t, c); got != want || got != storedBytes(t, c, bob.AccountID) {
		t.Fatalf("total %d, truth %d", got, want)
	}
}
