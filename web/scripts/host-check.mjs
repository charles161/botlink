// The dashboard's router (web/public/assets/js/app.js) and the server's host table (server/internal/pages/hosts.go,
// generated into web/public/assets/js/hosts.js) name the same pages: every route of the router is a page row of the
// table, and every page row has a route. Run from web/scripts/check.mjs.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const FIX = "add it to the host table as site or app: a line {\"<path>\", App, Page}, (or Site) in HostTable, server/internal/pages/hosts.go, " +
  "then BOTLINK_WRITE_HOSTS=1 go test ./server/internal/pages -run TestDashboardHostsFile";

// A concrete path for a table row ("/rooms/{id}" → a room id the router's pattern accepts).
const SAMPLE = { id: "01933b6e-0000-7000-8000-000000000001", code: "23456789ABCDEFGH", invite: "acme-K7Q2MX9PR4" };
export const samplePath = (p) => p.replace(/\{(\w+)\}/g, (_, k) => SAMPLE[k] || "x");

/** The regular expressions of app.js's `routes` list. */
export function routerPatterns(src) {
  const list = src.slice(src.indexOf("const routes = ["), src.indexOf("];", src.indexOf("const routes = [")));
  return [...list.matchAll(/\{\s*re:\s*\/((?:\\.|[^\/\n])+)\/([a-z]*),/g)].map((m) => new RegExp(m[1], m[2]));
}

export async function hostProblems(publicDir) {
  const problems = [];
  const { HOST_TABLE } = await import(pathToFileURL(join(publicDir, "assets", "js", "hosts.js")).href);
  const pages = HOST_TABLE.filter(([, , kind]) => kind === "page").map(([p]) => p);
  const routes = routerPatterns(await readFile(join(publicDir, "assets", "js", "app.js"), "utf8"));
  if (routes.length < 10) problems.push(`assets/js/app.js: found only ${routes.length} routes in \`const routes = [\`; the host check cannot read the router`);
  for (const re of routes) {
    if (!pages.some((p) => re.test(samplePath(p)))) problems.push(`assets/js/app.js: route ${re} is not a page in the host table, so no host serves it: ${FIX}`);
  }
  for (const p of pages) {
    if (!routes.some((re) => re.test(samplePath(p)))) {
      problems.push(`host table page ${p} has no route in assets/js/app.js: add one to \`routes\`, or drop the row from HostTable (server/internal/pages/hosts.go)`);
    }
  }
  return problems;
}
