// Approving several waiting chats of one room together: the rules that need no page (tests: web/test/batch.test.mjs).
// Which requests may be ticked, the ticks themselves (a copy of each card as it was shown), what happens to a tick when
// the list is drawn again, and the re-read before anything is signed. The page is needs-batch.js.
import { memberFingerprint } from "./crypto.js";
import { cardProblems } from "./draft.js";

/** The human-check action of a batch (target: the room id, targets: the ticked join request ids). */
export const BATCH_ACTION = "approve_joins";
/** At most this many chats in one batch. */
export const BATCH_MAX = 5;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MATCH_CODE = /^(?:[2-9A-HJ-NP-Z]{4}|[2-9A-HJ-NP-Z]{6})$/;

/** The fields of a join request the card shows or the member_add carries. A change in any of them is a different card. */
export const JOIN_FIELDS = ["id", "kind", "room_id", "room_name", "member_id", "name", "job", "app", "app_name", "machine", "folder", "turn",
  "match_code", "ed25519_pk", "x25519_pk", "invite_label", "readdressed_from_name", "created_at", "expires_at", "move_to"];
export const sameJoin = (a, b) => !!a && !!b && JOIN_FIELDS.every((f) => (a[f] ?? null) === (b[f] ?? null));
const copyOf = (card) => Object.fromEntries(JOIN_FIELDS.map((f) => [f, card[f] ?? null]));

/**
 * The card checked against itself before it may be ticked: a join request (never a move), ids, a chat name, an app,
 * two different keys, a code and time left (draft.js cardProblems for the fields a draft shares). Empty when it checks out.
 */
export function joinProblems(card) {
  if (!card || typeof card !== "object") return ["card"];
  const out = cardProblems(card, card.id);
  if (!UUID.test(card.id || "")) out.push("id");
  if (card.kind !== "join") out.push("kind");
  if (!UUID.test(card.room_id || "")) out.push("room_id");
  if (!MATCH_CODE.test(card.match_code || "")) out.push("match_code");
  if (!(Date.parse(card.expires_at || "") > Date.now())) out.push("expires_at");
  return [...new Set(out)];
}

const SAME_PLACE = ["app", "app_name", "machine", "folder"];
/**
 * Two waiting requests of one room that run in the same place (the same app, computer and folder): the card can't tell
 * them apart by where they run, only by the code. Two of them are never ticked into one batch: each is approved on its own.
 */
export function lookAlike(a, b) {
  if (!a || !b || a.room_id !== b.room_id || a.id === b.id) return false;
  return SAME_PLACE.every((f) => (a[f] ?? null) === (b[f] ?? null));
}

/** room_id → its waiting join requests, in list order, for each room with two or more (moves never count). */
export function batchRooms(joinRequests) {
  const by = new Map();
  for (const c of joinRequests || []) {
    if (c.kind !== "join") continue;
    if (!by.has(c.room_id)) by.set(c.room_id, []);
    by.get(c.room_id).push(c);
  }
  for (const [room, list] of by) if (list.length < 2) by.delete(room);
  return by;
}

/**
 * The ticks of one page: id → {card: a copy of what was shown, fp: the fingerprint the browser computed and showed}.
 * Kept in memory only, so a reload starts with nothing ticked. tick() refuses a card that doesn't check out, one with
 * no fingerprint yet, a sixth in a room, and one that runs where a ticked one runs (lookAlike).
 */
export function createTicks() {
  const ticks = new Map();
  const notes = new Map();      // id → why its tick went ("changed", or a batch answer's reason)
  const roomNotes = new Map();  // room_id → the bar's last line
  const inRoom = (roomId) => [...ticks.values()].filter((t) => t.card.room_id === roomId);
  return {
    has: (id) => ticks.has(id),
    count: (roomId) => inRoom(roomId).length,
    ticked: (roomId) => inRoom(roomId).map((t) => ({ card: { ...t.card }, fp: t.fp })),
    tick(card, fp) {
      if (joinProblems(card).length || typeof fp !== "string" || !fp) return "refused";
      if (!ticks.has(card.id) && inRoom(card.room_id).length >= BATCH_MAX) return "max";
      if (inRoom(card.room_id).some((t) => t.card.id !== card.id && lookAlike(t.card, card))) return "lookalike";
      ticks.set(card.id, { card: copyOf(card), fp });
      notes.delete(card.id);
      return "ok";
    },
    untick: (id) => { ticks.delete(id); },
    clearRoom: (roomId) => { for (const t of inRoom(roomId)) ticks.delete(t.card.id); },
    /** The list as drawn now: a ticked card that changed loses its tick (noted), one that left the list is dropped. */
    reconcile(joinRequests) {
      const now = new Map((joinRequests || []).map((c) => [c.id, c]));
      const lost = [];
      for (const [id, t] of ticks) {
        const c = now.get(id);
        if (c && sameJoin(t.card, c)) continue;
        ticks.delete(id);
        lost.push({ id, room_id: t.card.room_id, name: t.card.name, reason: c ? "changed" : "gone" });
        if (c) notes.set(id, "changed");
      }
      return lost;
    },
    note: (id) => notes.get(id) ?? null,
    setNote: (id, why) => { notes.set(id, why); },
    roomNote: (roomId) => roomNotes.get(roomId) ?? null,
    setRoomNote: (roomId, text) => { if (text) roomNotes.set(roomId, text); else roomNotes.delete(roomId); },
  };
}

/**
 * Before signing: the list read again must hold each ticked card field for field as shown, still checking out, with
 * the fingerprint the browser showed. Returns [{id, name, reason: "gone" | "changed"}] (empty: sign).
 */
export async function preSignProblems(shown, joinRequests) {
  const now = new Map((joinRequests || []).map((c) => [c.id, c]));
  const out = [];
  for (const { card, fp } of shown) {
    const c = now.get(card.id);
    if (!c) { out.push({ id: card.id, name: card.name, reason: "gone" }); continue; }
    let same = sameJoin(card, c) && !joinProblems(c).length;
    if (same) same = (await memberFingerprint(c.ed25519_pk, c.x25519_pk)) === fp;
    if (!same) out.push({ id: card.id, name: card.name, reason: "changed" });
  }
  return out;
}
