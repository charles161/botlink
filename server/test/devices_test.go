package test

import (
	"strings"
	"testing"

	"github.com/charles161/botlink/server/internal/testkit"
	"github.com/charles161/botlink/server/internal/wire"
)

// newBrowser registers a second browser (new device key) for the same signed-in person.
func newBrowser(t *testing.T, p *Person, label string) *Person {
	t.Helper()
	b := p.On(p.C)
	b.Dev = testkit.NewKey()
	b.DevID = newID()
	if r := b.Do("POST", "/app/v1/devices", map[string]any{"id": b.DevID, "ed25519_pk": b.Dev.Hex(), "label": label}); r.Status != 201 {
		t.Fatalf("register %s: %s", label, r)
	}
	return b
}

func (p *Person) device(t *testing.T) map[string]any {
	t.Helper()
	r := p.Do("GET", "/app/v1/me?device_id="+p.DevID, nil)
	d, _ := r.J["device"].(map[string]any)
	if d == nil {
		t.Fatalf("me: %s", r)
	}
	return d
}

func attentionOf(t *testing.T, p *Person, kind, subject string) map[string]any {
	t.Helper()
	for _, a := range p.Do("GET", "/app/v1/needs-you", nil).J["attention"].([]any) {
		it := a.(map[string]any)
		if it["kind"] == kind && (subject == "" || it["subject_id"] == subject) {
			return it
		}
	}
	return nil
}

// certify signs one device_add per room with signer's key (rooms the signer can sign in) and posts it.
func certify(t *testing.T, signer *Person, target *Person, label string, rooms ...*Room) *Resp {
	t.Helper()
	var entries []map[string]any
	for _, rm := range rooms {
		signer.Sync(rm)
		entries = append(entries, map[string]any{"room_id": rm.ID, "roster_entry": rm.Log.Build("device_add", signer.Dev,
			map[string]any{"account": signer.AccountID, "device": target.Dev.Hex(), "label": label})})
	}
	if entries == nil {
		entries = []map[string]any{}
	}
	hc := signer.Check("approve_device", target.DevID)
	return signer.Do("POST", "/app/v1/devices/"+target.DevID+"/certify", map[string]any{"human_check": map[string]any{"id": hc, "stub": true}, "entries": entries})
}

// createRoomWith creates a room whose genesis browser also adds the given approved browsers (SPEC §6.2).
func createRoomWith(t *testing.T, p *Person, name string, others ...*Person) (*Room, *Resp) {
	t.Helper()
	id := wire.NewV7().String()
	l := testkit.NewLog(id)
	g := l.Build("genesis", p.Dev, map[string]any{"name": name, "owner": p.AccountID, "device": p.Dev.Hex()})
	l.Push(g)
	entries := []any{}
	for _, o := range others {
		e := l.Build("device_add", p.Dev, map[string]any{"account": p.AccountID, "device": o.Dev.Hex(), "label": "other"})
		l.Push(e)
		entries = append(entries, e)
	}
	r := p.Do("POST", "/app/v1/rooms", map[string]any{"id": id, "name": name, "purpose": "", "genesis": g, "entries": entries})
	return &Room{ID: id, Name: name, Log: l}, r
}

