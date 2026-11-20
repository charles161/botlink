// A message a member signed before it moved to a new chat (member_rekey) is still that member's message
// (ENVELOPE §4, check 1b; FINDINGS F1). Everything else signed with a key it no longer has is refused, as before.
import { test } from "node:test";
import assert from "node:assert/strict";

import * as c from "../src/crypto.js";
import { sealEnvelope, openEnvelope, EnvelopeError, PREV_KEY_GRACE_S, PREV_KEY_SKEW_S, type SealInput } from "../src/envelope.js";
import { verifyRoster, makeEntry, entryHash, type SignedEntry } from "../src/roster.js";

const T = 1_762_339_200; // the move was signed at this moment (unix seconds)
const bad = (x: unknown) => x instanceof EnvelopeError && x.reason === "bad_signature";

async function world() {
  await c.ready();
  const dev = c.genKeys(); // the person's browser key (signs the member list)
  const old = c.genKeys(), cur = c.genKeys(), reader = c.genKeys(), stranger = c.genKeys();
  const room = c.uuidv7(), acct = c.uuidv7(), coder = c.uuidv7(), asker = c.uuidv7();
  const entries: SignedEntry[] = [];
  const add = (fields: Record<string, unknown>, at: number) => {
    const head = entries[entries.length - 1];
    entries.push(makeEntry({ room, ...fields }, entries.length, head ? entryHash(head) : null, dev.ed, dev.ed_sk, at));
  };
  add({ op: "genesis", name: "acme", owner: acct, device: dev.ed }, T - 1000);
  add({ op: "member_add", member: coder, account: acct, name: "coder", app: "claude-code", ed: old.ed, x: old.x }, T - 900);
  add({ op: "member_add", member: asker, account: acct, name: "asker", app: "codex", ed: reader.ed, x: reader.x }, T - 800);
  add({ op: "member_rekey", member: coder, ed: cur.ed, x: cur.x }, T);
  const st = verifyRoster(room, entries);
  const seal = (k: typeof old, sentAt: number, over: Partial<SealInput> = {}) => sealEnvelope({
    id: c.uuidv7(), room, from: coder, fromFp: c.memberFingerprint(k.ed, k.x), to: asker, toFp: c.memberFingerprint(reader.ed, reader.x), toX: reader.x, scope: "member",
    inReplyTo: null, sentAt, expiresAt: sentAt + 7 * 86400, intent: "answer", text: "it is app.py", neededBy: null, resendOf: null, senderSeed: k.ed_sk, ...over,
  });
  const ctx = (now: number) => ({ me: asker, myFp: c.memberFingerprint(reader.ed, reader.x), xSk: reader.x_sk, room, now,
    senderEd: (id: string) => st.members.get(id)?.ed || null, senderPrev: (id: string) => st.members.get(id)?.prev_keys || [] });
  return { st, old, cur, stranger, coder, seal, ctx };
}

test("the signed member list keeps the key a member had before it moved, and until when", async () => {
  const { st, old, cur, coder } = await world();
  const m = st.members.get(coder)!;
  assert.equal(m.ed, cur.ed);
  assert.deepEqual(m.prev_keys, [{ ed: old.ed, fp: c.memberFingerprint(old.ed, old.x), until_seq: 3, until_at: T }]);
});

test("sent before the move, read after it: opens, and says which key it carries", async () => {
  const { old, cur, seal, ctx } = await world();
  const o = openEnvelope(seal(old, T - 60), ctx(T + 600));
  assert.equal(o.plain.text, "it is app.py");
  assert.deepEqual(o.earlierKey, { fp: c.memberFingerprint(old.ed, old.x), until_at: T });
  // the clocks of the sender and of the browser that signed the move may differ a little
  assert.equal(openEnvelope(seal(old, T + PREV_KEY_SKEW_S), ctx(T + 600)).plain.text, "it is app.py");
  // a message with the member's current key is as before, with no such mark
  assert.equal(openEnvelope(seal(cur, T + 60), ctx(T + 600)).earlierKey, undefined);
});

test("the earlier key speaks only for the time it was the member's key", async () => {
  const { old, cur, stranger, seal, ctx } = await world();
  // signed with the old key but dated after the move: someone holding the old key writes "as coder" now
  assert.throws(() => openEnvelope(seal(old, T + PREV_KEY_SKEW_S + 1), ctx(T + 600)), (x) => bad(x) && /gave up before this was sent/.test((x as Error).message));
  // dated before the move, but read after every message of that time has expired on the server (7 days)
  assert.throws(() => openEnvelope(seal(old, T - 60), ctx(T + PREV_KEY_GRACE_S + 1)), (x) => bad(x) && /too long ago/.test((x as Error).message));
  // signed with the old key while the header names the current one (or the other way round)
  assert.throws(() => openEnvelope(seal(old, T - 60, { fromFp: c.memberFingerprint(cur.ed, cur.x) }), ctx(T + 600)), bad);
  assert.throws(() => openEnvelope(seal(cur, T - 60, { fromFp: c.memberFingerprint(old.ed, old.x), senderSeed: stranger.ed_sk }), ctx(T + 600)), bad);
  // a key that was never the member's
  assert.throws(() => openEnvelope(seal(stranger, T - 60), ctx(T + 600)), bad);
});

test("a reader that is given no earlier keys refuses, as every client did before", async () => {
  const { old, seal, ctx } = await world();
  const { senderPrev: _drop, ...plain } = ctx(T + 600);
  assert.throws(() => openEnvelope(seal(old, T - 60), plain), bad);
});
