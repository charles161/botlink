// The /create/<id> page's rules that need no page (docs/protocol/room-drafts.md §4; tests: web/test/draft.test.mjs):
// the code a person types, a chat's words shown inert, and the card checked against itself before anything is signed.
import { MEMBER_NAME } from "./crypto.js";

/**
 * The human-check action of a draft's confirm (docs/protocol/room-drafts.md §3 step 3; the server's
 * humancheck.ConfirmRoomAction, target: the draft id). The one place the page and the fixture server
 * (web/test/fixtures/mock-drafts.mjs) name it.
 */
export const CONFIRM_ACTION = "confirm_room";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX32 = /^[0-9a-f]{64}$/;
const APPS = new Set(["claude-code", "codex", "cursor", "other"]);

/** What the person typed → the 6-character code ("K7Q2MX"), or null. Case, outer spaces and one dash or space between the groups of three are ignored. */
export function normalizeCode(typed) {
  const m = /^([A-Z0-9]{3})[- ]?([A-Z0-9]{3})$/.exec(String(typed ?? "").trim().toUpperCase());
  return m ? m[1] + m[2] : null;
}

// Characters that change how text around them looks or reads without showing themselves: C0/C1 controls, the soft
// hyphen, bidi marks, embeddings, overrides and isolates, zero-width characters, line and paragraph separators,
// invisible operators, variation selectors, the byte-order mark, interlinear annotation marks and tag characters.
const HIDDEN = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u115f\u1160\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\ufff9-\ufffb\u{e0000}-\u{e007f}]/gu;
/** A chat's words as plain text in which every hidden or direction-changing character shows as a visible mark ([U+202E]). */
export const inertText = (s) => String(s ?? "").replace(HIDDEN, (c) => `[U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}]`);

/** The fields of a draft card the person sees and the browser signs for. A change in any of them between show and confirm stops the confirm. */
export const CARD_FIELDS = ["id", "room_name", "room_purpose", "name", "job", "app", "app_name", "machine", "folder", "turn", "member_id", "ed25519_pk", "x25519_pk"];
export const sameCard = (a, b) => !!a && !!b && CARD_FIELDS.every((f) => (a[f] ?? null) === (b[f] ?? null));

/**
 * The card checked against itself, as the approval card does before it signs: the draft the link names, a member id,
 * a chat name, an app and two keys the member_add can carry. Returns what is wrong (empty when it checks out). The
 * room name is the chat's proposal, not checked here: when it can't be used the person picks another one.
 */
export function cardProblems(card, id) {
  const out = [];
  if (!card || typeof card !== "object") return ["card"];
  if (card.id !== id) out.push("id");
  if (!UUID.test(card.member_id || "")) out.push("member_id");
  if (typeof card.name !== "string" || !MEMBER_NAME.test(card.name)) out.push("name");
  if (!APPS.has(card.app)) out.push("app");
  if (!HEX32.test(card.ed25519_pk || "")) out.push("ed25519_pk");
  if (!HEX32.test(card.x25519_pk || "")) out.push("x25519_pk");
  if (card.ed25519_pk && card.ed25519_pk === card.x25519_pk) out.push("x25519_pk");
  if (!Number.isFinite(Date.parse(card.expires_at || ""))) out.push("expires_at");
  return out;
}
