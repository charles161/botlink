// Mock of how a join request ended (server: appapi/ended.go, GET /app/v1/needs-you ended_join_requests) for
// web/test/test_notify.py. Installed by mock-server.mjs.
// Test hook: POST /__mock/join-end {id, ended: withdrawn|replaced|closed|expired, in_s?}. "expired" moves the request's
// expiry to in_s from now (default 0) and tells the open pages once, as if they had known that expiry from the start:
// the server sends nothing when a request runs out, so the page has to notice by itself.
export function installNotify({ route, E, getDb, changed }) {
  const ranOut = (j) => j.status === "pending" && Date.parse(j.expires_at) <= Date.now();
  const ended = (acct) => [...getDb().joinRequests.values()]
    .filter((j) => j.for_account === acct && (j.status !== "pending" || ranOut(j)))
    .map((j) => ({ id: j.id, kind: j.kind, room_id: j.room_id, room_name: j.room_name, name: j.name,
      ended: j.ended || (j.status === "pending" ? "expired" : j.status), ended_at: j.ended_at || j.expires_at }));
  route("POST", /^\/__mock\/join-end$/, ({ body }) => {
    const j = getDb().joinRequests.get(body.id);
    if (!j) throw new E(404, "not_found", "No request.");
    if (body.ended === "expired") { j.expires_at = new Date(Date.now() + (body.in_s || 0) * 1000).toISOString(); changed(); return { ok: true }; }
    j.status = "cancelled"; j.ended = body.ended; j.ended_at = new Date().toISOString(); changed();
    return { ok: true };
  }, { open: true, nocsrf: true });
  return { ended };
}
