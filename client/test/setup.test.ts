/** `up` / join's install-if-missing / `uninstall` in a temp HOME: only bot-link's own span changes, with backups. */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { parse as parseToml } from "smol-toml";
import { up, uninstallAll, ensureInstalled, serviceInstalledFor, watchStatus, localInstallProblem, isLocalServer } from "../src/setup.js";
import * as h from "../src/harnesses.js";
import { assertIsolated, newHome, on } from "./helpers.js";

before(() => assertIsolated());

test("up: Claude Code, Codex and Cursor get the MCP entry + the SPEC §7.2 hooks; the user's own config is untouched", async () => {
  const home = newHome("up");
  // the user's existing config: another MCP server, their own hook, a comment in TOML
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ numStartups: 3, mcpServers: { other: { command: "x" } } }, null, 2));
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ theme: "dark", hooks: { Stop: [{ hooks: [{ type: "command", command: "say done" }] }] } }, null, 2));
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(join(home, ".codex", "config.toml"), `# my codex config\nmodel = "gpt-5"\n\n[mcp_servers.other]\ncommand = "x"\n`);
  mkdirSync(join(home, ".cursor"), { recursive: true });
  await on(home, async () => {
    const r = up({ apps: ["claude-code", "codex", "cursor"], watch: true });
    assert.ok(r.ok, r.lines.join("\n"));
    const cj = JSON.parse(readFileSync(join(home, ".claude.json"), "utf-8"));
    assert.equal(cj.numStartups, 3);
    assert.deepEqual(cj.mcpServers.other, { command: "x" });
    assert.deepEqual(cj.mcpServers.botlink.args.slice(-3), ["mcp", "--app", "claude-code"]);
    assert.equal(cj.mcpServers.botlink.type, "stdio");
    const cs = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf-8"));
    assert.equal(cs.theme, "dark");
    assert.equal(cs.hooks.Stop[0].hooks[0].command, "say done", "the user's own hook stays first and unchanged");
    const stop = cs.hooks.Stop.flatMap((g: any) => g.hooks).find((x: any) => / hook claude-code stop$/.test(x.command));
    assert.equal(stop.asyncRewake, true);
    assert.equal(stop.timeout, 3600);
    assert.ok(cs.hooks.SessionStart.flatMap((g: any) => g.hooks).some((x: any) => / hook claude-code session-start$/.test(x.command)));
    assert.ok(cs.hooks.UserPromptSubmit.flatMap((g: any) => g.hooks).some((x: any) => / hook claude-code prompt$/.test(x.command)));
    assert.equal(cs.hooks.PreToolUse, undefined, "no taint gate in v1");
    const toml = readFileSync(join(home, ".codex", "config.toml"), "utf-8");
    assert.ok(toml.startsWith("# my codex config\nmodel = \"gpt-5\"\n"), "comment and user lines kept byte for byte");
    const ct = parseToml(toml) as any;
    assert.deepEqual(ct.mcp_servers.botlink.args.slice(-3), ["mcp", "--app", "codex"]);
    const ch = JSON.parse(readFileSync(join(home, ".codex", "hooks.json"), "utf-8"));
    assert.deepEqual(Object.keys(ch.hooks).sort(), ["SessionStart", "Stop", "UserPromptSubmit"]);
    const cu = JSON.parse(readFileSync(join(home, ".cursor", "hooks.json"), "utf-8"));
    assert.deepEqual(Object.keys(cu.hooks).sort(), ["sessionStart", "stop"]);
    assert.ok(JSON.parse(readFileSync(join(home, ".cursor", "mcp.json"), "utf-8")).mcpServers.botlink);
    // backups + ledger exist before the first write
    assert.ok(readdirSync(join(home, ".botlink", "backups")).length > 0);
    // watch service written in this (test) home, not started
    assert.ok(serviceInstalledFor("claude-code"));
    assert.ok(!serviceInstalledFor("cursor"), "a Cursor process that doesn't know its chat can't be woken");
    process.env.CURSOR_CONVERSATION_ID = "c0c0c0c0-1111-4222-8333-00000000000a";
    try {
      assert.ok(serviceInstalledFor("cursor"), "inside a Cursor chat (CURSOR_CONVERSATION_ID): watch can resume it");
    } finally {
      delete process.env.CURSOR_CONVERSATION_ID;
    }
    assert.match(watchStatus()[0], /is installed/);
    // idempotent: a second run changes nothing
    const before = readFileSync(join(home, ".claude", "settings.json"), "utf-8");
    const r2 = up({ apps: ["claude-code", "codex", "cursor"], watch: true });
    assert.ok(r2.ok);
    assert.equal(readFileSync(join(home, ".claude", "settings.json"), "utf-8"), before);
    // uninstall: back to the user's own config
    const u = uninstallAll();
    assert.ok(u.ok, u.lines.join("\n"));
    const cj2 = JSON.parse(readFileSync(join(home, ".claude.json"), "utf-8"));
    assert.equal(cj2.mcpServers.botlink, undefined);
    assert.deepEqual(cj2.mcpServers.other, { command: "x" });
    const cs2 = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf-8"));
    assert.deepEqual(cs2.hooks, { Stop: [{ hooks: [{ type: "command", command: "say done" }] }] });
    assert.equal(readFileSync(join(home, ".codex", "config.toml"), "utf-8"), `# my codex config\nmodel = "gpt-5"\n\n[mcp_servers.other]\ncommand = "x"\n`);
    assert.ok(!serviceInstalledFor("claude-code"));
  });
});

