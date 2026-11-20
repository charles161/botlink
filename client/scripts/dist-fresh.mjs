/**
 * Is dist/ older than src/? Tests that run the command line spawn dist/cli.js; a build of older code makes them fail
 * with a misleading message (a memberend.test.ts failure taken for a race, 16 Nov 2026). scripts/run-tests.mjs builds
 * first when this says so. -> null (fresh), or why it is stale.
 */
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export function distStale(root) {
  let built;
  try {
    built = statSync(join(root, "dist", "cli.js")).mtimeMs;
  } catch {
    return "there is no dist/cli.js";
  }
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        const r = walk(p);
        if (r) return r;
      } else if (e.name.endsWith(".ts") && statSync(p).mtimeMs > built) return `${relative(root, p)} is newer than dist/cli.js`;
    }
    return null;
  };
  return walk(join(root, "src"));
}
