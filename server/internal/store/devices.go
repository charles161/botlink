package store

import (
	"context"
	"encoding/hex"
	"errors"

	"github.com/jackc/pgx/v5"

	"github.com/charles161/botlink/server/internal/wire"
)

// PendingRoom is a live room of the device's person in which the device can't sign yet, with the labels of
// that person's browsers that can (SPEC §6.1: "approve it from <label>").
type PendingRoom struct {
	ID           string   `json:"room_id"`
	Name         string   `json:"room_name"`
	SignerLabels []string `json:"signer_labels"`
}

// DevicePendingRooms lists the rooms where account is a current person and pk is not a current signer.
func DevicePendingRooms(ctx context.Context, q Q, account string, pk []byte) ([]PendingRoom, error) {
	rows, err := q.Query(ctx, `
		select r.id, r.name,
		  coalesce((select array_agg(distinct d.label) from room_signers s join devices d on d.ed25519_pk = s.ed25519_pk
		    where s.room_id = r.id and s.removed_seq is null and d.account_id = $1 and d.revoked_at is null), '{}')
		from room_people p join rooms r on r.id = p.room_id
		where p.account_id = $1 and p.removed_at is null and r.deleted_at is null
		  and not exists (select 1 from room_signers s where s.room_id = r.id and s.ed25519_pk = $2 and s.removed_seq is null)
		order by r.created_at, r.id`, account, pk)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []PendingRoom{}
	for rows.Next() {
		var p PendingRoom
		if err := rows.Scan(&p.ID, &p.Name, &p.SignerLabels); err != nil {
			return nil, err
		}
		if p.SignerLabels == nil {
			p.SignerLabels = []string{}
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// SyncDeviceAttention keeps one open new_device item per browser of account (all of them, or just deviceID)
// that can't sign in some of the person's rooms, and resolves it once it can sign everywhere. An item the
// person dismissed comes back the next time this runs (a room was created, a browser was approved, a person
// was added …), so a browser is never left with "approve it from your other browser" and nothing to approve.
func SyncDeviceAttention(ctx context.Context, q Q, account, deviceID string) error {
	rows, err := q.Query(ctx, `select id, ed25519_pk, label, approved_at is not null from devices
		where account_id = $1 and revoked_at is null and ($2 = '' or id::text = $2) order by created_at`, account, deviceID)
	if err != nil {
		return err
	}
	type dev struct {
		id       string
		pk       []byte
		label    string
		approved bool
	}
	var devs []dev
	for rows.Next() {
		var d dev
		if err := rows.Scan(&d.id, &d.pk, &d.label, &d.approved); err != nil {
			rows.Close()
			return err
		}
		devs = append(devs, d)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	for _, d := range devs {
		pend, err := DevicePendingRooms(ctx, q, account, d.pk)
		if err != nil {
			return err
		}
		if len(pend) == 0 {
			if _, err := q.Exec(ctx, `update attention set resolved_at = now() where account_id = $1 and kind = 'new_device' and subject_id = $2 and resolved_at is null`,
				account, d.id); err != nil {
				return err
			}
			continue
		}
		names := make([]string, 0, len(pend))
		for _, p := range pend {
			names = append(names, p.Name)
		}
		if err := UpsertAttention(ctx, q, account, nil, "new_device", d.id, map[string]any{"label": d.label, "fingerprint": wire.DeviceFP(d.pk),
			"approved": d.approved, "room_names": names, "pending_rooms": len(pend)}); err != nil {
			return err
		}
	}
	return nil
}

// ── membership notices for people (SPEC §6.10a)

// deviceAccount is the account whose browser key pk is, or "" (a member key: the chat itself).
func deviceAccount(ctx context.Context, q Q, pkHex string) (string, error) {
	pk, err := hex.DecodeString(pkHex)
	if err != nil {
		return "", nil
	}
	var acct string
	err = q.QueryRow(ctx, `select account_id from devices where ed25519_pk = $1`, pk).Scan(&acct)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	return acct, err
}

// MembershipAttention tells every current person of the room except actor (the human who did it themselves)
// that a member joined (kind member_joined) or left / was removed (member_left, how = left | removed).
// Call after the member row is inserted / removed (RemoveMember resolves items about the member).
func MembershipAttention(ctx context.Context, q Q, roomID, memberID, kind, how, actor string) error {
	var name, app, job, person, roomName string
	var appName *string // which "other" app (T3 Code, OpenCode, …): the notice names it, not "Other app"
	var ed, x []byte
	if err := q.QueryRow(ctx, `select m.name, m.app, m.app_name, m.job, a.display_name, m.ed25519_pk, m.x25519_pk, r.name
		from members m join accounts a on a.id = m.account_id join rooms r on r.id = m.room_id where m.id = $1`, memberID).Scan(
		&name, &app, &appName, &job, &person, &ed, &x, &roomName); err != nil {
		return err
	}
	var byName string
	if actor != "" {
		_ = q.QueryRow(ctx, `select display_name from accounts where id = $1`, actor).Scan(&byName)
	}
	rows, err := q.Query(ctx, `select account_id from room_people where room_id = $1 and removed_at is null and account_id::text <> $2`, roomID, actor)
	if err != nil {
		return err
	}
	accts, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return err
	}
	data := map[string]any{"name": name, "app": app, "job": job, "person_name": person, "fingerprint": wire.MemberFP(ed, x),
		"how": how, "by_name": byName, "room_name": roomName}
	if appName != nil {
		data["app_name"] = *appName
	}
	for _, acct := range accts {
		room := roomID
		if err := UpsertAttention(ctx, q, acct, &room, kind, memberID, data); err != nil {
			return err
		}
	}
	return nil
}
