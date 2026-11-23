// Original illustration system: line icons, app characters, the shared table.
// App characters are our own friendly "bot" shapes wearing each app's ORIGINAL mark as a badge (self-hosted from
// assets/apps/, path data generated into app-icons.js; body colours derive from the mark's dominant colour).
// App identity is also always written as text next to them.
import { h, s } from "./dom.js";
import { APP_ICONS } from "./app-icons.js";
import { logoFor } from "./app-logos.js";

const ICONS = {
  arrowRight: "M5 12h14M13 6l6 6-6 6",
  arrowLeft: "M19 12H5M11 6l-6 6 6 6",
  arrowUp: "M12 19V5M6 11l6-6 6 6",
  copy: "M9 9h10v10H9zM5 15V5h10",
  check: "M5 12.5l4.5 4.5L19 7.5",
  x: "M6 6l12 12M18 6L6 18",
  shield: "M12 3l7 3v5.5c0 4.4-3 8.2-7 9.5-4-1.3-7-5.1-7-9.5V6z M9 12l2 2 4-4",
  door: "M6 21V4.5A1.5 1.5 0 0 1 7.5 3h9A1.5 1.5 0 0 1 18 4.5V21M4 21h16M14 12h.01",
  chat: "M5 5h14v10H10l-5 4z",
  users: "M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2.5 20c.6-3.5 3.2-5.5 6.5-5.5s5.9 2 6.5 5.5M16 4.3a3.5 3.5 0 0 1 0 6.4M18.5 14.8c1.7.7 2.8 2.4 3 5.2",
  refresh: "M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5",
  power: "M12 3v8M6.3 7.3a8 8 0 1 0 11.4 0",
  link: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
  key: "M14.5 9.5m-4.5 0a4.5 4.5 0 1 0 9 0a4.5 4.5 0 1 0-9 0M11 13l-7 7M7 17l2 2M5 19l1.5 1.5",
  clock: "M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0-18 0M12 7v5l3 2",
  plus: "M12 5v14M5 12h14",
  logout: "M15 4h3.5A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5H15M10 16l-4-4 4-4M6 12h10",
  monitor: "M3 5h18v11H3zM8 20h8M12 16v4",
  book: "M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5zM4 20.5A2.5 2.5 0 0 0 6.5 23H20",
  alert: "M12 3l10 18H2zM12 10v4M12 17.5h.01",
  sparkle: "M12 3c.6 4.6 2.4 6.4 7 7-4.6.6-6.4 2.4-7 7-.6-4.6-2.4-6.4-7-7 4.6-.6 6.4-2.4 7-7z",
  chevronDown: "M6 9l6 6 6-6",
  trash: "M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3",
  external: "M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5",
  fingerprint: "M12 11v3c0 2.5-.6 4.6-1.8 6.5M8.5 7.6A5 5 0 0 1 17 11v2.5c0 1.5-.2 3-.6 4.4M6.5 11a5.5 5.5 0 0 1 .3-1.8M7 14.5c.3-1.2.5-2.3.5-3.5M20 11.5V11a8 8 0 0 0-14.5-4.7M3.7 15.5c.2-1.2.3-2.6.3-4",
  moon: "M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z",
  sun: "M12 12m-4 0a4 4 0 1 0 8 0a4 4 0 1 0-8 0M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4",
  menu: "M4 7h16M4 12h16M4 17h16",
  send: "M4 12l16-8-6 16-2.5-6.5z",
  lock: "M6 11h12v10H6zM8.5 11V7.5a3.5 3.5 0 0 1 7 0V11",
  bell: "M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15zM10 20.5a2 2 0 0 0 4 0",
  edit: "M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4",
};

export function icon(name, { size = 20, cls = "", label } = {}) {
  const d = ICONS[name] || ICONS.sparkle;
  return s("svg", {
    class: `icon ${cls}`.trim(), width: size, height: size, viewBox: "0 0 24 24",
    "aria-hidden": label ? undefined : "true", role: label ? "img" : undefined, "aria-label": label,
    focusable: "false",
  }, s("path", { d }));
}

// The GitHub mark (monochrome, the text colour: light and dark alike), for the sign-in button and the header's GitHub link.
const GITHUB = "M12 2.5a9.5 9.5 0 0 0-3 18.5c.5.1.7-.2.7-.5v-1.7c-2.7.6-3.3-1.2-3.3-1.2-.4-1.1-1.1-1.4-1.1-1.4-.9-.6.1-.6.1-.6 1 .1 1.5 1 1.5 1 .9 1.5 2.3 1.1 2.9.8.1-.6.3-1.1.6-1.3-2.1-.2-4.4-1.1-4.4-4.7 0-1 .4-1.9 1-2.6-.1-.2-.4-1.2.1-2.5 0 0 .8-.3 2.6 1a9 9 0 0 1 4.8 0c1.8-1.3 2.6-1 2.6-1 .5 1.3.2 2.3.1 2.5.6.7 1 1.6 1 2.6 0 3.7-2.3 4.5-4.4 4.7.3.3.7.9.7 1.8v2.7c0 .3.2.6.7.5A9.5 9.5 0 0 0 12 2.5z";
export const githubMark = ({ size = 20 } = {}) =>
  s("svg", { class: "icon brand", width: size, height: size, viewBox: "0 0 24 24", "aria-hidden": "true", focusable: "false" }, s("path", { d: GITHUB }));

