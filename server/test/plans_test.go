package test

// Plans, live limits, snapshots (only up), boosts, enforcement modes, credits, usage (lane D1, CONTRACT-PLANS.md).

import (
	"context"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/charles161/botlink/server/internal/config"
	"github.com/charles161/botlink/server/internal/plans"
	"github.com/charles161/botlink/server/internal/testkit"
)

func withMode(m string) func(*config.Config) {
	return func(c *config.Config) {
		c.Plans.SetPaywall(true)
		c.Plans.EditPaid(func(s *config.PaidSettings) { s.LimitsMode = m })
	}
}

// planAdmin starts a person whose email is an admin and unlocks the admin area.
func planAdmin(t *testing.T, c *Copy, email string) *Person {
	t.Helper()
	p := newPersonEmail(t, c, "Root", email)
	unlockAdmin(t, p)
	return p
}

func limitOf(t testing.TB, r *Resp, key string) map[string]any {
	t.Helper()
	ls, ok := r.J["limits"].(map[string]any)
	if !ok {
		t.Fatalf("no limits: %s", r)
	}
	return ls[key].(map[string]any)
}

func num(v any) int {
	f, _ := v.(float64)
	return int(f)
}

func myPlan(t testing.TB, p *Person) *Resp {
	t.Helper()
	r := p.Do("GET", "/app/v1/plan", nil)
	if r.Status != 200 {
		t.Fatalf("plan: %s", r)
	}
	return r
}

func TestPlansDefaultsAndClientPlan(t *testing.T) {
	c := startPaid(t, NewDB(t), "A")
	adam := NewPerson(t, c, "Adam")
	r := myPlan(t, adam)
	if r.J["plan"].(map[string]any)["id"] != "free" || r.J["mode"] != "count" {
		t.Fatalf("plan: %s", r)
	}
	want := map[string]int{"rooms": 3, "agents_per_room": 5, "people_per_room": 4, "history_days": 7}
	for k, v := range want {
		if l := limitOf(t, r, k); num(l["value"]) != v || l["source"] != "plan" {
			t.Errorf("%s: %v", k, l)
		}
	}
	if fs := r.J["for_sale"].([]any); len(fs) != 1 || fs[0].(map[string]any)["id"] != "pro" {
		t.Fatalf("for sale: %v", fs)
	}
	if b := r.J["billing"].(map[string]any); b["gateway"] != "off" || b["status"] != "none" {
		t.Fatalf("billing: %v", b)
	}
	// the client reads its person's limits from GET /api/v1/me
	room := adam.CreateRoom("plans")
	m := adam.Member(c, room, "bot")
	me := m.Do(c, "GET", "/api/v1/me", nil)
	pl, ok := me.J["plan"].(map[string]any)
	if me.Status != 200 || !ok || pl["id"] != "free" || num(pl["history_days"]) != 7 || num(pl["agents_per_room"]) != 5 {
		t.Fatalf("api me: %s", me)
	}
}