test("a botlink-mcp (0.x) entry named botlink is not ours: kept, v1 installs as botlink-v1", async () => {
  const home = newHome("legacy");
  const legacy = { type: "stdio", command: "/usr/bin/node", args: ["/home/x/.botlink-mcp/app/dist/cli.js", "serve", "--cloud", "--app", "claude-code"] };
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { botlink: legacy } }, null, 2));
  await on(home, async () => {
    const r = ensureInstalled("claude-code");
    assert.ok(r.ok, r.lines.join("\n"));
    assert.match(r.lines.join("\n"), /set up Claude Code/);
    const cj = JSON.parse(readFileSync(join(home, ".claude.json"), "utf-8"));
    assert.deepEqual(cj.mcpServers.botlink, legacy);
    assert.deepEqual(cj.mcpServers["botlink-v1"].args.slice(-3), ["mcp", "--app", "claude-code"]);
    assert.deepEqual(ensureInstalled("claude-code").lines, [], "second time: already set up, nothing printed");
    assert.ok(h.configured("claude-code"));
  });
});

test("join on an app without bot-link installs it first (other apps untouched)", async () => {
  const home = newHome("join-install");
  await on(home, async () => {
    const r = ensureInstalled("codex");
    assert.ok(r.ok);
    assert.ok(existsSync(join(home, ".codex", "config.toml")));
    assert.ok(!existsSync(join(home, ".claude.json")));
    assert.deepEqual(ensureInstalled("other"), { lines: [], ok: true });
  });
});

// ---------------------------------------------------------------- Cursor CLI permission (headless MCP calls)
const CURSOR_CFG = `{
  "permissions": {
    "allow": [
      "Shell(ls)"
    ],
    "deny": []
  },
  "version": 1,
  "editor": {
    "vimMode": false
  },
  "approvalMode": "allowlist"
}
`;

const RULES = ["Mcp(botlink:send)", "Mcp(botlink:reply)", "Mcp(botlink:inbox)", "Mcp(botlink:roster)", "Mcp(botlink:ask_human)", "Mcp(botlink:handover)"];

test("Cursor: up adds bot-link's 6 unattended tools (Mcp(botlink:<tool>)) to cursor-agent's cli-config.json ($XDG_CONFIG_HOME/cursor) with a backup; uninstall takes exactly that out", async () => {
  const home = newHome("cursor-perm");
  const xdg = join(home, ".config");
  const cfg = join(xdg, "cursor", "cli-config.json");
  mkdirSync(join(xdg, "cursor"), { recursive: true });
  mkdirSync(join(home, ".cursor"), { recursive: true });
  writeFileSync(cfg, CURSOR_CFG);
  await on(home, async () => {
    assert.equal(h.cursorCliConfigPath(), cfg);
    const r = up({ apps: ["cursor"], watch: false });
    assert.ok(r.ok, r.lines.join("\n"));
    const j = JSON.parse(readFileSync(cfg, "utf-8"));
    assert.deepEqual(j.permissions.allow, ["Shell(ls)", ...RULES]);
    assert.ok(!j.permissions.allow.some((r: string) => /:(leave|claim|save_rule|join|\*)\)$/.test(r)), "leave/claim/save_rule/join still ask the human");
    assert.deepEqual(j.permissions.deny, []);
    assert.equal(j.approvalMode, "allowlist");
    assert.deepEqual(j.editor, { vimMode: false });
    // only that line was added (byte-minimal edit)
    assert.equal(readFileSync(cfg, "utf-8").replace(/,\n\s*"Mcp\(botlink:[a-z_]+\)"/g, ""), CURSOR_CFG);
    assert.ok(readdirSync(join(home, ".botlink", "backups"), { recursive: true }).some((f) => String(f).includes("cli-config.json")), "backup taken before the first write");
    // idempotent
    const before = readFileSync(cfg, "utf-8");
    assert.ok(up({ apps: ["cursor"], watch: false }).ok);
    assert.equal(readFileSync(cfg, "utf-8"), before);
    // cursor-agent rewrites its own config (here: a new key, re-indented); uninstall still cuts only our rule
    const app = JSON.parse(before);
    app.hints = true;
    writeFileSync(cfg, JSON.stringify(app, null, 4) + "\n");
    const u = h.uninstall("cursor");
    assert.ok(u.ok, u.notes.join("\n"));
    const after = JSON.parse(readFileSync(cfg, "utf-8"));
    assert.deepEqual(after.permissions.allow, ["Shell(ls)"]);
    assert.equal(after.hints, true, "the app's own change stays");
  }, { XDG_CONFIG_HOME: xdg, CURSOR_CONFIG_DIR: undefined });
});

