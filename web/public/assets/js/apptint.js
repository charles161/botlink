// A chat in an app bot-link doesn't know by its roster app ("other") shows the name it gave at join (OpenCode,
// T3 Code, …) on a generic bot, tinted per name: a deterministic hue from the name, so the same app always looks the
// same and two apps look different. The name is unsigned display data (like job). Kept apart from art.js's avatar().
import { avatar } from "./art.js";
import { logoFor } from "./app-logos.js";

/** 0..359 from the name (FNV-1a over lowercased UTF-16 units). */
export function appHue(name) {
  let x = 0x811c9dc5;
  for (const ch of String(name).toLowerCase()) { x ^= ch.codePointAt(0); x = Math.imul(x, 0x01000193) >>> 0; }
  return x % 360;
}
/** Up to two letters for the bot's badge: "OpenCode" → "OC", "T3 Code" → "TC", "aider" → "AI". */
export function appMono(name) {
  const words = String(name).replace(/[^\p{L}\p{N} ]/gu, " ").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "●";
  const caps = [...words[0]].filter((c) => /\p{Lu}/u.test(c));
  const m = words.length > 1 ? [...words[0]][0] + [...words[1]][0] : caps.length > 1 ? caps.slice(0, 2).join("") : [...words[0]].slice(0, 2).join("");
  return m.toUpperCase();
}
/** Tint an existing character (svg.char) for an app name; no-op without a name. */
export function tintChar(svg, name) {
  if (!svg || !name) return svg;
  svg.classList.add("char-tinted");
  svg.style.setProperty("--app-hue", String(appHue(name)));
  return svg;
}
/** The avatar for a member/request: known apps as art.js draws them; an "other" chat with a name as a tinted bot,
 * wearing that app's icon when we keep one for the name (app-logos.js), else its letters. */
export function appAvatar(app, appName, opts = {}) {
  if (app !== "other" || !appName) return avatar(app, opts);
  const logo = logoFor(app, appName);
  return tintChar(avatar("other", { ...opts, ...(logo ? { logo: logo.src } : { mono: appMono(appName) }) }), appName);
}
/** The badge of an "other" seat at the room's table: { logo } or { mono } (art.js tableScene). */
export function seatBadge(app, appName) {
  if (app !== "other" || !appName) return {};
  const logo = logoFor(app, appName);
  return logo ? { logo: logo.src } : { mono: appMono(appName) };
}