// Raising a plan lifts every account on it; lowering touches no existing account (even one never looked at);
// a per-account limit only goes up; every change is logged with who, from, to and why.
func TestPlanSnapshotsOnlyUp(t *testing.T) {
	c := startPaid(t, NewDB(t), "A", withAdmins("root@example.com"))
	root := planAdmin(t, c, "root@example.com")
	early := NewPerson(t, c, "Early") // looked at before the raise
	quiet := NewPerson(t, c, "Quiet") // never looked at until the end (no snapshot row yet)
	if r := myPlan(t, early); num(limitOf(t, r, "rooms")["value"]) != 3 {
		t.Fatal(r)
	}
	up := root.Do("POST", "/app/v1/admin/plans/update", map[string]any{"plan_id": "free", "limits": map[string]any{"rooms": 5}, "reason": "launch week"})
	if up.Status != 200 || num(up.J["plan"].(map[string]any)["rooms"]) != 5 || num(up.J["raised_accounts"]) < 1 {
		t.Fatalf("raise: %s", up)
	}
	if r := myPlan(t, early); num(limitOf(t, r, "rooms")["value"]) != 5 {
		t.Fatalf("raise did not lift: %s", r)
	}
	down := root.Do("POST", "/app/v1/admin/plans/update", map[string]any{"plan_id": "free", "limits": map[string]any{"rooms": 2, "history_days": 3}, "reason": "too generous"})
	if down.Status != 200 || !strings.Contains(down.Str("note"), "only to accounts from now on") {
		t.Fatalf("lower: %s", down)
	}
	if r := myPlan(t, early); num(limitOf(t, r, "rooms")["value"]) != 5 || num(limitOf(t, r, "history_days")["value"]) != 7 {
		t.Fatalf("lowering touched an existing account: %s", r)
	}
	if r := myPlan(t, quiet); num(limitOf(t, r, "rooms")["value"]) != 5 || num(limitOf(t, r, "history_days")["value"]) != 7 {
		t.Fatalf("lowering touched an existing account with no snapshot: %s", r)
	}
	late := NewPerson(t, c, "Late")
	if r := myPlan(t, late); num(limitOf(t, r, "rooms")["value"]) != 2 || num(limitOf(t, r, "history_days")["value"]) != 3 {
		t.Fatalf("new account should get the lowered plan: %s", r)
	}
	// a later raise to 4 lifts Late (2 → 4) and leaves Early at 5 (never down)
	if r := root.Do("POST", "/app/v1/admin/plans/update", map[string]any{"plan_id": "free", "limits": map[string]any{"rooms": 4}, "reason": "middle"}); r.Status != 200 {
		t.Fatal(r)
	}
	if r := myPlan(t, late); num(limitOf(t, r, "rooms")["value"]) != 4 {
		t.Fatalf("late: %s", r)
	}
	if r := myPlan(t, early); num(limitOf(t, r, "rooms")["value"]) != 5 {
		t.Fatalf("early: %s", r)
	}
	// per-account raise: lower and equal refused, higher accepted
	for _, v := range []int{3, 5} {
		r := root.Do("POST", "/app/v1/admin/account/raise", map[string]any{"account_id": early.AccountID, "limit": "rooms", "value": v, "reason": "x"})
		if r.Status != 409 || r.Code() != "only_up" || num(r.J["error"].(map[string]any)["details"].(map[string]any)["current"]) != 5 {
			t.Fatalf("raise to %d: %s", v, r)
		}
	}
	r := root.Do("POST", "/app/v1/admin/account/raise", map[string]any{"account_id": early.AccountID, "limit": "rooms", "value": 8, "reason": "asked nicely"})
	if r.Status != 200 || num(limitOf(t, r, "rooms")["value"]) != 8 || limitOf(t, r, "rooms")["source"] != "raise" {
		t.Fatalf("raise: %s", r)
	}
	if r := root.Do("POST", "/app/v1/admin/account/raise", map[string]any{"account_id": early.AccountID, "limit": "rooms", "value": 7, "reason": "x"}); r.Code() != "only_up" {
		t.Fatalf("lower than a raise: %s", r)
	}
	if r := root.Do("POST", "/app/v1/admin/account/raise", map[string]any{"account_id": early.AccountID, "limit": "rooms", "value": 9, "reason": ""}); r.Status != 400 {
		t.Fatalf("no reason: %s", r)
	}
	// a plan raise above an account's raise still lifts it (max of snapshot and raise)
	if r := root.Do("POST", "/app/v1/admin/plans/update", map[string]any{"plan_id": "free", "limits": map[string]any{"rooms": 10}, "reason": "big"}); r.Status != 200 {
		t.Fatal(r)
	}
	if r := myPlan(t, early); num(limitOf(t, r, "rooms")["value"]) != 10 || limitOf(t, r, "rooms")["source"] != "plan" {
		t.Fatalf("plan above raise: %s", r)
	}
	// the change log: who, when, what, from, to, why
	log := root.Do("GET", "/app/v1/admin/limit-changes?limit=50", nil)
	cs := log.J["changes"].([]any)
	found := map[string]bool{}
	for _, x := range cs {
		ch := x.(map[string]any)
		key := ch["target"].(string) + ":" + ch["limit"].(string) + ":" + strOr(ch["from"]) + ">" + strOr(ch["to"]) + ":" + ch["reason"].(string)
		found[key] = true
		if ch["actor_kind"] != "admin" || ch["actor"].(map[string]any)["account_id"] != root.AccountID {
			t.Errorf("actor: %v", ch)
		}
	}
	for _, k := range []string{"plan:rooms:3>5:launch week", "plan:rooms:5>2:too generous", "plan:history_days:7>3:too generous", "account:rooms:5>8:asked nicely"} {
		if !found[k] {
			t.Errorf("change log missing %s; have %v", k, found)
		}
	}
	if r := root.Do("GET", "/app/v1/admin/limit-changes?account_id="+early.AccountID, nil); len(r.J["changes"].([]any)) != 1 {
		t.Fatalf("filtered log: %s", r)
	}
	// lookups
	if r := root.Do("GET", "/app/v1/admin/account?email="+url.QueryEscape(early.Email), nil); r.Status != 200 || r.J["account"].(map[string]any)["email"] != early.Email {
		t.Fatalf("by email: %s", r)
	}
	if r := root.Do("GET", "/app/v1/admin/account?account_id="+early.AccountID, nil); r.Status != 200 || r.J["account"].(map[string]any)["email"] == early.Email {
		t.Fatalf("by id should mask: %s", r)
	}
	if r := root.Do("GET", "/app/v1/admin/plans", nil); r.Status != 200 || len(r.J["plans"].([]any)) != 3 {
		t.Fatalf("plans: %s", r)
	}
}

