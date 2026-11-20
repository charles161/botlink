// Mock of Your account (server: appapi/account_data.go, store/account.go) so the mock tier can open /account:
// download my data, and delete my account. Installed by mock-server.mjs. In memory, same rules as the server where
// the dashboard can tell: the plan lists rooms owned and rooms joined (with can_sign for this browser), the delete
// needs the human check account_delete, the account's email as confirm, and this browser's signed person_remove for
// every room joined; it then leaves those rooms, deletes owned ones, ends every session and keeps a tombstone.
// Delete takes two steps like the server: ask (POST /me/delete/ask) starts a 72 h wait, any session cancels
// (POST /me/delete/cancel), the finish (POST /me/delete) works only once the wait is over and before it lapses.
// Test hook: POST /__mock/account-delete {email, ready?} (ready: the wait is over); {email, ask: true, first_passkey?,
// user_agent?} records an ask made from another browser (first_passkey: that ask set up the account's first passkey).
const DELAY_S = 72 * 3600, WINDOW_S = 7 * 86400;

export function installAccount({ route, E, getDb, appendEntry, consumeHumanCheck, changed, hcMode, paywall }) {
  const P = () => (getDb().pendingDeletes ||= new Map()); // account id → {asked_at, ready_at, lapses_at, session}
  const pendingOf = (sess, token) => {
    const d = P().get(sess.account_id);
    if (!d || d.lapses_at <= Date.now()) return null;
    const iso = (t) => new Date(t).toISOString();
    return { asked_at: iso(d.asked_at), ready_at: iso(d.ready_at), lapses_at: iso(d.lapses_at), ready: d.ready_at <= Date.now(),
      user_agent: d.user_agent || "", asked_here: !!token && d.session === token, first_passkey: !!d.first_passkey };
  };
  // WebAuthn creds, stand-ins set on the account, and passkeys the recovery mock made (/__mock/passkey-here)
  const passkeys = (acct) => [...getDb().creds.values()].filter((c) => c.account === acct).length + (getDb().accounts.get(acct).mock_passkeys || 0)
    + (getDb().recovery?.keys || []).filter((k) => k.account === acct).length;
  const myDevice = (acct, id) => { const d = id && getDb().devices.get(id); return d && d.account_id === acct ? d : null; };

  function plan(sess, deviceId, token) {
    const db = getDb(), acct = sess.account_id, d = myDevice(acct, deviceId);
    const rooms = [...db.rooms.values()].filter((r) => !r.deleted && r.people.has(acct));
    return {
      confirm_text: db.accounts.get(acct).email,
      owned_rooms: rooms.filter((r) => r.owner === acct).map((r) => ({ id: r.id, name: r.name, other_people: r.people.size - 1 })),
      joined_rooms: rooms.filter((r) => r.owner !== acct).map((r) => ({ id: r.id, name: r.name, owner_name: db.accounts.get(r.owner).display_name,
        other_people: r.people.size - 1, can_sign: !!d && r.people.get(acct).devices.has(d.ed25519_pk) })),
      chats: rooms.reduce((n, r) => n + [...r.members.values()].filter((m) => m.account_id === acct).length, 0),
      ...(paywall ? { plan_renews: false } : {}), passkeys: passkeys(acct), human_check_mode: hcMode,
      pending: pendingOf(sess, token), delay_s: DELAY_S, window_s: WINDOW_S, ask_hold_s: 86400, ask_paused_until: null,
    };
  }

  // Your browsers lists the passkeys when the check is real (devices.js); the mock's are its WebAuthn creds plus the
  // stand-ins a test sets with /__mock/recovery {passkeys}
  route("GET", /^\/app\/v1\/me\/passkeys$/, ({ sess }) => {
    const db = getDb(), acct = sess.account_id, at = new Date().toISOString();
    const real = [...db.creds.entries()].filter(([, c]) => c.account === acct).map(([id]) => ({ id, transports: [], created_at: at, last_used_at: null }));
    const stand = Array.from({ length: db.accounts.get(acct).mock_passkeys || 0 }, (_, i) => ({ id: `mock-passkey-${i + 1}`, transports: [], created_at: at, last_used_at: null }));
    return { passkeys: [...real, ...stand] };
  });

  route("GET", /^\/app\/v1\/me\/delete$/, ({ sess, url, token }) => plan(sess, url.searchParams.get("device_id"), token));

  route("POST", /^\/app\/v1\/me\/delete\/ask$/, ({ sess, body, req, token }) => {
    const a = getDb().accounts.get(sess.account_id);
    if (String(body?.confirm || "").trim().toLowerCase() !== a.email.toLowerCase()) throw new E(400, "bad_request", "Type your email address to confirm.");
    if (pendingOf(sess)) throw new E(409, "delete_pending", "A delete of this account is already waiting.");
    consumeHumanCheck(sess, body.human_check, "account_delete", null);
    const now = Date.now();
    P().set(sess.account_id, { asked_at: now, ready_at: now + DELAY_S * 1000, lapses_at: now + (DELAY_S + WINDOW_S) * 1000, session: token,
      user_agent: req?.headers?.["user-agent"] || "" });
    changed();
    return { pending: pendingOf(sess, token) };
  });
  route("POST", /^\/app\/v1\/me\/delete\/cancel$/, ({ sess }) => {
    if (!pendingOf(sess)) throw new E(404, "not_found", "No delete is waiting.");
    const first = !!P().get(sess.account_id).first_passkey;
    P().delete(sess.account_id);
    changed();
    return { pending: null, cancelled_by: "session", first_passkey_removed: first, ...(first ? { passkeys_removed: 1, sign_ins_ended: 1, resets_cancelled: 0 } : {}) };
  });
  route("POST", /^\/__mock\/account-delete$/, ({ body }) => {
    const a = [...getDb().accounts.values()].find((x) => x.email === body.email);
    if (a && body.ask) {
      const now = Date.now();
      P().set(a.id, { asked_at: now, ready_at: now + DELAY_S * 1000, lapses_at: now + (DELAY_S + WINDOW_S) * 1000, session: "elsewhere",
        user_agent: body.user_agent || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
        first_passkey: !!body.first_passkey });
    }
    const d = a && P().get(a.id);
    if (d && body.ready) { d.asked_at -= DELAY_S * 1000; d.ready_at = Date.now() - 1000; d.lapses_at = Date.now() + WINDOW_S * 1000; }
    changed();
    return { ok: !!d };
  }, { open: true, nocsrf: true });

  route("POST", /^\/app\/v1\/me\/delete$/, ({ sess, body }) => {
    const db = getDb(), acct = sess.account_id, a = db.accounts.get(acct);
    if (String(body?.confirm || "").trim().toLowerCase() !== a.email.toLowerCase()) throw new E(400, "bad_request", "Type your email address to confirm.");
    const pend = pendingOf(sess);
    if (!pend) throw new E(409, "delete_not_asked", "Ask to delete the account first. It can be finished after the wait.");
    if (!pend.ready) throw new E(409, "delete_not_ready", "The wait isn't over yet.");
    consumeHumanCheck(sess, body.human_check, "account_delete", null);
    const p = plan(sess, null);
    const entries = new Map((body.entries || []).map((x) => [x.room_id, x.roster_entry]));
    const missing = p.joined_rooms.filter((r) => !entries.has(r.id)).map((r) => r.id);
    if (missing.length) throw new E(409, "roster_conflict", "You were added to a room since this page loaded. Refresh and try again.", { room_ids: missing });
    let chats = 0;
    for (const r of p.joined_rooms) {
      const room = db.rooms.get(r.id);
      const e = appendEntry(room, entries.get(r.id));
      if (e.op !== "person_remove" || e.account !== acct) throw new E(400, "roster_invalid", "Each entry must be your own leave (person_remove of your account).");
      for (const [id, m] of room.members) if (m.account_id === acct) { room.members.delete(id); chats++; }
      for (const dv of room.people.get(acct).devices) room.signers.delete(dv);
      room.people.delete(acct);
    }
    for (const r of p.owned_rooms) {
      const room = db.rooms.get(r.id);
      for (const m of room.members.values()) if (m.account_id === acct) chats++;
      room.deleted = true;
    }
    for (const [t, s] of db.sessions) if (s.account_id === acct) db.sessions.delete(t);
    for (const [id, d] of db.devices) if (d.account_id === acct) db.devices.delete(id);
    for (const [id, c] of db.creds) if (c.account === acct) db.creds.delete(id);
    P().delete(acct);
    Object.assign(a, { email: `deleted-${acct}@deleted.invalid`, display_name: "Deleted account", deleted: true, mock_passkeys: 0 });
    changed();
    return { rooms_left: p.joined_rooms.length, rooms_deleted: p.owned_rooms.length, chats_removed: chats };
  });

  route("GET", /^\/app\/v1\/me\/export$/, ({ sess, res }) => {
    const db = getDb(), a = db.accounts.get(sess.account_id);
    const out = { exported_at: new Date().toISOString(), account: { id: a.id, email: a.email, display_name: a.display_name },
      rooms: [...db.rooms.values()].filter((r) => !r.deleted && r.people.has(a.id)).map((r) => ({ id: r.id, name: r.name, role: r.owner === a.id ? "owner" : "person" })),
      passkeys: passkeys(a.id) };
    res.writeHead(200, { "Content-Type": "application/json", "Content-Disposition": `attachment; filename="botlink-account-${a.id.slice(0, 8)}.json"`, "Cache-Control": "no-store" });
    res.end(JSON.stringify(out, null, 2));
    return undefined;
  });
}
