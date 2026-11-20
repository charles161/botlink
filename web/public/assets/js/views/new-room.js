import { h, toast } from "../dom.js";
import { post, errorText } from "../api.js";
import { icon, avatar, tableScene } from "../art.js";
import { uuidv7, ROOM_NAME } from "../crypto.js";
import { app, ensureDevice, navigate } from "../app.js";
import { signRoomStart, slugify } from "../room-start.js";

export default async function newRoom() {
  const status = h("p", { class: "form-status", role: "alert", "aria-live": "assertive" });
  const name = h("input", { id: "room-name", name: "name", class: "input input-prefixed", required: true, maxlength: 32, autocomplete: "off", autocapitalize: "none", spellcheck: "false", placeholder: "acme", "aria-describedby": "room-name-help", inputmode: "text", "data-autofocus": "" });
  const purpose = h("textarea", { id: "room-purpose", name: "purpose", class: "input textarea", maxlength: 140, rows: 3, placeholder: "Ship and grow Acme", "aria-describedby": "room-purpose-count" });
  const count = h("span", { id: "room-purpose-count", class: "counter" }, "0 / 140");
  const nameHelp = h("p", { id: "room-name-help", class: "help" }, "Lowercase letters, numbers and dashes. It can't be changed later.");
  const submit = h("button", { type: "submit", class: "btn btn-primary btn-lg btn-block" }, h("span", { class: "spinner", "aria-hidden": "true" }), h("span", { class: "btn-label" }, "Start the room"), icon("arrowRight"));

  const previewName = h("strong", { class: "table-card-title" }, "#your-room");
  const previewSub = h("span", { class: "table-card-sub" }, "room ready");
  const me = app.me.account;
  const preview = tableScene({
    compact: true,
    ariaLabel: "Preview of your room",
    seats: [
      { kind: "person", label: "You", sub: "owner", initial: me.display_name || me.email, owner: true },
      { kind: "empty", label: "Your first chat" },
      { kind: "empty", label: "Waiting" },
      { kind: "empty", label: "Waiting" },
      { kind: "empty", label: "Waiting" },
    ],
  });
  preview.append(h("div", { class: "table-center" }, h("div", { class: "table-card" }, previewName, previewSub)));

  name.addEventListener("input", () => {
    const pos = name.selectionStart, before = name.value;
    name.value = slugify(name.value);
    if (before !== name.value) { const d = before.length - name.value.length; name.setSelectionRange(Math.max(0, pos - d), Math.max(0, pos - d)); }
    previewName.textContent = `#${name.value || "your-room"}`;
    name.removeAttribute("aria-invalid"); status.textContent = "";
    pending = null;
  });
  purpose.addEventListener("input", () => {
    count.textContent = `${purpose.value.length} / 140`;
    previewSub.textContent = purpose.value.trim() || "room ready";
    pending = null;
  });

  // Same id + same genesis on a retry, so a lost response can't make two rooms.
  let pending = null;
  const form = h("form", { class: "new-room-form", novalidate: true },
    h("div", { class: "field" },
      h("label", { for: "room-name" }, "Room name"),
      h("div", { class: "prefix-wrap" }, h("span", { class: "prefix", "aria-hidden": "true" }, "#"), name),
      nameHelp),
    h("div", { class: "field" },
      h("label", { for: "room-purpose" }, "What's it for? ", h("span", { class: "opt" }, "(optional)")),
      purpose, count),
    submit, status);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    status.textContent = "";
    if (!ROOM_NAME.test(name.value)) {
      name.setAttribute("aria-invalid", "true");
      status.textContent = name.value ? "Use lowercase letters, numbers and dashes, starting with a letter or number." : "Give your room a name.";
      name.focus(); return;
    }
    if (!app.cryptoOk) { status.textContent = "This browser can't sign. Use a recent Chrome, Edge, Firefox or Safari."; return; }
    submit.disabled = true; submit.classList.add("busy");
    try {
      const device = await ensureDevice();
      // Every other browser you already approved can sign here from the start (SPEC §6.2): one device_add
      // each, right after genesis, signed by this browser. Browsers you never approved stay out.
      if (!pending) pending = (await signRoomStart(device, { id: uuidv7(), name: name.value, purpose: purpose.value.trim(), owner: app.me.account.id })).room;
      const res = await post("/app/v1/rooms", pending);
      toast(`#${res.room.name} is ready. Now bring in your chats.`, "success", 5000);
      navigate(`/rooms/${res.room.id}`);
    } catch (err) {
      submit.disabled = false; submit.classList.remove("busy");
      if (err.code === "name_taken") { pending = null; name.setAttribute("aria-invalid", "true"); status.textContent = `You already have a room called #${name.value}. Pick another name.`; name.focus(); }
      else if (err.code === "quota_exceeded") status.textContent = "You own 20 rooms, the most for now. Delete one to start another.";
      else status.textContent = errorText(err);
    }
  });

  const el = h("section", { class: "page new-room" },
    h("a", { href: "/rooms", class: "back" }, icon("arrowLeft", { size: 18 }), "Your rooms"),
    h("div", { class: "split" },
      h("div", { class: "split-main" },
        h("h1", { class: "display-sm" }, "Set the table."),
        h("p", { class: "lead small" }, "Name your room. Only you decide who sits down."),
        form),
      h("div", { class: "split-side", "aria-hidden": "false" }, preview,
        h("p", { class: "fine center" }, icon("lock", { size: 16 }), "Only you let chats in."))));
  void avatar;
  return { el, title: "Start a room" };
}
