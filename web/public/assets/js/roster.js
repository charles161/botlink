// Sign roster entries at the verified head. The browser fetches and verifies the whole signed
// member list itself before signing anything (ENVELOPE §5.3), and retries on 409 roster_conflict.
import { get, post } from "./api.js";
import { verifyRoster, signRosterEntry, sha256Hex, RosterError } from "./crypto.js";

export async function fetchVerified(roomId) {
  const roster = await get(`/app/v1/rooms/${roomId}/roster`);
  try {
    return { roster, verified: await verifyRoster(roomId, roster.entries) };
  } catch (e) {
    if (e instanceof RosterError) {
      const err = new Error(e.message);
      err.userMessage = "bot-link can't verify this room's member list, so nothing was signed. Don't trust messages from this room and tell the room owner.";
      err.fatal = true; err.rosterRule = e.rule;
      throw err;
    }
    throw e;
  }
}

/** The member_add that lets a chat in as `account`'s chat, from a join request or a room draft card (the same fields). */
export const memberAddOp = (req, account) => ({ op: "member_add", member: req.member_id, account, name: req.name, app: req.app, ed: req.ed25519_pk, x: req.x25519_pk });

const isSigner = (v, pk) => [...v.people.values()].some((p) => p.devices.has(pk));

/**
 * build(verified) → op fields ({op, ...}) or throws {userMessage}. send(wire) → server response.
 * Retries up to 5 times when the head moved under us (same human check; the server allows that, F6).
 */
export async function appendSigned(roomId, device, build, send) {
  if (!device) {
    const e = new Error("no device"); e.userMessage = "This browser has no signing key yet. Reload the page and try again."; throw e;
  }
  for (let attempt = 0; ; attempt++) {
    const { verified } = await fetchVerified(roomId);
    if (!isSigner(verified, device.pk)) throw await notSignerError(device, roomId, verified.roomName);
    const fields = build(verified);
    const { wire } = await signRosterEntry(device, { room: roomId, seq: verified.headSeq + 1, prev: verified.headHash, ...fields });
    try {
      return await send(wire, verified);
    } catch (e) {
      // the head moved (another approval landed first): re-read, re-sign, retry with the same human check (the
      // server accepts an unused check that already passed, FINDINGS F6). Small jitter so racing tabs spread out.
      if (e.code === "roster_conflict" && attempt < 4) { await new Promise((r) => setTimeout(r, 100 + Math.random() * 400)); continue; }
      throw e;
    }
  }
}

/** Sign a chain of entries after the head: the first at headSeq + 1 with prev headHash, each next one after the last. */
export async function signChain(device, { room, headSeq, headHash }, ops) {
  const wires = [];
  let prev = headHash;
  for (const [i, fields] of ops.entries()) {
    const { wire, bytes } = await signRosterEntry(device, { room, seq: headSeq + 1 + i, prev, ...fields });
    wires.push(wire); prev = await sha256Hex(bytes);
  }
  return wires;
}

/**
 * appendSigned for several entries sent in one request (approving several chats together): build(verified) → a list
 * of op fields, send(wires) → server response. The same checks and the same retry when the head moved.
 */
export async function appendSignedChain(roomId, device, build, send) {
  if (!device) {
    const e = new Error("no device"); e.userMessage = "This browser has no signing key yet. Reload the page and try again."; throw e;
  }
  for (let attempt = 0; ; attempt++) {
    const { verified } = await fetchVerified(roomId);
    if (!isSigner(verified, device.pk)) throw await notSignerError(device, roomId, verified.roomName);
    const wires = await signChain(device, { room: roomId, headSeq: verified.headSeq, headHash: verified.headHash }, build(verified));
    try {
      return await send(wires, verified);
    } catch (e) {
      if (e.code === "roster_conflict" && attempt < 4) { await new Promise((r) => setTimeout(r, 100 + Math.random() * 400)); continue; }
      throw e;
    }
  }
}

/**
 * This browser can't sign in roomId: (re)open its "New browser" request so the person's other browsers show it,
 * and say exactly where to approve it (SPEC §6.1 step 4). Never a generic error.
 */
export async function notSignerError(device, roomId, roomName) {
  let where = "your other browser";
  try {
    const d = await post(`/app/v1/devices/${device.id}/ask`);
    const p = (d.pending || []).find((x) => x.room_id === roomId);
    roomName = roomName || p?.room_name;
    if (p?.signer_labels?.length) where = [...new Set(p.signer_labels)].join(" or ");
  } catch { /* still say what to do */ }
  const e = new Error("not signer"); e.code = "not_signer"; e.fatal = true;
  e.userMessage = `This browser isn't approved for ${roomName ? `#${roomName}` : "this room"} yet. Approve it from ${where}: it's waiting under “What needs you” there.`;
  return e;
}