func strOr(v any) string {
	s, _ := v.(string)
	return s
}

// Non-admins never see the plan admin routes (same 404 as an unknown route); a locked admin gets admin_locked.
func TestPlanAdminGate(t *testing.T) {
	c := startPaid(t, NewDB(t), "A", withAdmins("root@example.com"))
	eve := NewPerson(t, c, "Eve")
	root := newPersonEmail(t, c, "Root", "root@example.com")
	for _, p := range []string{"/app/v1/admin/plans", "/app/v1/admin/over-limit", "/app/v1/admin/limit-changes"} {
		if r := eve.Do("GET", p, nil); r.Status != 404 {
			t.Errorf("eve %s: %s", p, r)
		}
		if r := root.Do("GET", p, nil); r.Status != 403 || r.Code() != "admin_locked" {
			t.Errorf("locked %s: %s", p, r)
		}
	}
	if r := eve.Do("POST", "/app/v1/admin/credits/grant", map[string]any{"account_id": eve.AccountID, "amount": 5, "reason": "me"}); r.Status != 404 {
		t.Fatalf("eve grant: %s", r)
	}
}

// A boost shows its end date, warns 7 days before, and ends by itself.
func TestBoostExpiryAndHeadsUp(t *testing.T) {
	c := startPaid(t, NewDB(t), "A", withAdmins("root@example.com"))
	root := planAdmin(t, c, "root@example.com")
	ann := NewPerson(t, c, "Ann")
	far := time.Now().Add(30 * 24 * time.Hour).UTC().Truncate(time.Second)
	r := root.Do("POST", "/app/v1/admin/account/boost", map[string]any{"account_id": ann.AccountID, "limit": "agents_per_room", "value": 8, "ends_at": far, "reason": "demo month"})
	if r.Status != 200 {
		t.Fatal(r)
	}
	p := myPlan(t, ann)
	l := limitOf(t, p, "agents_per_room")
	if num(l["value"]) != 8 || l["source"] != "boost" || l["boost"].(map[string]any)["ends_at"] != far.Format(time.RFC3339) {
		t.Fatalf("boost: %v", l)
	}
	for _, n := range p.J["notices"].([]any) {
		if n.(map[string]any)["kind"] == "boost_ending" {
			t.Fatalf("heads-up 30 days early: %v", n)
		}
	}
	// a second boost ending in 3 days on another limit: heads-up with the date and what comes after
	soon := time.Now().Add(3 * 24 * time.Hour).UTC().Truncate(time.Second)
	if r := root.Do("POST", "/app/v1/admin/account/boost", map[string]any{"account_id": ann.AccountID, "limit": "people_per_room", "value": 6, "ends_at": soon, "reason": "workshop"}); r.Status != 200 {
		t.Fatal(r)
	}
	p = myPlan(t, ann)
	var heads map[string]any
	for _, n := range p.J["notices"].([]any) {
		if n.(map[string]any)["kind"] == "boost_ending" {
			heads = n.(map[string]any)
		}
	}
	if heads == nil || heads["limit"] != "people_per_room" || !strings.Contains(heads["text"].(string), soon.Format("2 Jan 2006")) ||
		!strings.Contains(heads["text"].(string), "the limit is 4") {
		t.Fatalf("heads-up: %v", p.J["notices"])
	}
	// refused: a boost not above the permanent value, an end in the past, an end over a year away
	if r := root.Do("POST", "/app/v1/admin/account/boost", map[string]any{"account_id": ann.AccountID, "limit": "rooms", "value": 3, "ends_at": far, "reason": "x"}); r.Code() != "only_up" {
		t.Fatalf("boost at the limit: %s", r)
	}
	if r := root.Do("POST", "/app/v1/admin/account/boost", map[string]any{"account_id": ann.AccountID, "limit": "rooms", "value": 9, "ends_at": time.Now().Add(-time.Hour), "reason": "x"}); r.Status != 400 {
		t.Fatalf("past end: %s", r)
	}
	if r := root.Do("POST", "/app/v1/admin/account/boost", map[string]any{"account_id": ann.AccountID, "limit": "rooms", "value": 9, "ends_at": time.Now().Add(400 * 24 * time.Hour), "reason": "x"}); r.Status != 400 {
		t.Fatalf("far end: %s", r)
	}
	// the boost ends (moved into the past): back to the plan's value, no heads-up, still listed for admins
	exec(t, c, `update limit_boosts set starts_at = now() - interval '10 days', ends_at = now() - interval '1 second' where account_id = $1 and limit_key = 'people_per_room'`, ann.AccountID)
	p = myPlan(t, ann)
	if l := limitOf(t, p, "people_per_room"); num(l["value"]) != 4 || l["source"] != "plan" || l["boost"] != nil {
		t.Fatalf("after expiry: %v", l)
	}
	for _, n := range p.J["notices"].([]any) {
		if n.(map[string]any)["kind"] == "boost_ending" {
			t.Fatalf("heads-up after the end: %v", n)
		}
	}
	av := root.Do("GET", "/app/v1/admin/account?account_id="+ann.AccountID, nil)
	if bs := av.J["boosts"].([]any); len(bs) != 2 {
		t.Fatalf("admin boosts: %v", bs)
	}
}

