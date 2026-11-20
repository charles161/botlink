import { h, s, toast } from "../dom.js";
import { get, post, errorText } from "../api.js";
import { icon, avatar } from "../art.js";
import { navigate, afterSignIn, markSignedIn } from "../app.js";

const safeReturn = (r) => (r && /^\/(?![\/\\])[^\s\\]*$/.test(r) && !r.startsWith("/login") ? r : "/rooms");

const GH = "M12 2.5a9.5 9.5 0 0 0-3 18.5c.5.1.7-.2.7-.5v-1.7c-2.7.6-3.3-1.2-3.3-1.2-.4-1.1-1.1-1.4-1.1-1.4-.9-.6.1-.6.1-.6 1 .1 1.5 1 1.5 1 .9 1.5 2.3 1.1 2.9.8.1-.6.3-1.1.6-1.3-2.1-.2-4.4-1.1-4.4-4.7 0-1 .4-1.9 1-2.6-.1-.2-.4-1.2.1-2.5 0 0 .8-.3 2.6 1a9 9 0 0 1 4.8 0c1.8-1.3 2.6-1 2.6-1 .5 1.3.2 2.3.1 2.5.6.7 1 1.6 1 2.6 0 3.7-2.3 4.5-4.4 4.7.3.3.7.9.7 1.8v2.7c0 .3.2.6.7.5A9.5 9.5 0 0 0 12 2.5z";

export default async function login({ app, query }) {
  const returnTo = safeReturn(query.get("return_to"));
  const reauth = query.get("reauth") === "1";
  if (app.me && !reauth) { queueMicrotask(() => navigate(returnTo, { replace: true })); }

  let providers = [];
  let loadErr = null;
  try { providers = (await get("/app/v1/auth/providers")).providers || []; } catch (e) { loadErr = e; }

  const startUrl = (p) => `/app/v1/auth/${p}/start?return_to=${encodeURIComponent(returnTo)}`;
  const buttons = [];
  if (providers.includes("github")) buttons.push(h("a", { href: startUrl("github"), class: "btn btn-provider", "data-native": "" },
    s("svg", { class: "icon brand", width: 20, height: 20, viewBox: "0 0 24 24", "aria-hidden": "true" }, s("path", { d: GH })), "Continue with GitHub"));
  if (providers.includes("google")) buttons.push(h("a", { href: startUrl("google"), class: "btn btn-provider", "data-native": "" },
    h("span", { class: "g-mark", "aria-hidden": "true" }, "G"), "Continue with Google"));
  // The provider round trip lands back with a session; remember to ask for it on open pages too.
  for (const b of buttons) b.addEventListener("click", markSignedIn);

  let dev = null;
  if (providers.includes("dev")) {
    const status = h("p", { class: "form-status", role: "status", "aria-live": "polite" });
    const email = h("input", { id: "dev-email", name: "email", type: "email", required: true, autocomplete: "email", placeholder: "adam@example.com", class: "input" });
    const name = h("input", { id: "dev-name", name: "display_name", type: "text", maxlength: 80, autocomplete: "name", placeholder: "Adam", class: "input" });
    const submit = h("button", { type: "submit", class: "btn btn-ghost btn-block" }, h("span", { class: "spinner", "aria-hidden": "true" }), h("span", { class: "btn-label" }, "Sign in (dev)"));
    dev = h("form", { class: "dev-form", novalidate: true },
      h("div", { class: "divider" }, h("span", null, "dev server only")),
      h("div", { class: "field" }, h("label", { for: "dev-email" }, "Email"), email),
      h("div", { class: "field" }, h("label", { for: "dev-name" }, "Name ", h("span", { class: "opt" }, "(optional)")), name),
      submit, status);
    dev.addEventListener("submit", async (e) => {
      e.preventDefault();
      status.textContent = "";
      if (!email.value || !email.checkValidity()) { status.textContent = "Enter a valid email."; email.focus(); return; }
      submit.disabled = true; submit.classList.add("busy");
      try {
        const body = { email: email.value.trim() };
        if (name.value.trim()) body.display_name = name.value.trim();
        await post("/app/v1/auth/dev-login", body);
        await afterSignIn();
        toast(`Signed in as ${app.me?.account.display_name || body.email}.`);
        navigate(returnTo, { replace: true });
      } catch (err) {
        status.textContent = errorText(err);
        submit.disabled = false; submit.classList.remove("busy");
      }
    });
  }

  const el = h("section", { class: "page auth-page" },
    h("div", { class: "auth-card card" },
      h("div", { class: "auth-art", "aria-hidden": "true" },
        h("div", { class: "mini-table" }, h("span", { class: "mini-top" }),
          avatar("claude-code", { size: 40, cls: "mt-a" }), avatar("codex", { size: 40, cls: "mt-b" }), avatar("empty", { size: 40, cls: "mt-c" }))),
      h("h1", { class: "h1" }, reauth ? "Confirm it's you." : "Your seat is waiting."),
      h("p", { class: "lead small" }, reauth
        ? "Sign in again so bot-link knows a person is approving, not an agent."
        : "Sign in to start a room or to see who's waiting to come in."),
      loadErr ? h("p", { class: "form-status" }, errorText(loadErr)) : null,
      buttons.length ? h("div", { class: "provider-list" }, buttons) : null,
      !loadErr && !providers.length ? h("p", { class: "muted" }, "Sign-in isn't set up on this server yet.") : null,
      dev,
      h("p", { class: "fine" }, icon("shield", { size: 16 }), "We only use your verified email to tell people who invited whom. No posting, no repo access.")));
  return { el, title: reauth ? "Confirm it's you" : "Sign in" };
}
