import { ui, C, H } from "./ui-runtime.js";
import { icon } from "./icons.js";
export const sections = [
  ["lists", "Lists", "list"],
  ["tasks", "Tasks", "task"],
  ["records", "Records", "folder"],
  ["chores", "Chores", "task"],
];
export const sectionFor = (type) =>
  ({ list: "lists", task: "tasks", record: "records", chore: "chores" })[type];
export function tool(action, label, key = "", symbol = action, extra = "") {
  return ui`<button type="button" class="nav-control" data-action="${action}" data-id="${key}" aria-label="${H(label)}" ${extra}>${icon(symbol)}<span>${C(label)}</span></button>`;
}
export function menu(label, symbol, items) {
  return ui`<details class="browse-menu"><summary aria-label="${H(label)}">${icon(symbol)}</summary><div role="menu" aria-label="${H(label)} menu">${items.map((i) => ui`<button type="button" role="${i.checked === undefined ? "menuitem" : "menuitemradio"}" ${i.checked === undefined ? "" : `aria-checked="${i.checked}"`} data-action="${i.action}" data-id="${i.id || ""}">${C(i.label)}</button>`).join("")}</div></details>`;
}
export function sorting(prefix, mode = "manual") {
  return [
    {
      action: prefix + "sort-alpha",
      label: "Sort alphabetically",
      checked: mode === "alpha",
    },
    {
      action: prefix + "sort-manual",
      label: "Manual ordering",
      checked: mode !== "alpha",
    },
  ];
}
export function topbar({
  title,
  subtitle = "",
  back,
  search,
  plus = [],
  sort = [],
  extra = "",
}) {
  return ui`<div class="app-topbar no-print">${back ? tool(back, "Back", "", "back") : ""}<div class="browse-heading">${title ? ui`<h1>${title}</h1>` : ""}${subtitle ? ui`<p>${subtitle}</p>` : ""}</div><div class="browse-top-actions">${search ? tool(search, "Search", "", "search") : ""}${plus.length ? menu("Create", "plus", plus) : ""}${sort.length ? menu("Sorting and options", "more", sort) : ""}${extra}</div></div>`;
}
export function bottom(items, label = "Main navigation") {
  return ui`<nav class="toolbar no-print" aria-label="${H(label)}">${items.map((i) => tool(i.action, i.label, i.id || "", i.icon || i.action, i.current ? 'aria-current="page"' : "")).join("")}</nav>`;
}
export function row({
  title,
  meta = "",
  symbol = "list",
  action,
  id = "",
  controls = "",
  attributes = "",
}) {
  return ui`<li class="browse-row" ${attributes}><span class="browse-row-icon">${icon(symbol)}</span><div class="browse-row-content">${action ? ui`<button type="button" class="browse-open" data-action="${action}" data-id="${id}">${title}</button>` : ui`<strong>${title}</strong>`}${meta ? ui`<p>${meta}</p>` : ""}</div><div class="browse-row-actions">${controls}</div></li>`;
}
export function searchBox(prefix, value, escape, label = "Search") {
  return ui`<label class="browse-search">${C(label)}<input type="search" name="${prefix}Search" data-browse-search="${prefix}" value="${escape(value)}" autocomplete="off"></label>`;
}
export function ordered(rows, mode, label = (r) => r.title) {
  return [...rows].sort(
    mode === "alpha"
      ? (a, b) => label(a).localeCompare(label(b))
      : (a, b) =>
          (a.position || 0) - (b.position || 0) || a.id.localeCompare(b.id),
  );
}
export function folderInSection(folder, section, records, seen = new Set()) {
  if (folder.section === section || folder.section === "shared") return true;
  if (seen.has(folder.id)) return false;
  seen.add(folder.id);
  const children = records.filter((r) => r.folder === folder.id);
  return !children.length
    ? !folder.section && section === "lists"
    : children.some((r) =>
        r.type === "folder"
          ? folderInSection(r, section, records, new Set(seen))
          : sectionFor(r.type) === section,
      );
}

let menusBound = false;
export function bindBrowseMenus() {
  if (menusBound) return;
  menusBound = true;
  document.addEventListener(
    "toggle",
    (event) => {
      const details = event.target;
      if (!details.matches?.(".browse-menu") || !details.open) return;
      for (const other of document.querySelectorAll(".browse-menu[open]"))
        if (other !== details) other.open = false;
      const panel = details.querySelector("[role=menu]"),
        summary = details.querySelector("summary"),
        rect = summary.getBoundingClientRect();
      const topbar = details
          .closest(".browse-shell")
          ?.querySelector(".app-topbar"),
        minTop = topbar
          ? Math.max(8, topbar.getBoundingClientRect().bottom + 4)
          : 8;
      const footer = document.querySelector(".toolbar"),
        bottom = footer ? footer.getBoundingClientRect().top : innerHeight;
      panel.style.position = "fixed";
      panel.style.width = Math.min(260, innerWidth - 24) + "px";
      panel.style.maxHeight = Math.max(100, bottom - minTop - 12) + "px";
      panel.style.overflowY = "auto";
      const height = panel.getBoundingClientRect().height;
      panel.style.top =
        Math.max(minTop, Math.min(rect.bottom, bottom - height - 8)) + "px";
      panel.style.left =
        Math.max(
          12,
          Math.min(
            rect.right - panel.getBoundingClientRect().width,
            innerWidth - panel.getBoundingClientRect().width - 12,
          ),
        ) + "px";
    },
    true,
  );
  document.addEventListener("click", (event) => {
    if (!event.target.closest(".browse-menu"))
      for (const menu of document.querySelectorAll(".browse-menu[open]"))
        menu.open = false;
  });
}
