package test

// One lock order for approvals and member-list changes (store.LockRoom): the rooms row before join requests.
// Security review of fix-next (17 Nov 2026): an approval locked its request and then the room, removing a person and
// deleting a room lock the room and then the requests; Postgres found a deadlock every time and one side answered 500.
// And the 20-member cap was counted before the room was locked, so two approvals built one on the other could both
// count 19.
//
// These tests hold the room row themselves, queue the two sides behind it in a chosen order, then let go: the order in
// which Postgres hands the row on is the order the sides run in.

import (
	"context"
	"fmt"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/charles161/botlink/server/internal/faults"
	"github.com/charles161/botlink/server/internal/roster"
	"github.com/charles161/botlink/server/internal/testkit"
)

// holdRoom takes the rooms row the way a member-list change does, in a transaction of the test's own.
func holdRoom(t *testing.T, c *Copy, roomID string) pgx.Tx {
	t.Helper()
	tx, err := c.Pool.Begin(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = tx.Rollback(context.Background()) }) // a failed test must not keep the row (and hang the cleanup)
	if _, err := tx.Exec(context.Background(), `select 1 from rooms where id = $1 for no key update`, roomID); err != nil {
		t.Fatal(err)
	}
	return tx
}

// waitLockWaiters: n requests of this database wait on a lock.
func waitLockWaiters(t *testing.T, c *Copy, n int, what string) {
	t.Helper()
	for end := time.Now().Add(10 * time.Second); time.Now().Before(end); time.Sleep(20 * time.Millisecond) {
		if count(t, c, `select count(*) from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`) >= n {
			return
		}
	}
	t.Fatalf("%s never waited on the room", what)
}

// pgDeadlocks counts "deadlock detected" in the test cluster's log (make db-up writes .dev/pg.log); -1 without one.
func pgDeadlocks() int {
	b, err := os.ReadFile("../../.dev/pg.log")
	if err != nil {
		return -1
	}
	return strings.Count(string(b), "deadlock detected")
}

func async(f func() *Resp) <-chan *Resp {
	ch := make(chan *Resp, 1)
	go func() { ch <- f() }()
	return ch
}

// ownRoom is a person's own view of a room (their log, synced from the server).
func ownRoom(p *Person, room *Room) *Room {
	r := &Room{ID: room.ID, Name: room.Name, Log: testkit.NewLog(room.ID)}
	p.Sync(r)
	return r
}

// approvals prepared before the room is held: Bea approves her own waiting chats, one by one or as one batch.
func prepareApproval(t *testing.T, bea *Person, room *Room, batch bool, as ...*Agent) func() *Resp {
	t.Helper()
	br := ownRoom(bea, room)
	cards := cardsOf(t, bea, as...)
	if batch {
		hc := bea.mustBatchCheck(room.ID, reqIDs(as...)...)
		items := bea.batchItems(br, cards...)
		return func() *Resp { return bea.approveBatch(room.ID, hc, items) }
	}
	hc := bea.Check("approve_join", as[0].ReqID)
	e := br.Log.Build("member_add", bea.Dev, map[string]any{"member": cards[0]["member_id"], "account": bea.AccountID, "name": cards[0]["name"],
		"app": cards[0]["app"], "ed": cards[0]["ed25519_pk"], "x": cards[0]["x25519_pk"]})
	return func() *Resp {
		return bea.Do("POST", "/app/v1/join-requests/"+as[0].ReqID+"/approve", map[string]any{"human_check": map[string]any{"id": hc, "stub": true}, "roster_entry": e})
	}
}

func prepareRemoval(t *testing.T, adam, bea *Person, room *Room, deleteRoom bool) func() *Resp {
	t.Helper()
	if deleteRoom {
		return func() *Resp { return adam.Do("DELETE", "/app/v1/rooms/"+room.ID, nil) }
	}
	adam.Sync(room)
	e := room.Log.Build("person_remove", adam.Dev, map[string]any{"account": bea.AccountID})
	return func() *Resp {
		return adam.Do("POST", "/app/v1/rooms/"+room.ID+"/roster", map[string]any{"roster_entry": e})
	}
}

