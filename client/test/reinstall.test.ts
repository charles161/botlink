/**
 * Install hygiene (blocker 9, audit LANE2A rows 4 and 11): a clean reinstall keeps the member keys and memberships,
 * and app configs never stay pinned to one version's folder (only the stable `current` shim survives updates).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import * as st from "../src/state.js";
import * as core from "../src/core.js";
import * as upd from "../src/update.js";
import { up, uninstallAll, staleCliPaths } from "../src/setup.js";
import { FakeServer } from "./fake-server.js";
import { assertIsolated, newHome, on, startFake } from "./helpers.js";

let f: FakeServer;
before(async () => {
  assertIsolated();
  f = await startFake();
});
after(async () => f.stop());

test("a clean reinstall (uninstall, delete the installed client, set up again) keeps the keys and the membership", async () => {
  const adam = await f.account("Adam");
  const room = await f.room(adam, `keep${Math.floor(Math.random() * 1e6)}`, "keys survive a reinstall");
  const inv = `http://localhost:8811/i/${f.invite(room, adam)}`;
  const home = newHome("reinstall");
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude.json"), "{}\n");
  await on(home, async () => {
    const r = await core.joinCreate({ invite: inv, name: "keeper", job: "keeps its keys", app: "claude-code", turn: "on_turn", session: "11111111-aaaa-4bbb-8ccc-0000000000aa", cwd: home, folder: "~", machine: "test-box" });
    f.approve(r.req.id);
    const w = await core.joinWait({ maxMs: 5000 });
    assert.equal(w.status, "approved");
    const m = st.liveMembers()[0];
    const keyFile = join(home, ".botlink", "keys", `${m.key_id}.json`);
    const keyBefore = readFileSync(keyFile, "utf-8");
    assert.ok(up({ apps: ["claude-code"], watch: false, dev: true }).ok);
    // the reinstall
    const u = uninstallAll();
    assert.ok(u.ok, u.lines.join("\n"));
    assert.match(u.lines.join("\n"), /memberships and keys stay in ~\/\.botlink/);
    rmSync(upd.clientDir(), { recursive: true, force: true });
    assert.ok(up({ apps: ["claude-code"], watch: false, dev: true }).ok);
    // same member, same key file, and it still signs for the room
    assert.equal(st.liveMembers().length, 1);
    assert.equal(st.liveMembers()[0].id, m.id);
    assert.equal(readFileSync(keyFile, "utf-8"), keyBefore);
    const v = await core.refreshRoster(st.loadMember(m.id)!);
    assert.ok(v.display.get(m.id), "the server still knows this member's key");
  });
});

test("an app config that names one version's folder is stale (rewritten to the shim), the shim itself is not", async () => {
  const home = newHome("pinned");
  await on(home, async () => {
    const shim = upd.shimCli();
    const versioned = join(upd.clientDir(), "1.0.0-dev-0123456789ab", "dist", "cli.js");
    assert.deepEqual(staleCliPaths(JSON.stringify({ args: [versioned, "mcp"] })), [versioned], "a version folder is pinned: an update never reaches it");
    assert.deepEqual(staleCliPaths(JSON.stringify({ args: [shim, "mcp"] })), []);
    assert.deepEqual(staleCliPaths(JSON.stringify({ args: [join(upd.clientDir(), ".tmp-1-abcd", "dist", "cli.js")] })), [join(upd.clientDir(), ".tmp-1-abcd", "dist", "cli.js")]);
  });
});
