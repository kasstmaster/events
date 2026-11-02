import {
  sections,
  sectionFor,
  tool,
  menu,
  sorting,
  topbar,
  bottom,
  row,
  searchBox,
  ordered,
  folderInSection,
} from "./browse-ui.js";
import { ui, C, H } from "./ui-runtime.js";
import { localSchedule } from "./reminder-time.js";
export function familyTools(ctx) {
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
    render,
    load,
  } = ctx;
  let current = null,
    selected = "",
    search = "",
    memberEditing = null,
    dragItem = null;
  let section = "",
    showSearch = false,
    addItemOpen = false;
  const itemDrafts = new Map();
  let saveStatus = "Connected · showing server-confirmed data";
  function saving(value) {
    saveStatus = value;
    const el = document.querySelector("#family-save-status");
    if (el) el.textContent = value;
  }

  const data = () => state.familyData || state.data;
  const adult = () => data().member.role !== "kid";
  const manager = () => ["owner", "administrator"].includes(data().member.role);
  const canManageRecord = (r) =>
    adult() &&
    (!["task", "chore"].includes(r.type) ||
      manager() ||
      !r.assignees.some(
        (key) => data().members.find((m) => m.id === key)?.role === "kid",
      ));
  const record = () => data().records.find((r) => r.id === selected);
  const name = (id) =>
    data().members.find((m) => m.id === id)?.name || "Family member";
  const action = (id, label, key = "", cls = "secondary") =>
    button(id, H(label), key ? `data-id="${escape(key)}"` : "", cls);
  const folderOptions = () => [
    ["", C("No folder")],
    ...data()
      .records.filter(
        (r) =>
          r.type === "folder" &&
          r.id !== current?.id &&
          folderInSection(
            r,
            current?.section || section || "lists",
            data().records,
          ),
      )
      .map((r) => [r.id, r.title]),
  ];
  async function refresh() {
    state.familyData = await api("/api/family");
    if (state.session.role === "family") state.data = state.familyData;
  }
  function preferences(extra = {}) {
    return api("/api/family/preferences", {
      method: "PUT",
      version:
        extra.member && extra.member !== data().member.id
          ? state.familyPreferenceEdit?.version || 0
          : data().preferences.version || 0,
      data: { ...data().preferences, ...extra },
    });
  }
  function renderWorkspace() {
    const d = data(),
      r = record();
    const selectedSection =
      r?.type === "folder" ? section : sectionFor(r?.type) || section;
    const title =
      selected === "__settings__"
        ? C("Settings")
        : r
          ? escape(r.title)
          : selected === "__mine__"
            ? C("My Tasks")
            : selectedSection
              ? C(
                  sections.find((s) => s[0] === selectedSection)?.[1] ||
                    "Lists",
                )
              : C("Family Workspace");
    const type = {
      lists: "list",
      tasks: "task",
      records: "record",
      chores: "chore",
    }[selectedSection];
    const plus =
      adult() && selected !== "__settings__"
        ? [
            { action: "family-new-folder", label: "Create folder" },
            ...(type
              ? [
                  {
                    action: "family-new-" + type,
                    label: {
                      list: "Create list",
                      task: "Create task",
                      record: "Create record",
                      chore: "Create chore",
                    }[type],
                  },
                ]
              : sections.map(([key, label]) => ({
                  action:
                    "family-new-" +
                    {
                      lists: "list",
                      tasks: "task",
                      records: "record",
                      chores: "chore",
                    }[key],
                  label:
                    "Create " +
                    {
                      lists: "list",
                      tasks: "task",
                      records: "record",
                      chores: "chore",
                    }[key],
                }))),
          ]
        : [];
    const options = [
      ...sorting(
        "family-",
        r?.type === "list"
          ? d.preferences.alphabetical
            ? "alpha"
            : "manual"
          : d.preferences.collectionSort,
      ),
      { action: "family-refresh", label: "Refresh household" },
      { action: "family-mine", label: "My Tasks" },
    ];
    if (r?.type === "list")
      options.push({
        action: "family-hide",
        label: d.preferences.hideCompleted ? "Show All" : "Hide Completed",
      });
    const count =
      r?.type === "list" ? d.items.filter((i) => i.list === r.id) : [];
    const header = topbar({
      title,
      subtitle:
        r?.type === "list"
          ? `${count.filter((i) => !i.completed).length} ${H("of")} ${count.length} ${H("items remaining")}`
          : "",
      back: selected || section ? "family-back" : null,
      search: selected === "__settings__" ? null : "family-search",
      plus,
      sort: selected === "__settings__" ? [] : options,
      extra:
        r?.type === "list"
          ? tool("family-add-open", "Add Item", "", "plus")
          : "",
    });
    let content = "";
    if (selected === "__settings__")
      content = `<ul class="browse-rows">${row({ title: C("Notification settings"), action: "family-preferences", symbol: "settings" })}${row({ title: C("Change Password"), action: "family-password", symbol: "edit" })}${manager() ? row({ title: C("Family Members"), action: "family-members", symbol: "contacts" }) : ""}${state.session.role === "host" ? row({ title: C("Back to household home"), action: "home", symbol: "home" }) : ""}</ul>`;
    else if (search) {
      const found = ordered(
        d.records.filter((r) =>
          [
            r.title,
            r.notes,
            r.instructions,
            r.model,
            r.serial,
            ...Object.values(r.details || {}),
          ]
            .join(" ")
            .toLowerCase()
            .includes(search.toLowerCase()),
        ),
        d.preferences.collectionSort,
      );
      content = renderRows(found);
    } else if (r && r.type !== "folder") content = renderRecord(r);
    else if (selected === "__mine__") content = renderTasks(true);
    else if (!selectedSection)
      content = `<ul class="browse-rows">${sections.map(([key, label]) => row({ title: C(label), symbol: "folder", action: "family-section", id: key, meta: String(d.records.filter((r) => sectionFor(r.type) === key).length) + " " + H("items") })).join("")}</ul>`;
    else {
      const folder = r?.type === "folder" ? r.id : "";
      const rows = ordered(
        d.records.filter(
          (r) =>
            (d.records.some((parent) => parent.id === r.folder)
              ? r.folder
              : "") === folder &&
            (r.type === "folder"
              ? folderInSection(r, selectedSection, d.records)
              : sectionFor(r.type) === selectedSection),
        ),
        d.preferences.collectionSort,
      );
      content = renderRows(rows);
    }
    const notifications = d.notifications.filter((n) => !n.read);
    return `<div class="browse-shell">${header}${showSearch ? searchBox("family", search, escape, "Search Lists, Tasks, Records and Chores") : ""}<div class="browse-content">${notifications.length ? `<details class="browse-notifications"><summary>${H("In-app notifications")} (${notifications.length})</summary><ul class="browse-rows">${notifications.map((n) => row({ title: escape(n.title), action: "family-notification", id: n.id, controls: action("family-read", "Mark read", n.id) })).join("")}</ul></details>` : ""}${content}<p id="family-save-status" class="connection" role="status">${escape(C(saveStatus))}</p>${d.pendingHistory ? "<p>Older task history is still being prepared in bounded batches.</p>" : ""}</div>${bottom(
      [
        {
          action: "family-root",
          label: "Home",
          icon: "home",
          current: selected !== "__settings__",
        },
        {
          action: "family-settings",
          label: "Settings",
          icon: "settings",
          current: selected === "__settings__",
        },
        { action: "logout", label: "Sign Out", icon: "logout" },
      ],
    )}</div>`;
  }
  function recordControls(r) {
    if (!canManageRecord(r)) return "";
    return (
      tool("family-edit", "Edit", r.id, "edit") +
      menu("Record actions", "more", [
        ...(data().preferences.collectionSort !== "alpha"
          ? [
              { action: "family-record-up", id: r.id, label: "Move up" },
              { action: "family-record-down", id: r.id, label: "Move down" },
            ]
          : []),
        ...(manager() || r.createdBy === data().member.id
          ? [{ action: "family-delete", id: r.id, label: "Delete" }]
          : []),
      ])
    );
  }
  function renderRows(records) {
    const d = data();
    const renderRow = (r) => {
      const scheduled = ["task", "chore"].includes(r.type);
      const occurrences = scheduled
        ? d.occurrences.filter((o) => o.chore === r.id && !o.cancelled)
        : [];
      const complete = (o) =>
        !!o.completed[o.completionMode === "shared" ? "shared" : d.member.id];
      const occurrence =
        occurrences.find((o) => !complete(o)) || occurrences.at(-1);
      const completion =
        occurrence && !r.cancelled
          ? occurrence.assignees.includes(d.member.id)
            ? `<label class="check"><input type="checkbox" aria-label="${H("Complete this occurrence")}" data-family-occurrence="${occurrence.id}" ${complete(occurrence) ? "checked" : ""}>${H("Complete")}</label>`
            : `<span class="browse-status">${H(complete(occurrence) ? "Complete" : "Pending")}</span>`
          : "";
      const meta =
        r.type === "record"
          ? [r.model, r.serial].filter(Boolean).join(" · ")
          : scheduled
            ? [
                r.assignees.map(name).join(", "),
                r.dueLocal || String(C("No due date")),
                r.repeat,
                r.cancelled ? String(C("Cancelled")) : "",
              ]
                .filter(Boolean)
                .join(" · ")
            : (r.categories || []).join(" · ");
      return row({
        title: escape(r.title),
        meta: escape(meta),
        symbol:
          r.type === "folder" || r.type === "record"
            ? "folder"
            : r.type === "list"
              ? "list"
              : "task",
        action: "family-open",
        id: r.id,
        controls: completion + (adult() ? recordControls(r) : ""),
        attributes:
          adult() && d.preferences.collectionSort !== "alpha"
            ? `draggable="true" data-family-record="${r.id}"`
            : "",
      });
    };
    const groups = new Map();
    for (const r of records) {
      const category = ["record", "task", "chore"].includes(r.type)
        ? r.categories?.[0] || ""
        : "";
      if (!groups.has(category)) groups.set(category, []);
      groups.get(category).push(r);
    }
    return `<ul class="browse-rows">${[...groups].map(([category, rows]) => `${category ? `<li class="browse-category">${escape(category)}</li>` : ""}${rows.map(renderRow).join("")}`).join("") || `<li class="browse-empty">${H("Nothing here yet. Use the plus menu to get started.")}</li>`}</ul>`;
  }
  function renderTasks(mine, choreId) {
    const d = data(),
      tasks = d.occurrences.filter(
        (o) =>
          (!choreId || o.chore === choreId) &&
          (!mine || o.assignees.includes(d.member.id)),
      );
    return `<ul class="browse-rows">${
      tasks
        .map((o) => {
          const c = d.records.find((r) => r.id === o.chore);
          if (!c) return "";
          const complete =
            !!o.completed[
              o.completionMode === "shared" ? "shared" : d.member.id
            ];
          return row({
            title: escape(c.title),
            meta: escape(
              [
                o.due
                  ? new Date(o.due).toLocaleString([], { timeZone: c.timezone })
                  : String(C("No due date")),
                o.assignees.map(name).join(", "),
                c.repeat,
                o.cancelled ? String(C("Cancelled")) : "",
              ]
                .filter(Boolean)
                .join(" · "),
            ),
            symbol: "task",
            action: "family-open",
            id: c.id,
            controls:
              !o.cancelled && !c.cancelled && o.assignees.includes(d.member.id)
                ? `<label class="check"><input type="checkbox" aria-label="${H("Complete this occurrence")}" data-family-occurrence="${o.id}" ${complete ? "checked" : ""}>${H("Complete")}</label>`
                : "",
          });
        })
        .join("") ||
      `<li class="browse-empty">${H("No tasks are assigned here yet.")}</li>`
    }</ul>`;
  }
  function renderRecord(r) {
    const d = data();
    if (r.type === "list") {
      const draft = itemDrafts.get(r.id) || { title: "", category: "" },
        items = d.items.filter((i) => i.list === r.id);
      return `${addItemOpen ? ui`<form data-form="family-add-item" class="browse-add-item">${field(H("New item"), "title", draft.title, "text", 'required maxlength="500"')}${select(H("Category"), "category", [["", C("No category")], ...r.categories.map((c) => [c, c])], draft.category)}<button>${H("Add item")}</button><p class="form-error" role="alert"></p></form>` : ""}${[
        "",
        ...r.categories,
      ]
        .map(
          (category) =>
            `<section class="list-category">${category ? `<h2 class="browse-category">${escape(category)}</h2>` : ""}<ul class="family-items browse-rows">${
              ordered(
                items.filter(
                  (i) =>
                    i.category === category &&
                    (!d.preferences.hideCompleted || !i.completed),
                ),
                d.preferences.alphabetical ? "alpha" : "manual",
              )
                .map(
                  (item) =>
                    `<li data-family-item="${item.id}" class="browse-row ${item.completed ? "completed" : ""}"><label class="check"><input aria-label="${H("Complete")} ${escape(item.title)}" type="checkbox" data-family-check="${item.id}" ${item.completed ? "checked" : ""}></label><span class="family-item-title browse-row-content">${escape(item.title)}</span>${
                      adult()
                        ? `<div class="browse-row-actions">${tool("family-item-edit", "Edit item", item.id, "edit")}${menu(
                            "Item actions",
                            "more",
                            [
                              ...(!d.preferences.alphabetical
                                ? [
                                    {
                                      action: "family-item-up",
                                      label: "Move up",
                                      id: item.id,
                                    },
                                    {
                                      action: "family-item-down",
                                      label: "Move down",
                                      id: item.id,
                                    },
                                  ]
                                : []),
                              {
                                action: "family-item-delete",
                                label: "Delete item",
                                id: item.id,
                              },
                            ],
                          )}${!d.preferences.alphabetical ? `<button type="button" data-family-drag="${item.id}" draggable="true" aria-label="${H("Drag")} ${escape(item.title)}">↕</button>` : ""}</div>`
                        : ""
                    }</li>`,
                )
                .join("") ||
              `<li class="browse-empty">${H("No items here yet.")}</li>`
            }</ul></section>`,
        )
        .join("")}`;
    }
    const controls = adult() ? recordControls(r) : "";
    if (r.type === "record")
      return `<div class="browse-detail">${controls}<dl><dt>${H("Model")}</dt><dd>${escape(r.model)}</dd><dt>${H("Serial number")}</dt><dd>${escape(r.serial)}</dd>${Object.entries(
        r.details || {},
      )
        .map(([k, v]) => `<dt>${escape(k)}</dt><dd>${escape(v)}</dd>`)
        .join(
          "",
        )}</dl><p class="preserve-lines">${escape(r.notes)}</p><h2>${H("Maintenance history")}</h2>${(r.history || []).map((h) => row({ title: escape(h.date), meta: escape(h.notes), symbol: "task" })).join("")}${action("family-files", adult() ? "Manage documents" : "View documents", r.id)}${manager() ? action("family-maintenance", "Create linked maintenance chore", r.id) : ""}</div>`;
    return `<div class="browse-detail">${controls}<p>${escape(r.instructions)}</p><p>${escape(r.assignees.map(name).join(", "))} · ${escape(r.repeat)} · ${escape(r.timezone)}</p>${r.linkedRecord ? action("family-open", "View linked home record", r.linkedRecord) : ""}${action("family-history", "View completion history", r.id)}${renderTasks(false, r.id)}</div>`;
  }
  function recordEditor(r = { type: "list" }) {
    current = {
      ...r,
      section:
        r.section ||
        (r.type === "folder" && r.id ? "shared" : sectionFor(r.type)) ||
        section ||
        "lists",
      folder: r.folder || (record()?.type === "folder" ? record().id : ""),
    };
    r = current;
    const common = ui`${r.type === "folder" ? select(H("Main section"), "section", [...sections.map(([key, label]) => [key, C(label)]), ["shared", C("Shared across sections")]], r.id && !r.section ? "shared" : r.section || section || "lists") : ""}${field(H("Title"), "title", r.title || "", "text", 'required maxlength="200"')}${select(H("Folder"), "folder", folderOptions(), r.folder || "")}`;
    const categories = ["record", "task", "chore"].includes(r.type)
      ? area(
          H("Categories · one per line"),
          "categories",
          (r.categories || []).join("\n"),
        )
      : "";
    const acl = manager()
      ? ui`<fieldset><legend>Kid Friendly / Child Access</legend><p>Only the specific children selected here can access this item. Folder access alone never exposes restricted contents. New records allow no children. Restricted parent folders must also allow the child.</p>${
          data()
            .members.filter((m) => m.role === "kid" && !m.disabled)
            .map(
              (m) =>
                ui`<label class="check"><input name="childAccess" type="checkbox" value="${m.id}" ${(r.childAccess || []).includes(m.id) ? "checked" : ""}>${escape(m.name)}</label>`,
            )
            .join("") || "<p>Create a kid account in Family members first.</p>"
        }</fieldset>`
      : "";
    let fields = "";
    if (r.type === "list")
      fields = ui`${area(H("Categories · one per line, in manual order"), "categories", (r.categories || []).join("\n"))}<p>No categories are required. Reorder category lines to change their manual order.</p>`;
    if (r.type === "record")
      fields = ui`${field(H("Model number"), "model", r.model || "")}${field(H("Serial number"), "serial", r.serial || "")}${field(H("Relevant date"), "date", r.date || "", "date")}${area(H("Notes"), "notes", r.notes || "")}${area(
        H("Custom details · one key: value per line"),
        "details",
        Object.entries(r.details || {})
          .map(([k, v]) => k + ": " + v)
          .join("\n"),
      )}${area(H("Maintenance history · one date | notes per line"), "history", (r.history || []).map((h) => h.date + " | " + h.notes).join("\n"))}`;
    if (["task", "chore"].includes(r.type))
      fields = ui`${area(H("Instructions"), "instructions", r.instructions || "")}<fieldset><legend>Assigned family members</legend>${data()
        .members.filter((m) => !m.disabled && (manager() || m.role !== "kid"))
        .map(
          (m) =>
            ui`<label class="check"><input type="checkbox" name="assignees" value="${m.id}" ${(r.assignees || []).includes(m.id) ? "checked" : ""}>${escape(m.name)}</label>`,
        )
        .join(
          "",
        )}</fieldset>${field(H("First due date / time · optional"), "dueLocal", r.dueLocal || "", "datetime-local")}${field(H("IANA timezone"), "timezone", r.timezone || data().preferences.timezone || data().timezone || "UTC")}${select(
        H("Repeat"),
        "repeat",
        ["none", "daily", "weekly", "monthly"].map((v) => [v, v]),
        r.repeat || "none",
      )}${field(H("Repeat every"), "interval", r.interval || 1, "number", 'min="1" max="365"')}${select(
        H("Completion responsibility"),
        "completionMode",
        [
          ["each", C("Each assignee separately")],
          ["shared", C("One completion for everyone")],
        ],
        r.completionMode || "each",
      )}${select(
        H("In-app reminder"),
        "reminderMinutes",
        [
          [-1, C("Off")],
          [0, C("At the due time")],
          [15, C("15 minutes before")],
          [30, C("30 minutes before")],
          [60, C("1 hour before")],
          [1440, C("1 day before")],
        ],
        r.reminderMinutes ?? -1,
      )}${select(
        H("Linked home record"),
        "linkedRecord",
        [
          ["", C("None")],
          ...data()
            .records.filter((r) => r.type === "record")
            .map((r) => [r.id, r.title]),
        ],
        r.linkedRecord || "",
      )}<label class="check"><input type="checkbox" name="cancelled" ${r.cancelled ? "checked" : ""}>Cancel future reminders and occurrences</label><p>Assigned children can access this chore independently of the child-access checkboxes. Remove their assignment to revoke that access. Linked home records keep their own permissions.</p><p>Reminders are in-app only. Repeating chores keep separate occurrence history. DST times that do not exist or occur twice are skipped.</p>`;
    modal(
      r.id ? C("Edit household record") : C("Create household record"),
      common + categories + fields + acl,
      "family-record",
    );
  }
  function memberEditor(member = {}) {
    memberEditing = member;
    modal(
      member.id ? C("Manage family member") : C("Create family member"),
      ui`${field(H("Name"), "name", member.name || "", "text", "required")}${member.id ? "" : field(H("Sign-in name · no email required"), "login", "", "text", "required")}<p>Share the sign-in name and password privately. No account email is sent. An adult can reset a forgotten password here.</p>${select(H("Household role"), "role", [...(data().member.role === "owner" ? [["administrator", C("Household administrator")]] : []), ["member", C("Regular member")], ["kid", C("Kid account")]], member.role || "member")}${field(H(member.id ? "New password · leave empty to keep current password" : "Password · at least 12 characters"), "password", "", "password", member.id ? "" : 'required minlength="12"')}<label class="check"><input type="checkbox" name="disabled" ${member.disabled ? "checked" : ""}>Disable sign-in and revoke sessions</label>${member.id ? action("family-member-remove", "Remove member", member.id, "danger") : ""}`,
      "family-member",
    );
  }
  async function files(r) {
    const full = await api("/api/family/records/" + r.id);
    current = r;
    modal(
      C("Private documents"),
      ui`<p>${(data().storage.used / 1000000).toFixed(1)} / 20 MB used · 2 MB maximum per file. PDF, PNG, JPEG, WebP or plain text.</p>${adult() ? ui`${field(H("Document"), "document", "", "file", 'accept="application/pdf,image/png,image/jpeg,image/webp,text/plain"')}${action("family-upload", "Upload document")}` : ""}<ul>${full.files.map((f) => ui`<li>${escape(f.name)} · ${f.size} bytes <a class="button" href="/api/family/files/${f.id}" download>Download</a>${adult() ? action("family-file-delete", "Delete document", f.id) : ""}</li>`).join("") || "<li>No documents uploaded.</li>"}</ul>`,
    );
    state.familyFiles = full.files;
  }
  async function toggle(item) {
    await api("/api/family/items/" + item.id, {
      method: "PUT",
      version: item.version,
      data: { completed: !item.completed },
    });
    await refresh();
    saving("Saved");
    render();
  }
  async function moveItem(item, direction, targetId) {
    const items = data()
      .items.filter(
        (i) =>
          i.list === item.list &&
          i.category === item.category &&
          i.id !== item.id,
      )
      .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
    let index = targetId
      ? items.findIndex((i) => i.id === targetId)
      : data()
          .items.filter(
            (i) => i.list === item.list && i.category === item.category,
          )
          .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
          .findIndex((i) => i.id === item.id) + (direction > 0 ? 1 : -1);
    index = Math.max(0, Math.min(items.length, index));
    const lower = items[index - 1]?.position,
      upper = items[index]?.position,
      position =
        lower === undefined
          ? (upper ?? Date.now()) - 1024
          : upper === undefined
            ? lower + 1024
            : (lower + upper) / 2;
    await api("/api/family/items/" + item.id, {
      method: "PUT",
      version: item.version,
      data: { position },
    });
    await refresh();
    render();
  }
  async function moveRecord(key, direction, targetKey) {
    const r = data().records.find((r) => r.id === key);
    const rows = ordered(
      data().records.filter(
        (x) =>
          x.folder === r.folder &&
          x.id !== r.id &&
          (x.type === "folder" || sectionFor(x.type) === sectionFor(r.type)),
      ),
      "manual",
    );
    const all = ordered([...rows, r], "manual"),
      index = targetKey
        ? rows.findIndex((x) => x.id === targetKey)
        : all.findIndex((x) => x.id === key) + (direction > 0 ? 1 : -1);
    const at = Math.max(0, Math.min(rows.length, index)),
      before = rows[at - 1]?.position,
      after = rows[at]?.position,
      position =
        before === undefined
          ? (after ?? Date.now()) - 1024
          : after === undefined
            ? before + 1024
            : (before + after) / 2;
    await api("/api/family/records/" + r.id, {
      method: "PUT",
      version: r.version,
      data: { ...r, position },
    });
    await refresh();
    render();
  }
  return {
    reset() {
      itemDrafts.clear();
      selected = "";
      section = "";
      showSearch = false;
      addItemOpen = false;
      search = "";
      state.familyData = null;
    },
    render: renderWorkspace,
    renderExample(key = "") {
      const previous = { selected, section, search, showSearch, addItemOpen };
      try {
        selected = key;
        section = "";
        search = "";
        showSearch = false;
        addItemOpen = false;
        return renderWorkspace();
      } finally {
        ({ selected, section, search, showSearch, addItemOpen } = previous);
      }
    },
    refresh,
    saving,
    async action(actionName, target) {
      if (actionName === "home" && state.session.role === "family") {
        selected = "";
        state.view = "family";
        render();
        return true;
      }
      if (!actionName.startsWith("family-")) return false;
      const key = target.dataset.id;
      if (actionName === "family-section") {
        section = key;
        selected = "";
        search = "";
        render();
        return true;
      }
      if (actionName === "family-settings") {
        selected = "__settings__";
        search = "";
        render();
        return true;
      }
      if (actionName === "family-search") {
        showSearch = !showSearch;
        if (!showSearch) search = "";
        render();
        document.querySelector("[data-browse-search=family]")?.focus();
        return true;
      }
      if (actionName === "family-add-open") {
        addItemOpen = !addItemOpen;
        render();
        document
          .querySelector("form[data-form=family-add-item] [name=title]")
          ?.focus();
        return true;
      }
      if (actionName === "family-back") {
        const r = record();
        selected = r?.folder || "";
        if (!r) section = "";
        search = "";
        render();
        return true;
      }
      if (
        actionName === "family-sort-alpha" ||
        actionName === "family-sort-manual"
      ) {
        const alpha = actionName.endsWith("alpha");
        await preferences(
          record()?.type === "list"
            ? { alphabetical: alpha }
            : { collectionSort: alpha ? "alpha" : "manual" },
        );
        await refresh();
        render();
        return true;
      }
      if (
        actionName === "family-record-up" ||
        actionName === "family-record-down"
      ) {
        await moveRecord(key, actionName.endsWith("up") ? -1 : 1);
        return true;
      }

      if (actionName === "family-workspace") {
        selected = "";
        section = "";
        search = "";
        await refresh();
        state.view = "family";
        state.event = null;
        render();
      } else if (actionName === "family-refresh") {
        await refresh();
        render();
      } else if (actionName === "family-root") {
        selected = "";
        section = "";
        search = "";
        render();
      } else if (actionName === "family-mine") {
        selected = "__mine__";
        render();
      } else if (actionName === "family-open") {
        selected = key;
        section = sectionFor(record()?.type) || section;
        search = "";
        addItemOpen = false;
        render();
      } else if (actionName.startsWith("family-new-"))
        recordEditor({ type: actionName.slice(11) });
      else if (actionName === "family-edit")
        recordEditor(data().records.find((r) => r.id === key));
      else if (actionName === "family-delete") {
        const r = data().records.find((r) => r.id === key);
        if (
          !confirm(
            String(
              C(
                "Delete this household record? Completed history is retained for chores.",
              ),
            ),
          )
        )
          return true;
        await api("/api/family/records/" + key, {
          method: "DELETE",
          version: r.version,
          data: {},
        });
        selected = "";
        await refresh();
        render();
      } else if (actionName === "family-hide" || actionName === "family-sort") {
        await preferences(
          actionName === "family-hide"
            ? { hideCompleted: !data().preferences.hideCompleted }
            : { alphabetical: !data().preferences.alphabetical },
        );
        await refresh();
        render();
      } else if (
        actionName === "family-history" ||
        actionName === "family-history-more"
      ) {
        const offset =
          actionName === "family-history-more"
            ? state.familyHistoryNext || 0
            : 0;
        const result = await api(
          "/api/family/records/" + key + "/history?offset=" + offset,
        );
        state.familyHistoryNext = result.next;
        modal(
          C("Completion history"),
          ui`${
            result.occurrences
              .map(
                (o) =>
                  ui`<article><p>${escape(o.due || "No due date")}${o.cancelled ? " · cancelled schedule" : ""}</p><p>${
                    Object.entries(o.completed)
                      .map(
                        ([key, time]) =>
                          escape(
                            key === "shared" ? "Shared completion" : name(key),
                          ) +
                          ": " +
                          escape(new Date(time).toLocaleString()),
                      )
                      .join(" · ") || C("Not completed")
                  }</p></article>`,
              )
              .join("") || "<p>No occurrences yet.</p>"
          }${result.next !== null ? action("family-history-more", "Next history page", key) : ""}`,
        );
      } else if (actionName === "family-files")
        await files(data().records.find((r) => r.id === key));
      else if (actionName === "family-upload") {
        const input = document.querySelector("[name=document]"),
          file = input.files[0];
        if (!file) throw Error("Choose a document.");
        if (file.size > 2000000) throw Error("Each file may be up to 2 MB.");
        const base64 = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result.split(",")[1]);
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });
        await api("/api/family/files", {
          method: "POST",
          data: {
            record: current.id,
            name: file.name,
            mime: file.type,
            base64,
          },
        });
        await refresh();
        await files(current);
      } else if (actionName === "family-file-delete") {
        if (!confirm(String(C("Delete this private document?")))) return true;
        const f = state.familyFiles.find((f) => f.id === key);
        await api("/api/family/files/" + key, {
          method: "DELETE",
          version: f.version,
          data: {},
        });
        await refresh();
        await files(current);
      } else if (actionName === "family-maintenance")
        recordEditor({ type: "chore", linkedRecord: key });
      else if (actionName === "family-item-edit") {
        current = data().items.find((i) => i.id === key);
        modal(
          C("Edit list item"),
          ui`${field(H("Item"), "title", current.title, "text", "required")}${select(H("Category"), "category", [["", C("No category")], ...record().categories.map((c) => [c, c])], current.category)}`,
          "family-item",
        );
      } else if (actionName === "family-item-delete") {
        const item = data().items.find((i) => i.id === key);
        if (!confirm(String(C("Delete this list item?")))) return true;
        await api("/api/family/items/" + key, {
          method: "DELETE",
          version: item.version,
          data: {},
        });
        await refresh();
        render();
      } else if (
        actionName === "family-item-up" ||
        actionName === "family-item-down"
      )
        await moveItem(
          data().items.find((i) => i.id === key),
          actionName === "family-item-up" ? -1 : 1,
        );
      else if (actionName === "family-members")
        modal(
          C("Family members"),
          ui`<p>Each person uses their own sign-in. Platform administration is never granted here.</p>${action("family-member-new", "Create family member")}<ul>${data()
            .members.map(
              (m) =>
                ui`<li>${escape(m.name)} · ${escape(m.role)}${m.disabled ? " · disabled" : ""}${m.role !== "owner" && m.id !== data().member.id && (data().member.role === "owner" || m.role !== "administrator") ? action("family-member-edit", "Manage", m.id) : ""}</li>`,
            )
            .join(
              "",
            )}</ul>${data().member.role === "owner" ? action("family-owner-transfer", "Transfer ownership") : ""}`,
        );
      else if (actionName === "family-member-new") memberEditor();
      else if (actionName === "family-member-edit")
        memberEditor(data().members.find((m) => m.id === key));
      else if (actionName === "family-member-remove") {
        if (
          !confirm(
            String(
              C(
                "Disable and remove this member’s access? History is retained.",
              ),
            ),
          )
        )
          return true;
        await api("/api/family/members/" + key, {
          method: "DELETE",
          version: memberEditing.version,
          data: {},
        });
        await refresh();
        await saved("Member access removed.");
      } else if (actionName === "family-password")
        modal(
          C("Change my password"),
          field(
            H("Current password"),
            "currentPassword",
            "",
            "password",
            "required",
          ) +
            field(
              H("New password"),
              "password",
              "",
              "password",
              'required minlength="12"',
            ),
          "family-password",
        );
      else if (actionName === "family-owner-transfer")
        modal(
          C("Transfer household ownership"),
          ui`<p>This signs out all household accounts. The former owner becomes a regular member.</p>${select(
            H("New owner"),
            "member",
            data()
              .members.filter(
                (m) =>
                  m.role !== "kid" && !m.disabled && m.id !== data().member.id,
              )
              .map((m) => [m.id, m.name]),
            "",
          )}${field(H("Your current password"), "password", "", "password", "required")}`,
          "family-owner-transfer",
        );
      else if (actionName === "family-preferences") {
        const p = data().preferences;
        state.familyPreferenceEdit = p;
        if (!adult()) {
          modal(
            C("Your settings"),
            "<p>Your household owner or administrator manages task notifications and quiet hours. List display preferences are available on each list.</p>",
          );
          return true;
        }
        modal(
          C("Notification settings"),
          ui`${field(H("IANA timezone"), "timezone", p.timezone || data().timezone || "UTC")}<label class="check"><input name="notifications" type="checkbox" ${p.notifications !== false ? "checked" : ""}>Enable in-app task reminders</label>${field(H("Quiet hours start · 0–23"), "quietStart", p.quietStart || 0, "number", 'min="0" max="23"')}${field(H("Quiet hours end · 0–23"), "quietEnd", p.quietEnd || 0, "number", 'min="0" max="23"')}${
            manager()
              ? select(
                  H("Settings for"),
                  "member",
                  [
                    [data().member.id, C("Myself")],
                    ...data()
                      .members.filter((m) => m.role === "kid")
                      .map((m) => [m.id, m.name]),
                  ],
                  data().member.id,
                )
              : ""
          }<p>These settings apply to in-app notifications. Browser push, email and SMS are not enabled.</p>`,
          "family-preferences",
        );
      } else if (actionName === "family-notification") {
        const n = data().notifications.find((n) => n.id === key),
          o = data().occurrences.find((o) => o.id === n.occurrence);
        selected = o?.chore || "";
        render();
      } else if (actionName === "family-read") {
        const n = data().notifications.find((n) => n.id === key);
        await api("/api/family/notifications/" + encodeURIComponent(key), {
          method: "PUT",
          version: n.version,
          data: {},
        });
        await refresh();
        render();
      }
      return true;
    },
    async submit(form, kind) {
      if (!kind.startsWith("family-")) return false;
      if (
        kind === "family-preferences" &&
        form.dataset.preferenceReady === "false"
      )
        throw new Error(
          C("Wait for the selected member’s preferences to load."),
        );
      saving("Saving…");
      const fd = new FormData(form),
        value = Object.fromEntries(fd);
      if (kind === "family-record") {
        const input = {
          ...current,
          ...value,
          type: current.type,
          childAccess: manager()
            ? fd.getAll("childAccess")
            : current.childAccess || [],
        };
        if (["list", "record", "task", "chore"].includes(input.type))
          input.categories = value.categories
            .split("\n")
            .map((v) => v.trim())
            .filter(Boolean);
        if (input.type === "record") {
          input.details = Object.fromEntries(
            value.details
              .split("\n")
              .filter((v) => v.includes(":"))
              .map((v) => [
                v.slice(0, v.indexOf(":")).trim(),
                v.slice(v.indexOf(":") + 1).trim(),
              ]),
          );
          input.history = value.history
            .split("\n")
            .filter((v) => v.includes("|"))
            .map((v) => ({
              date: v.split("|")[0].trim(),
              notes: v.slice(v.indexOf("|") + 1).trim(),
            }));
        }
        if (["task", "chore"].includes(input.type)) {
          input.assignees = fd.getAll("assignees");
          input.cancelled = fd.has("cancelled");
        }
        const result = await api(
          "/api/family/records" + (current.id ? "/" + current.id : ""),
          {
            method: current.id ? "PUT" : "POST",
            version: current.version,
            data: input,
          },
        );
        selected = result.id;
        section = sectionFor(current.type) || section;
      } else if (kind === "family-add-item") {
        await api("/api/family/items", {
          method: "POST",
          data: { ...value, list: selected },
        });
        itemDrafts.set(selected, { title: "", category: value.category });
      } else if (kind === "family-item")
        await api("/api/family/items/" + current.id, {
          method: "PUT",
          version: current.version,
          data: value,
        });
      else if (kind === "family-member")
        await api(
          "/api/family/members" +
            (memberEditing.id ? "/" + memberEditing.id : ""),
          {
            method: memberEditing.id ? "PUT" : "POST",
            version: memberEditing.version,
            data: { ...value, disabled: fd.has("disabled") },
          },
        );
      else if (kind === "family-password" || kind === "family-owner-transfer") {
        await api(
          kind === "family-password"
            ? "/api/family/password"
            : "/api/family/transfer-owner",
          { method: kind === "family-password" ? "PUT" : "POST", data: value },
        );
        state.view = "family-login";
        await load();
        document.querySelector("#editor").close();
        return true;
      } else if (kind === "family-preferences")
        await preferences({ ...value, notifications: fd.has("notifications") });
      await refresh();
      saving("Saved");
      await saved("Saved to your household.");
      return true;
    },
    bind() {
      document.addEventListener("change", async (event) => {
        if (
          event.target.name !== "member" ||
          !event.target.closest("form[data-form=family-preferences]")
        )
          return;
        const form = event.target.closest("form");
        const selectedMember = event.target.value;
        form.dataset.preferenceReady = "false";
        const saveButton = form.querySelector("button:not([type=button])");
        if (saveButton) saveButton.disabled = true;
        try {
          const p = await api(
            "/api/family/preferences?member=" +
              encodeURIComponent(event.target.value),
          );
          if (
            !form.isConnected ||
            form.elements.member.value !== selectedMember
          )
            return;
          state.familyPreferenceEdit = p;
          form.dataset.preferenceReady = "true";
          if (saveButton) saveButton.disabled = false;
          form.elements.timezone.value = p.timezone || data().timezone || "UTC";
          form.elements.quietStart.value = p.quietStart || 0;
          form.elements.quietEnd.value = p.quietEnd || 0;
          form.elements.notifications.checked = p.notifications !== false;
        } catch (error) {
          notify(error.message);
        }
      });
      const rememberDraft = (event) => {
        const form = event.target.closest("form[data-form=family-add-item]");
        if (form)
          itemDrafts.set(selected, Object.fromEntries(new FormData(form)));
      };
      document.addEventListener("input", rememberDraft);
      document.addEventListener("change", rememberDraft);
      document.addEventListener("input", (event) => {
        if (event.target.matches("[data-browse-search=family]")) {
          search = event.target.value;
          const position = event.target.selectionStart;
          render();
          const input = document.querySelector("[data-browse-search=family]");
          input.focus();
          if (input.type !== "search")
            input.setSelectionRange(position, position);
        }
      });
      document.addEventListener("change", async (event) => {
        const target = event.target,
          key = target.dataset.familyCheck || target.dataset.familyOccurrence;
        if (!key) return;
        target.disabled = true;
        target.setAttribute("aria-busy", "true");
        saving("Saving…");
        try {
          if (target.dataset.familyCheck)
            await toggle(data().items.find((i) => i.id === key));
          else {
            const o = data().occurrences.find((o) => o.id === key);
            await api("/api/family/occurrences/" + encodeURIComponent(key), {
              method: "PUT",
              version: o.version,
              data: { completed: target.checked },
            });
            await refresh();
            saving("Saved");
            render();
          }
        } catch (error) {
          target.checked = !target.checked;
          saving(
            "Save failed · " +
              error.message +
              " Use Refresh household to load the latest version.",
          );
          notify(error.message);
        } finally {
          target.disabled = false;
          target.removeAttribute("aria-busy");
        }
      });
      document.addEventListener("dblclick", async (event) => {
        if (event.target.closest("button,input,select,textarea,a")) return;
        const row = event.target.closest("[data-family-item]");
        if (!row) return;
        try {
          await toggle(
            data().items.find((i) => i.id === row.dataset.familyItem),
          );
        } catch (error) {
          notify(error.message);
        }
      });
      let dragRecord = null;
      document.addEventListener("dragstart", (event) => {
        const el = event.target.closest("[data-family-record]");
        if (el) {
          dragRecord = el.dataset.familyRecord;
          event.dataTransfer.setData("text/plain", dragRecord);
        }
      });
      document.addEventListener("dragover", (event) => {
        if (dragRecord && event.target.closest("[data-family-record]"))
          event.preventDefault();
      });
      document.addEventListener("drop", async (event) => {
        const el = event.target.closest("[data-family-record]");
        if (!el || !dragRecord) return;
        event.preventDefault();
        const key = dragRecord;
        dragRecord = null;
        try {
          await moveRecord(key, 0, el.dataset.familyRecord);
        } catch (error) {
          notify(error.message);
        }
      });
      document.addEventListener("dragstart", (event) => {
        if (event.target.dataset.familyDrag) {
          dragItem = event.target.dataset.familyDrag;
          event.dataTransfer.setData("text/plain", dragItem);
        }
      });
      document.addEventListener("dragover", (event) => {
        if (dragItem && event.target.closest("[data-family-item]"))
          event.preventDefault();
      });
      document.addEventListener("drop", async (event) => {
        const row = event.target.closest("[data-family-item]");
        if (!row || !dragItem) return;
        event.preventDefault();
        const item = data().items.find((i) => i.id === dragItem);
        dragItem = null;
        const target = data().items.find(
          (i) => i.id === row.dataset.familyItem,
        );
        if (item?.category !== target?.category) return;
        try {
          await moveItem(item, 0, target.id);
        } catch (error) {
          notify(error.message);
        }
      });
    },
  };
}
