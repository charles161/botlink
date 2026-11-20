// Back from the payment page (/billing?checkout=<id>): the plan changes only when the payment service confirms it
// to the server, never because the browser came back. So this page asks the server for a few seconds and says
// plainly when it is still waiting. /billing/fake is the test payment page (BOTLINK_BILLING_GATEWAY=fake, dev only).
import { h, fill, toast } from "../dom.js";
import { get, post, errorText } from "../api.js";
import { icon } from "../art.js";
import { navigate } from "../app.js";
import { planErrorText, recallCheckout, forgetCheckout, num } from "../plans-util.js";

const POLL_MS = 1500;
const TRIES = 10; // about 15 s, then "still waiting" with a button to check again

const validId = (id) => typeof id === "string" && /^[\w-]{1,100}$/.test(id);

function fakePay(id) {
  const status = h("p", { class: "form-status", role: "status", "aria-live": "polite" });
  const pay = h("button", { type: "button", class: "btn btn-primary", "data-autofocus": "" }, h("span", { class: "spinner", "aria-hidden": "true" }), "Pay (test)");
  pay.addEventListener("click", async () => {
    pay.disabled = true; pay.classList.add("busy"); status.textContent = "";
    try {
      await post("/app/v1/billing/fake/pay", { checkout_id: id });
      navigate(`/billing?checkout=${encodeURIComponent(id)}`, { replace: true });
    } catch (e) {
      status.textContent = planErrorText(e);
      pay.disabled = false; pay.classList.remove("busy");
    }
  });
  const el = h("section", { class: "page page-narrow bill-page" },
    h("div", { class: "card bill-card" },
      h("p", { class: "kicker" }, "Test payment"),
      h("h1", { class: "h1" }, "Pay (test)"),
      h("p", { class: "lead small" }, "This is the test payment page. No card is asked for and no money moves. The server confirms the payment to itself, the same way the payment service would."),
      h("div", { class: "row-actions" }, pay, h("a", { href: "/usage", class: "btn btn-ghost" }, "Cancel")),
      status));
  return { el, title: "Test payment" };
}

function fakePortal() {
  const el = h("section", { class: "page page-narrow bill-page" },
    h("div", { class: "card bill-card" },
      h("p", { class: "kicker" }, "Test billing"),
      h("h1", { class: "h1" }, "Manage billing (test)"),
      h("p", { class: "lead small" }, "With real payments on, this is where you change your card, switch between monthly and yearly, or cancel. The test payment setup has nothing to change."),
      h("div", { class: "row-actions" }, h("a", { href: "/usage", class: "btn btn-primary", "data-autofocus": "" }, "Back to your plan"))));
  return { el, title: "Manage billing (test)" };
}

export default async function billing({ query }) {
  const id = query.get("checkout");
  if (location.pathname.replace(/\/$/, "") === "/billing/fake/portal") return fakePortal();
  if (location.pathname.replace(/\/$/, "") === "/billing/fake") {
    if (validId(id)) return fakePay(id);
  }
  if (!validId(id)) {
    const mod = await import("./usage.js");
    return mod.default();
  }

  const want = recallCheckout(id); // {id, product, balance} from this tab, if it started the checkout
  const credits = want?.product === "credits_pack";
  const title = h("h1", { class: "h1" }, "Checking your payment");
  const lead = h("p", { class: "lead small" }, credits ? "Your credits are added once the payment service confirms the payment." : "Your plan changes once the payment service confirms the payment.");
  const status = h("p", { class: "bill-status", role: "status", "aria-live": "polite" });
  const actions = h("div", { class: "row-actions" });
  const el = h("section", { class: "page page-narrow bill-page" },
    h("div", { class: "card bill-card" }, h("p", { class: "kicker" }, "Payment"), title, lead, status, actions));

  let timer = null, stopped = false, tries = 0;
  const done = (p) => {
    forgetCheckout();
    if (credits) {
      title.textContent = "Credits added";
      lead.textContent = `Your balance is ${num(p.credits?.balance)} credits.`;
    } else {
      title.textContent = `You're on ${p.plan?.name || "Pro"}`;
      lead.textContent = "Your new limits apply now.";
    }
    status.replaceChildren(icon("check", { size: 18 }), " Payment confirmed.");
    status.classList.add("is-done");
    fill(actions, h("a", { href: "/usage", class: "btn btn-primary" }, "See your plan"));
  };
  const waiting = () => {
    status.replaceChildren(h("span", { class: "bill-spin", "aria-hidden": "true" }), "Waiting for the payment to confirm…");
    fill(actions, h("a", { href: "/usage", class: "btn btn-ghost" }, "Back to your plan"));
  };
  const stillWaiting = () => {
    status.replaceChildren(icon("clock", { size: 18 }), " Still waiting for the payment to confirm. It can take a minute. Nothing changes until it does.");
    const again = h("button", { type: "button", class: "btn btn-primary" }, icon("refresh", { size: 18 }), "Check again");
    again.addEventListener("click", () => { tries = 0; waiting(); check(); });
    fill(actions, again, h("a", { href: "/usage", class: "btn btn-ghost" }, "Back to your plan"));
  };
  async function check() {
    if (stopped) return;
    tries++;
    try {
      const p = await get("/app/v1/plan");
      if (stopped) return;
      const ok = credits ? (p.credits?.balance ?? 0) > (want.balance ?? 0) : p.plan?.id && p.plan.id !== "free";
      if (ok) { done(p); return; }
    } catch (e) {
      if (e.status === 401) return;
      if (tries >= TRIES) { toast(errorText(e), "error"); }
    }
    if (stopped) return;
    if (tries >= TRIES) stillWaiting();
    else timer = setTimeout(check, POLL_MS);
  }
  waiting();
  check();
  return { el, title: "Payment", cleanup: () => { stopped = true; clearTimeout(timer); } };
}