// addPerson takes a new person into room as a room person (invite, accept, owner approves). Returns the status.
func planAddPerson(t *testing.T, c *Copy, owner *Person, room *Room, name string) *Resp {
	t.Helper()
	p := NewPerson(t, c, name)
	pi := owner.Do("POST", "/app/v1/rooms/"+room.ID+"/person-invites", map[string]any{"id": newID()})
	if pi.Status != 201 {
		t.Fatalf("person invite: %s", pi)
	}
	code := pi.Str("url")[strings.LastIndex(pi.Str("url"), "/")+1:]
	acc := p.Do("POST", "/app/v1/person-invites/"+code+"/accept", map[string]any{"device_id": p.DevID})
	if acc.Status != 201 {
		t.Fatalf("accept: %s", acc)
	}
	owner.Sync(room)
	hc := owner.Check("approve_person", acc.Str("id"))
	entry := room.Log.Build("person_add", owner.Dev, map[string]any{"account": p.AccountID, "name": name, "device": p.Dev.Hex()})
	r := owner.Do("POST", "/app/v1/person-requests/"+acc.Str("id")+"/approve", map[string]any{"human_check": map[string]any{"id": hc, "stub": true}, "roster_entry": entry})
	if r.Status == 200 {
		room.Log.Push(entry)
	}
	return r
}

