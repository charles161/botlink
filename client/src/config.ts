/**
 * Where bot-link keeps its local state: ~/.botlink (override BOTLINK_HOME). Dirs 0700, files 0600 (SPEC §7.1).
 * The config ledger, backups and locks of the harness edits (filesafe.ts) live here too.
 */
import { homedir } from "node:os";
import { join } from "node:path";

export function homeDir(): string {
  return process.env.BOTLINK_HOME || join(process.env.HOME || homedir(), ".botlink");
}

/**
 * bot-link's MCP tools an unattended (watch-resumed) run may call without asking: Claude Code gets them as
 * --allowedTools, Cursor as permissions.allow rules. leave, claim, save_rule and join always need the human.
 */
export const UNATTENDED_TOOL_NAMES = ["send", "reply", "inbox", "roster", "ask_human", "handover"];
