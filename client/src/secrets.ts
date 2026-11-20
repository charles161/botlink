/**
 * OS secret storage for member keys (ENVELOPE §1). Kept from botlink-mcp `cloud/secrets.ts`.
 *
 *   macOS  -> Keychain via `security` (service "botlink", account = key id)
 *   Linux  -> libsecret via `secret-tool` when it is installed AND a Secret Service answers
 *   else   -> ~/.botlink/keys/<key id>.json, 0600, with a warning
 *
 * BOTLINK_KEYCHAIN=0 forces the file store (tests/CI); =1 forces the native store.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, renameSync, rmSync } from "node:fs";
import { platform } from "node:os";
import { dirname, join } from "node:path";

import { homeDir } from "./config.js";

export const SERVICE = "botlink";
export type Backend = "keychain" | "libsecret" | "file";

export interface CloudSecrets {
  ed25519_sk: string;
  x25519_sk: string;
}

const SAFE = /^[A-Za-z0-9._:-]{1,128}$/;
function keyFile(account: string): string {
  if (!SAFE.test(account)) throw new Error("bad key id");
  return join(homeDir(), "keys", `${account}.json`);
}

function haveSecretTool(): boolean {
  const r = spawnSync("secret-tool", ["--version"], { stdio: "ignore" });
  return r.status === 0 || (r.error === undefined && r.status !== null && r.status !== 127);
}

/** The backend new secrets go to on this machine. */
export function preferredBackend(): Backend {
  const force = process.env.BOTLINK_KEYCHAIN;
  if (force === "0") return "file";
  if (platform() === "darwin") return "keychain";
  if (platform() === "linux" && haveSecretTool()) return "libsecret";
  if (force === "1") return platform() === "darwin" ? "keychain" : "libsecret";
  return "file";
}

function writePrivate(path: string, data: string) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, data, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

function fileGet(account: string): CloudSecrets | null {
  const p = keyFile(account);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf-8")) || null;
  } catch {
    return null;
  }
}

/** Store secrets; returns the backend actually used (a failing native store falls back to the file). */
export function putSecrets(account: string, s: CloudSecrets, backend = preferredBackend()): { backend: Backend; warning?: string } {
  const blob = JSON.stringify(s);
  if (backend === "keychain") {
    execFileSync("security", ["add-generic-password", "-s", SERVICE, "-a", account, "-w", blob, "-U"], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    return { backend };
  }
  if (backend === "libsecret") {
    const r = spawnSync("secret-tool", ["store", `--label=bot-link ${account}`, "service", SERVICE, "account", account], {
      input: blob,
      stdio: ["pipe", "ignore", "pipe"],
      timeout: 10000,
    });
    if (r.status === 0 && getSecrets(account, "libsecret")) return { backend };
    // no Secret Service on this session (headless box, no keyring daemon): fall back, loudly
  }
  writePrivate(keyFile(account), JSON.stringify(s) + "\n");
  return {
    backend: "file",
    warning: `No OS keychain here, so this chat's keys are in ${keyFile(account)} (mode 0600).`,
  };
}

export function getSecrets(account: string, backend: Backend): CloudSecrets | null {
  try {
    if (backend === "keychain") {
      const out = execFileSync("security", ["find-generic-password", "-s", SERVICE, "-a", account, "-w"], {
        stdio: ["ignore", "pipe", "ignore"],
      });
      return JSON.parse(out.toString("utf-8").trim());
    }
    if (backend === "libsecret") {
      const r = spawnSync("secret-tool", ["lookup", "service", SERVICE, "account", account], {
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 10000,
      });
      if (r.status !== 0) return null;
      const t = r.stdout.toString("utf-8").trim();
      return t ? JSON.parse(t) : null;
    }
    return fileGet(account);
  } catch {
    return null;
  }
}

export function deleteSecrets(account: string, backend: Backend): void {
  try {
    if (backend === "keychain") {
      execFileSync("security", ["delete-generic-password", "-s", SERVICE, "-a", account], { stdio: "ignore" });
    } else if (backend === "libsecret") {
      spawnSync("secret-tool", ["clear", "service", SERVICE, "account", account], { stdio: "ignore" });
    } else {
      rmSync(keyFile(account), { force: true });
    }
  } catch {
    /* best effort */
  }
}


