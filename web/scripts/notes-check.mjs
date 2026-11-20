// Builders' private notes (.fixall-*, .agreed-* at the repository root) are not product: a tracked one fails.
//   node web/scripts/notes-check.mjs [--root <dir>]     (web/scripts/check.mjs runs it too)
// A copy of the repository without git (a release tarball) has nothing tracked to check and passes.
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const NOTE = /^\.(fixall|agreed)-[^/]*$/;

export function notesProblems(root = resolve(HERE, "../..")) {
  let tracked;
  try {
    tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split("\0");
  } catch {
    return [];
  }
  return tracked.filter((f) => NOTE.test(f)).map((f) => `${f}: builders' notes are not product: git rm --cached ${f}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const ri = process.argv.indexOf("--root");
  const p = notesProblems(ri > 0 ? resolve(process.argv[ri + 1]) : undefined);
  if (p.length) { console.error(p.join("\n")); process.exit(1); }
  console.log("no builders' notes tracked");
}
