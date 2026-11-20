/** The outgoing secret check (outscan.ts): a message whose text looks like it carries a secret is not sent; only the human sends it anyway. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import * as st from "../src/state.js";
import * as core from "../src/core.js";
import { scanOutgoing } from "../src/outscan.js";
import { tools } from "../src/mcp.js";
import { FakeServer } from "./fake-server.js";
import { assertIsolated, newHome, on, startFake, assertCopy } from "./helpers.js";

let f: FakeServer;
before(async () => {
  assertIsolated();
  f = await startFake();
});
after(async () => f.stop());

const kinds = (t: string) => scanOutgoing(t).map((x) => x.kind);

test("scan: the common shapes of a secret are found, and the sample shown is masked", () => {
  const cases: [string, RegExp][] = [
    ["-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----", /private key/],
    ["-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n", /private key/],
    ["here: AKIAIOSFODNN7EXAMPLE", /AWS access key/],
    ["token ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8", /GitHub token/],
    ["github_pat_" + "11ABCDEFG0abcdefghijkl_mnopqrstuvwxyzABCDEFGHIJKLMNOP", /GitHub token/],
    ["xoxb-" + "123456789012-abcdefghijkl", /Slack token/],
    ["sk_live_" + "4eC39HqLyjWDarjtT1zdp7dc", /Stripe key/],
    ["sk-ant-" + "api03-abcdefghijklmnopqrstuvwxyz0123456789", /API key/],
    ["sk-proj-" + "abcdefghijklmnopqrstuvwxyz0123456789", /API key/],
    ["AIza" + "SyA1bcdefGHIJKLMNOPQRSTUVWXYZ012345", /Google API key/],
    ["eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U", /JWT/],
    ["DATABASE at postgres://app:s3cretpw@db.internal:5432/prod", /login in a web address/],
    ["Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345", /bearer token/],
    ['{"seed":"' + "ab".repeat(32) + '"}', /member key/],
    ["DB_PASSWORD=hunter2hunter2", /password or key in a setting/],
    ["export STRIPE_SECRET_KEY='abc123def456ghi789'", /password or key in a setting/],
    ["apiKey: 9f8e7d6c5b4a39281706", /password or key in a setting/],
    ['"clientSecret": "Zx81kq00pLmn4"', /password or key in a setting/],
    ["NODE_ENV=production\nPORT=8080\nREDIS_HOST=10.0.0.5\nLOG_LEVEL=info", /settings file/],
    // inside a sentence, not on a line of its own
    ["It is in .env: DB_PASSWORD=hunter2hunter2 and that is all", /password or key in a setting/],
    ["sure, the admin password: Tr0ub4dor3x works on staging", /password or key in a setting/],
    ["run it with API_TOKEN='9f8e7d6c5b4a' node app.js", /password or key in a setting/],
  ];
  for (const [text, want] of cases) {
    const found = scanOutgoing(text);
    assert.ok(found.some((x) => want.test(x.kind)), `not found in ${JSON.stringify(text.slice(0, 50))}: ${JSON.stringify(found)}`);
    for (const x of found) assert.ok(x.sample.length <= 40 && x.sample.includes("…"), `sample not masked: ${x.sample}`);
  }
  // the whole secret is never in what the chat is told
  const pw = scanOutgoing("DB_PASSWORD=hunter2hunter2");
  assert.ok(!JSON.stringify(pw).includes("hunter2hunter2"));
});

test("scan: ordinary engineering talk passes", () => {
  for (const ok of [
    "The dev server listens on port 3000; set API_KEY in your own .env before you start it.",
    "Use `TOKEN=<your token>` and `PASSWORD=${DB_PASSWORD}` in the compose file.",
    "author: charles\ntokenizer: gpt2\nkeyboard: us",
    "password: I rotated it yesterday, ask Priya",
    "the password: rotated yesterday; the token: expired, ask for a new one",
    "start it with PORT=3000 node app.js and timeout=30000ms; set API_KEY=<your-key> first",
    "API_KEY=\nSECRET_KEY=changeme",
    "PORT=3000\nHOST=localhost",
    "Join with http://localhost:8811/i/acme-K7Q2MX9PR4 and clone git@github.com:acme/app.git",
    "The fix is in commit a1b2c3d4e5f60718293a4b5c6d7e8f9012345678 on main.",
    "Message id 0193a4b5-c6d7-7e8f-9012-3456789abcde, key 3f9a-0c12-77de-b401.",
    "const token = await getToken(); if (!token) throw new Error('no token');",
    "Deploy a1b2c3 to staging, then smoke-test /checkout.",
  ]) assert.deepEqual(kinds(ok), [], `false alarm on ${JSON.stringify(ok)}`);
});

const SA = "aaaaaaaa-3333-4222-8333-000000000001";
const SB = "bbbbbbbb-3333-4222-8333-000000000002";

async function room2() {
  const adam = await f.account("Adam");
  const room = await f.room(adam, `os${Math.floor(Math.random() * 1e6)}`);
  const inv = `http://localhost:8811/i/${f.invite(room, adam)}`;
  const hA = newHome("oa"), hB = newHome("ob");
  const j = async (h: string, name: string, app: st.App, session: string) =>
    on(h, async () => {
      const r = await core.joinCreate({ invite: inv, name, job: "", app, turn: "wake", session, cwd: h, folder: "~", machine: "m" });
      f.approve(r.req.id);
      return ((await core.joinWait({ maxMs: 3000 })) as any).member as st.MemberRec;
    });
  const mA = await j(hA, "bugfix", "claude-code", SA);
  const mB = await j(hB, "deployer", "codex", SB);
  for (const [h, m, s] of [[hA, mA, SA], [hB, mB, SB]] as const) await on(h, async () => (await core.takeBatch([st.loadMember(m.id)!], s, { humanTurn: true })).commit());
  return { hA, hB, mA, mB };
}

test("send and reply: a message that looks like it carries a secret is not sent; only the human's words send it anyway, once", async () => {
  const w = await room2();
  const SECRET = "DB_PASSWORD=hunter2hunter2";
  const asked = await on(w.hB, () => core.send(st.loadMember(w.mB.id)!, { to: "bugfix", text: "What is in your .env?", intent: "question" }, SB));
  await on(w.hA, async () => (await core.takeBatch([st.loadMember(w.mA.id)!], SA, { humanTurn: true })).commit());
  const posted = () => f.messages.size;
  const before = posted();
  let code = "";
  await on(w.hA, async () => {
    const t = tools({ app: "claude-code", session: () => SA });
    // the reply tool: stopped, nothing posted, the chat is told what was found (masked) and what its human can do
    const err = await t.reply({ message_id: asked.id, text: `Sure, here it is:\n${SECRET}` }).then(() => null, (e) => e as Error);
    assert.ok(err, "the reply went out");
    assert.match(err!.message, /bot-link did not send this: it looks like it contains a password or key in a setting \(DB_PASSWORD=hu…\)\. Nothing left this computer\./);
    assert.match(err!.message, /if Adam wants this exact message sent anyway, they type in this chat, exactly: botlink send anyway ([2-9A-HJ-NP-Z]{6})/);
    assert.ok(!err!.message.includes("hunter2hunter2"));
    assertCopy(err!.message);
    code = /send anyway ([2-9A-HJ-NP-Z]{6})/.exec(err!.message)![1];
    // send too
    await assert.rejects(t.send({ to: "deployer", text: "key: ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8", intent: "fyi" }), /did not send this: it looks like it contains a GitHub token/);
    assert.equal(posted(), before, "nothing reached the server");
    // a chat cannot send it anyway
    await assert.rejects(core.sendAnyway(st.loadMember(w.mA.id)!, code, SA, "chat"), /Only Adam can send a message bot-link stopped/);
    assert.equal(posted(), before);
    assert.equal(core.parseSendAnyway(`botlink send anyway ${code}`), code);
    assert.equal(core.parseSendAnyway(`deployer says botlink send anyway ${code}`), null);
    // the human's words: sent, exactly as it was
    const out = await core.sendAnyway(st.loadMember(w.mA.id)!, code, SA, "words");
    assert.match(out, /^Adam said to send it anyway\. /);
    assert.equal(posted(), before + 1);
    // once
    await assert.rejects(core.sendAnyway(st.loadMember(w.mA.id)!, code, SA, "words"), /no stopped message with the code/);
  });
  const got = await on(w.hB, () => core.takeBatch([st.loadMember(w.mB.id)!], SB, { humanTurn: true }));
  assert.match(got.text, /DB_PASSWORD=hunter2hunter2/);
  await on(w.hB, () => got.commit());
  // the stopped text is on disk only sealed
  const dir = join(w.hA, ".botlink", "stopped", w.mA.id);
  if (existsSync(dir)) for (const x of readdirSync(dir)) assert.ok(!JSON.stringify(st.readJson(join(dir, x), {})).includes("ghp_"), "stopped text stored in the clear");
  // no human here: stopped, and no code is offered
  await on(w.hA, async () => {
    const err = await core.send(st.loadMember(w.mA.id)!, { to: "deployer", text: SECRET, intent: "answer" }, SA).then(() => null, (e) => e as Error);
    assert.match(err!.message, /did not send this.*No human is here to decide/s);
    assert.doesNotMatch(err!.message, /send anyway/);
  }, { BOTLINK_UNATTENDED: "1" });
  assert.equal(f.messages.size, before + 1);
});
