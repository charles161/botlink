/**
 * The `botlink watch` user service (systemd user unit / launchd agent). Kept from botlink-mcp `watch.ts`: the unit is
 * written and removed under the config-file safety rules (ledger snapshot, .prev copies, marker on the first line,
 * never over a unit bot-link didn't write or the user changed; uninstall removes only bot-link's file).
 */
import { spawnSync } from "node:child_process";
import { accessSync, constants as FS, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, unlinkSync } from "node:fs";
import { homedir, platform, userInfo } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { homeDir } from "./config.js";
import { beginAttempt, dirNames, endAttempt, forget, readForEdit, recordBeforeWrite, sha, spanInfo, unlinkIfStill, updateSpanInfo, writeContent } from "./filesafe.js";
import { backupPath, keepPrev, keepRemoved } from "./harnesses.js";
import { selfCmd } from "./version.js";

export const SERVICE_LABEL = "dev.botlink.watch";
export const MARKER = "managed by bot-link (botlink watch)";

// ---------------------------------------------------------------- the user service
export function serviceFile(): string {
  return platform() === "darwin" ? join(homedir(), "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`) : join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "systemd", "user", "botlink-watch.service");
}

function xml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** systemd: one argument, quoted (systemd's own rules: "..." with \ and " escaped; % and $ doubled). No newlines. */
function sdQuote(s: string): string {
  if (/[\r\n]/.test(s)) throw new Error(`a service argument can't hold a newline (it would add lines to the unit): ${JSON.stringify(s)}`);
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%").replace(/\$/g, "$$$$")}"`;
}

/**
 * systemd: the EXECUTABLE (J3b). systemd expands specifiers (%) in it but never variables ($), so a `$` stays as it
 * is ("$$" there names a different, missing file and the unit never starts); `"` and `\` there make systemd reject
 * the unit, so such a path is refused before anything is written.
 */
function sdExec(s: string): string {
  if (/[\r\n]/.test(s)) throw new Error(`a service argument can't hold a newline (it would add lines to the unit): ${JSON.stringify(s)}`);
  if (/["\\]/.test(s)) throw new Error(`systemd can't start a program whose path holds " or \\ (${s}); move Node.js (or bot-link) to a path without them, then run watch install again. Nothing was changed.`);
  return `"${s.replace(/%/g, "%%")}"`;
}

export function serviceContent(argv: string[], kind: "launchd" | "systemd" = platform() === "darwin" ? "launchd" : "systemd"): string {
  const log = join(homeDir(), "watch", "watch.log");
  if (kind === "launchd") {
    for (const x of argv) if (/[\r\n]/.test(x)) throw new Error(`a service argument can't hold a newline: ${JSON.stringify(x)}`);
    return [
      `<?xml version="1.0" encoding="UTF-8"?>`,
      `<!-- ${MARKER} -->`,
      `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
      `<plist version="1.0">`,
      `<dict>`,
      `  <key>Label</key><string>${SERVICE_LABEL}</string>`,
      `  <key>ProgramArguments</key>`,
      `  <array>`,
      ...argv.map((x) => `    <string>${xml(x)}</string>`),
      `  </array>`,
      `  <key>RunAtLoad</key><true/>`,
      `  <key>KeepAlive</key><true/>`,
      `  <key>ProcessType</key><string>Background</string>`,
      `  <key>StandardOutPath</key><string>${xml(log)}</string>`,
      `  <key>StandardErrorPath</key><string>${xml(log)}</string>`,
      `</dict>`,
      `</plist>`,
      ``,
    ].join("\n");
  }
  return [
    `# ${MARKER}`,
    `[Unit]`,
    `Description=bot-link watch: waits for messages for this computer's agents`,
    ``,
    `[Service]`,
    `ExecStart=${[sdExec(argv[0]), ...argv.slice(1).map(sdQuote)].join(" ")}`,
    `Restart=on-failure`,
    `RestartSec=30`,
    ``,
    `[Install]`,
    `WantedBy=default.target`,
    ``,
  ].join("\n");
}

/** May bot-link run the service manager here? Only for the real user's home, never in a test home. */
export function realHome(): boolean {
  if (process.env.BOTLINK_NO_HARNESS_CLI === "1") return false;
  try {
    return homedir() === userInfo().homedir;
  } catch {
    return false;
  }
}

export function managerCmds(action: "install" | "uninstall"): string[][] {
  const f = serviceFile();
  if (platform() === "darwin") {
    const dom = `gui/${userInfo().uid}`;
    return action === "install" ? [["launchctl", "bootout", dom, f], ["launchctl", "bootstrap", dom, f]] : [["launchctl", "bootout", dom, f]];
  }
  return action === "install"
    ? [["systemctl", "--user", "daemon-reload"], ["systemctl", "--user", "enable", "--now", "botlink-watch.service"]]
    : [["systemctl", "--user", "disable", "--now", "botlink-watch.service"], ["systemctl", "--user", "daemon-reload"]];
}

const XML_DECL = `<?xml version="1.0" encoding="UTF-8"?>`;

function kindOf(path: string): "launchd" | "systemd" {
  return path.endsWith(".plist") ? "launchd" : "systemd";
}

/** bot-link's unit: its marker is the exact first line (systemd), or the exact line right after the XML declaration (launchd). */
export function isOurUnit(text: string, kind: "launchd" | "systemd"): boolean {
  const lines = text.split("\n");
  return kind === "systemd" ? lines[0] === `# ${MARKER}` : lines[0] === XML_DECL && lines[1] === `<!-- ${MARKER} -->`;
}

/** The unit with bot-link's command line taken out: two units that differ only in the command are the same template. */
function template(text: string, kind: "launchd" | "systemd"): string {
  if (kind === "systemd") return text.replace(/^ExecStart=.*$/m, "ExecStart=<bot-link>");
  return text.replace(/(<key>ProgramArguments<\/key>\n\s*<array>\n)([\s\S]*?)(\n\s*<\/array>)/, "$1<bot-link>$3");
}

/** The lines of `text` that are not bot-link's (what the user added or changed), in order. */
export function userLinesOf(text: string, kind: "launchd" | "systemd"): string[] {
  const ours = new Set(template(serviceContent(["x"], kind), kind).split("\n"));
  return template(text, kind).split("\n").filter((l) => l.trim() && !ours.has(l));
}

export class ServiceEdited extends Error {}

function dropInHint(path: string, kind: "launchd" | "systemd"): string {
  if (kind === "systemd") {
    const d = `${path}.d`;
    return `Keep your settings in a drop-in instead, ${d}/override.conf (systemd reads it on top of bot-link's unit, and bot-link never touches ${d}/): put your lines there under [Service], then move your copy away (mv ${path} ${path}.mine) and run \`${selfCmd()} watch install\` again.`;
  }
  return `launchd has no drop-ins: keep a copy of your lines, move the file away (mv ${path} ${path}.mine), run \`${selfCmd()} watch install\` again, then add your lines back (bot-link will refuse to overwrite them from then on).`;
}

/**
 * Write the service file under the config-file safety rules (as for app configs): a stable read and a compare right
 * before the rename; never over a file bot-link didn't write (its marker on the exact first line); never over a unit
 * the user changed since bot-link last wrote it (the hash bot-link wrote is in the ledger; for a unit from before that
 * record, only its command line may differ); a ledger snapshot (.bak of whatever was there first) and a .prev of the
 * current bytes before every write; the file's mode kept, a read-only one left alone. -> "created" | "updated" | "unchanged".
 */
export function writeServiceFile(content: string, path = serviceFile(), kind: "launchd" | "systemd" = kindOf(path)): "created" | "updated" | "unchanged" {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  beginAttempt();
  try {
    const { plan, held } = readForEdit(path);
    if (plan !== null) {
      const text = plan.toString("utf-8");
      if (!isOurUnit(text, kind)) throw new Error(`${path} exists and bot-link didn't write it; nothing was changed. Move it away first if you want bot-link's service there.`);
      const wrote = spanInfo(path).wrote;
      if (text === content) {
        if (wrote !== sha(text)) updateSpanInfo(path, (s) => void (s.wrote = sha(text)));
        return "unchanged";
      }
      const untouched = wrote ? sha(text) === wrote : template(text, kind) === template(content, kind);
      if (!untouched) {
        const mine = userLinesOf(text, kind);
        throw new ServiceEdited(`${path}: you changed it since bot-link wrote it${mine.length ? ` (your lines: ${mine.join(" | ")})` : ""}, so bot-link won't overwrite it; nothing was changed. ${dropInHint(path, kind)}`);
      }
      try {
        accessSync(path, FS.W_OK);
      } catch {
        throw new Error(`${path} is read-only, so bot-link won't touch it; nothing was changed.`);
      }
    }
    recordBeforeWrite(path, (p, k) => backupPath(p, k), undefined, held);
    if (plan !== null) keepPrev(path, plan); // J3b: a new .prev.<time> every time, never overwritten
    // an existing unit keeps its exact mode; a new one is 0600
    writeContent(path, content, { ...(plan === null ? { mode: 0o600 } : {}), expect: held ? held.buf : null, held, names: dirNames(dirname(path)) });
    updateSpanInfo(path, (s) => void (s.wrote = sha(content)));
    return plan === null ? "created" : "updated";
  } finally {
    endAttempt();
  }
}

export interface RemoveResult {
  state: "removed" | "absent" | "not_ours" | "changed" | "read_only" | "outside_home";
  /** lines the user had added or changed in bot-link's unit (they are in `prev` and in `kept`) */
  userLines?: string[];
  /** the copy of the unit as it was, kept on uninstall (a new file, never overwritten later) */
  prev?: string;
  /** J3b: the user's lines on their own, in a permanent file */
  kept?: string;
  /** the unit was a symlink: only the link was removed; this, its target, was left as it is */
  linkTarget?: string;
}

function under(p: string, dir: string): boolean {
  const r = relative(dir, p);
  return r !== "" && !r.startsWith("..") && !isAbsolute(r);
}

/**
 * Remove the service file only while it is bot-link's and still holds what was read; a copy is kept (a new
 * .prev.<time> file), and the user's own lines also go into a permanent file of their own (J3b).
 *   - a symlink (home-manager / stow): only the LINK is removed, after its target was checked to be bot-link's; the
 *     target, wherever it is and whatever its mode, is never touched
 *   - a read-only unit, or one that resolves outside your home folder through a linked folder: left alone
 * `beforeRemove` runs once all of that is checked and right before the removal (watch uninstall: systemctl disable).
 */
export function removeServiceFile(path = serviceFile(), kind: "launchd" | "systemd" = kindOf(path), beforeRemove?: () => void): RemoveResult {
  let ls: import("node:fs").Stats;
  try {
    ls = lstatSync(path);
  } catch {
    return { state: "absent" };
  }
  if (ls.isSymbolicLink()) {
    let target: string;
    let text: string;
    try {
      target = realpathSync(path);
      text = readFileSync(target, "utf-8");
    } catch {
      return { state: "not_ours" }; // a dangling link: not bot-link's to remove
    }
    if (!isOurUnit(text, kind)) return { state: "not_ours" };
    const prev = keepPrev(path, text);
    beforeRemove?.();
    const now = lstatSync(path, { throwIfNoEntry: false });
    if (!now || !now.isSymbolicLink() || now.ino !== ls.ino) return { state: "changed", prev };
    unlinkSync(path); // the link itself; never its target
    forget(path);
    return { state: "removed", prev, linkTarget: target };
  }
  try {
    const real = realpathSync(path);
    // through a linked folder outside your home (stow): only a unit whose bytes are exactly what bot-link wrote there
    // (the hash in its ledger) is removed; one you edited is left alone (J3c: install and uninstall agree)
    if (real !== resolve(path) && !under(real, realpathSync(homedir()))) {
      const wrote = spanInfo(path).wrote;
      if (!wrote || sha(readFileSync(path)) !== wrote) return { state: "outside_home" };
    }
  } catch {
    return { state: "absent" };
  }
  try {
    accessSync(path, FS.W_OK);
  } catch {
    return { state: "read_only" };
  }
  let saved: { text: string; prev: string; kept?: string } | null = null;
  let before = beforeRemove;
  // the compare right before the removal can fail for a reason other than a write (bot-link was descheduled while
  // listing the folder): read and check again, a few times, before saying it changed
  for (let attempt = 1; ; attempt++) {
    beginAttempt();
    try {
      const { plan, held } = readForEdit(path);
      if (plan === null || !held) return { state: "absent" };
      const text = plan.toString("utf-8");
      if (!isOurUnit(text, kind)) return { state: "not_ours" };
      const wrote = spanInfo(path).wrote;
      const userLines = wrote && sha(text) === wrote ? [] : userLinesOf(text, kind);
      if (!saved || saved.text !== text) {
        const prev = keepPrev(path, plan);
        saved = { text, prev, ...(userLines.length ? { kept: keepRemoved(path, userLines, userLines, prev) } : {}) };
      }
      before?.();
      before = undefined; // once
      if (unlinkIfStill(path, held)) {
        forget(path);
        return { state: "removed", userLines, prev: saved.prev, ...(saved.kept ? { kept: saved.kept } : {}) };
      }
      if (attempt >= 4) return { state: "changed", prev: saved.prev, ...(saved.kept ? { kept: saved.kept } : {}) };
    } finally {
      endAttempt();
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * attempt);
  }
}

/**
 * `watch uninstall`: the service manager is told to stop and disable the unit ONLY once the unit is known to be
 * bot-link's and about to be removed (a user's own unit of that name is never stopped, J3b); then the file goes.
 * `run` runs one service-manager command (real: only for the real home).
 */
export function uninstallService(o: { path?: string; real?: boolean; run?: (argv: string[]) => void } = {}): RemoveResult & { lines: string[] } {
  const path = o.path ?? serviceFile();
  const real = o.real ?? realHome();
  const run = o.run ?? ((c: string[]) => void spawnSync(c[0], c.slice(1), { stdio: "ignore", timeout: 20_000 }));
  const cmds = managerCmds("uninstall");
  const stop = cmds.filter((c) => c.includes("disable") || c.includes("bootout"));
  const after = cmds.filter((c) => !stop.includes(c));
  let stopped = false;
  const res = removeServiceFile(path, kindOf(path), () => {
    if (!real) return;
    for (const c of stop) run(c);
    stopped = true;
  });
  if (stopped) for (const c of after) run(c);
  const lines: string[] = [];
  const r = res.state;
  const words: Record<RemoveResult["state"], string> = {
    removed: res.linkTarget ? `removed (it was a symlink: only the link was removed; its target ${res.linkTarget} was left as it is)` : "removed",
    absent: "not there (nothing to remove)",
    not_ours: "not bot-link's: left alone (and not stopped)",
    changed: "changed while removing it: left in place",
    read_only: "read-only: left alone (and not stopped). Remove it yourself if you want watch off",
    outside_home: "it resolves outside your home folder (a linked folder): left alone (and not stopped)",
  };
  lines.push(`${r === "removed" || r === "absent" ? "✓" : "!"} Service file ${path}: ${words[r]}.`);
  if (res.userLines && res.userLines.length) lines.push(`  It held lines of yours: ${res.userLines.join(" | ")}. They are saved in ${res.kept}, and the whole file in ${res.prev} (bot-link never overwrites or deletes either).`);
  else if (r === "removed" && res.prev) lines.push(`  A copy is kept in ${res.prev}.`);
  if (stopped && r !== "removed") lines.push("  The service was stopped and disabled, but its file was not removed.");
  return { ...res, lines };
}

export function unitInstalled(path = serviceFile()): boolean {
  try {
    return isOurUnit(readFileSync(path, "utf-8"), kindOf(path));
  } catch {
    return false;
  }
}

/** Install (write + enable) the unit running `argv`. The service manager runs only for the real home. */
export function installService(argv: string[], o: { real?: boolean; run?: (argv: string[]) => { ok: boolean; out: string } } = {}): { state: "created" | "updated" | "unchanged"; lines: string[] } {
  const real = o.real ?? realHome();
  const run = o.run ?? ((c: string[]) => {
    const r = spawnSync(c[0], c.slice(1), { encoding: "utf-8", timeout: 20_000 });
    return { ok: r.status === 0, out: `${r.stdout || ""}${r.stderr || ""}`.trim() };
  });
  const state = writeServiceFile(serviceContent(argv));
  const lines = [`✓ Service file ${serviceFile()}: ${state}.`];
  if (real) {
    for (const c of managerCmds("install")) {
      const r = run(c);
      if (!r.ok && !c.includes("bootout")) lines.push(`! \`${c.join(" ")}\` failed: ${r.out.split("\n")[0] || "no output"}`);
    }
  } else lines.push("  (test home: the service manager was not run)");
  return { state, lines };
}
