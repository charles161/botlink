// Approving several waiting chats of one room together, for the fixture server (the contract of the batch lane):
//   POST /app/v1/human-check {action: "approve_joins", target_id: <room id>, targets: [1..5 distinct join request ids]}:
//     targets(body) checks and returns the set the check is bound to (null for every other action).
//   POST /app/v1/rooms/{id}/join-requests/approve {human_check, items: [{id, roster_entry}]} (1..5, distinct): one
//     human check for exactly that room and that set, once; each roster_entry the member_add for its request, signed by
//     a device of the caller, at head+1 … head+n in the order of items, checked field for field. All or nothing.
//     200 {approved: [ids]}; 409 batch_changed {details.items: [{id, reason}]} (already_decided, expired, not_found:
//     someone else's or no such request), the check not used; 400 {details.id} for one of the caller's requests of
//     another room or a move (claim); 409 room_full / name_taken {details.id}; 400 for 0, more than 5 or repeated items
//     or an item without its roster_entry; 403 human_check_failed for a wrong, used or other-set check; 429
//     rate_limited (60 approvals an hour per account, a batch counts n and is refused as a whole) with retry_after_s.
//     The order of the server's checks (server/internal/appapi/approve_batch.go): body, human check (not used yet),
//     each request, the rate limit, then each entry in order (room_full, name_taken, the entry itself).
// Test hooks: POST /__mock/join-edit {id, ...fields} changes a join request (status too), GET /__mock/join/<id> reads
// one, POST /__mock/members-add {room_id, count, name?} seats placeholder chats, POST /__mock/person-request
// {room_id, email, name} makes a person request, POST /__mock/approvals-used {room_id, count} counts that many
// approvals this hour for the room's owner.
import { BATCH_ACTION, BATCH_MAX } from "../../public/assets/js/batch.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MEMBER_ADD_KEYS = ["account", "app", "at", "by", "ed", "member", "name", "op", "prev", "room", "seq", "v", "x"].join();
const ROOM_MAX = 20;
const APPROVALS_PER_HOUR = 60; // ratelimit.Approvals