// Count mode (the default): going over is recorded and shown, nothing is refused.
func TestCountModeNeverRefuses(t *testing.T) {
	c := startPaid(t, NewDB(t), "A", withAdmins("root@example.com"))
	root := planAdmin(t, c, "root@example.com")
	ann := NewPerson(t, c, "Ann")
	var rooms []*Room
	for i := 0; i < 4; i++ { // Free allows 3
		rooms = append(rooms, ann.CreateRoom("r"+string(rune('a'+i))))
	}
	for i := 0; i < 6; i++ { // Free allows 5 members per room
		ann.Member(c, rooms[0], "bot"+string(rune('a'+i)))
	}
	for i := 0; i < 4; i++ { // Free allows 4 people (owner + 3); this makes 5
		if r := planAddPerson(t, c, ann, rooms[1], "Guest "+string(rune('A'+i))); r.Status != 200 {
			t.Fatalf("person %d: %s", i, r)
		}
	}
	p := myPlan(t, ann)
	if p.J["over_limit"] != true {
		t.Fatalf("not over: %s", p)
	}
	for k, used := range map[string]int{"rooms": 4, "agents_per_room": 6, "people_per_room": 5} {
		if l := limitOf(t, p, k); l["over"] != true || num(l["used"]) != used {
			t.Errorf("%s: %v", k, l)
		}
	}
	if n := count(t, c, `select count(*) from limit_events where account_id = $1 and not refused`, ann.AccountID); n != 3 {
		t.Fatalf("limit events: %d", n)
	}
	ol := root.Do("GET", "/app/v1/admin/over-limit", nil)
	accs := ol.J["accounts"].([]any)
	if ol.J["mode"] != "count" || len(accs) != 1 || accs[0].(map[string]any)["account_id"] != ann.AccountID || len(accs[0].(map[string]any)["over"].([]any)) != 3 {
		t.Fatalf("over-limit: %s", ol)
	}
	if len(ol.J["recent"].([]any)) != 3 {
		t.Fatalf("recent: %s", ol)
	}
}

// Block mode: an add over a plan limit is refused with a plain message (and recorded); a room already over stays
// readable and usable; the hard caps refuse exactly as before.
func TestBlockModeRefuses(t *testing.T) {
	c := startPaid(t, NewDB(t), "A", withAdmins("root@example.com"), withMode("block"))
	root := planAdmin(t, c, "root@example.com")
	ann := NewPerson(t, c, "Ann")
	var rooms []*Room
	for i := 0; i < 3; i++ {
		rooms = append(rooms, ann.CreateRoom("r"+string(rune('a'+i))))
	}
	id := newID()
	l := testkit.NewLog(id)
	g := l.Build("genesis", ann.Dev, map[string]any{"name": "fourth", "owner": ann.AccountID, "device": ann.Dev.Hex()})
	r := ann.Do("POST", "/app/v1/rooms", map[string]any{"id": id, "name": "fourth", "purpose": "x", "genesis": g})
	if r.Status != 409 || r.Code() != "plan_limit" || !strings.Contains(r.J["error"].(map[string]any)["message"].(string), "You have 3 rooms") {
		t.Fatalf("4th room: %s", r)
	}
	members := []*Agent{}
	for i := 0; i < 5; i++ {
		members = append(members, ann.Member(c, rooms[0], "bot"+string(rune('a'+i))))
	}
	extra := NewAgentKeys(t, "botf")
	if r := extra.Join(c, ann.Invite(rooms[0])); r.Status != 409 || r.Code() != "plan_limit" {
		t.Fatalf("6th member join: %s", r)
	}
	for i := 0; i < 3; i++ {
		if r := planAddPerson(t, c, ann, rooms[1], "Guest "+string(rune('A'+i))); r.Status != 200 {
			t.Fatalf("person %d: %s", i, r)
		}
	}
	if r := planAddPerson(t, c, ann, rooms[1], "Guest D"); r.Status != 409 || r.Code() != "plan_limit" {
		t.Fatalf("5th person: %s", r)
	}
	if n := count(t, c, `select count(*) from limit_events where account_id = $1 and refused`, ann.AccountID); n != 3 {
		t.Fatalf("refused events: %d", n)
	}
	// over by a boost that ended: the room stays readable and members still send
	far := time.Now().Add(48 * time.Hour)
	if r := root.Do("POST", "/app/v1/admin/account/boost", map[string]any{"account_id": ann.AccountID, "limit": "agents_per_room", "value": 6, "ends_at": far, "reason": "x"}); r.Status != 200 {
		t.Fatal(r)
	}
	sixth := ann.Member(c, rooms[0], "botg")
	exec(t, c, `update limit_boosts set starts_at = now() - interval '3 days', ends_at = now() - interval '1 second' where account_id = $1`, ann.AccountID)
	if r := ann.Do("GET", "/app/v1/rooms/"+rooms[0].ID, nil); r.Status != 200 {
		t.Fatalf("over room not readable: %s", r)
	}
	if _, r := sixth.Send(c, members[0]); r.Status != 201 && r.Status != 200 {
		t.Fatalf("send in an over room: %s", r)
	}
	if lr := members[0].Lease(c, 0); lr.Status != 200 {
		t.Fatalf("lease in an over room: %s", lr)
	}
	if p := myPlan(t, ann); limitOf(t, p, "agents_per_room")["over"] != true {
		t.Fatalf("not shown as over: %s", p)
	}
}

