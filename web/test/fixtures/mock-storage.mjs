// Mock of the admin's stored-bytes list and its stop for an abusive account (server: adminapi/plans.go getStorage,
// postAccountSends; plans/storage.go). On in both paywall modes. Installed by mock-server.mjs. Stored bytes are made
// up from the account's rooms and chats (the mock keeps no message copies); a purge sets them to 0.
// Test hook: POST /__mock/storage {email, bytes} sets one account's stored bytes.
const MiB = 1 << 20;
const CEILING_MB = 8192, ACCOUNT_CEILING_MB = 64; // BOTLINK_STORAGE_TOTAL_MB, BOTLINK_STORAGE_CEILING_MB defaults
const WARN_PCT = 50, HIGH_PCT = 80;

export function installStorage({ route, E, adminGate, getDb, maskEmail, adminEmails }) {
  const S = () => (getDb().storage ||= { refused: new Set(), bytes: new Map() });
  function bytesOf(id) {
    if (S().bytes.has(id)) return S().bytes.get(id);
    let b = 0;
    for (const r of getDb().rooms.values()) {
      if (r.deleted || !r.people.has(id)) continue;
      b += Math.round(1.25 * MiB) * (1 + [...r.members.values()].filter((m) => m.account_id === id).length) + (r.owner === id ? MiB / 2 : 0);
    }
    return b;
  }
  const reason = (body) => {
    const r = typeof body?.reason === "string" ? body.reason.trim() : "";
    if (!r) throw new E(400, "bad_request", "Give a reason.");
    if ([...r].length > 300) throw new E(400, "bad_request", "Keep the reason under 300 characters.");
    return r;
  };
  const A = { open: true, nocsrf: true };

  route("GET", /^\/app\/v1\/admin\/storage$/, (c) => {
    adminGate(c, true);
    const own = getDb().accounts.get(c.sess.account_id).email;
    const rows = [...getDb().accounts.values()].filter((a) => !a.deleted).map((a) => ({ a, bytes: bytesOf(a.id) })).filter((x) => x.bytes > 0)
      .sort((x, y) => y.bytes - x.bytes || (x.a.id < y.a.id ? -1 : 1)).slice(0, 20);
    const total = [...getDb().accounts.values()].reduce((s, a) => s + bytesOf(a.id), 0);
    const ceiling = CEILING_MB * MiB, pct = Math.floor((total * 100) / ceiling);
    return { storage: { total_bytes: total, ceiling_bytes: ceiling, pct, level: pct >= HIGH_PCT ? "high" : pct >= WARN_PCT ? "warn" : "ok",
      account_ceiling_bytes: ACCOUNT_CEILING_MB * MiB,
      top: rows.map(({ a, bytes }) => ({ account_id: a.id, display_name: a.display_name, email: adminEmails.includes(a.email) || a.email === own ? a.email : maskEmail(a.email),
        bytes, sends_refused: S().refused.has(a.id) })) } };
  }, A);

  route("POST", /^\/app\/v1\/admin\/account\/sends$/, (c) => {
    adminGate(c, true);
    const b = c.body || {};
    reason(b);
    if (!b.account_id || !getDb().accounts.get(b.account_id)) throw new E(404, "not_found", "No account with that id.");
    if (b.refused) S().refused.add(b.account_id); else S().refused.delete(b.account_id);
    let freed = 0;
    if (b.purge) { freed = bytesOf(b.account_id); S().bytes.set(b.account_id, 0); }
    return { account_id: b.account_id, sends_refused: !!b.refused, freed_bytes: freed };
  }, A);

  route("POST", /^\/__mock\/storage$/, ({ body }) => {
    const a = [...getDb().accounts.values()].find((x) => x.email === body?.email);
    if (!a) throw new E(404, "not_found", "No account.");
    S().bytes.set(a.id, Number(body.bytes) || 0);
    return { ok: true };
  }, A);
}