// An approval (single or batch) and the removal of the approver from the room (or the room's delete), queued in both
// orders behind the room row: never a deadlock, never a 500; the loser is told why; nothing half-done.
func TestApprovalAndRemovalShareOneLockOrder(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A")
	adam := NewPerson(t, c, "Adam")
	bea := NewPerson(t, c, "Bea")
	deadlocks := pgDeadlocks()
	n := 0
	for _, batch := range []bool{false, true} {
		for _, del := range []bool{false, true} {
			for _, removerFirst := range []bool{true, false} {
				n++
				what := fmt.Sprintf("batch=%v delete=%v removerFirst=%v", batch, del, removerFirst)
				room := adam.CreateRoom(fmt.Sprintf("lock%d", n))
				adam.addPerson(room, bea)
				as := waitingChats(t, c, bea, room, fmt.Sprintf("b%d-", n), 2)
				approve := prepareApproval(t, bea, room, batch, as...)
				remove := prepareRemoval(t, adam, bea, room, del)
				hold := holdRoom(t, c, room.ID)
				first, second := remove, approve
				if !removerFirst {
					first, second = approve, remove
				}
				r1 := async(first)
				waitLockWaiters(t, c, 1, what+": the first side")
				r2 := async(second)
				waitLockWaiters(t, c, 2, what+": the second side")
				if err := hold.Commit(context.Background()); err != nil {
					t.Fatal(err)
				}
				x, y := <-r1, <-r2
				rem, app := x, y
				if !removerFirst {
					rem, app = y, x
				}
				if rem.Status == 409 && rem.Code() == "roster_conflict" && !removerFirst && !del {
					rem = prepareRemoval(t, adam, bea, room, del)() // signed before the approval moved the head: the page re-signs
				}
				if rem.Status != 200 {
					t.Fatalf("%s: removal answered %s (approval %s)", what, rem, app)
				}
				members := count(t, c, `select count(*) from members where room_id = $1 and removed_at is null`, room.ID)
				if removerFirst {
					want := "already_decided"
					if batch {
						want = "batch_changed"
					}
					if app.Status != 409 || app.Code() != want {
						t.Fatalf("%s: approval after the removal answered %s, want 409 %s", what, app, want)
					}
				} else if app.Status != 200 {
					t.Fatalf("%s: approval before the removal answered %s", what, app)
				}
				if members != 0 {
					t.Fatalf("%s: %d members left after the removal", what, members)
				}
				if p := count(t, c, `select count(*) from join_requests where room_id = $1 and status = 'pending'`, room.ID); p != 0 {
					t.Fatalf("%s: %d requests still pending", what, p)
				}
				if !del {
					rosterValid(t, adam, c, room)
				}
			}
		}
	}
	if d := pgDeadlocks(); d > deadlocks {
		t.Fatalf("Postgres logged %d deadlock(s)", d-deadlocks)
	}
}

// The same sides with no order imposed, many rounds: never a 500.
func TestApprovalAndRemovalRaceRounds(t *testing.T) {
	c := StartCopy(t, NewDB(t), "A")
	adam := NewPerson(t, c, "Adam")
	bea := NewPerson(t, c, "Bea")
	deadlocks := pgDeadlocks()
	rounds := 12
	if testing.Short() {
		rounds = 4
	}
	for i := 0; i < rounds; i++ {
		batch, del := i%2 == 1, i%4 >= 2
		room := adam.CreateRoom(fmt.Sprintf("race%d", i))
		adam.addPerson(room, bea)
		as := waitingChats(t, c, bea, room, fmt.Sprintf("r%d-", i), 2)
		approve := prepareApproval(t, bea, room, batch, as...)
		remove := prepareRemoval(t, adam, bea, room, del)
		var wg sync.WaitGroup
		var x, y *Resp
		wg.Add(2)
		go func() { defer wg.Done(); x = approve() }()
		go func() { defer wg.Done(); y = remove() }()
		wg.Wait()
		if y.Status == 409 && y.Code() == "roster_conflict" {
			y = prepareRemoval(t, adam, bea, room, del)()
		}
		if x.Status >= 500 || y.Status >= 500 || y.Status != 200 || (x.Status != 200 && x.Status != 409) {
			t.Fatalf("round %d (batch=%v delete=%v): approval %s, removal %s", i, batch, del, x, y)
		}
		if m := count(t, c, `select count(*) from members where room_id = $1 and removed_at is null`, room.ID); m != 0 {
			t.Fatalf("round %d: %d members left", i, m)
		}
	}
	if d := pgDeadlocks(); d > deadlocks {
		t.Fatalf("Postgres logged %d deadlock(s)", d-deadlocks)
	}
}

