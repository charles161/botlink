// Was a file left out of the public export of this repository on purpose? The export
// (deploy/public-repo/build-candidate.sh) writes .public-export at the root: "<path>\t<reason>" per path its allow-list
// drops (a folder ends in /). The private repository has no such file, so nothing is ever skipped there.
// The Go twin: server/internal/exportomit.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Why the export left `rel` out, or null (not left out, or not an export). */
export function omitted(root, rel) {
  const f = join(root, ".public-export");
  if (!existsSync(f)) return null;
  let best = null;
  for (const line of readFileSync(f, "utf8").split("\n")) {
    if (!line || line.startsWith("#") || !line.includes("\t")) continue;
    const [p, why] = line.split("\t");
    if ((rel === p || (p.endsWith("/") && rel.startsWith(p))) && (!best || p.length > best[0].length)) best = [p, why];
  }
  return best ? best[1] : null;
}
