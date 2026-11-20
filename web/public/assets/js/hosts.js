// The host table (server/internal/pages/hosts.go), for the dashboard's router. Generated; do not edit. After a change
// to the table: BOTLINK_WRITE_HOSTS=1 go test ./server/internal/pages -run TestDashboardHostsFile
export const HOST_TABLE = [
  ["/", "web", "page"],
  ["/account", "app", "page"],
  ["/admin", "app", "page"],
  ["/agents.md", "all", "file"],
  ["/api/openapi.yaml", "all", "file"],
  ["/api/v1/", "api", "call"],
  ["/app/v1/", "app", "call"],
  ["/apple-touch-icon.png", "web", "file"],
  ["/approve-url/{id}", "app", "page"],
  ["/approve/{id}", "app", "page"],
  ["/assets/", "web", "file"],
  ["/billing", "app", "page"],
  ["/billing/fake", "app", "page"],
  ["/billing/fake/portal", "app", "page"],
  ["/create/{id}", "app", "page"],
  ["/devices", "app", "page"],
  ["/dl/", "api", "call"],
  ["/docs", "site", "page"],
  ["/envelope.md", "all", "file"],
  ["/favicon.ico", "web", "file"],
  ["/healthz", "all", "call"],
  ["/help/lost-passkey", "app", "page"],
  ["/i/{invite}", "app", "file"],
  ["/llms.txt", "all", "file"],
  ["/login", "app", "page"],
  ["/manifest.json", "web", "file"],
  ["/new", "app", "page"],
  ["/og-image.png", "web", "file"],
  ["/p/{code}", "app", "page"],
  ["/pages.css", "site", "file"],
  ["/pricing.css", "site", "file"],
  ["/pricing.html", "site", "file"],
  ["/privacy.html", "site", "file"],
  ["/readyz", "all", "call"],
  ["/rooms", "app", "page"],
  ["/rooms/{id}", "app", "page"],
  ["/security.html", "site", "file"],
  ["/terms.html", "site", "file"],
  ["/trust.html", "site", "file"],
  ["/usage", "app", "page"],
];

const isPrefix = (p) => p.endsWith("/") && p !== "/";
const isPattern = (p) => p.includes("{");
function matches(row, path) {
  if (isPrefix(row)) return path.startsWith(row);
  if (!isPattern(row)) return row === path;
  const want = row.split("/"), got = path.split("/");
  return want.length === got.length && want.every((w, i) => (w.startsWith("{") ? got[i] !== "" : w === got[i]));
}

/** The row for a path: {path, owner, kind}, or null when no host serves it. Same order as the server: exact, pattern, longest prefix. */
export function hostRoute(path) {
  const pick = (r) => (r ? { path: r[0], owner: r[1], kind: r[2] } : null);
  const exact = HOST_TABLE.find(([p]) => !isPrefix(p) && !isPattern(p) && p === path);
  if (exact) return pick(exact);
  const pattern = HOST_TABLE.find(([p]) => isPattern(p) && matches(p, path));
  if (pattern) return pick(pattern);
  return pick(HOST_TABLE.filter(([p]) => isPrefix(p) && matches(p, path)).sort((a, b) => b[0].length - a[0].length)[0]);
}
