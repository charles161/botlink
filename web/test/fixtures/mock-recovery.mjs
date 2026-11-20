// Mock of the lost-passkey API (server: appapi/recovery.go, devremove.go) for web/test/test_recovery.py. Installed by
// mock-server.mjs. In memory, same rules as the server where the dashboard can tell: a reset needs a passkey on the
// account and a sign-in from the last 10 minutes, waits (72 h here), shows on every session, is cancelled by a passkey
// or by a session signed in before it, is finished only by the BROWSER that asked (its bl_reset cookie) from a fresh
// sign-in; removing a browser signs the other sessions out (or this one), drops the key from the rooms whose
// device_remove entries came with it, and removes the passkeys named (never the last; the mock's stub check has no
// "passkey that answered"). Passkeys remember the browser a sign-in declared (POST /app/v1/me/browser).
// Browser labels need proof (a challenge signed with the browser's key). Removing a browser wants keep or remove for
// every passkey with no proved place, and freeze_ok when an owned room would have no browser of its owner left.
// Test hooks: POST /__mock/recovery {email, stale?, ready?, off?}; POST /__mock/passkey-here {unknown?} (a passkey made
// in the calling page's browser, or of unknown place).
const DELAY_S = 72 * 3600, MAX_AGE_S = 600;

export function installRecovery({ route, E, getDb, uuid, now, changed, appendEntry, consumeHumanCheck, newHumanCheck, syncDeviceAttention, devicePublic, accountByEmail, edOk }) {
  const R = () => (getDb().recovery ||= { resets: [], events: [] });
  const open = (acct) => R().resets.find((r) => r.account === acct && !r.cancelled && !r.completed);
  const fresh = (sess) => !sess.created_at || Date.now() - sess.created_at <= MAX_AGE_S * 1000;
  const keys = (acct) => (R().keys ||= []).filter((k) => k.account === acct);
  const passkeys = (acct) => [...getDb().creds.values()].filter((c) => c.account === acct).length + keys(acct).length;
  const had = (acct) => passkeys(acct) > 0 || !!getDb().accounts.get(acct).had_passkey;
  const resetCookie = (req) => (req.headers.cookie || "").split(/;\s*/).map((c) => c.split("=")).find(([k]) => k === "bl_reset")?.[1] || "";
  const enabled = () => !R().off;
  const label = (id) => (id && getDb().devices.get(id)?.label) || null;
  const event = (acct, kind, data = {}) => R().events.unshift({ account: acct, kind, at: now(), data });
  const state = (sess, req) => {
    const r = open(sess.account_id);
    const here = !!r && !!r.browser && r.browser === resetCookie(req);
    return {
      reset: r ? { id: r.id, created_at: new Date(r.created_at).toISOString(), ready_at: new Date(r.ready_at).toISOString(), ready: r.ready_at <= Date.now(),
        started_here: here, cancel_needs_passkey: !here && (sess.created_at || 0) > r.created_at, user_agent: r.user_agent } : null,
      passkeys: passkeys(sess.account_id), had_passkey: had(sess.account_id), reset_enabled: enabled(), delete_hold_s: 7 * 86400, delay_s: DELAY_S, signin_max_age_s: MAX_AGE_S,
      signed_in_at: new Date(sess.created_at || Date.now()).toISOString(), signin_fresh: fresh(sess),
      events: R().events.filter((e) => e.account === sess.account_id).slice(0, 10).map(({ kind, at, data }) => ({ kind, at, data })),
      first_passkey_undo: getDb().accounts.get(sess.account_id).first_passkey_undo || null,
    };
  };
  const finishable = (sess, req) => {
    if (!enabled()) throw new E(409, "reset_off", "Passkey resets are turned off on this server.");
    const r = open(sess.account_id);
    if (!r) throw new E(404, "not_found", "No passkey reset is waiting.");
    if (!r.browser || r.browser !== resetCookie(req)) throw new E(403, "forbidden", "Finish the reset in the browser that asked for it.");
    if (r.ready_at > Date.now()) throw new E(409, "reset_not_ready", "The waiting time isn't over yet.");
    if (!fresh(sess)) throw new E(403, "reauth_required", "Sign in again first. This needs a sign-in from the last few minutes.");
    return r;
  };
  const endOthers = (acct, token) => { for (const [t, s] of getDb().sessions) if (s.account_id === acct && t !== token) getDb().sessions.delete(t); };

  route("GET", /^\/app\/v1\/me\/passkey-reset$/, ({ sess, req }) => state(sess, req));
  route("POST", /^\/app\/v1\/me\/browser\/challenge$/, ({ sess }) => {
    const id = uuid(), challenge = Buffer.from(uuid().replace(/-/g, "") + uuid().replace(/-/g, ""), "hex"); // 32 bytes
    (sess.proofs ||= new Map()).set(id, { challenge, expires: Date.now() + 300e3 });
    return { id, challenge: challenge.toString("base64url"), expires_at: new Date(Date.now() + 300e3).toISOString() };
  });
  route("POST", /^\/app\/v1\/me\/browser$/, ({ sess, body }) => {
    const pr = sess.proofs?.get(body.proof_id);
    sess.proofs?.delete(body.proof_id);
    const d = getDb().devices.get(body.device_id);
    const msg = pr && Buffer.concat([Buffer.from("botlink-browser-proof-v1\n"), pr.challenge, Buffer.from(String(body.device_id))]);
    if (!pr || pr.expires < Date.now() || !d || d.account_id !== sess.account_id || d.revoked_at || !edOk(d.ed25519_pk, String(body.sig || ""), msg))
      throw new E(403, "proof_failed", "This browser couldn't prove which browser it is.");
    sess.device_id = d.id;
    return { ok: true };
  });
  route("GET", /^\/app\/v1\/me\/passkeys$/, ({ sess }) => ({ passkeys: keys(sess.account_id).map((k) => ({ id: k.id, transports: [], created_at: k.created_at, last_used_at: null,
    created_device_id: k.created_device_id, created_device_label: label(k.created_device_id), last_used_device_id: null, last_used_device_label: null })) }));
  route("POST", /^\/app\/v1\/me\/passkey-reset$/, ({ sess, token, req, res }) => {
    if (!enabled()) throw new E(409, "reset_off", "Passkey resets are turned off on this server.");
    if (!had(sess.account_id)) throw new E(409, "no_passkey", "You have no passkey to reset. Your next approval sets one up.");
    if (!fresh(sess)) throw new E(403, "reauth_required", "Sign in again first. This needs a sign-in from the last few minutes.");
    if (open(sess.account_id)) throw new E(409, "reset_pending", "A passkey reset is already waiting for this account.");
    const t = Date.now(), browser = uuid();
    R().resets.push({ id: uuid(), account: sess.account_id, token, browser, user_agent: req.headers["user-agent"] || "", created_at: t, ready_at: t + DELAY_S * 1000 });
    event(sess.account_id, "passkey_reset_started");
    res.statusCode = 201; changed();
    res.setHeader("Set-Cookie", `bl_reset=${browser}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${DELAY_S + 30 * 86400}`);
    req.headers.cookie = `${req.headers.cookie || ""}; bl_reset=${browser}`;
    return state(sess, req);
  });
  route("POST", /^\/app\/v1\/me\/passkey-reset\/check$/, ({ sess, req, body }) => {
    if (body.action === "cancel") { if (!open(sess.account_id)) throw new E(404, "not_found", "No passkey reset is waiting."); return newHumanCheck(sess, "passkey_reset_cancel", null); }
    if (body.action === "finish") { finishable(sess, req); return newHumanCheck(sess, "passkey_reset_finish", null); }
    throw new E(400, "bad_request", "action must be cancel or finish.");
  });
  route("POST", /^\/app\/v1\/me\/passkey-reset\/cancel$/, ({ sess, req, body }) => {
    const r = open(sess.account_id);
    if (!r) throw new E(404, "not_found", "No passkey reset is waiting.");
    let by = "session";
    if (body?.human_check) { consumeHumanCheck(sess, body.human_check, "passkey_reset_cancel", null)(); by = "passkey"; }
    else if (r.browser !== resetCookie(req) && (sess.created_at || 0) > r.created_at) throw new E(403, "forbidden", "This browser signed in after the reset was asked. Cancel it with one of your passkeys, or from a browser that was signed in before.");
    r.cancelled = now();
    event(sess.account_id, "passkey_reset_cancelled", { by });
    changed();
    return state(sess, req);
  });
  route("POST", /^\/app\/v1\/me\/passkey-reset\/finish$/, ({ sess, token, req, res, body }) => {
    const r = finishable(sess, req);
    consumeHumanCheck(sess, body.human_check, "passkey_reset_finish", null)();
    const db = getDb();
    for (const [id, c] of db.creds) if (c.account === sess.account_id) db.creds.delete(id);
    const id = `mock-${uuid()}`;
    db.creds.set(id, { id, account: sess.account_id });
    R().keys = keys(sess.account_id).length ? R().keys.filter((k) => k.account !== sess.account_id) : R().keys;
    db.accounts.get(sess.account_id).had_passkey = true;
    res.setHeader("Set-Cookie", "bl_reset=; Path=/; Max-Age=0");
    endOthers(sess.account_id, token);
    r.completed = now();
    event(sess.account_id, "passkey_reset_completed");
    changed();
    return { passkeys: [{ id, transports: [], created_at: now(), last_used_at: null }] };
  });
  route("POST", /^\/app\/v1\/devices\/([0-9a-f-]+)\/remove$/, ({ sess, token, m, body, res }) => {
    const db = getDb();
    const d = db.devices.get(m[1]);
    if (!d || d.account_id !== sess.account_id) throw new E(404, "not_found", "Not found.");
    const commit = consumeHumanCheck(sess, body.human_check, "device_remove", d.id);
    const drop = body.passkey_ids || [], keep = body.keep_ids || [];
    const mineKeys = keys(sess.account_id);
    if ([...drop, ...keep].some((id) => !mineKeys.some((k) => k.id === id))) throw new E(404, "not_found", "Not found.");
    if (mineKeys.some((k) => !k.created_device_id && !drop.includes(k.id) && !keep.includes(k.id))) throw new E(400, "passkeys_unchosen", "bot-link can't tell where some of your passkeys live. Choose keep or remove for each.");
    if (drop.length && passkeys(sess.account_id) - drop.length < 1) throw new E(409, "last_passkey", "This would remove your last passkey. Keep one.");
    if (!d.revoked_at && !body.freeze_ok) {
      const frozen = [...db.rooms.values()].filter((r) => !r.deleted && r.owner === sess.account_id && r.signers.has(d.ed25519_pk)
        && ![...(r.people.get(sess.account_id)?.devices || [])].some((pk) => pk !== d.ed25519_pk && [...db.devices.values()].some((x) => x.ed25519_pk === pk && !x.revoked_at)));
      if (frozen.length) throw new E(409, "rooms_freeze", "This is your only browser that can change who is in some rooms you own. After removing it, nobody can. Confirm to go ahead.", { room_names: frozen.map((r) => r.name) });
    }
    for (const x of body.entries || []) {
      const room = db.rooms.get(x.room_id);
      if (!room || room.deleted || !room.people.has(sess.account_id)) throw new E(404, "not_found", "Not found.");
      appendEntry(room, x.roster_entry, { op: "device_remove", device: d.ed25519_pk, account: sess.account_id });
      room.signers.delete(d.ed25519_pk); room.people.get(sess.account_id).devices.delete(d.ed25519_pk);
    }
    commit();
    R().keys = R().keys.filter((k) => !drop.includes(k.id));
    d.revoked_at ||= now();
    if (body.this_browser) { db.sessions.delete(token); res.setHeader("Set-Cookie", "bl_session=; Path=/; Max-Age=0"); }
    else endOthers(sess.account_id, token);
    event(sess.account_id, "device_removed", { label: d.label });
    syncDeviceAttention(sess.account_id);
    changed();
    return { ...devicePublic(d), passkeys_removed: drop.length, answering_kept: false };
  });
  route("POST", /^\/__mock\/recovery$/, ({ body }) => {
    const a = accountByEmail(body.email);
    const db = getDb();
    if (body.off !== undefined) R().off = !!body.off;
    if (body.stale) for (const s of db.sessions.values()) if (s.account_id === a.id) s.created_at = Date.now() - 3600e3;
    if (body.ready) { const r = open(a.id); if (r) { r.created_at -= DELAY_S * 1000; r.ready_at = Date.now() - 1000; } }
    // a first passkey set up elsewhere after these sign-ins (account_guard.go): they may remove it for 72 h
    if (body.first_passkey) a.first_passkey_undo = { made_at: new Date(Date.now() - 600e3).toISOString(), until: new Date(Date.now() + (72 * 3600 - 600) * 1000).toISOString(),
      user_agent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36" };
    changed();
    return { ok: true };
  }, { open: true, nocsrf: true });
  route("POST", /^\/app\/v1\/me\/first-passkey\/remove$/, ({ sess, token }) => {
    const a = getDb().accounts.get(sess.account_id);
    if (!a.first_passkey_undo) throw new E(403, "forbidden", "Only a browser that was signed in before the account's first passkey was set up can remove it.");
    delete a.first_passkey_undo;
    endOthers(sess.account_id, token);
    event(sess.account_id, "first_passkey_removed", { passkeys_removed: 1, sign_ins_ended: 1 });
    changed();
    return { passkeys_removed: 1, sign_ins_ended: 1, resets_cancelled: 0 };
  });
  route("POST", /^\/__mock\/passkey-here$/, ({ sess, body }) => {
    const k = { id: `pk-${uuid()}`, account: sess.account_id, created_device_id: body?.unknown ? null : sess.device_id || null, created_at: now() };
    (R().keys ||= []).push(k);
    getDb().accounts.get(sess.account_id).had_passkey = true;
    return { id: k.id };
  }, { open: true, nocsrf: true });
}
