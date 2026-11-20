package appapi

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/charles161/botlink/server/internal/auth"
	"github.com/charles161/botlink/server/internal/httpx"
	"github.com/charles161/botlink/server/internal/humancheck"
	"github.com/charles161/botlink/server/internal/store"
)

// The account's passkeys (owner follow-up to the security review, 12 Nov 2026). A passkey is the lock on every join
// approval, so changing the set of passkeys is locked too:
//   - add: the human check "webauthn_register" asserts an existing passkey first and carries the options for the new
//     one ("register"); the first passkey of an account needs a sign-in within 5 minutes plus Turnstile;
//   - remove: the human check "passkey_remove" asserts with ANOTHER passkey of the account; never the last one.

// passkeysJSON lists the account's passkeys with where each lives, as far as the server can tell (migration 0043): the
// browser whose sign-in made it and the one it last answered in (their ids and labels, null when unknown: passkeys made
// before 16 Nov 2026, or a sign-in that never said which browser it is).
func passkeysJSON(ctx context.Context, q store.Q, account string) ([]map[string]any, error) {
	rows, err := q.Query(ctx, `select c.id, c.transports, c.created_at, c.last_used_at, c.created_device_id::text, cd.label,
			c.last_used_device_id::text, ud.label
		from webauthn_credentials c
		left join devices cd on cd.id = c.created_device_id and cd.account_id = c.account_id
		left join devices ud on ud.id = c.last_used_device_id and ud.account_id = c.account_id
		where c.account_id = $1 order by c.created_at`, account)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var id []byte
		var transports []string
		var created time.Time
		var used *time.Time
		var madeIn, madeLabel, usedIn, usedLabel *string
		if err := rows.Scan(&id, &transports, &created, &used, &madeIn, &madeLabel, &usedIn, &usedLabel); err != nil {
			return nil, err
		}
		out = append(out, map[string]any{"id": base64.RawURLEncoding.EncodeToString(id), "transports": transports,
			"created_at": created.UTC(), "last_used_at": utcPtr(used), "created_device_id": madeIn, "created_device_label": madeLabel,
			"last_used_device_id": usedIn, "last_used_device_label": usedLabel})
	}
	return out, rows.Err()
}

func (a *API) writePasskeys(w http.ResponseWriter, r *http.Request, s *auth.Session) error {
	list, err := passkeysJSON(r.Context(), a.St.Pool, s.AccountID)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, 200, map[string]any{"passkeys": list})
	return nil
}

// GET /app/v1/me/passkeys
func (a *API) getPasskeys(w http.ResponseWriter, r *http.Request, s *auth.Session) error {
	return a.writePasskeys(w, r, s)
}

// POST /app/v1/me/passkeys {human_check, credential?}: add a passkey. With a passkey on the account the proof is an
// assertion with it and `credential` is the new one (made with the check's "register" options); without, the proof's
// registration is the first passkey.
func (a *API) postPasskey(w http.ResponseWriter, r *http.Request, s *auth.Session) error {
	ctx := r.Context()
	body, err := httpx.ReadBody(r)
	if err != nil {
		return err
	}
	var b struct {
		HumanCheck humancheck.Proof `json:"human_check"`
		Credential json.RawMessage  `json:"credential"`
	}
	if err := httpx.DecodeStrict(body, &b); err != nil {
		return err
	}
	if a.HC.Mode == "stub" {
		return httpx.E(409, "passkeys_unavailable", "This server runs a stand-in human check: there are no passkeys to add.")
	}
	var had bool
	if err := a.St.Pool.QueryRow(ctx, `select exists(select 1 from webauthn_credentials where account_id = $1)`, s.AccountID).Scan(&had); err != nil {
		return err
	}
	hasNew := len(b.Credential) > 0 && string(b.Credential) != "null"
	if had && !hasNew {
		return httpx.BadRequest("credential (the new passkey) is required when the account already has one.")
	}
	if !had && hasNew {
		return httpx.BadRequest("credential is only for a second passkey; the first one is the human check's own answer.")
	}
	used, err := a.HC.VerifyCred(ctx, a.St.Pool, s, &b.HumanCheck, "webauthn_register", httpx.ClientIP(r, a.Cfg.TrustCF))
	if err != nil {
		return err
	}
	if had && used == nil {
		return httpx.E(403, "human_check_failed", "The human check didn't pass. Try again.").With("reason", "webauthn_assert")
	}
	err = a.St.Tx(ctx, func(tx pgx.Tx) error {
		if err := store.LockPasskeys(ctx, tx, s.AccountID); err != nil {
			return err
		}
		if had {
			if err := a.HC.RegisterNew(ctx, tx, s, b.HumanCheck.ID, b.Credential); err != nil {
				return err
			}
		}
		return humancheck.Consume(ctx, tx, b.HumanCheck.ID, s)
	})
	if err != nil {
		return err
	}
	return a.writePasskeys(w, r, s)
}

// POST /app/v1/me/passkeys/remove {credential_id, human_check}: remove one of my passkeys, vouched for by another one.
func (a *API) postPasskeyRemove(w http.ResponseWriter, r *http.Request, s *auth.Session) error {
	ctx := r.Context()
	body, err := httpx.ReadBody(r)
	if err != nil {
		return err
	}
	var b struct {
		CredentialID string           `json:"credential_id"`
		HumanCheck   humancheck.Proof `json:"human_check"`
	}
	if err := httpx.DecodeStrict(body, &b); err != nil {
		return err
	}
	id, err := base64.RawURLEncoding.DecodeString(b.CredentialID)
	if err != nil || len(id) == 0 || len(id) > 1024 {
		return httpx.NotFound()
	}
	var mine bool
	var n int
	if err := a.St.Pool.QueryRow(ctx, `select exists(select 1 from webauthn_credentials where id = $1 and account_id = $2),
		(select count(*) from webauthn_credentials where account_id = $2)`, id, s.AccountID).Scan(&mine, &n); err != nil {
		return err
	}
	if !mine {
		return httpx.NotFound()
	}
	if n < 2 {
		return httpx.E(409, "last_passkey", "This is your only passkey. Add another one before you remove it.")
	}
	used, err := a.HC.VerifyCred(ctx, a.St.Pool, s, &b.HumanCheck, "passkey_remove", httpx.ClientIP(r, a.Cfg.TrustCF))
	if err != nil {
		return err
	}
	if used == nil || string(used) == string(id) {
		// a passkey never vouches for its own removal (a stolen one would remove the others one by one otherwise)
		return httpx.E(403, "human_check_failed", "Confirm with another of your passkeys.").With("reason", "webauthn_other_passkey")
	}
	err = a.St.Tx(ctx, func(tx pgx.Tx) error {
		if err := humancheck.Consume(ctx, tx, b.HumanCheck.ID, s); err != nil {
			return err
		}
		// serialised per account: two removals each confirmed with the other passkey can't both pass (review finding 6)
		if err := store.LockPasskeys(ctx, tx, s.AccountID); err != nil {
			return err
		}
		var left int
		if err := tx.QueryRow(ctx, `with d as (delete from webauthn_credentials where id = $1 and account_id = $2 returning 1)
			select (select count(*) from webauthn_credentials where account_id = $2) - (select count(*) from d)`, id, s.AccountID).Scan(&left); err != nil {
			return err
		}
		if left < 1 {
			return httpx.E(409, "last_passkey", "This is your only passkey. Add another one before you remove it.")
		}
		return nil
	})
	if err != nil {
		return err
	}
	return a.writePasskeys(w, r, s)
}