export const APP_NAMES = { "claude-code": "Claude Code", codex: "Codex", cursor: "Cursor", opencode: "OpenCode", other: "Other app" };
/** The server's measured label (SPEC §6.9) in people's words. Same meaning, no turn/wake jargon. */
const TURN_TEXT = { "wakes on its own": "Ready anytime", "always on": "Always on", "answers on its next turn": "Replies when next used", "listener down": "Listener down" };
export const turnText = (label) => TURN_TEXT[label] || label || "";
/** detail: the unsigned app_name of an "other" chat (OpenCode, T3 Code, …); shown as the app's name, never trusted. A
 * name we keep an icon for is written as that app writes it ("grok-bot" → "Grok Bot", app-logos.js). */
export const appName = (a, detail) => (a === "other" && detail ? logoFor(a, String(detail))?.name ?? String(detail) : APP_NAMES[a] || "Other app");
let gradSeq = 0;

/** The app's real mark inside a round cream badge (top-right of the character). */
function logoBadge(k, { cx = 45, cy = 7.5, r = 12.5 } = {}) {
  const ic = APP_ICONS[k];
  const pad = r * 0.26;
  const size = (r - pad) * 2;
  const kids = [];
  let gradId = null;
  if (ic.gradient) {
    gradId = `app-g-${k}-${++gradSeq}`;
    const [x0, y0, w, hgt] = ic.viewBox.split(/\s+/).map(Number);
    kids.push(s("defs", null, s("linearGradient", { id: gradId, gradientUnits: "userSpaceOnUse", x1: x0 + w / 2, x2: x0 + w / 2, y1: y0, y2: y0 + hgt },
      ic.gradient.map((g) => s("stop", { offset: g.offset, "stop-color": g.color })))));
  }
  for (const p of ic.paths) {
    kids.push(s("path", { d: p.d, fill: p.fill === "gradient" ? `url(#${gradId})` : p.fill, "fill-rule": p.rule || undefined, class: "c-logo-path" }));
  }
  return s("g", { class: "c-logo-badge" },
    s("circle", { cx, cy, r, class: "c-badge c-line" }),
    s("svg", { x: cx - size / 2, y: cy - size / 2, width: size, height: size, viewBox: ic.viewBox, class: "c-logo", overflow: "visible" }, ...kids));
}

/** A self-named app's own icon (app-logos.js) in the round badge, on the generic bot (the body says: named by itself). */
function imageBadge(src, { cx = 45, cy = 7.5, r = 12.5 } = {}) {
  const id = `app-clip-${++gradSeq}`, ri = r - 1.5;
  return s("g", { class: "c-logo-badge" },
    s("defs", null, s("clipPath", { id }, s("circle", { cx, cy, r: ri }))),
    s("circle", { cx, cy, r, class: "c-badge c-line" }),
    s("image", { href: src, x: cx - ri, y: cy - ri, width: ri * 2, height: ri * 2, preserveAspectRatio: "xMidYMid slice", "clip-path": `url(#${id})`, class: "c-logo-img" }));
}

/** A character for an app. kind: claude-code | codex | cursor | other | person | empty. logo: an icon's address for an
 * "other" bot whose name matched one of ours (instead of its letters). */