// 19 members; two approvals by two people of the room, the second signed on top of the first (head+1, head+2). The
// second starts first and is stopped (fault point admit_before_append) after it has read the room, until the first has
// let in the 20th member or 2 s passed. Counting before the room was locked, it then let in a 21st. Never 21.
// (Two approvals by the same person already queue on that person's approvals counter.)
func TestRoomCapCountedUnderTheRoomLock(t *testing.T) {
	resetFaults(t)
	c := StartCopy(t, NewDB(t), "A")
	adam := NewPerson(t, c, "Adam")
	bea := NewPerson(t, c, "Bea")
	for _, batch := range []bool{false, true} {
		room := adam.CreateRoom(fmt.Sprintf("cap-%v", batch))
		adam.addPerson(room, bea)
		mine := waitingChats(t, c, adam, room, fmt.Sprintf("a%v-", batch), 1)[0]
		hers := waitingChats(t, c, bea, room, fmt.Sprintf("b%v-", batch), 1)[0]
		exec(t, c, `insert into members (id, room_id, account_id, name, app, turn, ed25519_pk, x25519_pk)
			select gen_random_uuid(), $1::uuid, $2::uuid, 'filler' || i, 'other', 'on_turn',
				decode(md5('e' || i || $1::text) || md5('f' || i || $1::text), 'hex'), decode(md5('x' || i || $1::text) || md5('y' || i || $1::text), 'hex')
			from generate_series(1, 19) i`, room.ID, adam.AccountID)
		add := func(p *Person, card map[string]any) roster.Wire {
			return room.Log.Append("member_add", p.Dev, map[string]any{"member": card["member_id"], "account": p.AccountID, "name": card["name"],
				"app": card["app"], "ed": card["ed25519_pk"], "x": card["x25519_pk"]})
		}
		adam.Sync(room)
		e1 := add(adam, cardOf(t, adam, mine.ReqID)) // head+1
		e2 := add(bea, cardOf(t, bea, hers.ReqID))   // head+2, on top of e1
		send := func(p *Person, a *Agent, e roster.Wire) func() *Resp {
			if batch {
				hc := p.mustBatchCheck(room.ID, a.ReqID)
				return func() *Resp { return p.approveBatch(room.ID, hc, []map[string]any{{"id": a.ReqID, "roster_entry": e}}) }
			}
			hc := p.Check("approve_join", a.ReqID)
			return func() *Resp {
				return p.Do("POST", "/app/v1/join-requests/"+a.ReqID+"/approve", map[string]any{"human_check": map[string]any{"id": hc, "stub": true}, "roster_entry": e})
			}
		}
		first, second := send(adam, mine, e1), send(bea, hers, e2)
		firstDone := make(chan struct{})
		var calls sync.Mutex
		n := 0
		stopped := make(chan struct{})
		faults.Set("admit_before_append", func(ctx context.Context, _ int) error {
			calls.Lock()
			n++
			me := n
			calls.Unlock()
			if me == 1 { // the second approval, started first
				close(stopped)
				select {
				case <-firstDone:
				case <-time.After(2 * time.Second):
				}
			}
			return nil
		})
		r2 := async(second)
		<-stopped
		x := first()
		close(firstDone)
		y := <-r2
		faults.Set("admit_before_append", nil)
		if m := count(t, c, `select count(*) from members where room_id = $1 and removed_at is null`, room.ID); m != 20 {
			t.Fatalf("batch=%v: %d members (the 20th: %s, the 21st: %s)", batch, m, x, y)
		}
		if x.Status != 200 || y.Status != 409 || (y.Code() != "room_full" && y.Code() != "roster_conflict") {
			t.Fatalf("batch=%v: the 20th %s, the 21st %s", batch, x, y)
		}
	}
}
