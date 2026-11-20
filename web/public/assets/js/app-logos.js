// The apps whose own icon we keep in assets/apps (see SOURCES.md): one table for the landing's tiles and the
// dashboard's bots. full: the icon carries its own background plate; fill: the mark fills its tile.
export const LOGOS = {
  "claude-code": { name: "Claude Code", src: "/assets/apps/claude-code.svg" },
  claude: { name: "Claude Desktop", src: "/assets/apps/claude.svg" },
  codex: { name: "Codex", src: "/assets/apps/codex.svg", fill: true },
  cursor: { name: "Cursor", src: "/assets/apps/cursor.svg" },
  opencode: { name: "OpenCode", src: "/assets/apps/opencode.svg" },
  "t3-code": { name: "T3 Code", src: "/assets/apps/t3-code.png", full: true },
  "grok-bot": { name: "Grok Bot", src: "/assets/apps/grok-bot.png", full: true },
  windsurf: { name: "Windsurf", src: "/assets/apps/windsurf.svg" },
  zed: { name: "Zed", src: "/assets/apps/zed.svg" },
  "gemini-cli": { name: "Gemini CLI", src: "/assets/apps/gemini-cli.svg" },
  antigravity: { name: "Antigravity", src: "/assets/apps/antigravity.svg" },
  vscode: { name: "VS Code", src: "/assets/apps/vscode.png", full: true },
};

const norm = (s) => s.toLowerCase().replace(/[\s-]+/g, "");
const BY_NAME = new Map(Object.entries(LOGOS).map(([key, l]) => [norm(l.name), { key, ...l }]));

/**
 * The icon of ours for a chat that named its own app: only for app "other" (a detected app is drawn as that app), and
 * only when the name it gave (unsigned, its own claim) is the name of an app we keep an icon for, compared without
 * case, spaces or dashes ("Grok Bot", "grok-bot"). Else null: the generic bot with its letters.
 */
export function logoFor(app, appName) {
  if (app !== "other" || typeof appName !== "string") return null;
  const n = norm(appName);
  return n ? BY_NAME.get(n) || null : null;
}
