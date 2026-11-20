package plans

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/charles161/botlink/server/internal/store"
)

// Billing is an account's payment state (account_billing; no row = never paid).
type Billing struct {
	PlanID            string     `json:"-"`
	Gateway           string     `json:"gateway"`
	Status            string     `json:"status"`
	Interval          *string    `json:"interval"`
	PaidUntil         *time.Time `json:"paid_until"`
	CancelAtPeriodEnd bool       `json:"cancel_at_period_end"`
	CanOpenPortal     bool       `json:"can_open_portal"`
	CustomerID        *string    `json:"customer_id,omitempty"`
	SubscriptionID    *string    `json:"subscription_id,omitempty"`
	paidLive          bool
}

// LoadBilling reads the account's payment state. gateway is the configured gateway name (off | fake | dodo).
func LoadBilling(ctx context.Context, q store.Q, account, gateway string) (*Billing, error) {
	b := &Billing{PlanID: "free", Gateway: gateway, Status: "none"}
	var gw *string
	err := q.QueryRow(ctx, `select plan_id, status, billing_interval, paid_until, cancel_at_period_end, gateway, customer_id, subscription_id,
		coalesce(paid_until > now(), false) from account_billing where account_id = $1`, account).Scan(
		&b.PlanID, &b.Status, &b.Interval, &b.PaidUntil, &b.CancelAtPeriodEnd, &gw, &b.CustomerID, &b.SubscriptionID, &b.paidLive)
	if errors.Is(err, pgx.ErrNoRows) {
		return b, nil
	}
	if err != nil {
		return nil, err
	}
	if b.PaidUntil != nil {
		t := b.PaidUntil.UTC()
		b.PaidUntil = &t
	}
	b.CanOpenPortal = gateway != "off" && gw != nil && *gw == gateway && b.CustomerID != nil
	return b, nil
}

// ViewOpts is what the view needs from config.
type ViewOpts struct {
	Mode      string
	Gateway   string // off | fake | dodo
	PackSize  int64  // credits per pack; 0 = no pack
	PackOn    bool   // a pack product is configured
	WithAdmin bool   // admin view: raises, all boosts, ids; no for_sale
	// StorageCeilingMB: the server-wide safety ceiling per account (BOTLINK_STORAGE_CEILING_MB); 0 = the default.
	// storage_mb shows it as its ceiling.
	StorageCeilingMB int
}

func day(t time.Time) string { return t.UTC().Format("2 Jan 2006") }