test("Cursor: uninstall gives cli-config.json back byte for byte; a rule the user already had is never bot-link's", async () => {
  const home = newHome("cursor-perm2");
  const xdg = join(home, ".config");
  const cfg = join(xdg, "cursor", "cli-config.json");
  mkdirSync(join(xdg, "cursor"), { recursive: true });
  mkdirSync(join(home, ".cursor"), { recursive: true });
  writeFileSync(cfg, CURSOR_CFG);
  await on(home, async () => {
    assert.ok(up({ apps: ["cursor"], watch: false }).ok);
    assert.ok(h.uninstall("cursor").ok);
    assert.equal(readFileSync(cfg, "utf-8"), CURSOR_CFG);
    // the user's own identical rule: kept through up + uninstall
    const mine = CURSOR_CFG.replace(`"Shell(ls)"`, `"Shell(ls)",\n      "Mcp(botlink:inbox)"`);
    writeFileSync(cfg, mine);
    const r = up({ apps: ["cursor"], watch: false });
    assert.ok(r.ok, r.lines.join("\n"));
    const allow = JSON.parse(readFileSync(cfg, "utf-8")).permissions.allow;
    assert.deepEqual(allow, ["Shell(ls)", "Mcp(botlink:inbox)", ...RULES.filter((x) => x !== "Mcp(botlink:inbox)")], "only the missing rules are added");
    assert.ok(h.uninstall("cursor").ok);
    assert.equal(readFileSync(cfg, "utf-8"), mine, "the user's own rule stays");
  }, { XDG_CONFIG_HOME: xdg, CURSOR_CONFIG_DIR: undefined });
});

test("Cursor: no cli-config.json yet -> created with just the permission (CURSOR_CONFIG_DIR wins), deleted again by uninstall", async () => {
  const home = newHome("cursor-perm3");
  const dir = join(home, "cursor-cfg");
  mkdirSync(join(home, ".cursor"), { recursive: true });
  await on(home, async () => {
    assert.equal(h.cursorCliConfigPath(), join(dir, "cli-config.json"));
    assert.ok(up({ apps: ["cursor"], watch: false }).ok);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "cli-config.json"), "utf-8")), { permissions: { allow: RULES } });
    assert.ok(h.uninstall("cursor").ok);
    assert.ok(!existsSync(join(dir, "cli-config.json")));
  }, { CURSOR_CONFIG_DIR: dir });
});

