import { utcSchedule, localSchedule } from "/reminder-time.js";
import { ui, M, C, H } from "/ui-runtime.js";
import {
  layouts,
  roleDefaults,
  layoutLabels,
  viewLabels,
  designControls,
} from "./ui-system.js";
import {
  newCard,
  cardFields,
  cardFonts,
  renderCard,
  cardTextLines,
  populateField,
  cardFieldLabels,
} from "./card-system.js";
import { copyCatalog } from "./ui-copy.js";
export function featureTools(ctx) {
  const {
    state,
    api,
    modal,
    button,
    field,
    area,
    select,
    escape,
    notify,
    saved,
    load,
    fileData,
    selectedEvent,
  } = ctx;
  let editingPrivate = false;
  let editingUI,
    editingCard,
    cardContext = {},
    qrData = "",
    dragIndex = null,
    reminderVersion;
  const role = () => state.session.role;
  const options = () => [
    ["", C("None")],
    ...state.data.events.map((e) => [e.id, e.title]),
  ];
  const cardOptions = () =>
    role() === "admin"
      ? []
      : state.data.guests.map((g) => [
          g.id,
          [g.first, g.last, g.suffix].filter(Boolean).join(" "),
        ]);
  const designFields = (d) => designControls(d, { field, select, label: H });
  async function uiEditor(scope = "global", key = "") {
    const path =
      scope === "global"
        ? "/api/admin/defaults"
        : `/api/${role()}/interface/${scope}/${key}`;
    const result = await api(path);
    editingUI = { path, ...result, scope, key };
    const d = result.ui.design,
      c = result.overrides.copy || {};
    modal(
      scope === "global"
        ? C("Global page defaults")
        : `${scope === "household" ? C("Household") : C("Event")} page settings`,
      ui`${scope === "global" ? M("<p>Global defaults. Explicit household and event choices are preserved.</p>") : M("<p>Changes apply only to this ") + scope + ".</p>"}${result.record && scope === "household" ? field(H("Household title"), "contentName", result.record.name) : ""}${result.record && scope === "event" ? `${field(H("Event title"), "contentTitle", result.record.title)}${area(H("Event description"), "contentDescription", result.record.description)}` : ""}<details open><summary>Role formatting</summary>${designFields(d)}${scope !== "global" ? M('<label class="check"><input name="resetDesign" type="checkbox">Reset appearance to inherited defaults</label>') : ""}</details><details><summary>Page wording</summary>${field(H("Find interface text"), "copySearch", "", "search", "data-copy-search")}<p>Leave wording equal to its default to inherit. Saved words remain separate from formatting.</p><div class="copy-editor">${copyCatalog.map((key) => ui`<label data-copy-key="${escape(key)}">${escape(key)}<textarea aria-label="Default wording: ${escape(key)}" name="copy:${escape(key)}">${escape(c[key] ?? result.ui.copy[key] ?? key)}</textarea></label>`).join("")}</div></details><details><summary>Container and button layout</summary><p>Drag rows, or use Move up / Move down with a keyboard or touch.</p>${Object.entries(
        result.ui.layouts,
      )
        .map(
          ([view, items]) =>
            ui`<fieldset data-layout="${view}"><legend>${H(viewLabels[view] || view)}</legend><ol class="layout-list">${items.map((item) => ui`<li draggable="true" data-layout-item="${item}"><span>${H(layoutLabels[item] || item)}</span>${button("layout-up", H("Move up"), "", "quiet")}${button("layout-down", H("Move down"), "", "quiet")}</li>`).join("")}</ol></fieldset>`,
        )
        .join("")}</details>`,
      "ui-settings",
    );
  }
  function readDesign(form, base) {
    const fd = new FormData(form),
      d = { ...base };
    for (const key of Object.keys(roleDefaults)) {
      if (key === "backgroundImage") continue;
      if (fd.has(key))
        d[key] =
          typeof roleDefaults[key] === "number"
            ? Number(fd.get(key))
            : fd.get(key);
    }
    return d;
  }
  async function chooseScope(preview = false) {
    const data = await api("/api/admin/households");
    state.previewHouseholds = data;
    modal(
      preview ? C("Preview guest pages") : C("Choose an editing scope"),
      ui`${select(
        H("Household"),
        "previewHousehold",
        data.map((h) => [h.id, h.name]),
        data[0]?.id,
      )}<div id="preview-events"></div>${preview ? M("<p>Read-only guest preview: no RSVP, messages or guest-data changes.</p>") : ""}`,
      preview ? "admin-preview" : "choose-scope",
      preview ? C("Preview") : C("Open editor"),
    );
    updateScopeEvents();
  }
  function updateScopeEvents() {
    const h = state.previewHouseholds?.find(
      (h) => h.id === document.querySelector("[name=previewHousehold]")?.value,
    );
    const el = document.querySelector("#preview-events");
    if (el)
      el.innerHTML = select(
        H("Event (optional)"),
        "previewEvent",
        [
          ["", C("Household home")],
          ["__login__", C("Guest login page")],
          ...(h?.events || []).map((e) => [e.id, e.title]),
        ],
        "",
      );
  }
  async function cards() {
    const records = await api(
      role() === "admin" ? "/api/admin/templates" : "/api/host/cards",
    );
    const templates =
      role() === "admin"
        ? records
        : [...state.templates, ...(await api("/api/host/private-templates"))];
    modal(
      role() === "admin"
        ? C("Shared card templates")
        : C("Your cards & templates"),
      ui`<p>One editor for invitations, thank-you cards and holiday cards. Use a desktop or larger tablet for detailed layout work.</p>${button("new-card", H("Create card / template"), "", "")}<h3>${role() === "admin" ? C("Shared templates") : C("Saved cards")}</h3><ul>${records.map((r) => ui`<li>${escape(r.name)} ${button("edit-card", H("Open"), `data-id="${r.id}"`, "quiet")}${button("remove-card", H("Remove"), `data-id="${r.id}"`, "quiet")}</li>`).join("") || M("<li>Nothing saved yet.</li>")}</ul>${role() === "host" ? ui`<h3>Start from a template</h3><div class="stack">${templates.map((t) => button("use-card-template", escape(t.name), `data-id="${t.id}"`)).join("")}</div>` : ""}`,
    );
    state.cardPrivateTemplates =
      role() === "host"
        ? templates.filter(
            (t) => !state.templates.some((shared) => shared.id === t.id),
          )
        : [];
    state.cardRecords = records;
    state.cardTemplates = templates;
    if (role() === "host" && state.cardPrivateTemplates.length)
      document
        .querySelector("#editor .dialog-body")
        .insertAdjacentHTML(
          "beforeend",
          ui`<h3>Private template editing</h3>${state.cardPrivateTemplates.map((t) => button("edit-private-template", escape(t.name), `data-id="${t.id}"`)).join("")}`,
        );
  }
  function normalizeCard(card) {
    return {
      ...newCard(card.name),
      ...card,
      background: card.background ?? card.image ?? "",
      elements: structuredClone(card.elements ?? newCard().elements),
    };
  }
  async function cardEditor(
    card = newCard(),
    source = false,
    privateTemplate = false,
  ) {
    editingPrivate = privateTemplate;
    editingCard = normalizeCard(card);
    if (source) {
      delete editingCard.id;
      delete editingCard.version;
      editingCard.sourceTemplate = card.id;
    }
    cardContext = editingCard.context || {
      household: { name: state.data.household?.name || "Your household" },
      event: selectedEvent() || { title: "An event", date: "2028-06-12" },
      recipient: {
        name: "Recipient name",
        first: C("Recipient"),
        last: "Name",
        address: "Address",
      },
    };
    qrData = role() === "host" ? await qrURL() : "";
    drawCardEditor();
  }
  async function qrURL() {
    const response = await fetch("/api/host/qr", {
      credentials: "same-origin",
    });
    if (!response.ok) throw new Error("Could not load household QR.");
    return "data:image/svg+xml;base64," + btoa(await response.text());
  }
  function drawCardEditor() {
    const card = editingCard;
    modal(
      role() === "admin" ? C("Edit shared template") : C("Edit your card"),
      ui`<p>Drag a field in the preview; use numeric positions and Move controls for touch/keyboard. Text bounds are guides—check long names before printing.</p><div class="card-workspace"><div id="card-canvas" tabindex="0" aria-label="Card preview"></div><div class="card-controls">${field(H("Card name"), "cardName", card.name, "text", 'required maxlength="100"')}${select(
        H("Card type"),
        "cardKind",
        [
          ["invitation", C("Invitation")],
          ["thank-you", C("Thank-you")],
          ["holiday", C("Holiday")],
        ],
        card.kind,
      )}${role() === "host" ? `${select(H("Populate from event"), "cardEvent", options(), card.event || state.event || "")}${select(H("Recipient"), "cardRecipient", [["", C("No recipient")], ...cardOptions()], card.recipient || "")}` : ""}${field(H("Background artwork"), "cardBackground", "", "file", 'accept="image/png,image/jpeg,image/webp"')}<label class="check"><input name="removeCardBackground" type="checkbox">Remove background artwork</label>${field(H("Card background color"), "cardColor", card.color, "color")}<div class="form-grid">${field(H("Canvas width"), "cardWidth", card.width, "number", 'min="300" max="2400"')}${field(H("Canvas height"), "cardHeight", card.height, "number", 'min="300" max="2400"')}</div><label class="check"><input name="includeQR" type="checkbox" ${card.includeQR ? "checked" : ""}>Include QR code</label>${role() === "host" ? M('<label class="check"><input name="savePrivateTemplate" type="checkbox">Save as a reusable private template</label>') : ""}<div id="card-fields">${card.elements
        .map(
          (e, index) =>
            ui`<fieldset data-card-index="${index}"><legend>Field ${index + 1}</legend>${select(
              H("Dynamic field"),
              "field",
              cardFields.map((f) => [f, C(cardFieldLabels[f])]),
              e.field,
            )}${area(H("Text / fallback"), "fieldText", e.field === "text" ? e.text : e.fallback)}<div class="form-grid">${["x", "y", "width", "height", "fontSize"].map((k) => field(C({ x: "Horizontal position", y: "Vertical position", width: "Box width", height: "Box height", fontSize: "Text size" }[k]), k, e[k], "number", `min="${k === "fontSize" ? 8 : 0}" max="2400"`)).join("")}${field(H("Text color"), "color", e.color, "color")}${select(
              H("Font"),
              "font",
              cardFonts.map((f) => [f, f]),
              e.font,
            )}${select(
              H("Alignment"),
              "align",
              [
                ["left", C("Left")],
                ["center", C("Center")],
                ["right", C("Right")],
              ],
              e.align,
            )}</div><label class="check"><input name="bold" type="checkbox" ${e.bold ? "checked" : ""}>Bold</label>${button("remove-card-field", H("Remove field"), `data-index="${index}"`, "quiet")}</fieldset>`,
        )
        .join(
          "",
        )}</div>${button("add-card-field", H("Add field"))}<hr>${field(H("Print quantity"), "printQuantity", 1, "number", 'min="1" max="50"')}<p class="small muted">One card per printed page; quantity generates that many pages. Paper size, scaling and printer copies remain in your print dialog.</p><div class="row">${button("download-card", H("Download SVG"))}${button("download-png", "Download PNG")}${button("print-card", H("Print cards"))}${button("share-card", H("Share / text"))}${button("email-card", H("Email composer"))}</div></div></div>`,
      "card",
      role() === "admin" ? C("Save shared template") : C("Save card"),
    );
    refreshCard();
  }
  function collectCard() {
    const form = document.querySelector("form[data-form=card]");
    if (!form) return;
    const fd = new FormData(form);
    Object.assign(editingCard, {
      name: fd.get("cardName"),
      kind: fd.get("cardKind"),
      width: Number(fd.get("cardWidth")),
      height: Number(fd.get("cardHeight")),
      color: fd.get("cardColor"),
      includeQR: fd.has("includeQR"),
      event: fd.get("cardEvent") || "",
      recipient: fd.get("cardRecipient") || "",
    });
    if (fd.has("removeCardBackground")) editingCard.background = "";
    editingCard.elements = [...form.querySelectorAll("[data-card-index]")].map(
      (row, index) => {
        const value = (name) => row.querySelector(`[name="${name}"]`).value;
        const existing = editingCard.elements[index];
        return {
          ...existing,
          field: value("field"),
          text: value("field") === "text" ? value("fieldText") : "",
          fallback: value("field") === "text" ? "" : value("fieldText"),
          ...Object.fromEntries(
            ["x", "y", "width", "height", "fontSize"].map((k) => [
              k,
              Number(value(k)),
            ]),
          ),
          font: value("font"),
          color: value("color"),
          align: value("align"),
          bold: row.querySelector("[name=bold]").checked,
        };
      },
    );
    if (role() === "host") {
      const event = state.data.events.find((e) => e.id === editingCard.event),
        recipient = state.data.guests.find(
          (g) => g.id === editingCard.recipient,
        ),
        address = state.data.addresses.find((a) => a.id === recipient?.address);
      cardContext = {
        household: { name: state.data.household.name },
        event: event || {},
        recipient: recipient
          ? {
              name: [recipient.first, recipient.last, recipient.suffix]
                .filter(Boolean)
                .join(" "),
              first: recipient.first,
              last: recipient.last,
              address: address?.lines || "",
            }
          : {},
      };
    }
  }
  function refreshCard() {
    const target = document.querySelector("#card-canvas");
    if (!target) return;
    target.innerHTML = renderCard(editingCard, cardContext, qrData);
    const clipped = editingCard.elements.some(
      (e) =>
        e.field !== "qr" &&
        cardTextLines(populateField(e, cardContext), e.width, e.fontSize)
          .length *
          e.fontSize *
          1.3 >
          e.height,
    );
    let warning = document.querySelector("#card-fit-warning");
    if (!warning) {
      warning = document.createElement("p");
      warning.id = "card-fit-warning";
      warning.className = "small muted";
      target.after(warning);
    }
    warning.textContent = clipped
      ? "Some text may be clipped. Increase the field height or reduce its size before exporting."
      : "";
  }
  function cardSVG() {
    collectCard();
    return renderCard(editingCard, cardContext, qrData);
  }
  function download() {
    const blob = new Blob([cardSVG()], { type: "image/svg+xml" }),
      url = URL.createObjectURL(blob),
      a = document.createElement("a");
    a.href = url;
    a.download = editingCard.name.replace(/[^a-z0-9-]/gi, "-") + ".svg";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    notify(C("Card downloaded."));
  }
  async function pngCard() {
    const svg = cardSVG(),
      image = new Image();
    image.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = editingCard.width;
    canvas.height = editingCard.height;
    canvas.getContext("2d").drawImage(image, 0, 0);
    return new Promise((resolve, reject) =>
      canvas.toBlob(
        (blob) =>
          blob
            ? resolve(blob)
            : reject(new Error("Unable to export this card.")),
        "image/png",
      ),
    );
  }
  function print() {
    const svg = cardSVG(),
      quantity = Math.max(
        1,
        Math.min(
          50,
          Number(document.querySelector("[name=printQuantity]").value),
        ),
      );
    const frame = document.createElement("iframe");
    frame.className = "print-frame";
    document.body.append(frame);
    frame.contentDocument.open();
    frame.contentDocument.write(
      M(
        "<!doctype html><title>Print cards</title><style>@page{margin:10mm}.copy{break-after:page;display:grid;place-items:center;height:90vh}.copy:last-child{break-after:auto}svg{max-width:100%;max-height:100%}</style>",
      ) +
        Array.from(
          { length: quantity },
          () => ui`<div class="copy">${svg}</div>`,
        ).join(""),
    );
    frame.contentDocument.close();
    frame.contentWindow.focus();
    frame.contentWindow.print();
    setTimeout(() => frame.remove(), 60000);
  }
  async function reminders() {
    const event = selectedEvent(),
      data = await api(`/api/host/events/${event.id}/reminders`);
    reminderVersion = event.version;
    state.editingReminders = data.reminders;
    modal(
      C("Text reminders"),
      ui`<p>${data.configured ? C("Messaging provider configured. Enabling a schedule can send real texts.") : C("Messaging is not enabled. Schedules can be saved and previewed, but no texts will send.")}</p><p>Only individually invited adults with an international phone number and recorded SMS consent are eligible. Opt-outs always win.</p><div id="reminder-rows">${data.reminders.map(reminderRow).join("")}</div>${button("add-reminder", H("Add reminder"))}${button("preview-reminders", H("Preview recipients"))}<div id="reminder-preview"></div><h3>Delivery status</h3><ul>${data.deliveries.map((d) => ui`<li>${escape(d.phone)}: ${escape(d.status === "sent" ? "Sent (provider-reported; delivery unconfirmed)" : d.status)}${d.error ? " · " + escape(d.error) : ""}</li>`).join("") || M("<li>No deliveries.</li>")}</ul><p class="small muted">Accepted means the provider accepted a request, not delivered. Unknown outcomes are not retried automatically.</p>`,
      "reminders",
    );
  }
  function reminderRow(r = {}) {
    return ui`<fieldset data-reminder-id="${r.id || crypto.randomUUID()}"><legend>Reminder</legend>${select(
      H("Reminder type"),
      "reminderKind",
      [
        ["rsvp", C("RSVP: no response")],
        ["upcoming", C("Upcoming: attending")],
      ],
      r.kind || "rsvp",
    )}${field(H("Send at (selected time zone)"), "reminderWhen", r.when ? localSchedule(r.when, r.timezone) : "", "datetime-local", "required")}${field(H("Schedule time zone"), "reminderTimezone", r.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone, "text", "required")}${area(H("Message"), "reminderMessage", r.message || "A reminder about our gathering.", 'required maxlength="1200"')}<label class="check"><input name="reminderEnabled" type="checkbox" ${r.enabled ? "checked" : ""}>Enable reminder</label>${button("remove-reminder", H("Remove reminder"), "", "quiet")}</fieldset>`;
  }
  function readReminders() {
    return [...document.querySelectorAll("[data-reminder-id]")].map((row) => ({
      id: row.dataset.reminderId,
      kind: row.querySelector("[name=reminderKind]").value,
      when: utcSchedule(
        row.querySelector("[name=reminderWhen]").value,
        row.querySelector("[name=reminderTimezone]").value,
      ),
      localTime: row.querySelector("[name=reminderWhen]").value,
      timezone: row.querySelector("[name=reminderTimezone]").value,
      message: row.querySelector("[name=reminderMessage]").value,
      enabled: row.querySelector("[name=reminderEnabled]").checked,
    }));
  }
  async function deletion(key) {
    const summary = await api(`/api/admin/hosts/${key}/deletion`);
    state.deletingHost = { key, ...summary };
    modal(
      C("Permanently delete host"),
      ui`<p><strong>${escape(summary.email)}</strong></p><p>Affected domain: ${escape(summary.domain || "No household domain")}</p><p>${escape(summary.scope)}</p><ul>${Object.entries(
        summary.counts,
      )
        .map(([k, v]) => ui`<li>${k}: ${v}</li>`)
        .join(
          "",
        )}</ul>${field(H("Type the host email to confirm"), "confirmEmail", "", "email", "required")}${field(H("Type the affected domain (leave blank if none)"), "confirmDomain")}`,
      "delete-host",
      C("Permanently delete host"),
    );
  }
  return {
    uiEditor,
    cards,
    async invitation() {
      const event = selectedEvent(),
        records = await api("/api/host/cards");
      const saved = records.findLast(
        (r) =>
          r.event === event.id &&
          r.kind === "invitation" &&
          r.sourceTemplate === (event.template || ""),
      );
      if (saved) {
        await cardEditor(saved);
        return;
      }
      const source =
        state.templates.find((t) => t.id === event.template) ||
        newCard(event.title);
      await cardEditor(
        { ...source, event: event.id, sourceTemplate: event.template || "" },
        true,
      );
    },
    adminPanel: () =>
      ui`<section class="panel"><h2>Shared design & pages</h2><div class="row">${button("global-defaults", H("Edit global defaults"))}${button("scoped-editor", H("Edit household / event pages"))}${button("preview-guest", H("Preview guest experience"))}${button("cards", H("Cards & templates"))}</div><p>Content, formatting and layout are separate. Preview never submits guest data.</p>${(state.data.deletions || []).length ? ui`<h3>Account cleanup</h3><ul>${state.data.deletions.map((job) => ui`<li>${escape(job.email || job.label || "Deleted household")}: ${escape(job.phase)} ${job.error ? escape(job.error) : ""}</li>`).join("")}</ul>` : ""}</section>`,
    async action(action, target) {
      const key = target.dataset.id;
      if (action === "global-defaults") {
        await uiEditor();
        return true;
      }
      if (action === "scoped-editor" || action === "preview-guest") {
        await chooseScope(action === "preview-guest");
        return true;
      }
      if (action === "host-ui") {
        await uiEditor(
          state.event ? "event" : "household",
          state.event || state.data.household.id,
        );
        return true;
      }
      if (action === "exit-preview") {
        state.preview = null;
        state.event = null;
        await load();
        return true;
      }
      if (action === "cards") {
        await cards();
        return true;
      }
      if (action === "new-card") {
        await cardEditor();
        return true;
      }
      if (action === "edit-private-template") {
        await cardEditor(
          state.cardPrivateTemplates.find((t) => t.id === key),
          false,
          true,
        );
        return true;
      }
      if (action === "edit-card") {
        await cardEditor(state.cardRecords.find((r) => r.id === key));
        return true;
      }
      if (action === "use-card-template") {
        await cardEditor(
          state.cardTemplates.find((r) => r.id === key),
          true,
        );
        return true;
      }
      if (action === "remove-card") {
        const r = state.cardRecords.find((r) => r.id === key);
        if (!confirm("Remove this saved card or template?")) return true;
        await api(
          (role() === "admin" ? "/api/admin/templates/" : "/api/host/cards/") +
            key,
          { method: "DELETE", version: r.version, data: {} },
        );
        await cards();
        return true;
      }
      if (action === "add-card-field") {
        collectCard();
        editingCard.elements.push({
          ...newCard().elements[0],
          id: crypto.randomUUID(),
          field: "text",
          text: "Your text",
          x: 40,
          y: 40,
        });
        drawCardEditor();
        return true;
      }
      if (action === "remove-card-field") {
        collectCard();
        editingCard.elements.splice(Number(target.dataset.index), 1);
        drawCardEditor();
        return true;
      }
      if (action === "download-png") {
        const blob = await pngCard(),
          url = URL.createObjectURL(blob),
          a = document.createElement("a");
        a.href = url;
        a.download = "card.png";
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        return true;
      }
      if (action === "download-card") {
        download();
        return true;
      }
      if (action === "print-card") {
        print();
        return true;
      }
      if (action === "share-card") {
        const file = new File([await pngCard()], "card.png", {
          type: "image/png",
        });
        if (navigator.canShare?.({ files: [file] }))
          await navigator.share({ files: [file], title: editingCard.name });
        else {
          download();
          notify(
            C(
              "Attach the downloaded card in your text app. No message was sent.",
            ),
          );
        }
        return true;
      }
      if (action === "email-card") {
        download();
        location.href =
          "mailto:?subject=" +
          encodeURIComponent(editingCard.name) +
          "&body=" +
          encodeURIComponent("Please attach the card you downloaded.");
        notify(C("Email composer opened. No email was sent."));
        return true;
      }
      if (action === "layout-up" || action === "layout-down") {
        const row = target.closest("[data-layout-item]");
        if (action === "layout-up" && row.previousElementSibling)
          row.previousElementSibling.before(row);
        if (action === "layout-down" && row.nextElementSibling)
          row.nextElementSibling.after(row);
        return true;
      }
      if (action === "reminders") {
        await reminders();
        return true;
      }
      if (action === "add-reminder") {
        document
          .querySelector("#reminder-rows")
          .insertAdjacentHTML("beforeend", reminderRow());
        return true;
      }
      if (action === "remove-reminder") {
        target.closest("[data-reminder-id]").remove();
        return true;
      }
      if (action === "preview-reminders") {
        const result = await api(
          `/api/host/events/${selectedEvent().id}/reminders`,
          { method: "POST", data: { reminders: readReminders() } },
        );
        document.querySelector("#reminder-preview").innerHTML = result.previews
          .map(
            (r) =>
              ui`<h3>${escape(r.kind)} · ${escape(new Date(r.when).toLocaleString(undefined, { timeZone: r.timezone }))}</h3><p>${escape(r.message)}</p><ul>${r.recipients.map((g) => ui`<li>${escape(g.name)} · ${escape(g.phone)}</li>`).join("") || M("<li>No eligible recipients.</li>")}</ul>`,
          )
          .join("");
        return true;
      }
      if (action === "delete-host") {
        await deletion(key);
        return true;
      }
      return false;
    },
    async submit(form, kind) {
      const fd = new FormData(form);
      if (kind === "ui-settings") {
        const ui = { copy: {}, design: {}, layouts: {} };
        for (const [key, val] of fd)
          if (
            key.startsWith("copy:") &&
            val !== (editingUI.inherited?.copy?.[key.slice(5)] ?? key.slice(5))
          )
            ui.copy[key.slice(5)] = val;
        const d = readDesign(form, editingUI.ui.design),
          uploaded = await fileData(form.elements.backgroundUpload);
        if (uploaded) d.backgroundImage = uploaded;
        for (const [key, value] of Object.entries(d))
          if (
            value !== editingUI.ui.design[key] ||
            key in (editingUI.overrides.design || {})
          )
            ui.design[key] = value;
        for (const group of form.querySelectorAll("[data-layout]")) {
          const layoutValue = [
            ...group.querySelectorAll("[data-layout-item]"),
          ].map((row) => row.dataset.layoutItem);
          if (
            JSON.stringify(layoutValue) !==
            JSON.stringify(
              editingUI.inherited?.layouts?.[group.dataset.layout] ||
                layouts[group.dataset.layout],
            )
          )
            ui.layouts[group.dataset.layout] = layoutValue;
        }
        const data =
          editingUI.scope === "global"
            ? ui
            : {
                ui,
                resetDesign: fd.has("resetDesign"),
                ...(editingUI.scope === "household"
                  ? { content: { name: fd.get("contentName") } }
                  : {
                      content: {
                        title: fd.get("contentTitle"),
                        description: fd.get("contentDescription"),
                      },
                    }),
              };
        await api(editingUI.path, {
          method: "PUT",
          version: editingUI.version,
          data,
        });
        await saved("Page settings saved.");
        return true;
      }
      if (kind === "choose-scope") {
        await uiEditor(
          fd.get("previewEvent") ? "event" : "household",
          fd.get("previewEvent") || fd.get("previewHousehold"),
        );
        return true;
      }
      if (kind === "admin-preview") {
        state.preview = {
          household: fd.get("previewHousehold"),
          event:
            fd.get("previewEvent") === "__login__"
              ? ""
              : fd.get("previewEvent"),
          mode: fd.get("previewEvent") === "__login__" ? "login" : "guest",
        };
        state.event =
          fd.get("previewEvent") === "__login__"
            ? null
            : fd.get("previewEvent") || null;
        await saved("Read-only guest preview.");
        return true;
      }
      if (kind === "card") {
        collectCard();
        const upload = await fileData(form.elements.cardBackground);
        if (upload) editingCard.background = upload;
        if (fd.has("removeCardBackground")) editingCard.background = "";
        const privateTemplate = fd.has("savePrivateTemplate") || editingPrivate,
          base =
            role() === "admin"
              ? "/api/admin/templates"
              : privateTemplate
                ? "/api/host/private-templates"
                : "/api/host/cards";
        const key = privateTemplate && !editingPrivate ? null : editingCard.id;
        await api(base + (key ? "/" + key : ""), {
          method: key ? "PUT" : "POST",
          version: key ? editingCard.version : undefined,
          data: editingCard,
        });
        await saved("Card saved. Source templates remain unchanged.");
        return true;
      }
      if (kind === "reminders") {
        await api(`/api/host/events/${selectedEvent().id}/reminders`, {
          method: "PUT",
          version: reminderVersion,
          data: { reminders: readReminders() },
        });
        await saved("Reminder schedule saved.");
        return true;
      }
      if (kind === "delete-host") {
        const d = state.deletingHost;
        await api(`/api/admin/hosts/${d.key}/deletion`, {
          method: "POST",
          data: {
            confirmEmail: fd.get("confirmEmail"),
            confirmDomain: fd.get("confirmDomain"),
            householdVersion: d.householdVersion,
            confirmRevision: d.revision,
          },
        });
        await saved("Account disabled. Owned routing cleanup is queued.");
        return true;
      }
      if (kind === "household-notes") {
        const h = state.data.household;
        await api("/api/host/household", {
          method: "PUT",
          version: h.version,
          data: { ...h, notes: fd.get("notes") },
        });
        await saved("Private notes saved.");
        return true;
      }
      return false;
    },
    input(event) {
      if (event.target.name === "cardBackground") {
        fileData(event.target)
          .then((value) => {
            if (value) {
              editingCard.background = value;
              refreshCard();
            }
          })
          .catch((error) => notify(error.message));
      }
      const form = event.target.closest("form");
      if (form?.dataset.form === "card") {
        collectCard();
        refreshCard();
      }
      if (event.target.matches("[data-copy-search]"))
        for (const label of document.querySelectorAll("[data-copy-key]"))
          label.hidden = !label.dataset.copyKey
            .toLowerCase()
            .includes(event.target.value.toLowerCase());
      if (event.target.name === "previewHousehold") updateScopeEvents();
    },
    bind() {
      document.addEventListener("dragstart", (event) => {
        const row = event.target.closest("[data-layout-item]");
        if (row) {
          dragIndex = row;
          event.dataTransfer.setData("text/plain", row.dataset.layoutItem);
        }
      });
      document.addEventListener("dragover", (event) => {
        if (event.target.closest("[data-layout-item]")) event.preventDefault();
      });
      document.addEventListener("drop", (event) => {
        const row = event.target.closest("[data-layout-item]");
        if (row && dragIndex && row.parentElement === dragIndex.parentElement) {
          event.preventDefault();
          row.before(dragIndex);
        }
        dragIndex = null;
      });
      let dragging;
      document.addEventListener("pointerdown", (event) => {
        const canvas = event.target.closest("#card-canvas");
        if (!canvas) return;
        const svg = canvas.querySelector("svg"),
          rect = svg.getBoundingClientRect(),
          x = ((event.clientX - rect.left) * editingCard.width) / rect.width,
          y = ((event.clientY - rect.top) * editingCard.height) / rect.height;
        const index = editingCard.elements.findLastIndex(
          (e) =>
            Math.abs(e.x - x) < Math.max(e.width, 60) &&
            Math.abs(e.y - y) < Math.max(e.height, 40),
        );
        if (index >= 0) {
          dragging = {
            index,
            x,
            y,
            startX: editingCard.elements[index].x,
            startY: editingCard.elements[index].y,
          };
          canvas.setPointerCapture(event.pointerId);
          event.preventDefault();
        }
      });
      document.addEventListener("pointermove", (event) => {
        if (!dragging) return;
        const svg = document.querySelector("#card-canvas svg"),
          rect = svg.getBoundingClientRect(),
          e = editingCard.elements[dragging.index];
        e.x = Math.max(
          0,
          Math.min(
            editingCard.width,
            Math.round(
              dragging.startX +
                ((event.clientX - rect.left) * editingCard.width) / rect.width -
                dragging.x,
            ),
          ),
        );
        e.y = Math.max(
          0,
          Math.min(
            editingCard.height,
            Math.round(
              dragging.startY +
                ((event.clientY - rect.top) * editingCard.height) /
                  rect.height -
                dragging.y,
            ),
          ),
        );
        const row = document.querySelector(
          `[data-card-index="${dragging.index}"]`,
        );
        row.querySelector("[name=x]").value = e.x;
        row.querySelector("[name=y]").value = e.y;
        refreshCard();
      });
      document.addEventListener("pointerup", () => (dragging = null));
    },
  };
}
