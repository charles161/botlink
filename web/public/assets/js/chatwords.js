// Text a chat wrote, shown as a chat's words: set apart, inside visible quotation marks, never markup or a link, with
// hidden and direction-changing characters shown as marks (draft.js inertText). The room-draft page (views/create.js)
// and the event address card (needs-eventurl.js) use it.
import { h } from "./dom.js";
import { inertText } from "./draft.js";

/**
 * One quoted line of the chat's words: a label in our words, the text inside visible quotation marks, never markup.
 * address: the text is a web address, so it may wrap after "/", "?", "&", "#" and "=" (empty <wbr> marks: the text and
 * what a copy takes stay exactly the address).
 */
export function quoted(label, field, text, { address = false } = {}) {
  const shown = inertText(text);
  const body = address ? shown.split(/(?<=[/?&#=])/).flatMap((part, i) => (i ? [h("wbr"), part] : [part])) : [];
  return h("div", { class: "cw-line" },
    h("span", { class: "cw-label" }, label),
    text
      ? h("span", { class: "cw-quote" }, h("span", { class: "cw-mark", "aria-hidden": "true" }, "“"), address ? h("bdi", { class: "cw-text", "data-field": field }, body) : h("bdi", { class: "cw-text", "data-field": field, text: shown }), h("span", { class: "cw-mark", "aria-hidden": "true" }, "”"))
      : h("span", { class: "cw-none" }, "None given."));
}
