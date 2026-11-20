package appapi

import (
	"context"
	"time"

	"github.com/charles161/botlink/server/internal/store"
)

// endedWindow is how long a join request that ended stays in GET /app/v1/needs-you's ended_join_requests.
const endedWindow = 30 * time.Minute

// endedJoinRequests: the person's own join requests that ended in the last 30 minutes, newest first, and how each
// ended (prod-readiness blocker 10). The dashboard learns of a change only as "changed"; with this list a card the
// person is looking at can say why it left instead of sitting there:
//
//	approved / rejected   decided by this person (in this browser or another one)
//	expired               ran out (15 minutes), whether or not the sweep has marked it yet
//	replaced              a newer move request for the same member took its place
//	closed                the room was deleted, or the member or the person is no longer in it
//	withdrawn             the chat took it back (POST /api/v1/join-requests/{id}/cancel)
//
// Only ids, names and the room: the same the card showed.
func endedJoinRequests(ctx context.Context, q store.Q, account string) ([]map[string]any, error) {
	rows, err := q.Query(ctx, `
		select id, kind, room_id, room_name, name, ended, ended_at from (
			select j.id, j.kind, j.room_id, r.name as room_name, j.name,
				case
					when j.status in ('pending', 'expired') or j.decided_at > j.expires_at then 'expired'
					when j.status in ('approved', 'rejected') then j.status
					when r.deleted_at is not null then 'closed'
					when exists(select 1 from join_requests n where n.member_id = j.member_id and n.id <> j.id
						and n.created_at between j.decided_at - interval '1 second' and j.decided_at + interval '1 second') then 'replaced'
					when j.kind = 'claim' and exists(select 1 from members m where m.id = j.member_id and m.removed_at is not null) then 'closed'
					when not exists(select 1 from room_people p where p.room_id = j.room_id and p.account_id = j.for_account_id
						and p.removed_at is null) then 'closed'
					else 'withdrawn'
				end as ended,
				case when j.status = 'pending' then j.expires_at else least(j.decided_at, j.expires_at) end as ended_at
			from join_requests j join rooms r on r.id = j.room_id
			where j.for_account_id = $1 and j.created_at > now() - interval '2 hours' -- a request lasts 15 minutes
				and (j.status <> 'pending' or j.expires_at <= now())
		) e
		where ended_at > now() - make_interval(secs => $2) and ended_at <= now()
		order by ended_at desc limit 50`, account, endedWindow.Seconds())
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var id, kind, room, roomName, name, ended string
		var at time.Time
		if err := rows.Scan(&id, &kind, &room, &roomName, &name, &ended, &at); err != nil {
			return nil, err
		}
		out = append(out, map[string]any{"id": id, "kind": kind, "room_id": room, "room_name": roomName, "name": name,
			"ended": ended, "ended_at": at.UTC()})
	}
	return out, rows.Err()
}
