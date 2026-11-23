// Join requests of one room from the same place (app, computer, folder) shown as one card: a chat that ran `join`
// again and again under new names left a pile of full cards (P0 rejoin, 21 Nov 2026). The rules that need no page are
// here (tests: web/test/tries.test.mjs); the card is needs-tries.js.
//
// The place is what the chat says about itself, so any chat can copy it: a card of tries never approves more than one
// request, shows the code of the request it approves, and says how many different codes wait.

const PLACE = ["app", "app_name", "machine", "folder"];

/** The place a join request groups by, or null: moves never group, nor a request missing its app, computer or folder. */
export function placeKey(c) {
  if (!c || c.kind !== "join" || !c.app || !c.machine || !c.folder) return null;
  return JSON.stringify([c.room_id, ...PLACE.map((f) => c[f] ?? null)]);
}

/**
 * The join requests as units in list order: {key, newest, older (newest first), all}. A unit stands where its first
 * request stands, so a new try never moves the card. The newest goes by created time, a tie by list order.
 */
export function joinTries(joinRequests) {
  const units = [];
  const byKey = new Map();
  (joinRequests || []).forEach((c, i) => {
    const key = placeKey(c);
    const u = key && byKey.get(key);
    if (u) { u.items.push([c, i]); return; }
    const fresh = { key, items: [[c, i]] };
    if (key) byKey.set(key, fresh);
    units.push(fresh);
  });
  return units.map(({ key, items }) => {
    const sorted = [...items].sort(([a, ia], [b, ib]) => (Date.parse(b.created_at) || 0) - (Date.parse(a.created_at) || 0) || ib - ia).map(([c]) => c);
    return { key, newest: sorted[0], older: sorted.slice(1), all: sorted };
  });
}

/** How many different codes the unit's requests show. */
export const codesWaiting = (unit) => new Set(unit.all.map((c) => c.match_code)).size;

/** A short stable key for the unit's card (the same for every try of one place): letters, digits and dashes. */
export function triesKey(unit) {
  const s = unit.key || unit.newest.id;
  let a = 5381, b = 52711;
  for (let i = 0; i < s.length; i++) { const ch = s.charCodeAt(i); a = (a * 33) ^ ch; b = (b * 31) ^ ch; }
  return `${(a >>> 0).toString(36)}-${(b >>> 0).toString(36)}`;
}
