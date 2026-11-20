package adminapi

// Plans, limits and credits for admins (CONTRACT-PLANS.md, lane D1). Same gate as the overview: admin email, the
// human check unlock, CSRF on writes. Every write needs a reason and is logged (limit_changes).

import (
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/charles161/botlink/server/internal/auth"
	"github.com/charles161/botlink/server/internal/httpx"
	"github.com/charles161/botlink/server/internal/plans"
	"github.com/charles161/botlink/server/internal/wire"
)

func (a *API) planRoutes() map[string]route {
	return map[string]route{
		"/app/v1/admin/plans":         {http.MethodGet, true, a.getPlans},
		"/app/v1/admin/plans/update":  {http.MethodPost, true, a.postPlanUpdate},
		"/app/v1/admin/account":       {http.MethodGet, true, a.getAccountLimits},
		"/app/v1/admin/account/raise": {http.MethodPost, true, a.postAccountRaise},
		"/app/v1/admin/account/boost": {http.MethodPost, true, a.postAccountBoost},
		"/app/v1/admin/credits/grant": {http.MethodPost, true, a.postCreditsGrant},
		"/app/v1/admin/limit-changes": {http.MethodGet, true, a.getLimitChanges},
		"/app/v1/admin/over-limit":    {http.MethodGet, true, a.getOverLimit},
	}
}

// abuseRoutes: the fair-use tools, with or without the paywall: the storage list and an account's sends refused.
func (a *API) abuseRoutes() map[string]route {
	return map[string]route{
		"/app/v1/admin/storage":       {http.MethodGet, true, a.getStorage},
		"/app/v1/admin/account/sends": {http.MethodPost, true, a.postAccountSends},
	}
}

func (a *API) viewOpts() plans.ViewOpts {
	p := a.Cfg.Plans
	pd := p.Paid()
	return plans.ViewOpts{Mode: pd.Mode(), Gateway: pd.GatewayName(), PackSize: pd.CreditsPackSize, PackOn: pd.DodoProductCredits != "" || pd.GatewayName() == "fake", WithAdmin: true, StorageCeilingMB: p.StorageCeiling()}
}

func (a *API) getPlans(w http.ResponseWriter, r *http.Request, _ *auth.Session) error {
	ps, err := plans.ListPlans(r.Context(), a.Pool)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, 200, map[string]any{"mode": a.Cfg.Plans.Mode(), "ceiling": plans.Ceiling, "plans": ps})
	return nil
}

func (a *API) postPlanUpdate(w http.ResponseWriter, r *http.Request, s *auth.Session) error {
	body, err := httpx.ReadBody(r)
	if err != nil {
		return err
	}
	var b struct {
		PlanID string         `json:"plan_id"`
		Limits map[string]int `json:"limits"`
		Reason string         `json:"reason"`
	}
	if err := httpx.DecodeStrict(body, &b); err != nil {
		return err
	}
	if len(b.Limits) == 0 {
		return httpx.BadRequest("Nothing to change.")
	}
	p, changes, lifted, lowered, err := plans.UpdatePlan(r.Context(), a.Pool, s.AccountID, b.PlanID, b.Limits, b.Reason)
	if err != nil {
		return err
	}
	note := "Raised limits apply to every account on this plan now."
	if lowered {
		note = "Lowered limits apply only to accounts from now on. Existing accounts keep what they have."
	}
	httpx.WriteJSON(w, 200, map[string]any{"plan": p, "changes": changes, "raised_accounts": lifted, "note": note})
	return nil
}

// accountView answers with the account plan view (admin shape). showEmail: the admin looked it up by this email.
func (a *API) accountView(w http.ResponseWriter, r *http.Request, s *auth.Session, account string, showEmail bool) error {
	ctx := r.Context()
	var name, email string
	var created time.Time
	err := a.Pool.QueryRow(ctx, `select display_name, email, created_at from accounts where id = $1 and deleted_at is null`, account).Scan(&name, &email, &created)
	if errors.Is(err, pgx.ErrNoRows) {
		return httpx.E(404, "not_found", "No account with that id or email.")
	}
	if err != nil {
		return err
	}
	v, err := plans.View(ctx, a.Pool, account, a.viewOpts())
	if err != nil {
		return err
	}
	if !showEmail && !a.Cfg.IsAdmin(email) && !strings.EqualFold(email, s.Email) {
		email = MaskEmail(email)
	}
	v["account"] = map[string]any{"id": account, "display_name": name, "email": email, "created_at": created.UTC()}
	httpx.WriteJSON(w, 200, v)
	return nil
}

func (a *API) getAccountLimits(w http.ResponseWriter, r *http.Request, s *auth.Session) error {
	q := r.URL.Query()
	id, email := q.Get("account_id"), strings.ToLower(strings.TrimSpace(q.Get("email")))
	switch {
	case id != "":
		if !wire.IsUUID(id) {
			return httpx.E(404, "not_found", "No account with that id or email.")
		}
		return a.accountView(w, r, s, id, false)
	case email != "":
		err := a.Pool.QueryRow(r.Context(), `select id from accounts where email = $1 and deleted_at is null`, email).Scan(&id)
		if errors.Is(err, pgx.ErrNoRows) {
			return httpx.E(404, "not_found", "No account with that id or email.")
		}
		if err != nil {
			return err
		}
		return a.accountView(w, r, s, id, true)
	}
	return httpx.BadRequest("Give account_id or email.")
}

