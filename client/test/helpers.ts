/** Test isolation + "computers": each simulated computer is its own BOTLINK_HOME (and HOME for app configs). */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { userInfo } from "node:os";

import * as c from "../src/crypto.js";
import { FakeServer } from "./fake-server.js";

export function assertIsolated() {
  assert.ok(process.env.BOTLINK_TEST_BASE, "run tests through scripts/run-tests.mjs (npm test)");
  assert.equal(process.env.CLAUDE_CONFIG_DIR, undefined);
  assert.equal(process.env.CODEX_HOME, undefined);
  assert.notEqual(process.env.HOME, userInfo().homedir, "HOME must be a temp dir");
  const s = process.env.BOTLINK_SERVER || "";
  assert.match(s, /^http:\/\/(127\.0\.0\.1|localhost):\d{4,5}$/, "BOTLINK_SERVER must be local");
  assert.equal((globalThis as any).__botlinkNetGuard, true, "test/netguard.mjs must be loaded (scripts/run-tests.mjs sets NODE_OPTIONS): tests never reach a real server");
}

let n = 0;
export function newHome(label: string): string {
  const d = mkdtempSync(join(process.env.BOTLINK_TEST_BASE!, `${label}-${++n}-`));
  mkdirSync(join(d, ".botlink"), { recursive: true, mode: 0o700 });
  return d;
}

/** Run fn as a chat on the computer whose home is `home` (BOTLINK_HOME + HOME switched for the duration). */
export async function on<T>(home: string, fn: () => Promise<T> | T, extra: Record<string, string | undefined> = {}): Promise<T> {
  const saved: Record<string, string | undefined> = { HOME: process.env.HOME, BOTLINK_HOME: process.env.BOTLINK_HOME };
  for (const k of Object.keys(extra)) saved[k] = process.env[k];
  process.env.HOME = home;
  process.env.BOTLINK_HOME = join(home, ".botlink");
  for (const [k, v] of Object.entries(extra)) if (v === undefined) delete process.env[k];
  else process.env[k] = v;
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

/** The ten local ports the fakes use: 8820-8829, or BOTLINK_TEST_PORT_BASE..+9 (so two worktrees can test at once). */
export const PORT_BASE = Number(process.env.BOTLINK_TEST_PORT_BASE) || 8820;
let nextPort = PORT_BASE;
export async function startFake(): Promise<FakeServer> {
  await c.ready();
  for (let i = 0; i < 10; i++) {
    const port = PORT_BASE + ((nextPort++ - PORT_BASE) % 10);
    try {
      const f = await new FakeServer().start(port);
      process.env.BOTLINK_SERVER = f.url;
      return f;
    } catch {
      /* port busy: next */
    }
  }
  throw new Error(`no free port in ${PORT_BASE}-${PORT_BASE + 9}`);
}

export const FORBIDDEN = /\b(receipts?|seen|answered|webhooks?|delivered|leases?|leased|envelopes?|chatgpt)\b/i;
/** The copy test (PLAN §5.5): "re-delivered" is the one fixed flag SPEC §7.2 mandates (CONTRACT-CHANGES 2026-11-05). */
export function assertCopy(text: string) {
  const t = text.replace(/re-delivered/g, "");
  const m = t.match(FORBIDDEN);
  assert.equal(m, null, `forbidden word ${m?.[0]} in output:\n${text}`);
}
