package wake

import (
	"testing"
	"time"
)

func TestRingBeforeSelectIsKept(t *testing.T) {
	b := New("t")
	bell := b.Hold("inbox:m1", "session:m1")
	defer bell.Release()
	b.Ring("inbox:m1") // nobody selecting yet
	b.Ring("inbox:m1") // coalesces
	select {
	case <-bell.C:
	case <-time.After(time.Second):
		t.Fatal("ring before select was lost")
	}
	select {
	case <-bell.C:
		t.Fatal("rings should coalesce into one slot")
	default:
	}
}

func TestRingOnlyMatchingKeys(t *testing.T) {
	b := New("t")
	a := b.Hold("inbox:a")
	c := b.Hold("inbox:c")
	defer a.Release()
	defer c.Release()
	b.Ring("inbox:a")
	select {
	case <-c.C:
		t.Fatal("wrong bell rang")
	default:
	}
	select {
	case <-a.C:
	default:
		t.Fatal("bell a did not ring")
	}
}

func TestRingAllAndRelease(t *testing.T) {
	b := New("t")
	x := b.Hold("inbox:x")
	y := b.Hold("dash:y")
	b.RingAll()
	for _, bell := range []*Bell{x, y} {
		select {
		case <-bell.C:
		default:
			t.Fatal("RingAll missed a bell")
		}
	}
	x.Release()
	x.Release()
	y.Release()
	if b.Held() != 0 {
		t.Fatalf("held = %d after release", b.Held())
	}
	if len(b.waiters) != 0 {
		t.Fatalf("waiter map leaked: %v", b.waiters)
	}
}
