// Small, safe Markdown renderer (headings, paragraphs, lists, tables, code, emphasis, links).
// Builds DOM nodes directly; nothing from the document is ever parsed as HTML.
import { h } from "./dom.js";

const safeHref = (u) => (/^(https?:\/\/|\/(?!\/)|#)/.test(u) ? u : null);

export function inline(text) {
  const out = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|(\[[^\]]+\]\([^)\s]+\))/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    if (m[1]) out.push(h("code", null, t.slice(1, -1)));
    else if (m[2]) out.push(h("strong", null, inline(t.slice(2, -2))));
    else if (m[3]) out.push(h("em", null, inline(t.slice(1, -1))));
    else {
      const [, label, href] = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(t);
      const safe = safeHref(href);
      out.push(safe ? h("a", { href: safe, "data-native": /\.(md|txt|yaml)$/.test(safe) ? "" : undefined }, inline(label)) : label);
    }
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** Returns {nodes, toc:[{id,text}]} */
export function renderMarkdown(src) {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const nodes = [], toc = [];
  let i = 0;
  const isBlockStart = (l) => /^(#{1,6} |```|\s*[-*] |\s*\d+\. |\|)/.test(l) || l.trim() === "";
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    let m;
    if ((m = /^(#{1,6}) (.*)$/.exec(line))) {
      const level = Math.min(m[1].length, 4), text = m[2].trim(), id = slug(text);
      if (level === 2) toc.push({ id, text });
      nodes.push(h(`h${level}`, { id }, inline(text)));
      i++; continue;
    }
    if (line.startsWith("```")) {
      const buf = []; i++;
      while (i < lines.length && !lines[i].startsWith("```")) buf.push(lines[i++]);
      i++;
      nodes.push(h("pre", null, h("code", null, buf.join("\n"))));
      continue;
    }
    if (line.startsWith("|")) {
      const rows = [];
      while (i < lines.length && lines[i].startsWith("|")) rows.push(lines[i++]);
      const cells = (r) => r.replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
      const head = cells(rows[0]);
      const body = rows.slice(/^\|[\s:|-]+\|$/.test(rows[1] || "") ? 2 : 1).map(cells);
      nodes.push(h("div", { class: "table-scroll", tabindex: "0", role: "region", "aria-label": "Table" },
        h("table", null, h("thead", null, h("tr", null, head.map((c) => h("th", null, inline(c))))),
          h("tbody", null, body.map((r) => h("tr", null, r.map((c) => h("td", null, inline(c)))))))));
      continue;
    }
    if ((m = /^(\s*)([-*]|\d+\.) /.exec(line))) {
      const ordered = /\d/.test(m[2]);
      const list = h(ordered ? "ol" : "ul");
      while (i < lines.length && /^\s*([-*]|\d+\.) /.test(lines[i])) {
        let item = lines[i].replace(/^\s*([-*]|\d+\.) /, ""); i++;
        const sub = [];
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*]|\d+\.) /.test(lines[i])) {
          if (lines[i].trim().startsWith("```")) {
            const buf = []; i++;
            while (i < lines.length && !lines[i].trim().startsWith("```")) buf.push(lines[i++].trim());
            i++; sub.push(h("pre", null, h("code", null, buf.join("\n"))));
          } else { item += " " + lines[i].trim(); i++; }
        }
        list.append(h("li", null, inline(item), sub));
      }
      nodes.push(list);
      continue;
    }
    const para = [line];
    i++;
    while (i < lines.length && !isBlockStart(lines[i])) para.push(lines[i++]);
    nodes.push(h("p", null, inline(para.join(" "))));
  }
  return { nodes, toc };
}
