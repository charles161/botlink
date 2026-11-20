// Rooms a chat asked for (room drafts), the app API of docs/protocol/room-drafts.md §3, for the fixture server:
// claim, confirm (code, human check, the room exactly as POST /app/v1/rooms makes it, the chat's member_add checked
// field for field), reject. Test hooks: POST /__mock/draft makes a draft as POST /api/v1/room-drafts would,
// POST /__mock/draft-edit changes one (a card that changes between show and confirm), GET /__mock/draft/<id> reads one.
import { timingSafeEqual } from "node:crypto";
import { CONFIRM_ACTION } from "../../public/assets/js/draft.js";

const OPEN_PER_PERSON = 3; // BOTLINK_DRAFT_OPEN_PER_PERSON
const WRONG_CODES = 5;
// POST /api/v1/room-drafts's checks on the room fields (server/internal/agentapi/room_drafts.go validate): a room name,
// and a purpose of at most 140 characters that is one line of visible text (wire.OneLineTextOK: no control, format or
// line/paragraph separator characters).
const ROOM_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
const NOT_ONE_LINE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const APPS = ["claude-code", "codex", "cursor", "other"];
const MEMBER_ADD_KEYS = ["account", "app", "at", "by", "ed", "member", "name", "op", "prev", "room", "seq", "v", "x"].join();

