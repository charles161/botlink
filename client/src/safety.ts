/**
 * What a run that bot-link starts with no human present may do (watch's resume, a listener's command).
 *
 * Default: **answer only**. bot-link resumes the chat with the tools that run commands or change files switched off
 * (Claude Code: `--disallowedTools`, which takes them away whatever the app's own settings allow; Codex:
 * `--sandbox read-only`). The woken chat can read, and it can use bot-link's own tools: enough to answer.
 *
 * **Work** is the human's explicit choice (`botlink unattended work --yes`, their own terminal): the woken run then
 * has what the app's own settings give it. If those settings let a chat run anything without asking (Bash allowed,
 * permissions bypassed, Codex with full access), bot-link says exactly that and takes the yes only together with it;
 * a later change that makes the app permissive is not covered by an earlier yes, and wakes go back to answer only.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as jsonc from "jsonc-parser";

import * as st from "./state.js";
import { parseToml } from "./toml-span.js";

export type AwayMode = "answer" | "work";

/** Claude Code tools a woken run does not get in answer-only mode: commands, file changes, the web. */
export const CLAUDE_AWAY_DENY = ["Bash", "Write", "Edit", "MultiEdit", "NotebookEdit", "WebFetch", "WebSearch"];
/** Codex: the sandbox a woken run gets in answer-only mode. */
export const CODEX_AWAY_SANDBOX = "read-only";

const home = () => process.env.HOME || "";
const claudeDir = () => process.env.CLAUDE_CONFIG_DIR || join(home(), ".claude");
const codexDir = () => process.env.CODEX_HOME || join(home(), ".codex");

function readJsonc(path: string): any {
  try {
    return jsonc.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

/** An allow rule that lets a chat run or change anything: `Bash`, `Bash(*)`, `Bash(:*)`, `Write`, `Edit`, `*`. */
const BROAD = /^(?:\*|Bash|Bash\(\s*(?:\*|:\*|\*:\*|\*\*)\s*\)|Write|Edit|MultiEdit|Write\(\s*\*+\s*\)|Edit\(\s*\*+\s*\))$/;

/** Why this app's settings let a chat act without asking (empty: they don't, as far as bot-link can read them). */
export function permissive(app: st.App | string, cwd: string | null): string[] {
  const why: string[] = [];
  if (app === "claude-code") {
    const files = [...new Set([join(claudeDir(), "settings.json"), join(claudeDir(), "settings.local.json"), ...(cwd ? [join(cwd, ".claude", "settings.json"), join(cwd, ".claude", "settings.local.json")] : [])])];
    for (const f of files) {
      if (!existsSync(f)) continue;
      const j = readJsonc(f);
      const mode = j?.permissions?.defaultMode;
      if (mode === "bypassPermissions" || mode === "acceptEdits" || mode === "auto") why.push(`${f}: permissions.defaultMode is "${mode}"`);
      const allow: unknown[] = Array.isArray(j?.permissions?.allow) ? j.permissions.allow : [];
      const broad = allow.filter((x): x is string => typeof x === "string" && BROAD.test(x.trim()));
      if (broad.length) why.push(`${f}: permissions.allow has ${broad.slice(0, 4).join(", ")}`);
      if (j?.skipDangerousModePermissionPrompt === true) why.push(`${f}: skipDangerousModePermissionPrompt is on`);
    }
  } else if (app === "codex") {
    const files = [...new Set([join(codexDir(), "config.toml"), ...(cwd ? [join(cwd, ".codex", "config.toml")] : [])])];
    for (const f of files) {
      if (!existsSync(f)) continue;
      let t: any = null;
      try {
        t = parseToml(readFileSync(f, "utf-8"));
      } catch {
        continue;
      }
      if (t?.sandbox_mode === "danger-full-access") why.push(`${f}: sandbox_mode is "danger-full-access"`);
      if (t?.sandbox_mode === "workspace-write" && t?.approval_policy === "never") why.push(`${f}: sandbox_mode "workspace-write" with approval_policy "never"`);
    }
  } else if (app === "cursor") {
    const f = join(process.env.CURSOR_CONFIG_DIR || join(home(), ".cursor"), "cli-config.json");
    const j = existsSync(f) ? readJsonc(f) : null;
    const allow: unknown[] = Array.isArray(j?.permissions?.allow) ? j.permissions.allow : [];
    const broad = allow.filter((x): x is string => typeof x === "string" && /^Shell\(\s*\*?\s*\)$|^Shell$|^\*$/.test(x.trim()));
    if (broad.length) why.push(`${f}: permissions.allow has ${broad.slice(0, 4).join(", ")}`);
  }
  return why;
}

export interface AwayChoice {
  mode: AwayMode;
  at: number;
  /** the permissive settings the human was shown and accepted, when they said yes to "work" */
  accepted?: string[];
}

export function awayChoice(): AwayChoice {
  const c = (st.loadConfig() as { unattended?: AwayChoice }).unattended;
  return c && (c.mode === "work" || c.mode === "answer") ? c : { mode: "answer", at: 0 };
}

export function setAwayChoice(c: AwayChoice) {
  st.saveConfig({ ...st.loadConfig(), unattended: c } as st.LocalConfig);
}

/** What a run bot-link starts for this member may do right now, and why (for the log and `status`). */
export function awayModeFor(app: st.App | string, cwd: string | null): { mode: AwayMode; why: string } {
  const c = awayChoice();
  if (c.mode !== "work") return { mode: "answer", why: "the default: a woken run answers, it runs no commands and changes no files" };
  const now = permissive(app, cwd);
  const fresh = now.filter((x) => !(c.accepted || []).includes(x));
  if (fresh.length) return { mode: "answer", why: `this app's settings changed since the human said yes to work (${fresh[0]}): answer only until they say yes again` };
  return { mode: "work", why: "the human let woken runs work" };
}

/** A flag in a wake command that switches the app's own permission checks off. */
const SKIP_FLAGS = [
  /--dangerously-skip-permissions\b/, /--dangerously-bypass-approvals-and-sandbox\b/, /--yolo\b/, /--full-auto\b/,
  /--permission-mode[= ]+["']?bypassPermissions\b/, /danger-full-access\b/, /--allow-dangerously-skip-permissions\b/,
  /(?:^|\s)--force\b/, /--trust-all-tools\b/, /--allow-all-tools\b/,
];
export function skipFlag(command: string): string | null {
  for (const re of SKIP_FLAGS) {
    const m = re.exec(command);
    if (m) return m[0].trim();
  }
  return null;
}
