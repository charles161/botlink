// Every kind of account event the server can record has a plain sentence on Your browsers ("Recent changes"). The
// kinds come from db/migrations (the last account_events_kind_check), so a migration that adds a kind without a
// sentence fails here.
//   node --test web/test/account_events.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EVENT_TEXT, eventSentence } from "../public/assets/js/events.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MIG = join(ROOT, "db", "migrations");

/** The kinds account_events accepts after every migration: the last statement that defines its kind check wins. */
export function migrationKinds() {
  let kinds = null;
  for (const f of readdirSync(MIG).filter((x) => x.endsWith(".sql")).sort()) {
    const sql = readFileSync(join(MIG, f), "utf8").replace(/--.*$/gm, "");
    // create table account_events (... kind text not null check (kind in (...)) ...) or add constraint account_events_kind_check
    const re = /(create table(?: if not exists)? account_events\b[\s\S]*?kind\s+text[^,]*?check\s*\(\s*kind\s+in\s*\(([^)]*)\)|account_events_kind_check\s+check\s*\(\s*kind\s+in\s*\(([^)]*)\))/gi;
    for (const m of sql.matchAll(re)) kinds = [...(m[2] || m[3]).matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
  }
  return kinds;
}

const helpers = (here = "dev-here") => ({ here, deviceLabel: () => "Chrome on Mac", absTime: () => "17 Nov, 10:00", when: () => "2 hours ago" });
const FORBIDDEN = /\b(receipts?|seen|answered|webhooks?|delivered|leases?|envelopes?|epochs?|chatgpt)\b/i;

// data each kind can carry, in its variants (what the server writes; see appapi and store)
const VARIANTS = {
  passkey_reset_started: [{ ready_at: "2026-11-19T10:00:00Z", user_agent: "x" }, {}],
  passkey_reset_cancelled: [{ by: "passkey" }, { by: "session" }, { by: "session", why: "first_passkey_removed" }],
  passkey_reset_completed: [{ removed_passkeys: 2, ended_sign_ins: 1 }, { removed_passkeys: 1, ended_sign_ins: 0 }],
  device_removed: [{ label: "Work laptop", passkeys_removed: 1, delete_cancelled: true }, { label: "Work laptop", this_browser: true }, {}],
  account_delete_asked: [{ ready_at: "2026-11-19T10:00:00Z" }],
  account_delete_cancelled: ["session", "passkey", "passkey_reset", "browser_removed", "signed_out"].map((by) => ({ by }))
    .concat([{ by: "session", first_passkey_removed: true, passkeys_removed: 1, sign_ins_ended: 2 }]),
  account_delete_finished: [{}],
  signed_out_others: [{ sign_ins_ended: 3, delete_cancelled: true }, { sign_ins_ended: 0 }],
  first_passkey_removed: [{ passkeys_removed: 1, sign_ins_ended: 1 }],
};
const ACTORS = [{}, { actor_user_agent: "Mozilla/5.0" }, { actor_device_id: "dev-other", actor_device_label: "Work laptop" }, { actor_device_id: "dev-here", actor_device_label: "Mine" }];

test("the migrations name account event kinds", () => {
  const kinds = migrationKinds();
  assert.ok(kinds && kinds.length >= 9, `kinds read from db/migrations: ${kinds}`);
  assert.ok(kinds.includes("account_delete_asked") && kinds.includes("first_passkey_removed"));
});

test("every kind in the migrations has a sentence", () => {
  const missing = migrationKinds().filter((k) => typeof EVENT_TEXT[k] !== "function");
  assert.deepEqual(missing, [], `account event kinds with no sentence in web/public/assets/js/events.js: ${missing.join(", ")}`);
});

test("every sentence says who, what and when, in plain words", () => {
  for (const kind of migrationKinds()) {
    for (const data of VARIANTS[kind] || [{}]) {
      for (const actor of ACTORS) {
        const s = eventSentence({ kind, at: "2026-11-16T10:00:00Z", data: { ...data, ...actor } }, helpers());
        assert.ok(!/_/.test(s), `${kind}: a raw name in "${s}"`);
        assert.ok(!/undefined|null|NaN|\[object/.test(s), `${kind}: "${s}"`);
        assert.ok(s.includes("2 hours ago"), `${kind}: no time in "${s}"`);
        assert.ok(/^(This browser|Your browser “|A sign-in on Chrome on Mac|A sign-in to your account)/.test(s), `${kind}: no who in "${s}"`);
        assert.ok(!FORBIDDEN.test(s) && !/—/.test(s), `${kind}: forbidden word or dash in "${s}"`);
        assert.ok(/\.$/.test(s), `${kind}: "${s}" does not end a sentence`);
      }
    }
  }
  const here = eventSentence({ kind: "account_delete_asked", at: "x", data: { actor_device_id: "dev-here", actor_device_label: "Mine" } }, helpers());
  assert.match(here, /^This browser asked to delete this account 2 hours ago\./);
  const ua = eventSentence({ kind: "account_delete_cancelled", at: "x", data: { by: "session", first_passkey_removed: true, actor_user_agent: "x" } }, helpers());
  assert.equal(ua, "A sign-in on Chrome on Mac cancelled the account delete 2 hours ago. The passkey added when the delete was asked for was removed, and other sign-ins were ended.");
});

test("a kind the dashboard doesn't know still reads as a sentence", () => {
  assert.equal(eventSentence({ kind: "something_new", at: "x", data: {} }, helpers()), "A sign-in to your account changed something on your account 2 hours ago.");
});
