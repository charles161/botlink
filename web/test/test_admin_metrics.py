"""Admin metrics section (views/admin-metrics.js): the numbers behind KILL-CRITERIA.md, on the mock, 390x844 and 1440x900.

The mock server has no metrics route (it is shared by every lane); this test answers GET /app/v1/admin/metrics in the
browser with FIXTURE, which has the shape server/internal/adminapi/metrics.go returns (its Go test checks the keys).

    PORT=8931 node web/test/fixtures/mock-server.mjs &
    python3 web/test/test_admin_metrics.py --base http://localhost:8931

Asserts: the section shows the thresholds with met / not met / too early beside the numbers, the funnel, the weekly
series, retention and activation as plain tables; it asks for the numbers only when told to, sends the launch moment;
says so when the admin area is locked (without asking); no email or domain on the page; 0 console errors; no horizontal overflow, no
text under 13px, 44px tap targets, no forbidden words.
"""
import argparse, json, sys
from playwright.sync_api import sync_playwright, expect
from test_e2e import Run, sign_in, approve_dialog

ADMIN_EMAIL = "ops@botlink.test"


def week(i):
    return f"2026-{9 + (i + 8) // 30:02d}-{(i * 7) % 28 + 1:02d}T00:00:00Z"


def thr(id, when, label, goal, unit, value, status, then):
    return {"id": id, "when": when, "label": label, "goal": goal, "unit": unit, "value": value, "status": status, "then": then,
            "source": "REPORT-FUTURE decision 5", "query": "db/metrics/funnel.sql back_next_week_pct"}


FUNNEL = {"since": "2026-11-24T15:00:00Z", "until": "2026-12-01T15:00:00Z", "signups": 412, "rooms_created": 230, "person_invites_made": 96,
          "person_requests": 71, "people_approved": 64, "chat_join_requests": 388, "chat_joins_approved": 351, "rooms_first_message": 180,
          "rooms_2plus_people": 52, "rooms_between_people": 44, "rooms_between_people_2plus_domains": 6,
          "rooms_between_people_2plus_domains_split_freemail": 9, "cross_domain_pct": 13.6, "rooms_idle_answer": 41,
          "back_next_week": None, "back_next_week_pct": None}