export function avatar(kind, { size = 52, mono, logo, initial, label, cls = "" } = {}) {
  const k = ["claude-code", "codex", "cursor", "other", "person", "empty"].includes(kind) ? kind : "other";
  const body = {
    "claude-code": () => [
      s("circle", { cx: 17, cy: 13, r: 6.5, class: "c-fill c-line" }),
      s("circle", { cx: 39, cy: 13, r: 6.5, class: "c-fill c-line" }),
      s("path", { d: "M8 30c0-11 8.5-18 20-18s20 7 20 18v6c0 6-4 10-10 10H18c-6 0-10-4-10-10z", class: "c-fill c-line" }),
    ],
    codex: () => [
      s("path", { d: "M10 17c0-6 3-9 9-9.5l17-1.2c6-.4 10 3 10 9v19c0 6-4 9.7-10 9.7H19c-6 0-9-3.7-9-9.7z", class: "c-fill c-line", transform: "rotate(-3 28 28)" }),
      s("path", { d: "M15 22.5h26", class: "c-visor" }),
    ],
    cursor: () => [
      s("rect", { x: 9, y: 10, width: 38, height: 36, rx: 9, class: "c-fill c-line", transform: "rotate(5 28 28)" }),
      s("path", { d: "M40 3.5l7 14-5.2-2.6L38 19z", class: "c-pointer c-line" }),
    ],
    other: () => [
      s("path", { d: "M28 5v6", class: "c-line" }),
      s("circle", { cx: 28, cy: 4.5, r: 3, class: "c-dot c-line" }),
      s("rect", { x: 9, y: 11, width: 38, height: 35, rx: 10, class: "c-fill c-line" }),
      s("path", { d: "M6 26v8M50 26v8", class: "c-line" }),
    ],
    person: () => [s("circle", { cx: 28, cy: 28, r: 20, class: "c-fill c-line" })],
    empty: () => [s("rect", { x: 9, y: 10, width: 38, height: 36, rx: 11, class: "c-empty" })],
  }[k]();
  const face = k === "empty" ? [] : k === "person"
    ? [s("text", { x: 28, y: 34.5, "text-anchor": "middle", class: "c-initial" }, (initial || "?").slice(0, 1).toUpperCase())]
    : [
      s("circle", { cx: 21.5, cy: 28, r: 2.6, class: "c-eye" }),
      s("circle", { cx: 34.5, cy: 28, r: 2.6, class: "c-eye" }),
      s("path", { d: "M23.5 35.5q4.5 4 9 0", class: "c-mouth" }),
    ];
  const badge = k === "empty" || k === "person" ? [] : APP_ICONS[k] && !mono ? [logoBadge(k)] : k === "other" && logo ? [imageBadge(logo)] : [
    s("g", { class: "c-logo-badge" },
      s("rect", { x: 34, y: -1, width: 22, height: 15, rx: 7.5, class: "c-badge c-line" }),
      s("text", { x: 45, y: 10, "text-anchor": "middle", class: "c-mono" }, mono || "●")),
  ];
  return s("svg", {
    class: `char char-${k} ${cls}`.trim(), width: size, height: size, viewBox: "-2 -4 60 62",
    role: label ? "img" : undefined, "aria-label": label, "aria-hidden": label ? undefined : "true", focusable: "false",
  }, ...body, ...face, ...badge);
}

// Brand: "Bloom Loop" (botlink-brand/final, README.md). Four equal arcs, cobalt → coral → mint → gold; never
// recoloured, rotated or animated. The lockup keeps the kit's 1600×480 viewBox (it holds the clear space) and is
// drawn at >= 180px wide; below that only the mark is used. Letters and hyphen take the theme's brand colours (CSS).
const LOOP = [
  ["M512 234A278 278 0 0 1 790 512", "#315BF4"],
  ["M790 512A278 278 0 0 1 512 790", "#FF6B5E"],
  ["M512 790A278 278 0 0 1 234 512", "#3DCCA5"],
  ["M234 512A278 278 0 0 1 512 234", "#F6B83F"],
];
const loop = (transform) => s("g", { fill: "none", "stroke-width": 154, "stroke-linecap": "round", transform },
  ...LOOP.map(([d, c]) => s("path", { d, stroke: c })));
const WORD = [ // Loma Bold outlines: [x offset, path, hyphen?]
  [470, "M596 -13C895 -13 1055 222 1055 544C1055 848 892 1082 605 1082C518 1082 432 1041 354 977V1466H134V0H341V84C358 67 445 -13 596 -13ZM591 882C767 882 835 736 835 536C835 320 741 187 584 187C496 187 354 249 354 543C354 735 449 882 591 882Z"],
  [647.96875, "M566 -13C888 -13 1063 187 1063 535C1063 882 888 1082 566 1082C244 1082 68 882 68 535C68 187 244 -13 566 -13ZM566 882C792 882 843 710 843 535C843 359 792 187 566 187C340 187 288 359 288 535C288 710 340 882 566 882Z"],
  [825.9375, "M528 195C493 190 475 187 474 187C391 187 366 234 366 297V862H497V1062H366V1433H146V1062H18V862H146V311C146 129 146 -13 406 -13C456 -13 506 -8 554 2Z"],
  [914.84375, "M65 411H618V631H65Z", true],
  [1021.40625, "M112 0H332V1466H112Z"],
  [1092.5, "M121 1220H332V1466H121ZM116 0H336V1062H116Z"],
  [1163.59375, "M592 882C708 882 780 833 780 678V0H1000V660C1000 845 920 1082 600 1082C488 1082 422 1061 355 999V1064H135V0H355V586C355 724 401 882 592 882Z"],
  [1341.5625, "M136 0H356V390L443 484L740 0H1016L592 636L975 1062H696L356 684V1466H136Z"],
];

