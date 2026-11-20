// Starting a room: the genesis entry and one device_add for each other browser the person already approved, all
// signed by this browser (SPEC §6.2). "Start a room" (views/new-room.js) and a room a chat asked for
// (views/create.js) both sign through here, so the two make the same room.
import { get } from "./api.js";
import { signRosterEntry, sha256Hex } from "./crypto.js";

/** What a person types as a room name → lowercase letters, numbers and dashes (ROOM_NAME checks the rest). */
export const slugify = (v) => v.toLowerCase().replace(/[\s_]+/g, "-").replace(/[^a-z0-9-]/g, "").replace(/^-+/, "").slice(0, 32);

/** This person's other approved browsers that are not removed (the device_add entries after genesis). */
export async function otherApprovedBrowsers(device) {
  try { return (await get("/app/v1/devices")).devices.filter((d) => d.id !== device.id && d.approved && !d.revoked_at); } catch { return []; }
}

/**
 * Sign a new room. Returns {room: the body of POST /app/v1/rooms, headSeq, headHash}: the next entry (a member_add)
 * goes at headSeq + 1 with prev headHash. `others` defaults to otherApprovedBrowsers(device).
 */
export async function signRoomStart(device, { id, name, purpose, owner, others }) {
  const g = await signRosterEntry(device, { room: id, seq: 0, prev: null, op: "genesis", name, owner, device: device.pk });
  const entries = [];
  let prev = await sha256Hex(g.bytes);
  for (const d of others ?? await otherApprovedBrowsers(device)) {
    const e = await signRosterEntry(device, { room: id, seq: entries.length + 1, prev, op: "device_add", account: owner, device: d.ed25519_pk, label: d.label.slice(0, 80) });
    entries.push(e.wire); prev = await sha256Hex(e.bytes);
  }
  return { room: { id, name, purpose, genesis: g.wire, entries }, headSeq: entries.length, headHash: prev };
}