export function installBatch({ route, E, getDb, uuid, now, rawPk, deviceFp, appendEntry, consumeHumanCheck, activity, membershipAttention, changed }) {
  const bad = (msg, details) => new E(400, "bad_request", msg, details);
  const approvals = new Map(); // account → times of approvals in the last hour
  const recent = (acct) => (approvals.get(acct) || []).filter((t) => t > Date.now() - 3600e3);
  const ids = (list) => {
    if (!Array.isArray(list) || list.length < 1 || list.length > BATCH_MAX) throw bad(`Between 1 and ${BATCH_MAX} requests.`);
    if (!list.every((x) => typeof x === "string" && UUID.test(x))) throw bad("Request ids are UUIDs.");
    if (new Set(list).size !== list.length) throw bad("A request is named twice.");
    return list;
  };

  /** The set a human check is bound to: the ticked ids for approve_joins (the room in target_id), null otherwise. */
  function targets(body) {
    if (body?.action !== BATCH_ACTION) {
      if (body?.targets !== undefined && body?.targets !== null) throw bad("targets is only for approve_joins.");
      return null;
    }
    if (!UUID.test(body.target_id || "")) throw bad("target_id is the room id.");
    return [...ids(body.targets)].sort();
  }

  route("POST", /^\/app\/v1\/rooms\/([0-9a-f-]{36})\/join-requests\/approve$/, ({ sess, m, body }) => {
    const db = getDb();
    if (Object.keys(body || {}).sort().join() !== "human_check,items") throw bad("The body is {human_check, items}.");
    const items = body.items;
    if (!Array.isArray(items) || !items.every((x) => x && typeof x === "object" && Object.keys(x).sort().join() === "id,roster_entry")) throw bad("Each item is {id, roster_entry}.");
    if (!items.every((x) => x.roster_entry?.entry && x.roster_entry?.sig && x.roster_entry?.signer)) throw bad("Each ticked chat needs its signed roster_entry.");
    const list = ids(items.map((x) => x.id));
    const r = db.rooms.get(m[1]);
    if (!r || r.deleted || !r.people.has(sess.account_id)) throw new E(404, "not_found", "Not found.");
    const commit = consumeHumanCheck(sess, body.human_check, BATCH_ACTION, r.id, [...list].sort());
    // every request still waits for this person in this room, or nothing happens and the check stays unused
    const reqs = list.map((id) => db.joinRequests.get(id));
    const changedItems = [];
    reqs.forEach((j, i) => {
      if (!j || j.for_account !== sess.account_id) changedItems.push({ id: list[i], reason: "not_found" });
      else if (j.room_id !== r.id) throw bad("Every ticked chat must be waiting to join this room.", { id: j.id });
      else if (j.kind !== "join") throw bad("A chat moving to another chat or computer is approved on its own.", { id: j.id });
      else if (j.status !== "pending") changedItems.push({ id: j.id, reason: "already_decided" });
      else if (Date.parse(j.expires_at) <= Date.now()) changedItems.push({ id: j.id, reason: "expired" });
    });
    if (changedItems.length) throw new E(409, "batch_changed", "Some requests changed. Nothing was approved.", { items: changedItems });
    const done = recent(sess.account_id);
    if (done.length + reqs.length > APPROVALS_PER_HOUR) throw new E(429, "rate_limited", "Too many approvals.", undefined, Math.max(1, Math.ceil((done[0] + 3600e3 - Date.now()) / 1000)));
    if (r.members.size + reqs.length > ROOM_MAX) throw new E(409, "room_full", "Room full.", { id: reqs[ROOM_MAX - r.members.size].id });
    const names = new Set([...r.members.values()].map((x) => x.name));
    for (const j of reqs) { if (names.has(j.name)) throw new E(409, "name_taken", "Name taken.", { id: j.id }); names.add(j.name); }
    const len = r.entries.length, head = r.headHash;
    try {
      items.forEach((it, i) => {
        const j = reqs[i];
        let e = null; try { e = JSON.parse(Buffer.from(it.roster_entry?.entry || "", "base64url").toString("utf8")); } catch { /* below */ }
        if (!e || Object.keys(e).sort().join() !== MEMBER_ADD_KEYS) throw new E(400, "roster_invalid", "An entry has other fields than a member_add.", { rule: "request_match", id: j.id });
        if (it.roster_entry.seq !== len + i) throw new E(400, "roster_invalid", "The entries are not at head+1 … head+n in the order of items.", { rule: "request_match", id: j.id });
        if (!r.people.get(sess.account_id).devices.has(it.roster_entry.signer)) throw new E(403, "not_signer", "Not one of your browsers in this room.");
        appendEntry(r, it.roster_entry, { op: "member_add", member: j.member_id, account: sess.account_id, name: j.name, app: j.app, ed: j.ed25519_pk, x: j.x25519_pk });
      });
    } catch (err) { r.entries.length = len; r.headHash = head; throw err; }
    for (const j of reqs) {
      r.members.set(j.member_id, { id: j.member_id, name: j.name, app: j.app, app_name: j.app_name ?? null, job: j.job, folder: j.folder, turn: j.turn_raw, account_id: sess.account_id, ed: j.ed25519_pk, x: j.x25519_pk, joined_at: now() });
      activity(r, { kind: "joined", from_name: j.name });
      membershipAttention(r, r.members.get(j.member_id), "member_joined", "joined", sess.account_id);
      j.status = "approved";
    }
    approvals.set(sess.account_id, [...done, ...reqs.map(() => Date.now())]);
    commit(); changed();
    return { approved: list };
  });

  // ── test hooks ──
  route("POST", /^\/__mock\/join-edit$/, ({ body }) => {
    const j = getDb().joinRequests.get(body.id); if (!j) throw new E(404, "not_found", "No request.");
    const { id, ...fields } = body; Object.assign(j, fields); changed(); return { ok: true };
  }, { open: true, nocsrf: true });
  route("GET", /^\/__mock\/join\/([0-9a-f-]{36})$/, ({ m }) => {
    const j = getDb().joinRequests.get(m[1]); if (!j) throw new E(404, "not_found", "No request.");
    return { id: j.id, status: j.status, room_id: j.room_id, name: j.name };
  }, { open: true, nocsrf: true });
  route("POST", /^\/__mock\/members-add$/, ({ body }) => {
    const r = getDb().rooms.get(body.room_id); if (!r) throw new E(404, "not_found", "No room.");
    for (let i = 0; i < (body.count || 1); i++) {
      const id = uuid();
      r.members.set(id, { id, name: body.count > 1 || !body.name ? `${body.name || "seat"}-${r.members.size + 1}` : body.name, app: "claude-code", job: "Holds a seat.", folder: "~/seat", turn: "on_turn", account_id: r.owner, ed: rawPk(), x: rawPk(), joined_at: now() });
    }
    changed(); return { ok: true, members: r.members.size };
  }, { open: true, nocsrf: true });
  route("POST", /^\/__mock\/approvals-used$/, ({ body }) => {
    const r = getDb().rooms.get(body.room_id); if (!r) throw new E(404, "not_found", "No room.");
    approvals.set(r.owner, Array.from({ length: body.count }, () => Date.now() - 600e3)); return { ok: true };
  }, { open: true, nocsrf: true });
  route("POST", /^\/__mock\/person-request$/, ({ body }) => {
    const db = getDb(); const r = db.rooms.get(body.room_id); if (!r) throw new E(404, "not_found", "No room.");
    const a = { id: uuid(), email: body.email, display_name: body.name || "Pat", avatar_url: null, provider: "dev" };
    db.accounts.set(a.id, a);
    const pk = rawPk();
    const pr = { id: uuid(), room_id: r.id, room_name: r.name, account_id: a.id, display_name: a.display_name, email: a.email, provider: a.provider, device_pk: pk, device_fingerprint: deviceFp(pk), status: "pending", created_at: now() };
    db.personRequests.set(pr.id, pr); changed(); return { id: pr.id };
  }, { open: true, nocsrf: true });

  return { targets };
}
