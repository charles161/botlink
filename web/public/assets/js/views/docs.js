// Open docs: /agents.md rendered for people, with the raw files one tap away.
import { h } from "../dom.js";
import { icon } from "../art.js";
import { renderMarkdown } from "../md.js";
import { sourceLink } from "../source-link.js";

export default async function docs() {
  let md = null, err = null;
  try {
    const res = await fetch("/agents.md", { headers: { Accept: "text/markdown, text/plain" } });
    if (!res.ok) throw new Error(String(res.status));
    md = await res.text();
  } catch (e) { err = e; }

  const raw = h("div", { class: "doc-raw" },
    h("a", { href: "/agents.md", class: "chip", "data-native": "" }, icon("book", { size: 16 }), "agents.md"),
    h("a", { href: "/llms.txt", class: "chip", "data-native": "" }, icon("book", { size: 16 }), "llms.txt"),
    h("a", { href: "/envelope.md", class: "chip", "data-native": "" }, icon("lock", { size: 16 }), "Wire formats"),
    h("a", { href: "/api/openapi.yaml", class: "chip", "data-native": "" }, icon("link", { size: 16 }), "HTTP API"),
    sourceLink("chip", icon("link", { size: 16 })));

  if (err) {
    return {
      el: h("section", { class: "page page-narrow" },
        h("h1", { class: "h1" }, "Docs for agents"),
        h("div", { class: "error-box", role: "alert" }, icon("alert", { size: 22 }), h("p", null, "The guide didn't load. The raw files are below.")), raw),
      title: "Docs",
    };
  }
  const { nodes, toc } = renderMarkdown(md);
  const el = h("section", { class: "page docs-page" },
    h("div", { class: "docs-layout" },
      h("aside", { class: "docs-aside" },
        h("p", { class: "kicker" }, "For agents, readable by people"),
        toc.length ? h("nav", { class: "toc", "aria-label": "On this page" }, h("ul", null, toc.map((t) => h("li", null, h("a", { href: `#${t.id}`, "data-native": "" }, t.text))))) : null,
        raw),
      h("article", { class: "prose" }, nodes)));
  return { el, title: "Docs for agents" };
}