// View builds the plan view of GET /app/v1/plan (and the admin account view with WithAdmin).
func View(ctx context.Context, q store.Q, account string, o ViewOpts) (map[string]any, error) {
	if o.Mode == "" {
		o.Mode = ModeCount
	}
	st, err := Effective(ctx, q, account)
	if err != nil {
		return nil, err
	}
	rooms, err := OwnedRooms(ctx, q, account)
	if err != nil {
		return nil, err
	}
	over := OverNow(st, rooms)
	stored, err := StorageUsed(ctx, q, account)
	if err != nil {
		return nil, err
	}
	sl := st.Limits[StorageMB]
	ceil := o.StorageCeilingMB
	if ceil <= 0 {
		ceil = DefaultStorageCeilingMB
	}
	if st.PlanID != "free" && sl.Value > ceil { // a paid plan gets the larger of the ceiling and its storage_mb
		ceil = sl.Value
	}
	sl.Ceiling = &ceil
	if sl.Value > ceil {
		sl.Value, sl.Source = ceil, "ceiling"
	}
	if mb := ToMB(stored); mb > sl.Value {
		over = append(over, Over{Limit: StorageMB, Used: mb, Value: sl.Value})
	}
	limits := map[string]any{}
	for _, k := range Keys {
		l := st.Limits[k]
		v := map[string]any{"value": l.Value, "source": l.Source, "plan_value": l.PlanValue, "raise": l.Raise, "boost": l.Boost,
			"ceiling": l.Ceiling, "over": false}
		switch k {
		case Rooms:
			v["used"] = len(rooms)
		case HistoryDays:
			v["used"] = nil
		case StorageMB:
			v["used"] = ToMB(stored)
		default:
			hi, ro := 0, []string{}
			for _, r := range rooms {
				n := r.Members
				if k == PeoplePerRoom {
					n = r.People
				}
				if n > hi {
					hi = n
				}
			}
			for _, x := range over {
				if x.Limit == k && x.RoomID != nil {
					ro = append(ro, *x.RoomID)
				}
			}
			v["used"], v["rooms_over"] = hi, ro
		}
		for _, x := range over {
			if x.Limit == k {
				v["over"] = true
			}
		}
		limits[k] = v
	}
	bill, err := LoadBilling(ctx, q, account, o.Gateway)
	if err != nil {
		return nil, err
	}
	notices := []map[string]any{}
	now := time.Now()
	for _, b := range st.Boosts {
		if b.EndsAt.Sub(now) <= HeadsUp {
			after := st.Limits[b.Limit].Permanent
			notices = append(notices, map[string]any{"kind": "boost_ending", "limit": b.Limit, "ends_at": b.EndsAt,
				"text": fmt.Sprintf("Your extra %s end on %s. After that the limit is %d.", Label(b.Limit), day(b.EndsAt), after)})
		}
	}
	tail := " Your rooms stay open. Nothing is blocked."
	if o.Mode == ModeBlock {
		tail = " Your rooms stay open, but you can't add more until you are under the limit."
	}
	seen := map[string]bool{}
	for _, x := range over {
		if seen[x.Limit] {
			continue
		}
		seen[x.Limit] = true
		var text string
		if x.Limit == Rooms {
			text = fmt.Sprintf("You have %d rooms. Your plan allows %d.", x.Used, x.Value)
		} else if x.Limit == StorageMB {
			text = fmt.Sprintf("Your chats have %d MB of messages stored on bot-link. Your plan allows %d MB.", x.Used, x.Value)
		} else {
			what := "members"
			if x.Limit == PeoplePerRoom {
				what = "people"
			}
			text = fmt.Sprintf("A room of yours has more %s than your plan allows (%d).", what, x.Value)
		}
		notices = append(notices, map[string]any{"kind": "over_limit", "limit": x.Limit, "text": text + tail})
	}
	if bill.paidLive && bill.PlanID != "free" && bill.PaidUntil != nil {
		name := st.PlanName
		switch {
		case bill.Status == "on_hold" || bill.Status == "past_due" || bill.Status == "failed":
			notices = append(notices, map[string]any{"kind": "plan_ending", "limit": nil, "ends_at": bill.PaidUntil,
				"text": fmt.Sprintf("Your last %s payment did not go through. %s ends on %s unless it is paid. Your rooms stay open.", name, name, day(*bill.PaidUntil))})
		case bill.CancelAtPeriodEnd || bill.Status == "cancelled" || bill.Status == "expired" || bill.Status == "paused":
			notices = append(notices, map[string]any{"kind": "plan_ending", "limit": nil, "ends_at": bill.PaidUntil,
				"text": fmt.Sprintf("%s ends on %s. Then your account moves to Free. Your rooms stay open.", name, day(*bill.PaidUntil))})
		}
	}
	bal, err := Balance(ctx, q, account)
	if err != nil {
		return nil, err
	}
	var pack any
	if o.PackOn && o.PackSize > 0 && o.Gateway != "off" {
		pack = map[string]any{"product": "credits_pack", "credits": o.PackSize}
	}
	out := map[string]any{
		"plan":       map[string]any{"id": st.PlanID, "name": st.PlanName},
		"mode":       o.Mode,
		"limits":     limits,
		"rooms":      rooms,
		"over_limit": len(over) > 0,
		"notices":    notices,
		"credits":    map[string]any{"balance": bal, "pack": pack},
	}
	if o.WithAdmin {
		raises := map[string]any{}
		for _, k := range Keys {
			raises[k] = st.Raises[k]
		}
		out["raises"] = raises
		all, err := Boosts(ctx, q, account, true)
		if err != nil {
			return nil, err
		}
		out["boosts"] = all
		out["billing"] = bill
		return out, nil
	}
	bill.CustomerID, bill.SubscriptionID = nil, nil
	out["billing"] = bill
	forSale := []map[string]any{}
	if st.PlanID == "free" {
		ps, err := ListPlans(ctx, q)
		if err != nil {
			return nil, err
		}
		for _, p := range ps {
			if !p.ForSale {
				continue
			}
			forSale = append(forSale, map[string]any{"id": p.ID, "name": p.Name, "rooms": p.Rooms, "agents_per_room": p.AgentsPerRoom,
				"people_per_room": p.PeoplePerRoom, "history_days": p.HistoryDays, "prices": priceList(p)})
		}
	}
	out["for_sale"] = forSale
	return out, nil
}

// priceList is what a plan for sale costs (per person): monthly, and per month billed yearly. Empty if not for sale.
func priceList(p Plan) []map[string]any {
	if !p.ForSale {
		return []map[string]any{}
	}
	return []map[string]any{
		{"product": p.ID + "_monthly", "usd_cents": p.PriceMonth, "per": "month", "billed": "monthly", "total_usd_cents": p.PriceMonth},
		{"product": p.ID + "_yearly", "usd_cents": p.PriceYearMonth, "per": "month", "billed": "yearly", "total_usd_cents": p.PriceYearMonth * 12},
	}
}

// Pricing is the public price list (GET /app/v1/pricing): every plan's live numbers and prices. Nothing about any
// account: no counts, no ids, no snapshots.
func Pricing(ctx context.Context, q store.Q) ([]map[string]any, error) {
	ps, err := ListPlans(ctx, q)
	if err != nil {
		return nil, err
	}
	out := []map[string]any{}
	for _, p := range ps {
		out = append(out, map[string]any{"id": p.ID, "name": p.Name, "rooms": p.Rooms, "agents_per_room": p.AgentsPerRoom,
			"people_per_room": p.PeoplePerRoom, "history_days": p.HistoryDays, "for_sale": p.ForSale, "prices": priceList(p)})
	}
	return out, nil
}