// ---------------------------------------------------------------- FINDINGS F1: unattended Codex must be able to call bot-link's tools
test("F1: Codex entry approves bot-link's own tools (default_tools_approval_mode = \"approve\"); an older entry gets it on up; uninstall restores the bytes", async () => {
  const home = newHome("codex-approve");
  mkdirSync(join(home, ".codex"), { recursive: true });
  const original = `model = "gpt-5"\n`;
  writeFileSync(join(home, ".codex", "config.toml"), original);
  await on(home, async () => {
    assert.ok(up({ apps: ["codex"], watch: false }).ok);
    const t1 = readFileSync(join(home, ".codex", "config.toml"), "utf-8");
    assert.equal((parseToml(t1) as any).mcp_servers.botlink.default_tools_approval_mode, "approve");
    assert.ok(t1.startsWith(original), "the user's lines stay byte for byte");
    assert.ok(!h.checkHarness("codex").some((c: any) => !c.ok && /approve/.test(c.what)), "doctor is happy with the new entry");
    // an entry written by an older client (no approval mode) plus a user key inside our table
    const old = t1.replace(/default_tools_approval_mode = "approve"\n/, "startup_timeout_sec = 20\n");
    writeFileSync(join(home, ".codex", "config.toml"), old);
    assert.ok(h.checkHarness("codex").some((c: any) => !c.ok && /default_tools_approval_mode/.test(c.what)), "doctor flags the old entry");
    assert.ok(up({ apps: ["codex"], watch: false }).ok);
    const e = (parseToml(readFileSync(join(home, ".codex", "config.toml"), "utf-8")) as any).mcp_servers.botlink;
    assert.equal(e.default_tools_approval_mode, "approve");
    assert.equal(e.startup_timeout_sec, 20, "the user's own key in our table is kept");
    assert.ok(uninstallAll({ apps: ["codex"] }).ok);
    assert.equal(readFileSync(join(home, ".codex", "config.toml"), "utf-8"), original);
  });
});

// ---------------------------------------------------------------- FINDINGS F4: a local/test server never lands in a real config by accident
test("F4: with a local BOTLINK_SERVER, up / join's install refuse without --dev (nothing written); --dev or BOTLINK_DEV=1 allows it", async () => {
  const home = newHome("dev-guard");
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(join(home, ".codex", "config.toml"), `model = "gpt-5"\n`);
  await on(home, async () => {
    const r = up({ apps: ["codex"], watch: false });
    assert.equal(r.ok, false);
    assert.match(r.lines.join("\n"), /local server .*--dev/);
    assert.equal(readFileSync(join(home, ".codex", "config.toml"), "utf-8"), `model = "gpt-5"\n`, "nothing written");
    assert.ok(!existsSync(join(home, ".codex", "hooks.json")));
    const j = ensureInstalled("codex");
    assert.equal(j.ok, false);
    assert.match(j.lines[0], /--dev/);
    assert.ok(!h.configured("codex"));
    assert.ok(up({ apps: ["codex"], watch: false, dev: true }).ok, "--dev allows it");
    assert.ok(h.configured("codex"));
  }, { BOTLINK_DEV: undefined });
  await on(newHome("dev-guard-env"), async () => {
    assert.ok(up({ apps: ["codex"], watch: false }).ok, "BOTLINK_DEV=1 allows it");
  }, { BOTLINK_DEV: "1" });
  // a real (non-local) server needs no flag
  await on(newHome("dev-guard-remote"), async () => {
    assert.equal(localInstallProblem(["codex"]), null);
    assert.ok(isLocalServer("http://localhost:8811") && isLocalServer("http://127.0.0.5:1") && isLocalServer("http://[::1]:80"));
    assert.ok(!isLocalServer("https://api.botlink.dev"));
  }, { BOTLINK_DEV: undefined, BOTLINK_SERVER: "https://api.botlink.dev" });
});

test("F4: the CLI refuses `up` with a local server unless --dev (exit 1, config untouched)", async () => {
  const { spawnSync } = await import("node:child_process");
  const home = newHome("dev-guard-cli");
  mkdirSync(join(home, ".codex"), { recursive: true });
  const env = { ...process.env, HOME: home, BOTLINK_HOME: join(home, ".botlink") } as NodeJS.ProcessEnv;
  delete env.BOTLINK_DEV;
  const cli = join(import.meta.dirname, "..", "dist", "cli.js");
  const r = spawnSync(process.execPath, [cli, "up", "--app", "codex", "--no-watch"], { env, encoding: "utf-8" });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.ok(!existsSync(join(home, ".codex", "config.toml")));
  // r2 (SPEC §7.0): without --yes it is a preview (exit 2) and changes nothing
  const pv = spawnSync(process.execPath, [cli, "up", "--app", "codex", "--no-watch", "--no-shim", "--scope", "user", "--dev"], { env, encoding: "utf-8" });
  assert.equal(pv.status, 2, pv.stdout + pv.stderr);
  assert.match(pv.stdout, /Nothing was changed yet/);
  assert.ok(!existsSync(join(home, ".codex", "config.toml")));
  const r2 = spawnSync(process.execPath, [cli, "up", "--app", "codex", "--no-watch", "--no-shim", "--scope", "user", "--yes", "--dev"], { env, encoding: "utf-8" });
  assert.equal(r2.status, 0, r2.stdout + r2.stderr);
  assert.match(readFileSync(join(home, ".codex", "config.toml"), "utf-8"), /default_tools_approval_mode = "approve"/);
});