// Founder bug: "I approved my Mac on Android, still I can't approve agents joining from the Mac."
// Android → Mac on the real server: approving a browser covers every room the approving browser signs in, new
// rooms include every approved browser, and a browser that can't sign somewhere always has an open request.
func TestAndroidToMacApproval(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A")
	android := NewPerson(t, c, "Adam") // first browser: approved by signing in
	if android.device(t)["approved"] != true {
		t.Fatal("first browser not approved")
	}
	alpha := android.CreateRoom("alpha")

	// 1. the Mac signs in: pending in #alpha, not approved, a new_device item on the account
	mac := newBrowser(t, android, "Safari on Mac")
	d := mac.device(t)
	if d["approved"] != false || d["pending_rooms"].(float64) != 1 {
		t.Fatalf("mac before approval: %v", d)
	}
	pend := d["pending"].([]any)[0].(map[string]any)
	if pend["room_name"] != "alpha" || pend["signer_labels"].([]any)[0] != "Adam's browser" {
		t.Fatalf("pending detail: %v", pend)
	}
	it := attentionOf(t, android, "new_device", mac.DevID)
	if it == nil || !strings.Contains(strings.Join(anyStrings(it["data"].(map[string]any)["room_names"]), ","), "alpha") {
		t.Fatalf("new_device item: %v", it)
	}

	// 2. approve the Mac on Android: device_add in every room Android signs in; the Mac is approved
	if r := certify(t, android, mac, "Safari on Mac", alpha); r.Status != 200 {
		t.Fatalf("certify: %s", r)
	}
	if d := mac.device(t); d["approved"] != true || d["pending_rooms"].(float64) != 0 {
		t.Fatalf("mac after approval: %v", d)
	}
	if attentionOf(t, android, "new_device", mac.DevID) != nil {
		t.Fatal("new_device item still open")
	}

	// 3. a room created on Android AFTER that includes the Mac from the start
	beta, r := createRoomWith(t, android, "beta", mac)
	if r.Status != 201 {
		t.Fatalf("create beta: %s", r)
	}
	if d := mac.device(t); d["pending_rooms"].(float64) != 0 || d["certified_rooms"].(float64) != 2 {
		t.Fatalf("mac in beta: %v", d)
	}
	if r := mac.Do("GET", "/app/v1/rooms/"+beta.ID+"?device_id="+mac.DevID, nil); r.J["my_device_certified"] != true {
		t.Fatalf("beta detail on mac: %s", r)
	}

	// 4. the founder's step: an agent joins #beta and the Mac approves it
	ag := NewAgentKeys(t, "mac-agent")
	if r := ag.Join(c, android.Invite(beta)); r.Status != 201 {
		t.Fatalf("join: %s", r)
	}
	if r := mac.Approve(beta, ag); r.Status != 200 {
		t.Fatalf("mac approving an agent in beta: %s", r)
	}
	// and in #alpha (approved via certify)
	ag2 := NewAgentKeys(t, "alpha-agent")
	if r := ag2.Join(c, android.Invite(alpha)); r.Status != 201 {
		t.Fatal(r)
	}
	if r := mac.Approve(alpha, ag2); r.Status != 200 {
		t.Fatalf("mac approving an agent in alpha: %s", r)
	}

	// 5. an older dashboard creates #gamma with genesis only: the Mac can't sign there, and it is never a dead
	//    end: the new_device item reopens naming #gamma, signer_labels say which browser can approve it
	gamma := android.CreateRoom("gamma")
	d = mac.device(t)
	if d["pending_rooms"].(float64) != 1 || d["pending"].([]any)[0].(map[string]any)["room_name"] != "gamma" {
		t.Fatalf("mac pending gamma: %v", d)
	}
	if it := attentionOf(t, android, "new_device", mac.DevID); it == nil || it["data"].(map[string]any)["approved"] != true {
		t.Fatalf("new_device item for gamma: %v", it)
	}
	ag3 := NewAgentKeys(t, "gamma-agent")
	if r := ag3.Join(c, android.Invite(gamma)); r.Status != 201 {
		t.Fatal(r)
	}
	if r := mac.Approve(gamma, ag3); r.Code() != "not_signer" {
		t.Fatalf("mac approving in gamma before approval: %s", r)
	}
	// dismissed on Android → the Mac asks again → the item is back
	it = attentionOf(t, android, "new_device", mac.DevID)
	if r := android.Do("POST", "/app/v1/attention/"+it["id"].(string)+"/dismiss", nil); r.Status != 200 {
		t.Fatal(r)
	}
	if attentionOf(t, android, "new_device", mac.DevID) != nil {
		t.Fatal("dismiss didn't work")
	}
	if r := mac.Do("POST", "/app/v1/devices/"+mac.DevID+"/ask", nil); r.Status != 200 || r.J["pending_rooms"].(float64) != 1 {
		t.Fatalf("ask: %s", r)
	}
	if attentionOf(t, android, "new_device", mac.DevID) == nil {
		t.Fatal("ask didn't reopen the item")
	}
	// asking again changes nothing (no update → no dashboard event loop)
	if r := mac.Do("POST", "/app/v1/devices/"+mac.DevID+"/ask", nil); r.Status != 200 {
		t.Fatal(r)
	}
	if n := count(t, c, `select count(*) from attention where subject_id = $1 and resolved_at is null`, mac.DevID); n != 1 {
		t.Fatalf("open items after a second ask: %d", n)
	}
	if r := certify(t, android, mac, "Safari on Mac", gamma); r.Status != 200 {
		t.Fatalf("certify gamma: %s", r)
	}
	if r := mac.Approve(gamma, ag3); r.Status != 200 {
		t.Fatalf("mac approving in gamma after approval: %s", r)
	}

	// 6. never-approved browsers are never auto-added; creating a room doesn't approve a browser
	linux := newBrowser(t, android, "Firefox on Linux")
	if _, r := createRoomWith(t, android, "delta", linux); r.Code() != "roster_invalid" {
		t.Fatalf("auto-adding an unapproved browser: %s", r)
	}
	own, r := createRoomWith(t, linux, "linux-own")
	if r.Status != 201 {
		t.Fatalf("linux creates a room: %s", r)
	}
	if linux.device(t)["approved"] != false {
		t.Fatal("creating a room approved the browser")
	}
	if _, r := createRoomWith(t, android, "epsilon", linux); r.Code() != "roster_invalid" {
		t.Fatalf("a browser that only signs its own room got auto-added: %s", r)
	}

	// 7. partial: approving from a browser that can't sign everywhere covers what it can; the rest stays open
	//    with the right label (#linux-own is signed by Linux only)
	ipad := newBrowser(t, android, "Safari on iPad")
	if r := certify(t, android, ipad, "Safari on iPad", alpha, beta, gamma); r.Status != 200 {
		t.Fatalf("partial certify: %s", r)
	}
	d = ipad.device(t)
	if d["approved"] != true || d["pending_rooms"].(float64) != 1 {
		t.Fatalf("ipad after partial: %v", d)
	}
	p0 := d["pending"].([]any)[0].(map[string]any)
	if p0["room_id"] != own.ID || p0["signer_labels"].([]any)[0] != "Firefox on Linux" {
		t.Fatalf("ipad pending: %v", p0)
	}
	if it := attentionOf(t, android, "new_device", ipad.DevID); it == nil {
		t.Fatal("new_device item closed while a room is still pending")
	}
	// signing a room the approving browser isn't in fails as a whole (the dashboard only signs what it can)
	if r := certify(t, android, ipad, "Safari on iPad", own); r.Code() != "not_signer" {
		t.Fatalf("certify from a non-signer: %s", r)
	}
}

