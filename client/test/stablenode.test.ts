// "Always the latest bot-link" (Charles 16 Nov 2026): app configs must not point at a node that an upgrade deletes.
// Homebrew runs node from /opt/homebrew/Cellar/node/<version>/bin/node; `brew upgrade node` removes that folder.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { stableNode } from "../src/harnesses.js";

function brew() {
  const p = mkdtempSync(join(process.env.BOTLINK_TEST_BASE!, "brew-"));
  mkdirSync(join(p, "Cellar", "node", "23.1.0", "bin"), { recursive: true });
  writeFileSync(join(p, "Cellar", "node", "23.1.0", "bin", "node"), "", { mode: 0o755 });
  mkdirSync(join(p, "opt"), { recursive: true });
  mkdirSync(join(p, "bin"), { recursive: true });
  return p;
}

test("a Homebrew Cellar node is written as its stable opt link when that link is the same binary", () => {
  const p = brew();
  symlinkSync(join("..", "Cellar", "node", "23.1.0"), join(p, "opt", "node"));
  const exec = join(p, "Cellar", "node", "23.1.0", "bin", "node");
  assert.equal(stableNode(exec), join(p, "opt", "node", "bin", "node"));
});

test("…or bin/node; anything else (a link to another version, no link, not Homebrew) keeps the exact path", () => {
  const p = brew();
  const exec = join(p, "Cellar", "node", "23.1.0", "bin", "node");
  assert.equal(stableNode(exec), exec, "no stable link: unchanged");
  symlinkSync(join("..", "Cellar", "node", "23.1.0", "bin", "node"), join(p, "bin", "node"));
  assert.equal(stableNode(exec), join(p, "bin", "node"));
  mkdirSync(join(p, "Cellar", "node", "22.0.0", "bin"), { recursive: true });
  writeFileSync(join(p, "Cellar", "node", "22.0.0", "bin", "node"), "");
  const other = join(p, "Cellar", "node", "22.0.0", "bin", "node");
  assert.equal(stableNode(other), other, "a link to another version is not this node");
  assert.equal(stableNode("/usr/bin/node"), "/usr/bin/node");
  assert.equal(stableNode("/Users/c/.nvm/versions/node/v22.1.0/bin/node"), "/Users/c/.nvm/versions/node/v22.1.0/bin/node");
});

test("a config that launches bot-link with a versioned Homebrew node is stale (update rewrites it with the stable one)", async () => {
  const { staleNodePaths } = await import("../src/setup.js");
  const cfg = JSON.stringify({ mcpServers: { botlink: { command: "/opt/homebrew/Cellar/node/22.3.0/bin/node", args: ["/Users/c/.botlink/client/current/dist/cli.js", "mcp"] } } });
  assert.deepEqual(staleNodePaths(cfg, "/opt/homebrew/opt/node/bin/node"), ["/opt/homebrew/Cellar/node/22.3.0/bin/node"]);
  assert.deepEqual(staleNodePaths(cfg, "/opt/homebrew/Cellar/node/22.3.0/bin/node"), [], "the node bot-link would write anyway: not stale");
  assert.deepEqual(staleNodePaths(`'/opt/homebrew/opt/node/bin/node' '/x/cli.js' hook codex stop`, "/opt/homebrew/opt/node/bin/node"), []);
});
