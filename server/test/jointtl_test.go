package test

import (
	"testing"
	"time"

	"github.com/charles161/botlink/server/internal/config"
)

// A join request lives BOTLINK_JOIN_TTL (default 15 minutes; staging can shorten it so a tester sees one expire), and
// the answer to the agent carries that expiry: the client words "has N minutes to approve" from it.
func TestJoinRequestLivesTheConfiguredTTL(t *testing.T) {
	db := NewDB(t)
	for _, k := range []struct {
		ttl  time.Duration
		want time.Duration
	}{{0, 15 * time.Minute}, {30 * time.Second, 30 * time.Second}} {
		c := StartCopy(t, db, "A", func(cfg *config.Config) { cfg.JoinTTL = k.ttl })
		adam := NewPerson(t, c, "Adam"+k.want.String())
		room := adam.CreateRoom("ttl")
		a := NewAgentKeys(t, "ttl")
		r := a.Join(c, adam.Invite(room))
		if r.Status != 201 {
			t.Fatal(r)
		}
		exp, err := time.Parse(time.RFC3339Nano, r.J["expires_at"].(string))
		if err != nil {
			t.Fatalf("expires_at: %v (%s)", err, r)
		}
		if left := time.Until(exp); left < k.want-10*time.Second || left > k.want+10*time.Second {
			t.Errorf("join TTL %v: the request expires in %v, want about %v", k.ttl, left, k.want)
		}
	}
}
