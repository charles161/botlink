package appapi

import (
	"bytes"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"net/http"
	"sort"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/charles161/botlink/server/internal/auth"
	"github.com/charles161/botlink/server/internal/httpx"
	"github.com/charles161/botlink/server/internal/humancheck"
	"github.com/charles161/botlink/server/internal/roster"
	"github.com/charles161/botlink/server/internal/store"
	"github.com/charles161/botlink/server/internal/wire"
)

// POST /app/v1/devices/{id}/remove {human_check, entries[], this_browser?}: remove one of my browsers ("Remove this
// browser", or a lost one from another browser). Lost-passkey lane, prod-readiness blocker 5.
//
// Before this, nothing ever set devices.revoked_at: "Sign out other browsers" only ended sessions, so a lost laptop's
// key stayed a signer, and one fresh sign-in on it (one click while it is still signed in to Google or GitHub) let it
// sign member-list changes again: remove chats and people, add browsers, and, while the fresh sign-in counted as the
// human check, add a person to a room.
//
// Now, in one transaction, after a passkey answered (DeviceRemoveAction asserts every time, no skip window):
//   - the signed member list of each room in entries gets a device_remove signed by THIS browser, so other people's
//     chats verify the removal too (ENVELOPE §5: a device of the account in that room, or an owner device, may sign it).
//     The server can't sign one: rooms this browser can't sign in stay listing the key, and the answer says how many
//     (certified_rooms); a browser that can sign there finishes with the same call (the device is already removed);
//   - devices.revoked_at: the server refuses that key everywhere it checks a browser key (approvals, roster changes,
//     certify, new rooms, person invites, ask, pending rooms);
//   - sign-ins end: every other sign-in of the account (a session isn't tied to a browser key, so the lost browser's
//     can't be singled out), or only this one with this_browser;
//   - passkey_ids: the passkeys to remove with it (security review of fix-all, finding 2: a passkey kept on the lost
//     computer kept working, and with one provider click the thief could revoke the person's own browser and delete
//     the account). The dashboard preselects the ones made or last used in that browser (places are proved by the
//     browser's own key, POST /app/v1/me/browser). Every passkey whose place is unknown must be named in passkey_ids
//     or keep_ids: no silent keep (re-review). The passkey answering this check always stays (answering_kept says
//     when it was named); never the last one; all in the same transaction, under the account's passkey lock;
//   - a revoked browser is never restored, so when this browser is the owner's only one that can change the members of
//     some owned rooms, those rooms freeze for good: refused with rooms_freeze (their names) unless freeze_ok.
func (a *API) postDeviceRemove(w http.ResponseWriter, r *http.Request, s *auth.Session) error {
	ctx := r.Context()
	id := r.PathValue("id")
	if !wire.IsUUID(id) {
		return httpx.NotFound()
	}
	body, err := httpx.ReadBody(r)
	if err != nil {
		return err
	}
	var b struct {
		HumanCheck humancheck.Proof `json:"human_check"`
		Entries    []struct {
			RoomID      string      `json:"room_id"`
			RosterEntry roster.Wire `json:"roster_entry"`
		} `json:"entries"`
		ThisBrowser bool     `json:"this_browser"`
		PasskeyIDs  []string `json:"passkey_ids"`
		KeepIDs     []string `json:"keep_ids"`
		FreezeOK    bool     `json:"freeze_ok"`
	}
	if err := httpx.DecodeStrict(body, &b); err != nil {
		return err
	}
	if len(b.Entries) > 40 {
		return httpx.BadRequest("At most 40 entries.")
	}
	var pk []byte
	var label string
	var revoked *time.Time
	err = a.St.Pool.QueryRow(ctx, `select ed25519_pk, label, revoked_at from devices where id = $1 and account_id = $2`, id, s.AccountID).Scan(&pk, &label, &revoked)
	if errors.Is(err, pgx.ErrNoRows) {
		return httpx.NotFound()
	}
	if err != nil {
		return err
	}
	if len(b.PasskeyIDs) > 20 || len(b.KeepIDs) > 20 {
		return httpx.BadRequest("At most 20 passkeys.")
	}
	decode := func(ids []string) ([][]byte, error) {
		out := [][]byte{} // never nil: a NULL array would make "not id = any(...)" unknown
		for _, pid := range ids {
			raw, err := base64.RawURLEncoding.DecodeString(pid)
			if err != nil || len(raw) == 0 || len(raw) > 1024 {
				return nil, httpx.NotFound()
			}
			out = append(out, raw)
		}
		return out, nil
	}
	passkeys, err := decode(b.PasskeyIDs)
	if err != nil {
		return err
	}
	keeps, err := decode(b.KeepIDs)
	if err != nil {
		return err
	}
	answered, err := a.HC.VerifyAnswered(ctx, a.St.Pool, s, &b.HumanCheck, humancheck.DeviceRemoveAction, id, httpx.ClientIP(r, a.Cfg.TrustCF))
	if err != nil {
		return err
	}
	// the passkey that answered this check stays, even when named: it is what proved a person is here
	answeringKept := false
	var drop [][]byte
	for _, pk := range passkeys {
		if answered != nil && bytes.Equal(pk, answered) {
			answeringKept = true
			continue
		}
		drop = append(drop, pk)
	}
	if len(drop) > 0 && answered == nil {
		return httpx.E(409, "passkey_in_use", "Confirm with a passkey to remove passkeys.")
	}
	sort.Slice(b.Entries, func(i, j int) bool { return b.Entries[i].RoomID < b.Entries[j].RoomID })
	for i := 1; i < len(b.Entries); i++ {
		if b.Entries[i].RoomID == b.Entries[i-1].RoomID {
			return httpx.BadRequest("One entry per room.")
		}
	}
	pkHex := hex.EncodeToString(pk)
	var removedPasskeys int64
	err = a.St.Tx(ctx, func(tx pgx.Tx) error {
		if err := humancheck.Consume(ctx, tx, b.HumanCheck.ID, s); err != nil {
			return err
		}
		if err := store.LockPasskeys(ctx, tx, s.AccountID); err != nil {
			return err
		}
		var named, keptNamed, total, unchosen int
		if err := tx.QueryRow(ctx, `select count(*) filter (where id = any($2)), count(*) filter (where id = any($3)), count(*),
				count(*) filter (where created_device_id is null and not id = any($2) and not id = any($3))
			from webauthn_credentials where account_id = $1`, s.AccountID, passkeys, keeps).Scan(&named, &keptNamed, &total, &unchosen); err != nil {
			return err
		}
		if named != len(passkeys) || keptNamed != len(keeps) {
			return httpx.NotFound() // not this account's passkey (or named twice)
		}
		if unchosen > 0 {
			return httpx.E(400, "passkeys_unchosen", "bot-link can't tell where some of your passkeys live. Choose keep or remove for each.").With("count", unchosen)
		}
		if len(drop) > 0 {
			if total-len(drop) < 1 {
				return httpx.E(409, "last_passkey", "This would remove your last passkey. Keep one.")
			}
			tag, err := tx.Exec(ctx, `delete from webauthn_credentials where account_id = $1 and id = any($2)`, s.AccountID, drop)
			if err != nil {
				return err
			}
			removedPasskeys = tag.RowsAffected()
		}
		if revoked == nil && !b.FreezeOK {
			rows, err := tx.Query(ctx, `select r.name from rooms r join room_signers s on s.room_id = r.id and s.ed25519_pk = $2 and s.removed_seq is null
				where r.owner_account_id = $1 and r.deleted_at is null and not exists (select 1 from room_signers s2 join devices d2 on d2.ed25519_pk = s2.ed25519_pk
					where s2.room_id = r.id and s2.removed_seq is null and d2.account_id = $1 and d2.revoked_at is null and d2.id <> $3)
				order by r.name`, s.AccountID, pk, id)
			if err != nil {
				return err
			}
			frozen, err := pgx.CollectRows(rows, pgx.RowTo[string])
			if err != nil {
				return err
			}
			if len(frozen) > 0 {
				return httpx.E(409, "rooms_freeze", "This is your only browser that can change who is in some rooms you own. After removing it, nobody can. Confirm to go ahead.").
					With("room_names", frozen)
			}
		}
		var conflicts []string
		for _, en := range b.Entries {
			if _, err := myRole(ctx, tx, en.RoomID, s.AccountID); err != nil {
				return err
			}
			if err := signerIsMyDevice(ctx, tx, en.RosterEntry.Signer, s.AccountID); err != nil {
				return err
			}
			e, _, err := store.AppendEntry(ctx, tx, en.RoomID, en.RosterEntry)
			if err != nil {
				var he *httpx.Error
				if errors.As(err, &he) && he.Code == "roster_conflict" {
					conflicts = append(conflicts, en.RoomID) // keep checking the rest; nothing commits
					continue
				}
				return err
			}
			if e.Op != "device_remove" || e.Account != s.AccountID || e.Device != pkHex {
				return httpx.E(400, "roster_invalid", "Each entry must remove this browser.").With("rule", "request_match")
			}
			if err := store.ApplyDerived(ctx, tx, en.RoomID, e); err != nil {
				return err
			}
		}
		if len(conflicts) > 0 {
			return httpx.E(409, "roster_conflict", "The member list changed in some rooms. Refresh and sign again.").With("room_ids", conflicts)
		}
		if _, err := tx.Exec(ctx, `update devices set revoked_at = coalesce(revoked_at, now()) where id = $1`, id); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `update attention set resolved_at = now() where account_id = $1 and kind = 'new_device' and subject_id = $2 and resolved_at is null`,
			s.AccountID, id); err != nil {
			return err
		}
		// a pending account delete is cancelled: removing a browser means something is wrong (third security pass);
		// asking again is paused for BOTLINK_ACCOUNT_DELETE_ASK_HOLD (account_guard.go)
		deleteCancelled, err := store.CancelDelete(ctx, tx, s.AccountID, "browser_removed", s.Hash, nil)
		if err != nil {
			return err
		}
		// recorded before the sign-ins end: the event names the sign-in that did it
		if err := store.AccountEventBy(ctx, tx, s.AccountID, s.Hash, "device_removed", map[string]any{"label": label, "device_id": id, "fingerprint": wire.DeviceFP(pk),
			"rooms_signed": len(b.Entries), "this_browser": b.ThisBrowser, "again": revoked != nil, "passkeys_removed": removedPasskeys,
			"delete_cancelled": deleteCancelled}); err != nil {
			return err
		}
		if b.ThisBrowser {
			if _, err := tx.Exec(ctx, `delete from web_sessions where token_hash = $1`, s.Hash); err != nil {
				return err
			}
		} else if _, err := tx.Exec(ctx, `delete from web_sessions where account_id = $1 and token_hash <> $2`, s.AccountID, s.Hash); err != nil {
			return err
		}
		if err := store.SyncDeviceAttention(ctx, tx, s.AccountID, ""); err != nil {
			return err
		}
		return store.DashChanged(ctx, tx, s.AccountID)
	})
	if err != nil {
		return err
	}
	if b.ThisBrowser {
		http.SetCookie(w, auth.Cookie("", a.Cfg.SecureCookies(), -1))
	}
	d, err := a.deviceJSON(ctx, a.St.Pool, s.AccountID, id)
	if err != nil {
		return err
	}
	d["passkeys_removed"] = removedPasskeys
	d["answering_kept"] = answeringKept
	httpx.WriteJSON(w, 200, d)
	return nil
}