FIXTURE = {
    "generated_at": "2026-12-02T10:00:00Z", "since": "2026-11-24T15:00:00Z",
    "launch": {"since": "2026-11-24T15:00:00Z", "until": "2026-12-01T15:00:00Z", "approved_joins": 351, "launch_rooms": 230,
               "rooms_2plus_people": 52, "rooms_2plus_apps": 140, "median_msgs_two_person_room_first_7d": 18.5,
               "day7_retention_pct": None, "rooms_between_people": 41, "rooms_between_people_any_answer": 47},
    "funnel_week1": FUNNEL, "funnel_day30": dict(FUNNEL, until="2026-12-24T15:00:00Z"),
    "weekly": [{"week": week(i), "rooms_active": i * 3, "rooms_2plus_people": i, "rooms_2plus_domains": i // 4,
                "rooms_2plus_domains_split_freemail": i // 3, "rooms_between_people": i // 2, "rooms_between_people_2plus_domains": i // 5,
                "cross_domain_pct": None if i < 2 else round(100 * (i // 5) / (i // 2), 1),
                "rooms_activated": None if i < 22 else i // 3, "rooms_activated_2plus_domains": None if i < 22 else i // 8,
                "week_complete": i < 25} for i in range(26)],
    "retention": [{"cohort_week": week(i), "rooms": i, "week1_back": None if i > 24 else i // 3, "week1_pct": None if i > 24 or i == 0 else round(100 * (i // 3) / i, 1),
                   "week4_back": None if i > 21 else i // 4, "week4_pct": None if i > 21 or i == 0 else round(100 * (i // 4) / i, 1)} for i in range(26)],
    "activation": [{"signup_week": week(i), "accounts": i * 10, "in_room": i * 6, "chat_approved": i * 5, "first_message": i * 4,
                    "between_people": i, "complete": i < 24} for i in range(26)],
    "thresholds": [
        thr("launch_worked", "7 days after the launch post", "Rooms between people in launch week", 40, "rooms", 41, "met", "Met: it worked."),
        thr("launch_alarm", "7 days after the launch post", "At least 10 rooms between people in launch week", 10, "rooms", 41, "met", "Not met: fix the invite."),
        thr("launch_back", "14 days after the launch post", "Rooms between people from launch week active again the week after", 25, "pct", None, "too_early", "With 40+: raise."),
        thr("day30_cross_domain", "30 days after the launch post", "Rooms between people spanning 2+ email domains", 12, "pct", 13.6, "too_early", "Met: price per connection."),
        thr("month6_week4", "6 months after the launch post", "Week-4 retention of rooms between people", 30, "pct", 22.5, "not_met", "Not met: pivot or sell."),
        thr("month6_cross_domain", "6 months after the launch post", "Activated rooms spanning 2+ email domains", 20, "pct", None, "too_early", "Not met: pivot or sell."),
        thr("raise", "14 days after the launch post", "40+ rooms between people and 25 % back the week after", 1, "yes", None, "too_early", "Met: raise."),
    ],
}


def run(browser, base, vp):
    r = Run(browser, base, vp)
    pg = r.pg
    calls = []

    def answer(route):
        calls.append(route.request.url)
        route.fulfill(status=200, content_type="application/json", body=json.dumps(FIXTURE))
    pg.route("**/app/v1/admin/metrics**", answer)

    sign_in(r, ADMIN_EMAIL, "Ops")
    r.go("/admin")
    sec = pg.locator("#adm-metrics")
    expect(sec).to_be_visible(timeout=5000)
    r.check(not calls, "metrics asked for before anyone clicked")

    # locked (the mock's /admin/status says so): says so, asks for no numbers
    sec.get_by_role("button", name="Show the numbers").click()
    expect(sec.locator(".error-box")).to_contain_text("Confirm it's you", timeout=5000)
    r.check(not calls, "metrics asked for while the admin area is locked")

    pg.get_by_role("button", name="Confirm it's you").first.click()
    approve_dialog(r, "Open admin")
    expect(pg.locator(".adm-stats")).to_be_visible(timeout=8000)

    sec.locator("input[name=since]").fill("2026-11-24T15:00")
    sec.get_by_role("button", name="Show the numbers").click()
    expect(sec.locator("table[aria-label='Thresholds']")).to_be_visible(timeout=5000)
    r.check("since=2026-11-24T" in calls[-1], f"launch moment not sent: {calls[-1]}")

    rows = sec.locator("table[aria-label='Thresholds'] tbody tr")
    r.check(rows.count() == 7, f"thresholds: {rows.count()} rows")
    text = sec.inner_text()
    for want in ["Met", "Not met", "Too early", "41", "13.6 %", "Rooms between people in launch week", "Pivot or sell".lower()]:
        r.check(want.lower() in text.lower(), f"missing {want!r}")
    r.check(sec.locator("tr.is-met").count() == 2 and sec.locator("tr.is-not-met").count() == 1 and sec.locator("tr.is-early").count() == 4,
            "threshold rows not marked met / not met / too early")
    for label in ["Funnel", "Weekly", "Retention", "Activation"]:
        r.check(sec.locator(f"table[aria-label^='{label}']").count() >= 1, f"no {label} table")
    r.check(sec.locator("table[aria-label^='Funnel'] tbody tr").count() >= 10, "funnel rows")
    r.check("412" in text and "351" in text, "funnel numbers missing")
    r.check(sec.locator("table[aria-label^='Weekly'] tbody tr").count() >= 8, "weekly rows")
    r.check("not kept" in text, "weekly: old activated weeks should say the messages are not kept")
    r.check("@" not in text and "gmail" not in text.lower(), "an email or domain on the page")
    r.check(pg.locator("canvas, svg.chart").count() == 0, "a chart instead of tables")

    # the live overview refresh keeps the section and its numbers
    r.settle(5600)
    r.check(sec.locator("table[aria-label='Thresholds'] tbody tr").count() == 7, "a refresh dropped the numbers")
    r.audit("admin-metrics")
    sec.locator("table[aria-label='Thresholds']").scroll_into_view_if_needed()
    r.shot("28-admin-metrics")

    # a non-admin never sees it
    eve = Run(browser, base, vp)
    sign_in(eve, f"eve-metrics-{vp}@acme.dev", "Eve")
    eve.go("/admin")
    eve.settle(300)
    eve.check(eve.pg.locator("#adm-metrics").count() == 0, "non-admin sees the metrics section")
    res = eve.pg.request.get(base + "/app/v1/admin/metrics")
    eve.check(res.status == 404, f"non-admin GET metrics on the mock: {res.status}")
    errs, fails = r.errors + eve.errors, r.failures + eve.failures
    eve.close(); r.close()
    return errs, fails


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://localhost:8931")
    a = ap.parse_args()
    errs, fails = [], []
    with sync_playwright() as p:
        b = p.chromium.launch()
        for vp in ["phone", "desktop"]:
            e, f = run(b, a.base, vp)
            errs += e; fails += f
        b.close()
    for x in errs + fails:
        print("FAIL", x)
    print(f"admin metrics: {len(errs)} console errors, {len(fails)} failures")
    sys.exit(1 if errs or fails else 0)


if __name__ == "__main__":
    main()
