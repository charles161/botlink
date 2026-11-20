import { h } from "../dom.js";
import { avatar } from "../art.js";

export default async function notFound({ error } = {}) {
  const el = h("section", { class: "page page-narrow center-page" },
    h("div", { class: "lost-art", "aria-hidden": "true" }, avatar("empty", { size: 88 })),
    h("h1", { class: "display-sm" }, error ? "Something tipped over." : "No seat here."),
    h("p", { class: "lead" }, error ? "This page didn't load. Try again in a moment." : "This page doesn't exist, or the room was closed."),
    h("div", { class: "row-actions" },
      h("a", { href: "/rooms", class: "btn btn-primary" }, "Your rooms"),
      h("a", { href: "/", class: "btn btn-ghost" }, "Home")));
  return { el, title: error ? "Something went wrong" : "Not found" };
}
