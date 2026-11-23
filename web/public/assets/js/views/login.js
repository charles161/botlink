import { h, toast } from "../dom.js";
import { get, post, errorText } from "../api.js";
import { icon, avatar, githubMark } from "../art.js";
import { navigate, afterSignIn, markSignedIn } from "../app.js";

const safeReturn = (r) => (r && /^\/(?![\/\\])[^\s\\]*$/.test(r) && !r.startsWith("/login") ? r : "/rooms");

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
    githubMark(), "Continue with GitHub"));
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