/** The standalone mark (decorative; the kit's 1024 viewBox with its clear space). */
export function logoMark({ size = 40, cls = "" } = {}) {
  return s("svg", { class: `brand-mark ${cls}`.trim(), width: size, height: size, viewBox: "0 0 1024 1024", "aria-hidden": "true", focusable: "false" }, loop());
}

/** Mark + wordmark lockup (decorative: the surrounding link or text names it). */
export function logo({ cls = "" } = {}) {
  return s("svg", { class: `brand-lockup ${cls}`.trim(), width: 180, height: 54, viewBox: "0 0 1600 480", "aria-hidden": "true", focusable: "false" },
    loop("translate(240 240) scale(0.4788732394) translate(-512 -512)"),
    s("g", null, ...WORD.map(([x, d, hyphen]) => s("path", { d, class: hyphen ? "brand-hyphen" : "brand-ink", transform: `translate(${x} 353.515625) scale(0.15625 -0.15625)` }))));
}

/**
 * The shared table. seats: [{kind, app, label, sub, mono, initial, onClick, stuck, owner, mine, id}]
 * Seats are HTML buttons placed around an SVG ellipse, so labels stay crisp and tappable.
 */
export function tableScene({ seats, center, compact = false, ariaLabel = "Members at the table" }) {
  const hasArrival = seats.some((seat) => seat.fresh === true && seat.kind !== "empty");
  const wrap = h("div", { class: ["table-scene", compact && "compact", hasArrival && "has-arrival"], role: "group", "aria-label": ariaLabel });
  const surface = s("svg", { class: "table-surface", viewBox: "0 0 600 330", preserveAspectRatio: "none", "aria-hidden": "true" },
    s("ellipse", { cx: 300, cy: 196, rx: 270, ry: 124, class: "t-shadow" }),
    s("ellipse", { cx: 300, cy: 178, rx: 286, ry: 140, class: "t-depth" }),
    s("ellipse", { cx: 300, cy: 162, rx: 286, ry: 140, class: "t-top" }),
    s("ellipse", { cx: 300, cy: 162, rx: 262, ry: 122, class: "t-inner" }),
    s("ellipse", { cx: 228, cy: 112, rx: 120, ry: 42, class: "t-shine" }),
    s("path", { d: "M96 151c54-68 128-101 221-101 69 0 131 18 185 55", class: "t-grain" }),
    s("path", { d: "M111 222c51 44 115 66 191 66 73 0 136-20 189-60", class: "t-grain t-grain-soft" }));
  wrap.append(surface);
  if (center) {
    wrap.append(h("div", { class: "table-center" },
      h("div", { class: "table-card" }, h("strong", { class: "table-card-title" }, center.title), center.sub ? h("span", { class: "table-card-sub" }, center.sub) : null)));
  }
  const n = seats.length;
  seats.forEach((seat, i) => {
    // Evenly around the ellipse, starting top-centre, clockwise. Slightly larger radius than the table.
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / Math.max(n, 1);
    const x = 50 + 46 * Math.cos(a);
    const y = 49 + 43 * Math.sin(a);
    const inner = [
      h("span", { class: "seat-char" },
        h("span", { class: "seat-chair", "aria-hidden": "true" }),
        h("span", { class: "seat-arrival-ring", "aria-hidden": "true" }),
        h("span", { class: "seat-sparks", "aria-hidden": "true" }, h("i"), h("i"), h("i")),
        avatar(seat.kind, { size: compact ? 44 : 52, mono: seat.mono, logo: seat.logo, initial: seat.initial }),
        seat.stuck ? h("span", { class: "seat-flag", title: "Can't read its messages" }, "!") : null,
        seat.owner ? h("span", { class: "seat-crown", title: "Owner" }, "★") : null),
      // a place card under the character: opaque, so it reads cleanly even where it meets the table's rim
      h("span", { class: "seat-tag" },
        h("span", { class: "seat-name" }, seat.label),
        seat.sub ? h("span", { class: "seat-sub" }, seat.sub) : null),
    ];
    const classes = [
      "seat",
      seat.kind === "empty" && "seat-empty",
      seat.mine && "seat-mine",
      seat.fresh === true && seat.kind !== "empty" && "seat-arriving",
      seat.fresh === false && "no-enter",
    ];
    const el = seat.onClick
      ? h("button", { type: "button", class: classes, style: { "--x": `${x}%`, "--y": `${y}%`, "--i": i }, "aria-label": seat.aria || seat.label, on: { click: seat.onClick } }, inner)
      : h("div", { class: classes, style: { "--x": `${x}%`, "--y": `${y}%`, "--i": i } }, inner);
    wrap.append(el);
  });
  return wrap;
}