export function installDrafts({ route, E, getDb, uuid, now, later, code, rawPk, memberFp, accountByEmail, appendEntry, consumeHumanCheck, buildRoom, storeRoom, roomDetail, activity, origin }) {
  const NOT_FOUND = () => new E(404, "not_found", "Not found.");
  const drafts = () => getDb().drafts;
  const live = (d) => d && d.status === "open" && Date.parse(d.expires_at) > Date.now();
  const card = (d, acct) => ({
    id: d.id, room_name: d.room_name, room_purpose: d.room_purpose, name: d.name, job: d.job, app: d.app, app_name: d.app_name, machine: d.machine,
    folder: d.folder, turn: d.turn, member_id: d.member_id, ed25519_pk: d.ed25519_pk, x25519_pk: d.x25519_pk, expires_at: d.expires_at,
    name_taken: [...getDb().rooms.values()].some((r) => !r.deleted && r.owner === acct && r.name === d.room_name),
  });
  // the draft the caller holds, open and unexpired; anything else is the one not-found
  const held = (sess, id) => { const d = drafts().get(id); if (!live(d) || d.claimed_by !== sess.account_id) throw NOT_FOUND(); return d; };
  // case and one dash between the groups are ignored; compared in constant time
  const codeOk = (typed, want) => {
    const m = /^([A-Za-z0-9]{3})-?([A-Za-z0-9]{3})$/.exec(typeof typed === "string" ? typed : "");
    const a = Buffer.from(m ? (m[1] + m[2]).toUpperCase() : "------"), b = Buffer.from(want);
    return a.length === b.length && timingSafeEqual(a, b) && !!m;
  };

  route("POST", /^\/app\/v1\/room-drafts\/([0-9a-f-]{36})\/claim$/, ({ sess, m }) => {
    const d = drafts().get(m[1]);
    if (!live(d) || (d.claimed_by && d.claimed_by !== sess.account_id)) throw NOT_FOUND();
    if (!d.claimed_by) {
      const holding = [...drafts().values()].filter((x) => x.claimed_by === sess.account_id && live(x)).length;
      if (holding >= OPEN_PER_PERSON) throw new E(429, "too_many_drafts", "You hold too many drafts.", undefined, 60);
      d.claimed_by = sess.account_id;
    }
    return card(d, sess.account_id);
  });

  route("POST", /^\/app\/v1\/room-drafts\/([0-9a-f-]{36})\/confirm$/, ({ sess, m, body, res }) => {
    const d0 = drafts().get(m[1]);
    if (d0) d0.confirm_calls = (d0.confirm_calls || 0) + 1;
    // the body is exactly {code, human_check, room, roster_entry}, room exactly the body of POST /app/v1/rooms (DecodeStrict)
    if (Object.keys(body || {}).sort().join() !== "code,human_check,room,roster_entry" || Object.keys(body.room || {}).sort().join() !== "entries,genesis,id,name,purpose")
      throw new E(400, "bad_request", "The confirm body has other fields than the contract's.");
    if (typeof body.code !== "string" || !body.code.trim()) throw new E(400, "bad_request", "Type the code your chat shows."); // not a try: nothing counted
    // the same confirm again after it went through (a double click, a retry): the room it made
    if (d0 && d0.status === "confirmed" && d0.claimed_by === sess.account_id && d0.room_id === body.room.id) return roomDetail(getDb().rooms.get(d0.room_id), sess.account_id);
    const commit = consumeHumanCheck(sess, body.human_check, CONFIRM_ACTION, d0?.id); // checked before the code, used only when all of it holds (step 3)
    const d = held(sess, m[1]);                                                   // 1
    if (!codeOk(body.code, d.match_code)) {                                       // 2
      d.wrong_codes += 1;
      if (d.wrong_codes >= WRONG_CODES) d.status = "closed";
      throw new E(403, "code_mismatch", "That code doesn't match.", { left: Math.max(0, WRONG_CODES - d.wrong_codes) });
    }
    const { room, existing } = buildRoom(sess, body.room);                        // 4
    if (existing) throw new E(409, "id_conflict", "Id in use.");
    const bytes = Buffer.from(body.roster_entry?.entry || "", "base64url");     // 5
    let entry = null; try { entry = JSON.parse(bytes.toString("utf8")); } catch { /* below */ }
    if (!entry || Object.keys(entry).sort().join() !== MEMBER_ADD_KEYS) throw new E(400, "roster_invalid", "The chat's entry has other fields than a member_add.", { rule: "request_match" });
    if (body.roster_entry.seq !== room.entries.length) throw new E(400, "roster_invalid", "The chat's entry is not at the seq after the room's entries.", { rule: "request_match" });
    appendEntry(room, body.roster_entry, { op: "member_add", member: d.member_id, account: sess.account_id, name: d.name, app: d.app, ed: d.ed25519_pk, x: d.x25519_pk });
    storeRoom(sess, room);
    room.members.set(d.member_id, { id: d.member_id, name: d.name, app: d.app, app_name: d.app_name ?? null, job: d.job, folder: d.folder, turn: d.turn, account_id: sess.account_id, ed: d.ed25519_pk, x: d.x25519_pk, joined_at: now() });
    activity(room, { kind: "joined", from_name: d.name });
    commit();
    Object.assign(d, { status: "confirmed", room_id: room.id, member_add: entry, genesis: JSON.parse(Buffer.from(body.room.genesis.entry, "base64url").toString("utf8")), device_adds: body.room.entries.length }); // 6
    res.statusCode = 201;
    return roomDetail(room, sess.account_id);
  });

  route("POST", /^\/app\/v1\/room-drafts\/([0-9a-f-]{36})\/reject$/, ({ sess, m, res }) => {
    const d = held(sess, m[1]);
    d.status = "rejected";
    res.writeHead(204, { "Cache-Control": "no-store" }); res.end();
    return undefined;
  }, { raw: true });

  // ── test hooks ──
  // A draft as POST /api/v1/room-drafts makes it, refused (400) as the server refuses it. `unchecked: true` seeds a draft
  // the real server never makes (hostile text, a bad app): only for tests of how the page renders and refuses it.
  route("POST", /^\/__mock\/draft$/, ({ body }) => {
    if (!body.unchecked) {
      if (body.room_name !== undefined && !ROOM_NAME.test(body.room_name)) throw new E(400, "bad_request", "room_name must be ^[a-z0-9][a-z0-9-]{0,31}$.");
      if (body.room_purpose !== undefined && ([...body.room_purpose].length > 140 || NOT_ONE_LINE.test(body.room_purpose))) throw new E(400, "bad_request", "room_purpose must be one line of visible text: no line breaks, tabs, control characters, zero-width or direction-changing characters.");
      if (body.app !== undefined && !APPS.includes(body.app)) throw new E(400, "bad_request", "Unknown app.");
    }
    const ed = body.ed || rawPk(), x = body.x || rawPk();
    const d = { id: body.id || uuid(), status: "open", room_name: body.room_name ?? "acme", room_purpose: body.room_purpose ?? "Ship and grow Acme",
      name: body.name || "builder", job: body.job ?? "Sets up the new project.", app: body.app || "claude-code", app_name: body.app_name ?? null,
      machine: body.machine ?? "adams-macbook", folder: body.folder ?? "~/acme", turn: body.turn || "wake", member_id: body.member_id || uuid(),
      ed25519_pk: ed, x25519_pk: x, match_code: body.match_code || code(6), expires_at: later(body.expires_in_s ?? 900), claimed_by: null, wrong_codes: 0, confirm_calls: 0, created_at: now() };
    if (body.claimed_by_email) d.claimed_by = accountByEmail(body.claimed_by_email).id;
    drafts().set(d.id, d);
    return { id: d.id, match_code: d.match_code, member_id: d.member_id, fingerprint: memberFp(ed, x), confirm_url: `${origin}/create/${d.id}`, expires_at: d.expires_at };
  }, { open: true, nocsrf: true });
  route("POST", /^\/__mock\/draft-edit$/, ({ body }) => {
    const d = drafts().get(body.id); if (!d) throw NOT_FOUND();
    const { id, ...fields } = body; Object.assign(d, fields); return { ok: true };
  }, { open: true, nocsrf: true });
  route("GET", /^\/__mock\/draft\/([0-9a-f-]{36})$/, ({ m }) => {
    const d = drafts().get(m[1]); if (!d) throw NOT_FOUND();
    const { claimed_by, ...rest } = d;
    return { ...rest, claimed_by_email: claimed_by ? getDb().accounts.get(claimed_by).email : null };
  }, { open: true, nocsrf: true });
}
