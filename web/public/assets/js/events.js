// The account's recent changes (account_events, migrations 0042, 0049, 0051) as plain sentences: who did it (this
// browser, a named browser of yours, or a sign-in on some browser), what, and when. Every kind the server can record
// has a sentence here; web/test/account_events.test.mjs reads the kinds from db/migrations and fails on a missing one.
// No imports: the test runs this file in node. The view passes its own helpers.

const n = (k, one, many) => `${k} ${k === 1 ? one : many}`;

/** Who did it, from the event's actor_* fields (recorded with the event; a browser only when its sign-in proved it). */
export function eventActor(data, { here, deviceLabel }) {
  if (data.actor_device_id && here && data.actor_device_id === here) return "This browser";
  if (data.actor_device_label) return `Your browser “${data.actor_device_label}”`;
  if (data.actor_user_agent) return `A sign-in on ${deviceLabel(data.actor_user_agent)}`;
  return "A sign-in to your account";
}

const DELETE_CANCEL = {
  session: "cancelled the account delete",
  passkey: "cancelled the account delete with a passkey",
  passkey_reset: "finished a passkey reset, which cancelled the account delete",
  browser_removed: "removed a browser, which cancelled the account delete",
  signed_out: "signed out the other browsers, which cancelled the account delete",
};

// kind -> (data, helpers) => [what, after]: "<who> <what> <when>.<after>"
export const EVENT_TEXT = {
  passkey_reset_started: (d, x) => ["asked to reset your passkeys", d.ready_at ? ` A new passkey could replace yours from ${x.absTime(d.ready_at)}.` : ""],
  passkey_reset_cancelled: (d) => [d.why === "first_passkey_removed" ? "removed the account's first passkey, which ended the passkey reset"
    : d.by === "passkey" ? "cancelled the passkey reset with a passkey" : "cancelled the passkey reset", ""],
  passkey_reset_completed: (d) => ["set up a new passkey after a reset",
    ` ${n(d.removed_passkeys || 0, "old passkey was", "old passkeys were")} removed and ${n(d.ended_sign_ins || 0, "other sign-in", "other sign-ins")} ended.`],
  device_removed: (d) => [d.this_browser ? "removed itself from your account"
    : `removed the browser “${d.label || "unnamed"}”${d.passkeys_removed ? ` and ${n(d.passkeys_removed, "passkey", "passkeys")}` : ""}`,
  `${d.this_browser && d.passkeys_removed ? ` ${n(d.passkeys_removed, "passkey was", "passkeys were")} removed with it.` : ""}${d.delete_cancelled ? " A waiting delete of this account was cancelled with it." : ""}`],
  account_delete_asked: (d, x) => ["asked to delete this account", d.ready_at ? ` It could be finished from ${x.absTime(d.ready_at)} if nobody cancelled it.` : ""],
  account_delete_cancelled: (d) => [DELETE_CANCEL[d.by] || DELETE_CANCEL.session,
    d.first_passkey_removed ? " The passkey added when the delete was asked for was removed, and other sign-ins were ended." : ""],
  account_delete_finished: () => ["deleted this account", ""],
  signed_out_others: (d) => ["signed out the other browsers",
    `${d.sign_ins_ended ? ` ${n(d.sign_ins_ended, "sign-in", "sign-ins")} ended.` : ""}${d.delete_cancelled ? " A waiting delete of this account was cancelled with it." : ""}`],
  first_passkey_removed: (d) => ["removed the account's first passkey, which was set up after it signed in",
    ` ${n(d.passkeys_removed || 0, "passkey was", "passkeys were")} removed and ${n(d.sign_ins_ended || 0, "newer sign-in", "newer sign-ins")} ended.`],
};

/** One event as a sentence. x: { here: this browser's id, deviceLabel(ua), absTime(iso), when(iso) e.g. "2 hours ago" }. */
export function eventSentence(e, x) {
  const d = e.data || {};
  const fn = EVENT_TEXT[e.kind];
  const [what, after] = fn ? fn(d, x) : ["changed something on your account", ""];
  return `${eventActor(d, x)} ${what} ${x.when(e.at)}.${after}`;
}