// The hard caps (SPEC §9) still refuse as before, even when a plan is set above them.
func TestHardCapsUnchanged(t *testing.T) {
	c := startPaid(t, NewDB(t), "A", withAdmins("root@example.com"), withMode("block"))
	root := planAdmin(t, c, "root@example.com")
	if r := root.Do("POST", "/app/v1/admin/plans/update", map[string]any{"plan_id": "free", "limits": map[string]any{"rooms": 100, "agents_per_room": 50, "people_per_room": 25}, "reason": "test ceiling"}); r.Status != 200 {
		t.Fatal(r)
	}
	ann := NewPerson(t, c, "Ann")
	p := myPlan(t, ann)
	for k, v := range plans.Ceiling {
		if l := limitOf(t, p, k); num(l["value"]) != v || l["source"] != "ceiling" {
			t.Errorf("%s: %v", k, l)
		}
	}
	for i := 0; i < 20; i++ {
		ann.CreateRoom("cap" + string(rune('a'+i)))
	}
	id := newID()
	l := testkit.NewLog(id)
	g := l.Build("genesis", ann.Dev, map[string]any{"name": "cap21", "owner": ann.AccountID, "device": ann.Dev.Hex()})
	r := ann.Do("POST", "/app/v1/rooms", map[string]any{"id": id, "name": "cap21", "purpose": "x", "genesis": g})
	if r.Status != 429 || r.Code() != "quota_exceeded" {
		t.Fatalf("21st room: %s", r)
	}
}

// The ledger's arithmetic: grants, top-ups, refunds, usage debits (only when a price is set), balance after each.
func TestCreditsLedger(t *testing.T) {
	c := startPaid(t, NewDB(t), "A", withAdmins("root@example.com"))
	root := planAdmin(t, c, "root@example.com")
	ann := NewPerson(t, c, "Ann")
	g := root.Do("POST", "/app/v1/admin/credits/grant", map[string]any{"account_id": ann.AccountID, "amount": 100, "reason": "early tester"})
	if g.Status != 200 || num(g.J["balance"]) != 100 {
		t.Fatal(g)
	}
	if r := root.Do("POST", "/app/v1/admin/credits/grant", map[string]any{"account_id": ann.AccountID, "amount": 0, "reason": "x"}); r.Status != 400 {
		t.Fatal(r)
	}
	if r := root.Do("POST", "/app/v1/admin/credits/grant", map[string]any{"account_id": ann.AccountID, "amount": 5, "reason": " "}); r.Status != 400 {
		t.Fatal(r)
	}
	ctx := context.Background()
	if ok, err := plans.AddPaid(ctx, c.Pool, ann.AccountID, "topup", 500, "Credits pack", "payment:fake:p1"); err != nil || !ok {
		t.Fatal(ok, err)
	}
	if ok, _ := plans.AddPaid(ctx, c.Pool, ann.AccountID, "topup", 500, "Credits pack", "payment:fake:p1"); ok {
		t.Fatal("same payment counted twice")
	}
	if ok, err := plans.AddPaid(ctx, c.Pool, ann.AccountID, "refund", -500, "Refund", "refund:fake:r1"); err != nil || !ok {
		t.Fatal(ok, err)
	}
	// usage: two final days and today; prices zero → nothing debited
	exec(t, c, `insert into usage_daily (account_id, day, messages_sent, chats_active, wakes, final) values
		($1, (now() at time zone 'UTC')::date - 2, 10, 2, 3, true), ($1, (now() at time zone 'UTC')::date - 1, 4, 1, 0, true),
		($1, (now() at time zone 'UTC')::date, 50, 5, 5, false)`, ann.AccountID)
	if n, err := plans.Debit(ctx, c.Pool, plans.Prices{}); err != nil || n != 0 {
		t.Fatal(n, err)
	}
	p := plans.Prices{Message: 1, ChatDay: 5, Wake: 2} // day -2: 10+10+6 = 26; day -1: 4+5+0 = 9; today: not final
	if n, err := plans.Debit(ctx, c.Pool, p); err != nil || n != 2 {
		t.Fatal(n, err)
	}
	if n, _ := plans.Debit(ctx, c.Pool, p); n != 0 {
		t.Fatal("debited twice")
	}
	cr := ann.Do("GET", "/app/v1/credits", nil)
	if cr.Status != 200 || num(cr.J["balance"]) != 100-26-9 {
		t.Fatalf("balance: %s", cr)
	}
	es := cr.J["entries"].([]any)
	if len(es) != 5 {
		t.Fatalf("entries: %v", es)
	}
	running := 0
	for i := len(es) - 1; i >= 0; i-- {
		e := es[i].(map[string]any)
		running += num(e["amount"])
		if num(e["balance_after"]) != running {
			t.Fatalf("balance_after %v at %v", e["balance_after"], e)
		}
	}
	if e := es[len(es)-1].(map[string]any); e["kind"] != "grant" || e["reason"] != "early tester" {
		t.Fatalf("first entry: %v", e)
	}
	if r := myPlan(t, ann); num(r.J["credits"].(map[string]any)["balance"]) != 65 {
		t.Fatalf("plan credits: %s", r)
	}
	if r := root.Do("GET", "/app/v1/admin/limit-changes?account_id="+ann.AccountID, nil); r.J["changes"].([]any)[0].(map[string]any)["to"] != "100" {
		t.Fatalf("grant not logged: %s", r)
	}
}

