#!/usr/bin/env node
/**
 * STUB "claude" / "codex" for the matrix's --stub mode (no model, no auth). It does what the real CLI does for
 * bot-link's purposes: runs the SessionStart hook with the session id (startup / resume), writes what the hook
 * returned into a transcript (STUB_TRANSCRIPTS/<session>.jsonl), and, when the context says more messages are
 * waiting or the prompt asks for it, calls the inbox (as the model would call the MCP tool). Checks plumbing only.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

const app = process.env.STUB_APP;
const cli = process.env.STUB_CLI;
const a = process.argv.slice(2);
let sid = null, source = "startup", prompt = "";
if (app === "claude-code") {
  prompt = a[a.indexOf("-p") + 1] || "";
  const eq = a.find((x) => x.startsWith("--resume="));
  if (eq) { sid = eq.slice(9); source = "resume"; }
  else if (a.includes("--resume")) { sid = a[a.indexOf("--resume") + 1]; source = "resume"; }
  else if (a.includes("--session-id")) sid = a[a.indexOf("--session-id") + 1];
  else sid = randomUUID();
} else {
  const r = a.indexOf("resume");
  if (r >= 0) { sid = a[r + 1]; source = "resume"; prompt = a[r + 2] || ""; }
  else { sid = randomUUID(); prompt = a[a.length - 1]; if (a.includes("--json")) process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: sid }) + "\n"); }
}
const dir = process.env.STUB_TRANSCRIPTS;
mkdirSync(dir, { recursive: true });
const tr = (o) => appendFileSync(join(dir, `${sid}.jsonl`), JSON.stringify({ session: sid, ...o }) + "\n");
tr({ type: "user", text: prompt });
const h = spawnSync(process.execPath, [cli, "hook", app, "session-start"], { input: JSON.stringify({ session_id: sid, cwd: process.cwd(), source, hook_event_name: "SessionStart" }), encoding: "utf-8" });
let ctx = "";
try { ctx = JSON.parse(h.stdout || "{}").hookSpecificOutput?.additionalContext || ""; } catch { ctx = ""; }
if (ctx) tr({ type: "hook_context", additionalContext: ctx });
// the model would call the inbox tool when told more are waiting (or when the prompt says so)
for (let i = 0; i < 10 && (/more messages? (is|are) waiting/.test(ctx) || (i === 0 && /call the bot-link inbox tool/i.test(prompt) && !ctx)); i++) {
  const r = spawnSync(process.execPath, [cli, "inbox"], { env: { ...process.env, BOTLINK_SESSION: sid }, encoding: "utf-8" });
  ctx = r.stdout || "";
  tr({ type: "tool_result", tool: "inbox", text: ctx });
  if (/^No new messages/.test(ctx)) break;
}
process.exit(0);
