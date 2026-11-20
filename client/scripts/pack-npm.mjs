#!/usr/bin/env node
/**
 * Make the npm tarball of the client: `@botlink/cli` (npm refused the bare name "botlink" as too close to "comlink").
 *   node scripts/pack-npm.mjs [--out <dir>] [--allow-dev]      (npm run pack:npm)
 *
 * The repo's package stays named "botlink": that is the tarball the server hands out at /dl/botlink-<16 hex>.tgz, and
 * every installed client's self-update (until the copies that accept both names are everywhere) refuses a tarball with
 * another name. So this script packs the normal package (prepack = clean + fresh build), renames it inside a copy of
 * the tarball, checks it, and packs that copy. Publish the result: `npm publish <file> --access public` (NPM-PUBLISH.md).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, copyFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const out = resolve(args.includes("--out") ? args[args.indexOf("--out") + 1] : root);
const allowDev = args.includes("--allow-dev");
const NAME = "@botlink/cli";
const fail = (why) => { console.error(`pack-npm: ${why} (see NPM-PUBLISH.md)`); process.exit(1); };

const work = mkdtempSync(join(tmpdir(), "botlink-npm-pack-"));
try {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  execFileSync(npm, ["pack", "--silent", "--pack-destination", work], { cwd: root, stdio: ["ignore", "ignore", "inherit"] });
  const tgz = readdirSync(work).find((f) => f.endsWith(".tgz"));
  if (!tgz) fail("npm pack wrote no tarball");
  const x = join(work, "x");
  mkdirSync(x);
  execFileSync("tar", ["-xzf", join(work, tgz), "-C", x, "--no-same-owner"]);
  const pkg = join(x, "package");
  const pjPath = join(pkg, "package.json");
  const pj = JSON.parse(readFileSync(pjPath, "utf-8"));
  if (pj.name !== "botlink") fail(`expected the repo package "botlink", got ${JSON.stringify(pj.name)}`);
  if (!allowDev && !/^\d+\.\d+\.\d+$/.test(pj.version || "")) fail(`version ${JSON.stringify(pj.version)} is not a release (x.y.z): run npm version <x.y.z> --no-git-tag-version first`);
  if (!readFileSync(join(pkg, "dist", "cli.js"), "utf-8").startsWith("#!/usr/bin/env node\n")) fail("dist/cli.js has no #!/usr/bin/env node line");
  pj.name = NAME;
  pj.publishConfig = { access: "public" };
  // the copy is a finished build: no build or publish guards run from it
  for (const k of ["prepack", "postpack", "prepublishOnly", "clean", "build", "test", "typecheck", "vectors", "pack:npm"]) delete pj.scripts?.[k];
  if (pj.scripts && !Object.keys(pj.scripts).length) delete pj.scripts;
  delete pj.devDependencies;
  writeFileSync(pjPath, JSON.stringify(pj, null, 2) + "\n");
  // the lock that pins every dependency (scripts/make-shrinkwrap.mjs, written at prepack) travels under the new name
  const swPath = join(pkg, "npm-shrinkwrap.json");
  let sw;
  try {
    sw = JSON.parse(readFileSync(swPath, "utf-8"));
  } catch {
    fail("the packed client has no npm-shrinkwrap.json (prepack writes it)");
  }
  sw.name = NAME;
  if (sw.packages?.[""]) sw.packages[""].name = NAME;
  writeFileSync(swPath, JSON.stringify(sw, null, 2) + "\n");
  // the README names the exact version: `npx @botlink/cli` without one runs whatever npx cached or npm serves that day
  const readmePath = join(pkg, "README.md");
  writeFileSync(readmePath, readFileSync(readmePath, "utf-8").replace(/@botlink\/cli(?![@\w/-])(?=[ `\n])/g, (m, off, all) => (/(?:npx -y|npm install -g) $/.test(all.slice(0, off)) ? `${NAME}@${pj.version}` : m)));
  const packed = execFileSync(npm, ["pack", "--silent", "--ignore-scripts", "--pack-destination", work], { cwd: pkg, encoding: "utf-8" }).trim().split("\n").pop();
  mkdirSync(out, { recursive: true });
  const dest = join(out, packed);
  copyFileSync(join(work, packed), dest);
  console.log(dest);
} finally {
  rmSync(work, { recursive: true, force: true });
}