// Daily usage from metadata: messages sent, chats active, today's row.
func TestDailyUsage(t *testing.T) {
	c := startPaid(t, NewDB(t), "A")
	ann := NewPerson(t, c, "Ann")
	room := ann.CreateRoom("usage")
	a := ann.Member(c, room, "a")
	b := ann.Member(c, room, "b")
	var last string
	for i := 0; i < 3; i++ {
		id, r := a.Send(c, b)
		if r.Status != 201 {
			t.Fatal(r)
		}
		last = id
	}
	// one wake made for b (an always-on call that went through) and one that failed (not counted)
	exec(t, c, `insert into push_jobs (member_id, message_id, done) values ($1, $2, true)`, b.ID, last)
	exec(t, c, `insert into push_jobs (member_id, message_id, done, failed) values ($1, $2, true, true)`, a.ID, last)
	u := ann.Do("GET", "/app/v1/usage?days=7", nil)
	if u.Status != 200 {
		t.Fatal(u)
	}
	days := u.J["days"].([]any)
	if len(days) != 7 || u.J["debits_on"] != false {
		t.Fatalf("usage: %s", u)
	}
	today := days[0].(map[string]any)
	if today["day"] != time.Now().UTC().Format("2006-01-02") || num(today["messages_sent"]) != 3 || num(today["chats_active"]) != 1 || num(today["wakes"]) != 1 {
		t.Fatalf("today: %v", today)
	}
	if r := ann.Do("GET", "/app/v1/usage?days=91", nil); r.Status != 400 {
		t.Fatal(r)
	}
}

// Two copies share one database: a plan raise on one is seen on the other at once.
func TestPlansTwoCopies(t *testing.T) {
	db := NewDB(t)
	a := startPaid(t, db, "A", withAdmins("root@example.com"))
	b := startPaid(t, db, "B", withAdmins("root@example.com"))
	root := planAdmin(t, a, "root@example.com")
	ann := NewPerson(t, a, "Ann")
	myPlan(t, ann)
	if r := root.Do("POST", "/app/v1/admin/plans/update", map[string]any{"plan_id": "free", "limits": map[string]any{"agents_per_room": 9}, "reason": "x"}); r.Status != 200 {
		t.Fatal(r)
	}
	if r := myPlan(t, ann.On(b)); num(limitOf(t, r, "agents_per_room")["value"]) != 9 {
		t.Fatalf("copy B: %s", r)
	}
}