func anyStrings(v any) []string {
	var out []string
	for _, x := range v.([]any) {
		out = append(out, x.(string))
	}
	return out
}

// Membership changes are security events for people: every person of the room except the one who did it sees
// an item at once (member_joined / member_left with app, job, key fingerprint).
func TestMembershipAttention(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A")
	adam := NewPerson(t, c, "Adam")
	priya := NewPerson(t, c, "Priya")
	room := adam.CreateRoom("team")
	addPerson(t, adam, priya, room)
	pr := &Room{ID: room.ID, Name: room.Name, Log: testkit.NewLog(room.ID)}

	a := adam.Member(c, room, "builder")
	it := attentionOf(t, priya, "member_joined", a.ID)
	if it == nil {
		t.Fatal("priya not told about builder joining")
	}
	data := it["data"].(map[string]any)
	if data["name"] != "builder" || data["fingerprint"] != a.FP() || data["how"] != "joined" || data["person_name"] != "Adam" || data["room_name"] != "team" {
		t.Fatalf("member_joined data: %v", data)
	}
	if attentionOf(t, adam, "member_joined", a.ID) != nil {
		t.Fatal("the approving human was told about their own approval")
	}

	// Priya's chat leaves on its own (signed by its member key): both humans hear "left"
	p := priya.Member(c, pr, "pchat")
	pr.Log.Reset(nil)
	priya.Sync(pr)
	leave := pr.Log.Build("member_remove", p.Key, map[string]any{"member": p.ID})
	if r := p.Do(c, "DELETE", "/api/v1/me", map[string]any{"roster_entry": leave}); r.Status != 200 {
		t.Fatalf("leave: %s", r)
	}
	for _, who := range []*Person{adam, priya} {
		it := attentionOf(t, who, "member_left", p.ID)
		if it == nil || it["data"].(map[string]any)["how"] != "left" {
			t.Fatalf("%s not told pchat left: %v", who.Name, it)
		}
	}
	// the member_joined item about pchat (on Adam's side) closed with the member
	if attentionOf(t, adam, "member_joined", p.ID) != nil {
		t.Fatal("member_joined about a removed member still open")
	}

	// Adam (owner) removes Adam's builder → Priya is told "removed by Adam", Adam is not
	adam.Sync(room)
	rm := room.Log.Build("member_remove", adam.Dev, map[string]any{"member": a.ID})
	if r := adam.Do("POST", "/app/v1/rooms/"+room.ID+"/roster", map[string]any{"roster_entry": rm}); r.Status != 200 {
		t.Fatalf("remove: %s", r)
	}
	it = attentionOf(t, priya, "member_left", a.ID)
	if it == nil || it["data"].(map[string]any)["how"] != "removed" || it["data"].(map[string]any)["by_name"] != "Adam" {
		t.Fatalf("priya removal item: %v", it)
	}
	if attentionOf(t, adam, "member_left", a.ID) != nil {
		t.Fatal("the removing human was told about their own removal")
	}
	// dismissable
	if r := priya.Do("POST", "/app/v1/attention/"+it["id"].(string)+"/dismiss", nil); r.Status != 200 || attentionOf(t, priya, "member_left", a.ID) != nil {
		t.Fatal("dismiss member_left")
	}
}

// addPerson runs the person-invite flow: owner invites p, p accepts, owner approves (person_add).
func addPerson(t *testing.T, owner, p *Person, room *Room) {
	t.Helper()
	pi := owner.Do("POST", "/app/v1/rooms/"+room.ID+"/person-invites", map[string]any{"id": newID()})
	code := pi.Str("url")[strings.LastIndex(pi.Str("url"), "/")+1:]
	acc := p.Do("POST", "/app/v1/person-invites/"+code+"/accept", map[string]any{"device_id": p.DevID})
	if acc.Status != 201 {
		t.Fatalf("accept: %s", acc)
	}
	owner.Sync(room)
	hc := owner.Check("approve_person", acc.Str("id"))
	e := room.Log.Build("person_add", owner.Dev, map[string]any{"account": p.AccountID, "name": p.Name, "device": p.Dev.Hex()})
	if r := owner.Do("POST", "/app/v1/person-requests/"+acc.Str("id")+"/approve", map[string]any{"human_check": map[string]any{"id": hc, "stub": true}, "roster_entry": e}); r.Status != 200 {
		t.Fatalf("person approve: %s", r)
	}
	room.Log.Push(e)
}
