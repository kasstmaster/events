import { order } from "./ui-system.js";
import { C, ui } from "./ui-runtime.js";
// Store bounded text runs, never arbitrary HTML. Shared by server and browser.
const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export function informationLink(value) {
  let source = String(value || "").trim();
  if (/^[^\s@:]+@[^\s@]+\.[^\s@]+$/.test(source)) source = "mailto:" + source;
  if (
    !source ||
    source.length > 2048 ||
    /[\u0000-\u0020\u007f]|%0[0-9a-f]|%1[0-9a-f]|%7f/i.test(source)
  )
    throw new Error("Enter a valid website URL or email address.");
  let url;
  try {
    url = new URL(source);
  } catch {
    throw new Error("Enter a valid website URL or email address.");
  }
  if (
    !["https:", "http:", "mailto:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    (url.protocol === "mailto:" &&
      (!/^[^\s@:]+@[^\s@]+\.[^\s@]+$/.test(url.pathname) ||
        url.search ||
        url.hash))
  )
    throw new Error("Enter a valid website URL or email address.");
  return url.href;
}
export function informationInput(value = []) {
  if (!Array.isArray(value) || value.length > 500)
    throw new Error("Information must contain at most 500 text sections.");
  let length = 0,
    popupLength = 0;
  const result = [];
  for (const run of value) {
    if (
      !run ||
      typeof run !== "object" ||
      Array.isArray(run) ||
      typeof run.text !== "string" ||
      Object.keys(run).some(
        (k) =>
          !["text", "bold", "italic", "underline", "href", "popup"].includes(k),
      ) ||
      ["bold", "italic", "underline"].some(
        (k) => run[k] !== undefined && typeof run[k] !== "boolean",
      )
    )
      throw new Error("Choose supported Information text formatting.");
    length += run.text.length;
    if (length > 10000 || run.text.includes("\u0000"))
      throw new Error("Information must be 10,000 characters or fewer.");
    const next = { text: run.text };
    for (const key of ["bold", "italic", "underline"])
      if (run[key]) next[key] = true;
    if (run.href !== undefined && run.href !== "") {
      if (typeof run.href !== "string")
        throw new Error("Enter a valid website URL or email address.");
      next.href = informationLink(run.href);
    }
    if (run.popup !== undefined && run.popup !== "") {
      if (
        typeof run.popup !== "string" ||
        !run.popup.trim() ||
        run.popup.length > 3000 ||
        run.popup.includes("\u0000")
      )
        throw new Error("Pop-up text must be 1–3,000 characters.");
      popupLength += run.popup.length;
      if (popupLength > 50000)
        throw new Error("Pop-up text is too long across all sections.");
      if (next.href)
        throw new Error(
          "Choose either a link or pop-up text for the same words.",
        );
      next.popup = run.popup;
    }
    if (next.text) result.push(next);
  }
  return result.some((run) => run.text.trim()) ? result : [];
}
export function renderInformation(value) {
  return informationInput(value)
    .map((run) => {
      let text = escape(run.text);
      if (run.bold) text = `<strong>${text}</strong>`;
      if (run.italic) text = `<em>${text}</em>`;
      if (run.underline) text = `<u>${text}</u>`;
      if (run.href)
        text = `<a href="${escape(run.href)}" target="_blank" rel="noopener noreferrer">${text}</a>`;
      if (run.popup)
        text = `<span class="information-popup" role="button" tabindex="0" aria-haspopup="dialog" data-information-popup="${escape(run.popup)}">${text}</span>`;
      return text;
    })
    .join("");
}
export function readInformation(editor) {
  const runs = [];
  function walk(node, marks = {}) {
    if (node.nodeType === 3) {
      if (node.nodeValue) runs.push({ text: node.nodeValue, ...marks });
      return;
    }
    if (
      node.nodeType !== 1 ||
      /^(SCRIPT|STYLE|IMG|SVG|IFRAME|OBJECT)$/.test(node.tagName)
    )
      return;
    if (node.tagName === "BR") {
      runs.push({ text: "\n", ...marks });
      return;
    }
    const next = { ...marks },
      tag = node.tagName;
    if (
      ["STRONG", "B"].includes(tag) ||
      /^(bold|[6-9]00)$/.test(node.style.fontWeight)
    )
      next.bold = true;
    if (["normal", "400"].includes(node.style.fontWeight)) delete next.bold;
    if (["EM", "I"].includes(tag) || node.style.fontStyle === "italic")
      next.italic = true;
    if (node.style.fontStyle === "normal") delete next.italic;
    if (tag === "U" || node.style.textDecoration.includes("underline"))
      next.underline = true;
    if (node.style.textDecoration === "none") delete next.underline;
    if (tag === "A") {
      try {
        next.href = informationLink(node.getAttribute("href"));
        delete next.popup;
      } catch {}
    }
    if (node.hasAttribute("data-information-popup")) {
      next.popup = node.getAttribute("data-information-popup");
      delete next.href;
    }
    if (
      ["DIV", "P"].includes(tag) &&
      runs.length &&
      !runs.at(-1).text.endsWith("\n")
    )
      runs.push({ text: "\n" });
    for (const child of node.childNodes) walk(child, next);
    if (
      ["DIV", "P"].includes(tag) &&
      node.nextSibling &&
      !runs.at(-1)?.text.endsWith("\n")
    )
      runs.push({ text: "\n" });
  }
  for (const child of editor.childNodes) walk(child);
  return informationInput(runs);
}
export function bindInformationEditor(doc = document, { showPopup } = {}) {
  const ranges = new WeakMap();
  const viewPopup = (target) => {
    const popup = target.closest?.("[data-information-popup]");
    if (!popup || popup.closest("[data-information-input]")) return false;
    showPopup?.(popup.textContent, popup.dataset.informationPopup);
    return true;
  };
  doc.addEventListener("click", (event) => viewPopup(event.target));
  doc.addEventListener("keydown", (event) => {
    if (
      ["Enter", " "].includes(event.key) &&
      event.target.matches?.("[data-information-popup]")
    ) {
      event.preventDefault();
      viewPopup(event.target);
    }
  });
  doc.addEventListener("selectionchange", () => {
    const selection = doc.getSelection();
    const editor = selection?.anchorNode?.parentElement?.closest(
      "[data-information-input]",
    );
    if (editor && selection.rangeCount && editor.contains(selection.focusNode))
      ranges.set(editor, selection.getRangeAt(0).cloneRange());
  });
  doc.addEventListener("pointerdown", (event) => {
    if (event.target.closest("[data-information-action]"))
      event.preventDefault();
  });
  doc.addEventListener("paste", (event) => {
    const editor = event.target.closest("[data-information-input]");
    if (!editor) return;
    event.preventDefault();
    doc.execCommand(
      "insertText",
      false,
      event.clipboardData.getData("text/plain"),
    );
  });
  doc.addEventListener("keydown", (event) => {
    const input = event.target.closest("[data-information-links] input");
    if (!input || !["Enter", "Escape"].includes(event.key)) return;
    event.preventDefault();
    input
      .closest("[data-information-links]")
      .querySelector(
        `[data-information-action="${event.key === "Enter" ? "apply-link" : "cancel-link"}"]`,
      )
      .click();
  });
  doc.addEventListener("drop", (event) => {
    if (event.target.closest("[data-information-input]"))
      event.preventDefault();
  });
  doc.addEventListener("click", (event) => {
    const button = event.target.closest("[data-information-action]");
    if (!button) return;
    event.preventDefault();
    const field = button.closest("[data-information-editor]"),
      editor = field.querySelector("[data-information-input]"),
      controls = field.querySelector("[data-information-links]"),
      input = controls.querySelector("input"),
      error = field.querySelector("[data-information-error]"),
      popupControls = field.querySelector("[data-information-popups]"),
      popupInput = popupControls?.querySelector("textarea");
    const action = button.dataset.informationAction;
    if (
      ![
        "bold",
        "italic",
        "underline",
        "link",
        "unlink",
        "apply-link",
        "cancel-link",
        "popup",
        "apply-popup",
        "cancel-popup",
        "remove-popup",
      ].includes(action)
    )
      return;
    error.textContent = "";
    if (action === "popup") {
      const range = ranges.get(editor);
      if (!range || range.collapsed || !range.toString().trim()) {
        error.textContent =
          "Highlight the words that should open the pop-up first.";
        return;
      }
      const node =
        range.startContainer.nodeType === 1
          ? range.startContainer
          : range.startContainer.parentElement;
      popupInput.value =
        node.closest?.("[data-information-popup]")?.dataset.informationPopup ||
        "";
      controls.hidden = true;
      popupControls.hidden = false;
      popupInput.focus();
      return;
    }
    if (action === "cancel-popup") {
      popupControls.hidden = true;
      editor.focus();
      return;
    }
    if (
      action === "apply-popup" &&
      (!popupInput.value.trim() || popupInput.value.length > 3000)
    ) {
      error.textContent = "Pop-up text must be 1–3,000 characters.";
      popupInput.focus();
      return;
    }
    if (action === "link") {
      popupControls.hidden = true;
      controls.hidden = false;
      input.value = "";
      input.focus();
      return;
    }
    let href;
    if (action === "apply-link") {
      try {
        href = informationLink(input.value);
      } catch (problem) {
        error.textContent = problem.message;
        input.focus();
        return;
      }
    }
    editor.focus();
    const range = ranges.get(editor);
    if (range && editor.contains(range.commonAncestorContainer)) {
      const selection = doc.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }
    if (action === "cancel-link") {
      controls.hidden = true;
      return;
    }
    if (["apply-link", "apply-popup", "remove-popup"].includes(action)) {
      if (
        !range ||
        range.collapsed ||
        !editor.contains(range.commonAncestorContainer)
      ) {
        error.textContent = "Highlight the words to format first.";
        return;
      }
      const fragment = range.extractContents();
      for (const node of [
        ...fragment.querySelectorAll("a,[data-information-popup]"),
      ])
        node.replaceWith(...node.childNodes);
      const wrapper = doc.createElement(action === "apply-link" ? "a" : "span");
      if (action === "apply-link") wrapper.setAttribute("href", href);
      if (action === "apply-popup")
        wrapper.dataset.informationPopup = popupInput.value;
      if (action === "remove-popup") wrapper.dataset.informationPopup = "";
      wrapper.append(fragment);
      range.insertNode(wrapper);
      const selection = doc.getSelection(),
        updated = doc.createRange();
      updated.selectNodeContents(wrapper);
      selection.removeAllRanges();
      selection.addRange(updated);
      ranges.set(editor, updated.cloneRange());
      controls.hidden = true;
      popupControls.hidden = true;
    } else doc.execCommand(action, false);
    editor.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

export function eventIntroduction(event, layout = [], item = "") {
  const [details, deadline] = eventInformationParts(
    event,
    false,
    event.informationLayout,
  );
  const slots = [
    [
      "artwork",
      event.icon
        ? ui`<img class="event-icon" data-event-edit="iconUpload" src="${escape(event.icon)}" alt="Event artwork">`
        : "",
    ],
    ["title", `<h1 data-event-edit="title">${escape(event.title)}</h1>`],
    [
      "description",
      `<p class="event-details" data-event-edit="description">${escape(event.description)}</p>`,
    ],
    ["details", details],
    ["deadline", deadline],
  ];
  const items = slots
    .filter(([, markup]) => markup)
    .map(([id, markup]) => ({
      id,
      markup: layout.includes(id)
        ? markup.replace(/^(<\w+)/, `$1 data-layout-item="${id}"`)
        : markup,
    }));
  return `<section class="event-hero" data-layout="eventInformation"${item}>${order(
    items,
    layout,
  )
    .map(({ markup }) => markup)
    .join("")}</section>`;
}

export const dateLabel = (value) =>
  value
    ? new Intl.DateTimeFormat(undefined, {
        dateStyle: "long",
        timeZone: "UTC",
      }).format(new Date(value + "T12:00:00Z"))
    : C("Date to come");

export function eventInformation(
  event,
  preview = false,
  layout = event.informationLayout,
) {
  return eventInformationParts(event, preview, layout).join("");
}

function eventInformationParts(event, preview, layout) {
  const edit = (name) =>
    preview ? 'data-host-content=""' : `data-event-edit="${name}"`;
  if (layout === "invitation") {
    const parts = event.date
      ? Object.fromEntries(
          new Intl.DateTimeFormat("en-US", {
            weekday: "long",
            month: "long",
            day: "numeric",
            year: "numeric",
            timeZone: "UTC",
          })
            .formatToParts(new Date(event.date + "T12:00:00Z"))
            .map((p) => [p.type, p.value]),
        )
      : null;
    const date = parts
      ? `${parts.weekday} ${parts.month} ${parts.day} ${parts.year}`
      : String(C("Date to come"));
    const deadline = event.deadline
      ? new Date(event.deadline + "T12:00:00Z")
      : null;
    const rsvp = deadline
      ? new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" })
          .format(deadline)
          .replace(/\.$/, "") +
        ". " +
        deadline.getUTCDate()
      : "";
    return [
      ui`<div class="event-meta event-information-invitation"><div class="invitation-date" ${edit("date")}>${escape(date)}</div>${event.time ? ui`<div class="invitation-time" ${edit("time")}>${escape(event.time)}</div>` : ""}${event.address ? ui`<div class="invitation-address" ${edit("eventAddress")}>${escape(event.address)}</div>` : ""}${deadline ? ui`<div class="invitation-rsvp"><span>${C("Kindly RSVP by")}</span> <span ${edit("deadline")}>${escape(rsvp)}</span></div>` : ""}</div>`,
    ];
  }
  return [
    ui`<div class="event-meta"><div><b>When</b><span ${edit("date")}>${escape(dateLabel(event.date))}</span><span ${edit("time")}>${escape(event.time)}</span></div>${event.address ? ui`<div><b>Where</b><span class="event-details" ${edit("eventAddress")}>${escape(event.address)}</span></div>` : ""}</div>`,
    event.deadline
      ? ui`<div class="event-deadline"><b>RSVP By</b><span ${edit("deadline")}>${escape(dateLabel(event.deadline))}</span></div>`
      : "",
  ];
}
