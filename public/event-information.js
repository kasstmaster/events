// Store bounded text runs, never arbitrary HTML. Shared by server and browser.
const escape = (value) =>
  String(value).replace(
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
  let length = 0;
  const result = [];
  for (const run of value) {
    if (
      !run ||
      typeof run !== "object" ||
      Array.isArray(run) ||
      typeof run.text !== "string" ||
      Object.keys(run).some(
        (k) => !["text", "bold", "italic", "underline", "href"].includes(k),
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
      } catch {}
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
export function bindInformationEditor(doc = document) {
  const ranges = new WeakMap();
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
      error = field.querySelector("[data-information-error]");
    const action = button.dataset.informationAction;
    error.textContent = "";
    if (action === "link") {
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
    if (action === "apply-link") {
      doc.execCommand("createLink", false, href);
      controls.hidden = true;
    } else doc.execCommand(action, false);
    editor.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
