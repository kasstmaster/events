import { utcSchedule, localSchedule } from "/reminder-time.js";
import { ui, M, C, H } from "/ui-runtime.js";
import {
  layouts,
  roleDefaults,
  layoutLabels,
  viewLabels,
} from "./ui-system.js";
import {
  newCard,
  cardFields,
  cardFonts,
  renderCard,
  cardTextLines,
  populateField,
  cardFieldLabels,
  cardBounds,
  snapCardElement,
} from "./card-system.js";
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
    renderDefaultExample,
    render,
    startAppearance,
  } = ctx;
  let editingPrivate = false;
  let selectedCardField = 0,
    snapGuides = {};
  let editingUI,
    editingCard,
    cardContext = {},
    qrData = "",
    dragIndex = null,
    reminderVersion;
  const role = () =>
    state.session.role === "host" &&
    state.session.platformAdmin &&
    state.adminMode
      ? "admin"
      : state.session.role;
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
  async function uiEditor(scope = "global", key = "") {
    if (role() !== "admin" || scope !== "global")
      throw new Error("Administrators edit page defaults only.");
    const path =
      scope === "global"
        ? "/api/admin/defaults"
        : `/api/${role()}/interface/${scope}/${key}`;
    const result = await api(path);
    editingUI = { path, ...result, scope, key };
    editingUI.draftCopy = { ...result.ui.copy };
    editingUI.draftLayouts = structuredClone(result.ui.layouts);
    modal(
      C("Page defaults · visual editor"),
      ui`<p>Example pages only. Double-click interface text and type to change wording. Double-click a container to format or move it. Drag the selected item within its group, or use Move up / Move down. Wording and positions apply to every household. Existing household and event formatting is preserved when defaults change.</p>${select(
        H("Example page"),
        "examplePage",
        Object.entries({
          ...viewLabels,
          event: "Host event page",
          eventInvitation: "Event information · invitation layout",
          eventSingleContainer: "Event · one container",
          eventSettings: "Event Settings · layout choices",
          guestEvent: "Guest event · RSVP saved",
          guestEventUnanswered: "Guest event · no RSVP yet",
          guestLoginSuffix: "Guest sign-in · suffix revealed",
          familyLogin: "Family member sign-in",
          contacts: "Contacts",
          adminApprovals: "Administrator approvals",
          adminHosts: "Administrator hosts",
          adminSettings: "Administrator Settings",
          hostSettings: "Host Settings",
          guestSettings: "Guest Settings",
          familySettings: "Family Settings",
          familyHome: "Family workspace · owner",
          familyKidHome: "Family workspace · kid",
          familyList: "Family list",
          familyKidList: "Family list · kid",
          familyRecord: "Private home record",
          familyChore: "Family chore",
          familyTasks: "My Tasks · adult",
          familyKidTasks: "My Tasks · kid",
          hostLogin: "Host sign-in",
          registration: "Host registration",
        }).map(([id, label]) => [id, C(label)]),
        "hostHome",
      )}${select(
        H("Example screen size"),
        "exampleWidth",
        [
          ["390", C("Phone")],
          ["768", C("Tablet")],
          ["1440", C("Desktop")],
        ],
        "390",
      )}<p class="small muted">These are the real page layouts with sample information. Select elements to edit defaults; example buttons do not change data.</p><div id="page-example" class="page-example"><iframe id="page-example-frame" title="Example page" sandbox="allow-same-origin"></iframe></div><section id="visual-inspector" hidden><h3>Selected element</h3><p id="selected-element"></p><div id="selected-wording"></div><p>Appearance is edited with the five categories in the top toolbar. These controls change shared wording and layout only.</p><div class="row">${button("visual-up", H("Move up"))}${button("visual-down", H("Move down"))}</div></section>`,
      "ui-settings",
    );
    renderExample("hostHome");
    const previousDesign = structuredClone(result.ui.design);
    await startAppearance("global", {
      design: previousDesign,
      defaults: roleDefaults,
      sources: [],
      preview: (design) => {
        editingUI.ui.design = design;
        styleExample();
      },
      save: persistDefaults,
      cancel: () => {
        closeModalForDefaults();
      },
    });
  }
  function closeModalForDefaults() {
    document.querySelector("#editor [data-action=close]")?.click();
  }
  async function persistDefaults(design) {
    const config = { copy: {}, design, layouts: {} };
    for (const [key, value] of Object.entries(editingUI.draftCopy))
      if (value !== key) config.copy[key] = value;
    for (const [key, value] of Object.entries(editingUI.draftLayouts))
      if (JSON.stringify(value) !== JSON.stringify(layouts[key]))
        config.layouts[key] = value;
    await api(editingUI.path, {
      method: "PUT",
      version: editingUI.version,
      data: config,
    });
    closeModalForDefaults();
    await load();
    notify(C("Page settings saved."));
  }
  let visualSelection;
  const exampleDocument = () =>
    document.querySelector("#page-example-frame")?.contentDocument;
  function sizeExample() {
    const frame = document.querySelector("#page-example-frame"),
      wrapper = frame?.parentElement;
    if (!frame || !wrapper) return;
    const width = Number(document.querySelector("[name=exampleWidth]").value),
      height = 900;
    const scale = Math.min(1, wrapper.clientWidth / width);
    frame.style.width = width + "px";
    frame.style.height = height + "px";
    frame.style.transform = `scale(${scale})`;
    wrapper.style.height = height * scale + "px";
    const doc = frame.contentDocument;
    if (doc?.documentElement) {
      doc.documentElement.style.setProperty(
        "--top-height",
        (doc.querySelector(".top-shell")?.getBoundingClientRect().height || 0) +
          "px",
      );
      doc.documentElement.style.setProperty(
        "--bottom-height",
        (doc.querySelector(".toolbar")?.getBoundingClientRect().height || 0) +
          "px",
      );
    }
  }
  function renderExample(view) {
    visualSelection = null;
    document.querySelector("#visual-inspector").hidden = true;
    const form = document.querySelector("form[data-form=ui-settings]");
    const config = {
      ...editingUI.ui,
      copy: editingUI.draftCopy,
      layouts: editingUI.draftLayouts,
      design: editingUI.ui.design,
    };
    const rendered = renderDefaultExample(view, config);
    const frame = document.querySelector("#page-example-frame");
    frame.onload = () => {
      const doc = frame.contentDocument;
      if (view === "guestLoginSuffix")
        doc.querySelector("#guest-suffix")?.removeAttribute("hidden");
      doc.addEventListener("click", (event) => {
        if (!event.target.closest?.("summary")) event.preventDefault();
      });
      doc.addEventListener("submit", (event) => {
        event.preventDefault();
      });
      doc.addEventListener("beforeinput", (event) => {
        if (!event.target.closest?.('[contenteditable="plaintext-only"]'))
          event.preventDefault();
      });
      doc.addEventListener("input", (event) => {
        const el = event.target.closest?.(
          '[contenteditable="plaintext-only"][data-default-copy]',
        );
        if (el) updateExampleCopy(el.dataset.defaultCopy, el.textContent, el);
      });
      doc.addEventListener("focusout", (event) => {
        const el = event.target.closest?.('[contenteditable="plaintext-only"]');
        if (el) {
          el.removeAttribute("contenteditable");
          const row = el.closest("[data-layout-item]");
          if (row) row.draggable = true;
        }
      });
      doc.addEventListener("dblclick", (event) => {
        const element = event.target.closest?.("[data-default-role]");
        if (element && role() === "admin") {
          event.preventDefault();
          selectVisual(element);
          if (element.dataset.defaultCopy) editWordingInline(element);
        }
      });
      doc.addEventListener("keydown", (event) => {
        const element = event.target.closest?.("[data-default-role]");
        if (element?.isContentEditable) {
          if (event.key === "Escape") {
            event.preventDefault();
            updateExampleCopy(
              element.dataset.defaultCopy,
              element.dataset.previousWording,
              element,
            );
            element.textContent = element.dataset.previousWording;
            element.blur();
          } else if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            element.blur();
          }
          return;
        }
        if (element && ["Enter", " "].includes(event.key)) {
          event.preventDefault();
          selectVisual(element);
          if (element.dataset.defaultCopy) editWordingInline(element);
        }
      });
      doc.addEventListener("dragstart", (event) => {
        const row = event.target.closest?.("[data-layout-item]");
        if (row?.draggable) {
          dragIndex = row;
          event.dataTransfer.setData("text/plain", row.dataset.layoutItem);
        }
      });
      doc.addEventListener("dragover", (event) => {
        if (event.target.closest?.("[data-layout-item]"))
          event.preventDefault();
      });
      doc.addEventListener("drop", (event) => {
        const row = event.target.closest?.("[data-layout-item]");
        if (row && dragIndex && row.parentElement === dragIndex.parentElement) {
          event.preventDefault();
          row.before(dragIndex);
          saveExampleLayout(row);
        }
        dragIndex = null;
      });
      const top = doc.querySelector(".top-shell");
      doc.documentElement.style.setProperty(
        "--top-height",
        (top?.getBoundingClientRect().height || 0) + "px",
      );
      sizeExample();
    };
    frame.srcdoc = `<!doctype html><html lang="en" style="${escape(rendered.style)}"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body data-defaults-example><div id="app">${rendered.markup}</div></body></html>`;
    sizeExample();
  }
  function styleExample() {
    const root = exampleDocument()?.documentElement;
    if (!root) return;
    const form = document.querySelector("form[data-form=ui-settings]");
    const d = editingUI.ui.design;
    // The shared renderer applies the complete design variables; preserve the selected node.
    const rendered = renderDefaultExample(
      document.querySelector("[name=examplePage]").value,
      {
        ...editingUI.ui,
        copy: editingUI.draftCopy,
        layouts: editingUI.draftLayouts,
        design: d,
      },
    );
    root.setAttribute("style", rendered.style);
    sizeExample();
  }
  function updateExampleCopy(key, value, source) {
    editingUI.draftCopy[key] = value;
    for (const el of exampleDocument().querySelectorAll("[data-default-copy]"))
      if (el.dataset.defaultCopy === key && el !== source)
        el.textContent = value;
    const inspector = document.querySelector("[name=selectedWording]");
    if (inspector && source !== inspector) inspector.value = value;
  }
  function editWordingInline(element) {
    element.dataset.previousWording = element.textContent;
    element.setAttribute("contenteditable", "plaintext-only");
    element.draggable = false;
    element.closest("[data-layout-item]")?.setAttribute("draggable", "false");
    element.focus();
    const selection = element.ownerDocument.getSelection(),
      range = element.ownerDocument.createRange();
    range.selectNodeContents(element);
    selection.removeAllRanges();
    selection.addRange(range);
  }
  function selectVisual(element) {
    const form = document.querySelector("form[data-form=ui-settings]");
    visualSelection = element;
    element.ownerDocument.getSelection()?.removeAllRanges();
    for (const el of exampleDocument().querySelectorAll(
      "[data-default-role]",
    )) {
      el.classList.toggle("layout-selected", el === element);
      el.draggable = el === element && el.hasAttribute("data-layout-item");
    }
    const selectedRow = element.closest("[data-layout-item]");
    if (selectedRow) selectedRow.draggable = true;
    const selectedRole = element.dataset.defaultRole;
    document.querySelector("#visual-inspector").hidden = false;
    document.querySelector("#selected-element").textContent =
      selectedRole + " · " + element.textContent.trim().slice(0, 80);
    const key = element.dataset.defaultCopy;
    document.querySelector("#selected-wording").innerHTML = key
      ? area(
          H("Selected wording"),
          "selectedWording",
          editingUI.draftCopy[key] ?? key,
        )
      : "<p>Example content represents household data; only its default formatting is editable here.</p>";
  }

  function saveExampleLayout(element) {
    const group = element.parentElement?.closest("[data-layout]");
    if (group) {
      const keys = [...group.children]
        .map((el) => el.dataset.layoutItem)
        .filter((key) => layouts[group.dataset.layout]?.includes(key));
      editingUI.draftLayouts[group.dataset.layout] = [
        ...keys,
        ...layouts[group.dataset.layout].filter((key) => !keys.includes(key)),
      ];
    }
  }

  async function chooseScope(preview = false) {
    const data =
      role() === "admin"
        ? await api("/api/admin/households")
        : [
            {
              id: state.data.household.id,
              name: state.data.household.name,
              events: state.data.events.map((e) => ({
                id: e.id,
                title: e.title,
              })),
            },
          ];
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
    state.nextManagementKind = "cards";
    modal(
      role() === "admin"
        ? C("Shared card templates")
        : C(selectedEvent() ? "Invitation Cards" : "Your cards & templates"),
      ui`${role() === "host" && selectedEvent() ? button("event-template", H("Edit invitation")) : ""}<p>One editor for invitations, thank-you cards and holiday cards. Use a desktop or larger tablet for detailed layout work.</p>${role() === "admin" ? "" : button("new-card", H("Create card / template"), "", "")}<h3>${role() === "admin" ? C("Shared templates") : C("Saved cards")}</h3><ul>${records.map((r) => ui`<li>${escape(r.name)} ${button("edit-card", H("Open"), `data-id="${r.id}"`, "quiet")}${button("remove-card", H("Remove"), `data-id="${r.id}"`, "quiet")}</li>`).join("") || M("<li>Nothing saved yet.</li>")}</ul>${role() === "host" ? ui`<h3>Start from a template</h3><div class="stack">${templates.map((t) => button("use-card-template", escape(t.name), `data-id="${t.id}"`)).join("")}</div>` : ""}`,
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
    selectedCardField = 0;
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
        inviteCode: "0123",
      },
    };
    qrData = await qrURL();
    notify("");
    if (state.view !== "card-editor") state.cardReturnView = state.view;
    document.querySelector("#editor").close();
    state.view = "card-editor";
    render();
  }
  async function qrURL() {
    const response = await fetch(
      role() === "host" ? "/api/host/qr" : "/card-qr-example.svg",
      {
        credentials: "same-origin",
      },
    );
    if (!response.ok) throw new Error("Could not load household QR.");
    return "data:image/svg+xml;base64," + btoa(await response.text());
  }
  function cardEditorPage() {
    const card = editingCard;
    return ui`<form data-form="card" class="card-editor-page"><div class="card-editor-header"><h1>${role() === "admin" ? C("Edit shared template") : C("Edit your card")}</h1><div class="row">${button("card-tools-toggle", H("Tools"), `aria-expanded="${!!state.cardToolsOpen}"`, "card-tools-toggle")}${button("card-editor-back", H("Close editor"))}<button>${role() === "admin" ? C("Save shared template") : C("Save card")}</button></div></div><p class="form-error" role="alert"></p><p>Drag a field in the preview; use numeric positions or arrow keys for precise movement. Text bounds are guides—check long names before printing.</p><div class="card-workspace"><section class="card-preview-area" aria-label="Card workspace"><div id="card-canvas" tabindex="0" aria-label="Card preview"></div></section><aside class="card-controls" aria-label="Card editor tools" ${window.innerWidth < 850 && !state.cardToolsOpen ? "inert" : ""}>${button("card-tools-toggle", H("Close tools"), "", "card-tools-toggle")}<h2>Variables</h2><p>Drag a variable onto the preview, or select it to add it. Select an item in the preview to format it. Items snap to the center and edges.</p><div class="card-variable-list">${cardFields.map((key) => ui`<button type="button" draggable="true" data-card-variable="${key}" data-action="add-card-variable" data-id="${key}">${C(cardFieldLabels[key])}</button>`).join("")}</div>${select(
      H("Selected item"),
      "cardSelected",
      card.elements.map((e, index) => [
        String(index),
        `${index + 1}. ${String(C(cardFieldLabels[e.field]))}`,
      ]),
      String(selectedCardField),
    )}${field(H("Card name"), "cardName", card.name, "text", 'required maxlength="100"')}${select(
      H("Card type"),
      "cardKind",
      [
        ["invitation", C("Invitation")],
        ["thank-you", C("Thank-you")],
        ["holiday", C("Holiday")],
      ],
      card.kind,
    )}${role() === "host" ? `${select(H("Populate from event"), "cardEvent", options(), card.event || selectedEvent()?.id || "")}${select(H("Recipient"), "cardRecipient", [["", C("No recipient")], ...cardOptions()], card.recipient || "")}` : ""}${field(H("Background artwork"), "cardBackground", "", "file", 'accept="image/png,image/jpeg,image/webp"')}<label class="check"><input name="removeCardBackground" type="checkbox">Remove background artwork</label>${field(H("Card background color"), "cardColor", card.color, "color")}<div class="form-grid">${field(H("Canvas width"), "cardWidth", card.width, "number", 'min="300" max="2400"')}${field(H("Canvas height"), "cardHeight", card.height, "number", 'min="300" max="2400"')}</div><label class="check"><input name="includeQR" type="checkbox" ${card.includeQR ? "checked" : ""}>Include QR code</label>${role() === "host" ? M('<label class="check"><input name="savePrivateTemplate" type="checkbox">Save as a reusable private template</label>') : ""}<div id="card-fields">${card.elements
      .map(
        (e, index) =>
          ui`<fieldset data-card-index="${index}" ${index === selectedCardField ? "" : "hidden"}><legend>Field ${index + 1}</legend>${select(
            H("Dynamic field"),
            "field",
            cardFields.map((f) => [f, C(cardFieldLabels[f])]),
            e.field,
          )}${e.field === "qr" ? ui`<label class="check"><input name="qrTransparent" type="checkbox" ${e.qrTransparent ? "checked" : ""}>Transparent QR background</label>${button("add-qr-text", H("Add text above QR"), `data-index="${index}"`, "quiet")}${role() === "admin" ? M('<p class="small">Example QR — replaced with the household link when used.</p>') : ""}` : ""}${area(H("Text / fallback"), "fieldText", e.field === "text" ? e.text : e.fallback)}<div class="form-grid">${["x", "y", "width", "height", "fontSize"].map((k) => field(C({ x: "Horizontal position", y: "Vertical position", width: "Box width", height: "Box height", fontSize: "Text size" }[k]), k, e[k], "number", `min="${k === "fontSize" ? 8 : 0}" max="2400" step="any"`)).join("")}${field(e.field === "qr" ? H("QR color") : H("Text color"), "color", e.field === "qr" ? e.qrColor || "#000000" : e.color, "color")}${select(
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
      )}</div>${button("add-card-field", H("Add field"))}<hr>${field(H("Print quantity"), "printQuantity", 1, "number", 'min="1" max="50"')}<p class="small muted">One card per printed page; quantity generates that many pages. Paper size, scaling and printer copies remain in your print dialog.</p><div class="row">${button("download-card", H("Download SVG"))}${button("download-png", "Download PNG")}${button("print-card", H("Print cards"))}${button("share-card", H("Share / text"))}${button("email-card", H("Email composer"))}</div></aside></div></form>`;
  }
  function drawCardEditor() {
    render();
  }
  function chooseCardField(index) {
    selectedCardField = Math.max(
      0,
      Math.min(editingCard.elements.length - 1, index),
    );
    const select = document.querySelector("[name=cardSelected]");
    if (select) select.value = String(selectedCardField);
    for (const row of document.querySelectorAll("[data-card-index]"))
      row.hidden = Number(row.dataset.cardIndex) !== selectedCardField;
    refreshCard();
  }
  function addCardVariable(field, point) {
    if (!cardFields.includes(field)) return;
    collectCard();
    if (field === "qr") editingCard.includeQR = true;
    const element = {
      ...newCard().elements[0],
      id: crypto.randomUUID(),
      field,
      text: field === "text" ? String(C("Your text")) : "",
      fallback: "",
      x: point?.x ?? editingCard.width / 2,
      y: point?.y ?? editingCard.height / 2,
      width: Math.min(field === "qr" ? 160 : 240, editingCard.width),
      height: field === "qr" ? 160 : 70,
      fontSize: 24,
      align: field === "qr" ? "left" : "center",
    };
    snapCardElement(element, editingCard);
    editingCard.elements.push(element);
    selectedCardField = editingCard.elements.length - 1;
    drawCardEditor();
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
          color: value("field") === "qr" ? existing.color : value("color"),
          align: value("align"),
          bold: row.querySelector("[name=bold]").checked,
          ...(value("field") === "qr"
            ? {
                qrColor: value("color"),
                qrTransparent: !!row.querySelector("[name=qrTransparent]")
                  ?.checked,
              }
            : {}),
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
              ...(editingCard.elements.some(
                (e) => e.field === "recipient.inviteCode",
              )
                ? { inviteCode: recipient.inviteCode || "" }
                : {}),
            }
          : {},
      };
    }
  }
  function refreshCard() {
    const target = document.querySelector("#card-canvas");
    if (!target) return;
    target.innerHTML = renderCard(editingCard, cardContext, qrData);
    const svg = target.querySelector("svg"),
      selected = editingCard.elements[selectedCardField];
    if (selected) {
      const b = cardBounds(selected);
      svg.insertAdjacentHTML(
        "beforeend",
        `<rect class="card-selection" x="${b.left}" y="${b.top}" width="${b.width}" height="${b.height}" fill="none" stroke="#b7784c" stroke-width="2" pointer-events="none"/><rect data-card-resize="${selectedCardField}" aria-label="Resize selected item" x="${b.left + b.width - 7}" y="${b.top + b.height - 7}" width="14" height="14" fill="#b7784c" style="cursor:nwse-resize"/>`,
      );
    }
    for (const [axis, value] of Object.entries(snapGuides))
      svg.insertAdjacentHTML(
        "beforeend",
        axis === "x"
          ? `<line class="card-snap-guide" x1="${value}" x2="${value}" y1="0" y2="${editingCard.height}" stroke="#b7784c" stroke-dasharray="6 4" pointer-events="none"/>`
          : `<line class="card-snap-guide" y1="${value}" y2="${value}" x1="0" x2="${editingCard.width}" stroke="#b7784c" stroke-dasharray="6 4" pointer-events="none"/>`,
      );

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
      ? C(
          "Some text may be clipped. Increase the field height or reduce its size before exporting.",
        )
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
      C("Reminders"),
      ui`<p>${data.configured ? C("Messaging provider configured. Enabling a schedule can send real texts.") : C("Messaging is not enabled. Schedules can be saved and previewed, but no texts will send.")}</p><p>RSVP messaging starts when an adult submits their response. Reminders use eligible invited adults with an international phone number on file. STOP opt-outs always win.</p><div id="reminder-rows">${data.reminders.map(reminderRow).join("")}</div>${button("add-reminder", H("Add reminder"))}${button("preview-reminders", H("Preview recipients"))}<div id="reminder-preview"></div><h3>Delivery status</h3><ul>${data.deliveries.map((d) => ui`<li>${escape(d.phone)}: ${escape(d.status === "sent" ? "Sent (provider-reported; delivery unconfirmed)" : d.status)}${d.error ? " · " + escape(d.error) : ""}</li>`).join("") || M("<li>No deliveries.</li>")}</ul><p class="small muted">Accepted means the provider accepted a request, not delivered. Unknown outcomes are not retried automatically.</p>`,
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
    cleanupPanel: () =>
      (state.data.deletions || []).length
        ? ui`<section class="panel"><h2>Account cleanup</h2><ul>${state.data.deletions.map((job) => ui`<li>${escape(job.email || job.label || "Deleted household")}: ${escape(job.phase)} ${job.error ? escape(job.error) : ""}</li>`).join("")}</ul></section>`
        : "",
    cardEditorPage,
    mountCardEditor() {
      document.body.classList.toggle("card-tools-open", !!state.cardToolsOpen);
      refreshCard();
    },
    async action(action, target) {
      const key = target.dataset.id;
      if (action === "global-defaults") {
        await uiEditor();
        return true;
      }
      if (action === "preview-guest") {
        if (role() !== "admin" && !state.session.platformAdmin) return true;
        await chooseScope(true);
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
      if (action === "card-tools-toggle") {
        state.cardToolsOpen = !state.cardToolsOpen;
        document.body.classList.toggle("card-tools-open", state.cardToolsOpen);
        document.querySelector(".card-controls").inert =
          window.innerWidth < 850 && !state.cardToolsOpen;
        for (const b of document.querySelectorAll(
          "[data-action=card-tools-toggle]",
        ))
          b.setAttribute("aria-expanded", String(state.cardToolsOpen));
        return true;
      }
      if (action === "card-editor-back") {
        state.actionEvent = null;
        if (role() === "admin" && state.cardReturnView === "management") {
          state.view = "home";
          await cards();
        } else {
          state.view = state.cardReturnView || "home";
          render();
        }
        return true;
      }
      if (action === "add-card-variable") {
        addCardVariable(key);
        return true;
      }
      if (action === "add-qr-text") {
        collectCard();
        const qr = editingCard.elements[Number(target.dataset.index)];
        if (qr?.field !== "qr") return true;
        const text = {
          ...newCard().elements[0],
          id: crypto.randomUUID(),
          field: "text",
          text: String(C("Scan to view invitations")),
          fallback: "",
          x: qr.x + qr.width / 2,
          y: Math.max(0, qr.y - 64),
          width: qr.width,
          height: 56,
          fontSize: 18,
          color: qr.qrColor || "#000000",
        };
        editingCard.elements.push(text);
        selectedCardField = editingCard.elements.length - 1;
        drawCardEditor();
        return true;
      }
      if (action === "add-card-field") {
        addCardVariable("text");
        return true;
      }
      if (action === "remove-card-field") {
        collectCard();
        editingCard.elements.splice(Number(target.dataset.index), 1);
        selectedCardField = Math.max(
          0,
          Math.min(selectedCardField, editingCard.elements.length - 1),
        );
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
      if (action === "visual-up" || action === "visual-down") {
        const row = visualSelection?.closest("[data-layout-item]");
        if (row) {
          if (action === "visual-up" && row.previousElementSibling)
            row.previousElementSibling.before(row);
          if (action === "visual-down" && row.nextElementSibling)
            row.nextElementSibling.after(row);
          saveExampleLayout(row);
        }
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
      if (kind === "ui-settings") return true; // Only the shared toolbar Save persists defaults.
      if (kind === "choose-scope") {
        await uiEditor(
          fd.get("previewEvent") ? "event" : "household",
          fd.get("previewEvent") || fd.get("previewHousehold"),
        );
        return true;
      }
      if (kind === "admin-preview") {
        state.preview = {
          endpoint:
            role() === "admin" ? "/api/admin/preview" : "/api/host/preview",
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
        const returnTemplates =
          role() === "admin" && state.cardReturnView === "management";
        state.view = returnTemplates ? "home" : state.cardReturnView || "home";
        await saved("Card saved. Source templates remain unchanged.");
        if (returnTemplates) await cards();
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
      return false;
    },
    input(event) {
      if (event.target.name === "cardSelected") {
        chooseCardField(Number(event.target.value));
        return;
      }
      if (event.target.name === "exampleWidth") sizeExample();
      if (event.target.name === "examplePage")
        renderExample(event.target.value);
      if (
        event.target.name === "selectedWording" &&
        visualSelection?.dataset.defaultCopy
      ) {
        updateExampleCopy(
          visualSelection.dataset.defaultCopy,
          event.target.value,
          event.target,
        );
      }
      if (event.target.closest("#default-design-controls")) styleExample();
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
        if (event.target.name === "field") drawCardEditor();
        else refreshCard();
      }
      if (event.target.matches("[data-copy-search]"))
        for (const label of document.querySelectorAll("[data-copy-key]"))
          label.hidden = !label.dataset.copyKey
            .toLowerCase()
            .includes(event.target.value.toLowerCase());
      if (event.target.name === "previewHousehold") updateScopeEvents();
    },
    bind() {
      window.addEventListener("resize", () => {
        sizeExample();
        if (state.view === "card-editor") {
          const side = document.querySelector(".card-controls");
          if (side)
            side.inert = window.innerWidth < 850 && !state.cardToolsOpen;
        }
      });
      document.addEventListener("dblclick", (event) => {
        const element = event.target.closest(
          "#page-example [data-default-role]",
        );
        if (element && role() === "admin") {
          event.preventDefault();
          selectVisual(element);
        }
      });
      document.addEventListener("click", (event) => {
        if (event.target.closest("#page-example")) event.preventDefault();
      });
      document.addEventListener("keydown", (event) => {
        const element = event.target.closest(
          "#page-example [data-default-role]",
        );
        if (
          element &&
          role() === "admin" &&
          ["Enter", " "].includes(event.key)
        ) {
          event.preventDefault();
          selectVisual(element);
        }
      });
      document.addEventListener("dragstart", (event) => {
        const row = event.target.closest("[data-layout-item]");
        if (row && row.draggable && role() === "admin") {
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
          saveExampleLayout(row);
        }
        dragIndex = null;
      });
      let dragging;
      const point = (event) => {
        const rect = document
          .querySelector("#card-canvas svg")
          .getBoundingClientRect();
        return {
          x: ((event.clientX - rect.left) * editingCard.width) / rect.width,
          y: ((event.clientY - rect.top) * editingCard.height) / rect.height,
        };
      };
      document.addEventListener("dragstart", (event) => {
        const palette = event.target.closest?.("[data-card-variable]");
        if (palette) {
          event.dataTransfer.setData(
            "application/x-events-card-variable",
            palette.dataset.cardVariable,
          );
          event.dataTransfer.effectAllowed = "copy";
        }
      });
      document.addEventListener("dragover", (event) => {
        if (event.target.closest?.("#card-canvas")) {
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        }
      });
      document.addEventListener("drop", (event) => {
        if (event.target.closest?.("#card-canvas")) {
          event.preventDefault();
          const field = event.dataTransfer.getData(
            "application/x-events-card-variable",
          );
          if (cardFields.includes(field)) addCardVariable(field, point(event));
        }
      });
      document.addEventListener("pointerdown", (event) => {
        const canvas = event.target.closest?.("#card-canvas");
        if (!canvas || event.button !== 0) return;
        const p = point(event);
        const resize = event.target.closest("[data-card-resize]");
        const marked = event.target.closest("[data-card-element]");
        const index = resize
          ? Number(resize.dataset.cardResize)
          : marked
            ? Number(marked.dataset.cardElement)
            : editingCard.elements.findLastIndex((e) => {
                if (e.field === "qr" && !editingCard.includeQR) return false;
                const b = cardBounds(e);
                return (
                  p.x >= b.left &&
                  p.x <= b.left + b.width &&
                  p.y >= b.top &&
                  p.y <= b.top + b.height
                );
              });
        if (index < 0) return;
        chooseCardField(index);
        const e = editingCard.elements[index];
        dragging = {
          index,
          x: p.x,
          y: p.y,
          startX: e.x,
          startY: e.y,
          resize: !!resize,
          startWidth: e.width,
          startHeight: e.height,
          bounds: cardBounds(e),
        };
        canvas.focus();
        canvas.setPointerCapture(event.pointerId);
        event.preventDefault();
      });
      document.addEventListener("pointermove", (event) => {
        if (!dragging) return;
        const p = point(event),
          e = editingCard.elements[dragging.index];
        if (Math.abs(p.x - dragging.x) + Math.abs(p.y - dragging.y) > 4)
          dragging.moved = true;
        if (dragging.resize) {
          const min = e.field === "qr" ? 100 : 10;
          e.width = Math.max(
            min,
            Math.min(
              editingCard.width - dragging.bounds.left,
              Math.round(dragging.startWidth + p.x - dragging.x),
            ),
          );
          e.height = Math.max(
            min,
            Math.min(
              editingCard.height - dragging.bounds.top,
              Math.round(dragging.startHeight + p.y - dragging.y),
            ),
          );
          const offset =
            e.field === "qr"
              ? 0
              : e.align === "center"
                ? e.width / 2
                : e.align === "right"
                  ? e.width
                  : 0;
          e.x = dragging.bounds.left + offset;
          const row = document.querySelector(
            `[data-card-index="${dragging.index}"]`,
          );
          for (const key of ["x", "y", "width", "height"])
            row.querySelector(`[name=${key}]`).value = e[key];
          refreshCard();
          return;
        }
        e.x = Math.round(dragging.startX + p.x - dragging.x);
        e.y = Math.round(dragging.startY + p.y - dragging.y);
        const scale =
          document.querySelector("#card-canvas svg").getBoundingClientRect()
            .width / editingCard.width;
        snapGuides = snapCardElement(e, editingCard, 8 / scale);
        const row = document.querySelector(
          `[data-card-index="${dragging.index}"]`,
        );
        row.querySelector("[name=x]").value = e.x;
        row.querySelector("[name=y]").value = e.y;
        refreshCard();
      });
      const release = () => {
        if (dragging && !dragging.moved && window.innerWidth < 850) {
          state.cardToolsOpen = true;
          document.body.classList.add("card-tools-open");
          document.querySelector(".card-controls").inert = false;
        }
        dragging = null;
        snapGuides = {};
        if (state.view === "card-editor") refreshCard();
      };
      document.addEventListener("pointerup", release);
      document.addEventListener("pointercancel", release);
      document.addEventListener("keydown", (event) => {
        if (
          !event.target.matches?.("#card-canvas") ||
          !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(
            event.key,
          )
        )
          return;
        const e = editingCard.elements[selectedCardField];
        if (!e) return;
        event.preventDefault();
        const step = event.shiftKey ? 10 : 1;
        e.x +=
          event.key === "ArrowLeft"
            ? -step
            : event.key === "ArrowRight"
              ? step
              : 0;
        e.y +=
          event.key === "ArrowUp"
            ? -step
            : event.key === "ArrowDown"
              ? step
              : 0;
        const row = document.querySelector(
          `[data-card-index="${selectedCardField}"]`,
        );
        row.querySelector("[name=x]").value = e.x;
        row.querySelector("[name=y]").value = e.y;
        refreshCard();
      });
    },
  };
}
