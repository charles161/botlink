/**
 * Older bot-link installs (botlink-mcp v3: the address-based `botlink` / `botlink-cloud` servers) next to bot-link v1
 * give a chat two or three sets of similar tools, and the old ones can't reach room members (onboarding feedback
 * 2026-11-06). setup finds them and, only with --remove-old (the human's OK), removes them: a backup copy of the file
 * first (~/.botlink/backups/<file>.<time>.old-botlink.bak), then exactly that entry, nothing else.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import * as jsonc from "jsonc-parser";

import { homeDir } from "./config.js";
import { isCloudEntry } from "./harnesses.js";
import { cutRanges, tomlTableRanges, parseToml } from "./toml-span.js";

export const OLD_NAMES = ["botlink", "botlink-cloud", "botlink-mcp"];

export interface OldEntry {
  file: string;
  name: string;
  /** "json": mcpServers.<name> · "toml": [mcp_servers.<name>] */
  format: "json" | "toml";
  /** jsonc key holding the servers (mcpServers / mcp) */
  key?: string;
  command: string;
}

function argvText(e: any): string {
  const a = Array.isArray(e?.command) ? e.command : [e?.command, ...(Array.isArray(e?.args) ? e.args : [])];
  return a.filter((x: unknown) => typeof x === "string").join(" ").slice(0, 160);
}

/** Old bot-link servers in these config files (JSON: key mcpServers or mcp; TOML: Codex config.toml). Read only. */
export function findOld(files: { path: string; format: "json" | "toml"; key?: string }[]): OldEntry[] {
  const out: OldEntry[] = [];
  for (const f of files) {
    if (!existsSync(f.path)) continue;
    let text: string;
    try {
      text = readFileSync(f.path, "utf-8");
    } catch {
      continue;
    }
    try {
      if (f.format === "toml") {
        const doc = parseToml(text) as any;
        for (const n of OLD_NAMES) {
          const e = doc?.mcp_servers?.[n];
          if (e && !isCloudEntry(e)) out.push({ file: f.path, name: n, format: "toml", command: argvText(e) });
        }
      } else {
        const doc = jsonc.parse(text, [], { allowTrailingComma: true });
        const sv = doc?.[f.key || "mcpServers"];
        for (const n of OLD_NAMES) if (sv && sv[n] && !isCloudEntry(sv[n])) out.push({ file: f.path, name: n, format: "json", key: f.key || "mcpServers", command: argvText(sv[n]) });
      }
    } catch {
      /* not parseable: leave it */
    }
  }
  return out;
}

/** The file without that one entry (or null when it isn't there any more). */
export function withoutOld(text: string, e: OldEntry): string | null {
  if (e.format === "toml") {
    const r = tomlTableRanges(text, ["mcp_servers", e.name]);
    return r.length ? cutRanges(text, r) : null;
  }
  const doc = jsonc.parse(text, [], { allowTrailingComma: true });
  if (!doc?.[e.key!]?.[e.name]) return null;
  const edits = jsonc.modify(text, [e.key!, e.name], undefined, { formattingOptions: { insertSpaces: true, tabSize: 2 } });
  return jsonc.applyEdits(text, edits);
}

/** Remove them (backup first). -> one line per entry. */
export function removeOld(entries: OldEntry[]): string[] {
  const lines: string[] = [];
  const bdir = join(homeDir(), "backups");
  mkdirSync(bdir, { recursive: true, mode: 0o700 });
  for (const e of entries) {
    let text: string;
    try {
      text = readFileSync(e.file, "utf-8");
    } catch (err) {
      lines.push(`! ${e.file}: can't read it (${(err as Error).message}); left as it is.`);
      continue;
    }
    const next = withoutOld(text, e);
    if (next === null) {
      lines.push(`  ${e.file}: "${e.name}" is already gone.`);
      continue;
    }
    const bak = join(bdir, `${basename(e.file)}.${new Date().toISOString().replace(/[:.]/g, "-")}.old-botlink.bak`);
    copyFileSync(e.file, bak);
    writeFileSync(e.file, next);
    lines.push(`✓ removed the old "${e.name}" server from ${e.file} (backup: ${bak})`);
  }
  return lines;
}