func (a *API) postAccountRaise(w http.ResponseWriter, r *http.Request, s *auth.Session) error {
	body, err := httpx.ReadBody(r)
	if err != nil {
		return err
	}
	var b struct {
		AccountID string `json:"account_id"`
		Limit     string `json:"limit"`
		Value     int    `json:"value"`
		Reason    string `json:"reason"`
	}
	if err := httpx.DecodeStrict(body, &b); err != nil {
		return err
	}
	if err := plans.Raise(r.Context(), a.Pool, s.AccountID, b.AccountID, b.Limit, b.Value, b.Reason); err != nil {
		return err
	}
	return a.accountView(w, r, s, b.AccountID, false)
}

func (a *API) postAccountBoost(w http.ResponseWriter, r *http.Request, s *auth.Session) error {
	body, err := httpx.ReadBody(r)
	if err != nil {
		return err
	}
	var b struct {
		AccountID string    `json:"account_id"`
		Limit     string    `json:"limit"`
		Value     int       `json:"value"`
		EndsAt    time.Time `json:"ends_at"`
		Reason    string    `json:"reason"`
	}
	if err := httpx.DecodeStrict(body, &b); err != nil {
		return err
	}
	if _, err := plans.AddBoost(r.Context(), a.Pool, s.AccountID, b.AccountID, b.Limit, b.Value, b.EndsAt, b.Reason); err != nil {
		return err
	}
	return a.accountView(w, r, s, b.AccountID, false)
}

func (a *API) postCreditsGrant(w http.ResponseWriter, r *http.Request, s *auth.Session) error {
	body, err := httpx.ReadBody(r)
	if err != nil {
		return err
	}
	var b struct {
		AccountID string `json:"account_id"`
		Amount    int64  `json:"amount"`
		Reason    string `json:"reason"`
	}
	if err := httpx.DecodeStrict(body, &b); err != nil {
		return err
	}
	e, err := plans.Grant(r.Context(), a.Pool, s.AccountID, b.AccountID, b.Amount, b.Reason)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, 200, map[string]any{"balance": e.BalanceAfter, "entry": e})
	return nil
}

func listLimit(r *http.Request, def, max int) (int, error) {
	v := r.URL.Query().Get("limit")
	if v == "" {
		return def, nil
	}
	n, err := strconv.Atoi(v)
	if err != nil || n < 1 || n > max {
		return 0, httpx.BadRequest("limit must be a whole number from 1 to " + strconv.Itoa(max) + ".")
	}
	return n, nil
}

func (a *API) getLimitChanges(w http.ResponseWriter, r *http.Request, _ *auth.Session) error {
	n, err := listLimit(r, 100, ListCap)
	if err != nil {
		return err
	}
	acc := r.URL.Query().Get("account_id")
	if acc != "" && !wire.IsUUID(acc) {
		return httpx.BadRequest("account_id must be an id.")
	}
	cs, err := plans.Changes(r.Context(), a.Pool, acc, r.URL.Query().Get("plan_id"), n)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, 200, map[string]any{"changes": cs})
	return nil
}

func (a *API) getOverLimit(w http.ResponseWriter, r *http.Request, s *auth.Session) error {
	accounts, events, err := plans.OverLimit(r.Context(), a.Pool, ListCap, func(e string) string {
		if a.Cfg.IsAdmin(e) || strings.EqualFold(e, s.Email) {
			return e
		}
		return MaskEmail(e)
	})
	if err != nil {
		return err
	}
	storage, err := a.storageView(r, s)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, 200, map[string]any{"mode": a.Cfg.Plans.Mode(), "accounts": accounts, "recent": events, "storage": storage})
	return nil
}

// GET /app/v1/admin/storage: the storage part of over-limit, with or without the paywall.
func (a *API) getStorage(w http.ResponseWriter, r *http.Request, s *auth.Session) error {
	storage, err := a.storageView(r, s)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, 200, map[string]any{"storage": storage})
	return nil
}

// storageView: stored bytes (security review finding 3): the server-wide level and the accounts storing the most.
func (a *API) storageView(r *http.Request, s *auth.Session) (map[string]any, error) {
	mask := func(e string) string {
		if a.Cfg.IsAdmin(e) || strings.EqualFold(e, s.Email) {
			return e
		}
		return MaskEmail(e)
	}
	total, err := plans.StorageUsedTotal(r.Context(), a.Pool)
	if err != nil {
		return nil, err
	}
	top, err := plans.TopStorage(r.Context(), a.Pool, 20, mask)
	if err != nil {
		return nil, err
	}
	lim := int64(a.Cfg.Plans.StorageTotal()) * plans.MiB
	return map[string]any{"total_bytes": total, "ceiling_bytes": lim, "pct": plans.StoragePct(total, lim),
		"level": plans.StorageLevel(total, lim), "account_ceiling_bytes": int64(a.Cfg.Plans.StorageCeiling()) * plans.MiB, "top": top}, nil
}

// POST /app/v1/admin/account/sends: refuse (or allow again) an account's sends; purge drops its stored copies now.
func (a *API) postAccountSends(w http.ResponseWriter, r *http.Request, s *auth.Session) error {
	body, err := httpx.ReadBody(r)
	if err != nil {
		return err
	}
	var b struct {
		AccountID string `json:"account_id"`
		Refused   bool   `json:"refused"`
		Purge     bool   `json:"purge"`
		Reason    string `json:"reason"`
	}
	if err := httpx.DecodeStrict(body, &b); err != nil {
		return err
	}
	freed, err := plans.SetSendsRefused(r.Context(), a.Pool, s.AccountID, b.AccountID, b.Refused, b.Purge, b.Reason)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, 200, map[string]any{"account_id": b.AccountID, "sends_refused": b.Refused, "freed_bytes": freed})
	return nil
}
