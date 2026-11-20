package push

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/charles161/botlink/server/internal/metrics"
	"github.com/charles161/botlink/server/internal/wake"
)

// Backoff after try n (1-based): 5 s, 30 s, 2 min, 10 min, 30 min; after 6 tries the job fails.
var Backoff = []time.Duration{5 * time.Second, 30 * time.Second, 2 * time.Minute, 10 * time.Minute, 30 * time.Minute}

const MaxTries = 6

type Worker struct {
	Pool   *pgxpool.Pool
	Client *Client
	Bus    *wake.Bus
	M      *metrics.Set
	Every  time.Duration
}

func (w *Worker) Run(ctx context.Context) {
	every := w.Every
	if every == 0 {
		every = 2 * time.Second
	}
	bell := w.Bus.Hold(wake.Push + ":")
	defer bell.Release()
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		for {
			n, err := w.Once(ctx)
			if err != nil {
				if ctx.Err() == nil {
					slog.Warn("push worker", "err", err)
				}
				break
			}
			if n < 10 {
				break
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-bell.C:
		case <-t.C:
		}
	}
}

type job struct {
	id       int64
	member   string
	message  string
	tries    int
	room     string
	url      *string
	secret   []byte
	alwaysOn bool
}

// Once claims up to 10 due jobs (claim lease 60 s, committed), POSTs outside any transaction, records
// the outcome. Returns how many jobs it handled.
func (w *Worker) Once(ctx context.Context) (int, error) {
	rows, err := w.Pool.Query(ctx, `
		with due as (
			select id from push_jobs where not done and next_attempt_at <= now() order by id limit 10 for update skip locked
		), claimed as (
			update push_jobs p set next_attempt_at = now() + interval '60 seconds' from due where p.id = due.id
			returning p.id, p.member_id, p.message_id, p.tries
		)
		select c.id, c.member_id, c.message_id, c.tries, m.room_id, m.push_url, m.push_secret,
		       m.turn = 'always_on' and m.removed_at is null and m.push_verified_at is not null
		from claimed c join members m on m.id = c.member_id order by c.id`)
	if err != nil {
		return 0, err
	}
	var jobs []job
	for rows.Next() {
		var j job
		if err := rows.Scan(&j.id, &j.member, &j.message, &j.tries, &j.room, &j.url, &j.secret, &j.alwaysOn); err != nil {
			rows.Close()
			return 0, err
		}
		jobs = append(jobs, j)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, err
	}
	for _, j := range jobs {
		w.deliver(ctx, j)
	}
	return len(jobs), nil
}

func (w *Worker) deliver(ctx context.Context, j job) {
	if !j.alwaysOn || j.url == nil || len(j.secret) != 32 {
		_, _ = w.Pool.Exec(ctx, `update push_jobs set done = true where id = $1`, j.id)
		w.count("skipped")
		return
	}
	attempt := j.tries + 1
	pushID := strconv.FormatInt(j.id, 10)
	body, _ := json.Marshal(map[string]any{"v": 1, "type": "message", "member_id": j.member, "room_id": j.room,
		"message_ids": []string{j.message}, "push_id": pushID, "attempt": attempt, "at": time.Now().Unix()})
	res, err := w.Client.Post(ctx, *j.url, j.secret, pushID, attempt, body)
	if err == nil && res.Status >= 200 && res.Status < 300 {
		_, _ = w.Pool.Exec(ctx, `update push_jobs set done = true, tries = $2, last_error = null where id = $1`, j.id, attempt)
		w.count("ok")
		return
	}
	reason := "error"
	msg := ""
	switch {
	case errors.Is(err, ErrBlocked):
		reason, msg = "blocked", "url blocked"
	case err != nil:
		msg = trim(err.Error())
	default:
		msg = fmt.Sprintf("status %d", res.Status)
	}
	w.count(reason)
	if attempt >= MaxTries {
		_, _ = w.Pool.Exec(ctx, `update push_jobs set tries = $2, done = true, failed = true, last_error = $3 where id = $1`, j.id, attempt, msg)
		return
	}
	_, _ = w.Pool.Exec(ctx, `update push_jobs set tries = $2, next_attempt_at = now() + $3::interval, last_error = $4 where id = $1`,
		j.id, attempt, fmt.Sprintf("%d seconds", int(Backoff[attempt-1].Seconds())), msg)
}

func trim(s string) string {
	if len(s) > 300 {
		return s[:300]
	}
	return s
}

func (w *Worker) count(result string) {
	if w.M != nil {
		w.M.Push.Inc(result)
	}
}
