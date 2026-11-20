// Admin: stored messages (inside the admin view, behind its unlock, in every mode). How full the server's store of
// sealed copies is, the accounts storing the most, and the stop for one account: refuse its sends, and optionally
// drop what it stores now. Loaded once per unlock and after each change, not on the overview's 5 s refresh.
// API: GET /app/v1/admin/storage, POST /app/v1/admin/account/sends.
import { h, fill, toast } from "../dom.js";
import { get, post, errorText } from "../api.js";
import { icon } from "../art.js";
import { confirmDialog } from "../humancheck.js";

const LEVEL = { ok: "Room to spare", warn: "Over half full", high: "Nearly full" };
const KB = 1024, MB = KB * 1024, GB = MB * 1024;
const size = (b) => (b >= GB ? `${(b / GB).toFixed(1)} GB` : b >= MB ? `${(b / MB).toFixed(1)} MB` : b > 0 ? `${Math.max(1, Math.round(b / KB))} KB` : "0 MB");
let uid = 0;

function table(label, cols, rows, empty) {
  if (!rows.length) return h("p", { class: "muted adm-empty" }, empty);
  return h("div", { class: "adm-table-wrap" },
    h("table", { class: "adm-table storage-list", "aria-label": label },
      h("thead", null, h("tr", null, cols.map((c) => h("th", { scope: "col", class: c.num ? "num" : null }, c.label)))),
      h("tbody", null, rows.map((r) => h("tr", { class: r._cls, "data-account": r.account_id }, cols.map((c) => h("td", { "data-label": c.label, class: c.num ? "num" : null }, c.get(r))))))));
}

export function storageSection({ onLocked }) {
  const box = h("div", { class: "panel-body" });
  const el = h("section", { id: "storage", class: "adm-storage", hidden: true, "aria-labelledby": "storage-title" },
    h("div", { class: "adm-storage-head" },
      h("h2", { class: "h2", id: "storage-title" }, "Stored messages"),
      h("p", { class: "lead small" }, "Sealed copies wait on the server until the chats they are for read them or they expire. When the server is full, nobody can send.")),
    h("section", { class: ["panel", "adm-panel", "storage-panel"] },
      h("div", { class: "panel-head" }, h("h2", null, icon("alert"), "Who stores the most"), h("span", { class: "panel-meta" }, "top 20")),
      box));
  const jump = h("a", { href: "#storage", class: "chip", hidden: true, "data-native": "" }, icon("book", { size: 18 }), "Stored messages");
  let loaded = false;

  async function stop(row) {
    const refuse = !row.sends_refused;
    const id = `st-${++uid}`;
    const reason = h("input", { id: `${id}-reason`, class: "input", type: "text", name: "reason", maxlength: 300, autocomplete: "off", placeholder: "Why (kept in the server's log)" });
    const purge = refuse ? h("input", { id: `${id}-purge`, type: "checkbox", name: "purge" }) : null;
    const body = h("div", { class: "storage-form" },
      h("p", { class: "modal-lead" }, refuse
        ? `${row.display_name}'s chats can't send messages until you allow it again.`
        : `${row.display_name}'s chats can send messages again.`),
      h("div", { class: "field" }, h("label", { for: reason.id }, "Reason"), reason),
      refuse ? h("label", { class: "adm-check", for: purge.id }, purge, h("span", null, "Also drop what this account stores now. Messages no chat has read yet are dropped, and the chats that sent them see them as expired.")) : null);
    let locked = false, res = null;
    const ok = await confirmDialog({
      title: refuse ? "Refuse sends" : "Allow sends", body, danger: refuse,
      confirmLabel: refuse ? "Refuse sends" : "Allow sends",
      onConfirm: async () => {
        const why = reason.value.trim();
        if (!why) { reason.focus(); throw Object.assign(new Error("reason"), { userMessage: "Give a reason." }); }
        try {
          res = await post("/app/v1/admin/account/sends", { account_id: row.account_id, refused: refuse, purge: !!purge?.checked, reason: why });
        } catch (e) { if (e.code === "admin_locked") locked = true; throw e; }
      },
    });
    if (locked) { onLocked(); return; }
    if (!ok || !res) return;
    toast(refuse ? `Sends refused for ${row.display_name}.${res.freed_bytes ? ` Freed ${size(res.freed_bytes)}.` : ""}` : `${row.display_name} can send again.`);
    load();
  }

  async function load() {
    try {
      const { storage: s } = await get("/app/v1/admin/storage");
      const action = (r) => {
        const b = h("button", { type: "button", class: ["btn", "btn-sm", r.sends_refused ? "btn-ghost" : "btn-danger"] }, r.sends_refused ? "Allow sends" : "Refuse sends");
        b.addEventListener("click", () => stop(r));
        return b;
      };
      fill(box,
        h("dl", { class: "adm-kv" },
          h("div", null, h("dt", null, "Whole server"), h("dd", null,
            `${size(s.total_bytes)} of ${size(s.ceiling_bytes)} (${s.pct}%) `,
            h("span", { class: ["badge", "adm-badge", `storage-${s.level}`] }, LEVEL[s.level] || s.level))),
          h("div", null, h("dt", null, "Each account"), h("dd", null, `up to ${size(s.account_ceiling_bytes)}`))),
        table("Accounts storing the most", [
          { label: "Person", get: (r) => h("span", null, h("b", null, r.display_name), " ", h("span", { class: "adm-mail muted" }, r.email || "")) },
          { label: "Stored", num: true, get: (r) => size(r.bytes) },
          { label: "Sends", get: (r) => (r.sends_refused ? h("strong", { class: "storage-refused" }, "Refused") : "Allowed") },
          { label: "", get: action },
        ], (s.top || []).map((r) => ({ ...r, _cls: r.sends_refused ? "is-bad" : null })), "No account stores anything right now."));
    } catch (e) {
      if (e.code === "admin_locked") onLocked();
      else fill(box, h("div", { class: "error-box", role: "alert" }, h("p", null, errorText(e))));
    }
  }

  return {
    el, jump,
    show() { el.hidden = false; jump.hidden = false; if (!loaded) { loaded = true; load(); } },
    hide() { el.hidden = true; jump.hidden = true; loaded = false; },
  };
}
