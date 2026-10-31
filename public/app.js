const $ = (selector) => document.querySelector(selector);
const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const fullName = (guest) =>
  [guest.first, guest.last, guest.suffix].filter(Boolean).join(" ");
const state = {
  session: null,
  setup: null,
  data: null,
  event: null,
  view: "home",
  publicHousehold: null,
  templates: [],
  lastSync: null,
};
const fonts = ["Georgia", "system-ui", "Arial", "Verdana", "Times New Roman"];
let noticeTimer;
const notify = (message) => {
  $("#notice").textContent = message;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => ($("#notice").textContent = ""), 6000);
};
async function api(path, { method = "GET", data, version } = {}) {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: {
      ...(data ? { "Content-Type": "application/json" } : {}),
      ...(version !== undefined ? { "If-Match": String(version) } : {}),
    },
    body: data ? JSON.stringify(data) : undefined,
  });
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(result.error || "Unable to save.");
    error.status = response.status;
    throw error;
  }
  return result;
}
const button = (action, label, extra = "", className = "secondary") =>
  `<button type="button" class="${className}" data-action="${action}" ${extra}>${label}</button>`;
const field = (label, name, value = "", type = "text", extra = "") =>
  `<label>${label}<input name="${name}" type="${type}" value="${escape(value)}" ${extra}></label>`;
const area = (label, name, value = "", extra = "") =>
  `<label>${label}<textarea name="${name}" ${extra}>${escape(value)}</textarea></label>`;
const select = (label, name, options, value, extra = "") =>
  `<label>${label}<select aria-label="${label}" name="${name}" ${extra}>${options.map(([key, label]) => `<option value="${escape(key)}" ${key === value ? "selected" : ""}>${escape(label)}</option>`).join("")}</select></label>`;
const dateLabel = (value) =>
  value
    ? new Intl.DateTimeFormat(undefined, {
        dateStyle: "long",
        timeZone: "UTC",
      }).format(new Date(value + "T12:00:00Z"))
    : "Date to come";
function applyDesign(settings = {}) {
  const d = {
    ...state.data?.defaults,
    ...state.publicHousehold?.defaults,
    ...settings,
  };
  if (!d.background) return;
  const root = document.documentElement.style;
  root.setProperty("--bg", d.background);
  root.setProperty(
    "--panel",
    `color-mix(in srgb, ${d.container} ${d.opacity}%, transparent)`,
  );
  root.setProperty("--heading", d.titleColor);
  root.setProperty("--ink", d.textColor);
  root.setProperty("--title-font", d.titleFont);
  root.setProperty("--body-font", d.textFont);
  root.setProperty("--title-size", `${d.titleSize}px`);
  root.setProperty("--text-size", `${d.textSize}px`);
  root.setProperty(
    "--background-image",
    d.backgroundImage ? `url("${d.backgroundImage}")` : "none",
  );
}
let loadGeneration = 0;
const isEditing = () =>
  $("#editor").open || document.activeElement?.matches("input,select,textarea");
async function load({ background = false } = {}) {
  if (background && isEditing()) return;
  const generation = ++loadGeneration;
  try {
    const setup = await api("/api/setup");
    state.setup = setup;
    if (setup.required) {
      if (generation !== loadGeneration || (background && isEditing())) return;
      Object.assign(state, {
        session: { role: null },
        data: null,
        publicHousehold: null,
      });
      render();
      return;
    }
    const context = await api("/api/public/context");
    const session = await api("/api/session");
    let data = null,
      templates = [],
      publicHousehold = context.household;
    if (session.role) {
      data = await api(
        session.role === "admin" ? "/api/admin" : `/api/${session.role}`,
      );
      if (session.role === "guest") templates = await api("/api/templates");
      else if (session.role === "host") templates = data.templates;
    } else {
      const match = location.pathname.match(/^\/h\/([A-Za-z0-9_-]+)$/);
      if (match)
        publicHousehold = await api(`/api/public/households/${match[1]}`);
    }
    // An editor may have opened while a background request was in flight.
    // Never adopt newer versions behind an older unsaved form.
    if (generation !== loadGeneration || (background && isEditing())) return;
    Object.assign(state, {
      session,
      data,
      templates,
      publicHousehold,
      lastSync: new Date(),
    });
    render();
  } catch (error) {
    if (generation !== loadGeneration) return;
    if (background) {
      $("#sync-status")?.replaceChildren(
        document.createTextNode(
          "Connection paused · your last saved information is shown",
        ),
      );
    } else
      $("#app").innerHTML =
        `<main id="main"><div class="panel"><h1>${error.status === 404 ? "This household address is unavailable." : "Couldn’t open this page"}</h1><p>${escape(error.message)}</p>${button("reload", "Try again")}</div></main>`;
  }
}

function setupPage() {
  const setup = state.setup;
  if (!setup?.required)
    return `<section class="auth panel"><h1>Setup is complete</h1><p>This site already has an administrator. Setup cannot replace the account.</p>${button("host-login", "Host Login", "", "")}</section>`;
  if (!setup.enabled)
    return `<section class="auth panel"><h1>Administrator setup</h1><p>The site owner must first add an encrypted <strong>ADMIN_SETUP_TOKEN</strong> secret to the <strong>events</strong> Worker in Cloudflare, then refresh this page.</p><p>Use a unique random token of 32–256 characters from a password manager. No installation or local server is needed.</p>${button("reload", "Check again", "", "")}</section>`;
  return `<section class="auth"><p class="eyebrow">One-time owner setup</p><h1>Make Gather yours.</h1><div class="panel"><p>Enter the setup token you saved in Cloudflare, then choose your administrator login. This page locks after setup.</p><form data-form="setup">${field("Setup token", "token", "", "password", 'required minlength="32" maxlength="256" autocomplete="off"')}${field("Administrator email", "email", "", "email", 'required maxlength="254" autocomplete="username"')}${field("Choose administrator password", "password", "", "password", 'required minlength="12" maxlength="256" autocomplete="new-password"')}${field("Confirm password", "confirmPassword", "", "password", 'required minlength="12" maxlength="256" autocomplete="new-password"')}<p class="form-error" role="alert"></p><button>Create administrator</button></form></div><p class="small muted">Use HTTPS. Do not put the setup token in the URL or send it through chat.</p></section>`;
}
const suggestedAddress = "household-" + crypto.randomUUID().slice(0, 8);
function subdomainField(value = "") {
  return (
    field(
      "Household web address",
      "subdomain",
      value,
      "text",
      'required minlength="3" maxlength="63" pattern="[A-Za-z0-9][A-Za-z0-9-]{1,61}[A-Za-z0-9]" autocapitalize="none" spellcheck="false" aria-describedby="subdomain-help"',
    ) +
    '<p id="subdomain-help" class="small muted">Choose your own name before .ilymmd.com. Use 3–63 letters, numbers or internal hyphens. Names are case-insensitive. New addresses need activation; your existing link works while pending. Retired names stay reserved permanently.</p>' +
    button("check-subdomain", "Check address availability") +
    '<p id="subdomain-status" class="small" role="status"></p>'
  );
}
const householdShareUrl = () =>
  state.data.household.shareUrl ||
  location.origin + "/h/" + state.data.household.slug;
function authPage() {
  if (
    state.setup?.required ||
    (location.pathname === "/setup" && state.view !== "login")
  )
    return setupPage();
  const household = state.publicHousehold;
  if (household) applyDesign(household.design);
  if (household && !["login", "register"].includes(state.view)) {
    return `<section class="auth"><div class="panel"><p class="eyebrow">You’re in good company</p><h1>${escape(household.name)}</h1><p>Welcome. Enter your name to see your invitations.</p><form data-form="guest-login" class="stack">${field("First name", "first", "", "text", 'required autocomplete="given-name" maxlength="80"')}${field("Last name", "last", "", "text", 'required autocomplete="family-name" maxlength="80"')}${field("Suffix, if applicable", "suffix", "", "text", 'autocomplete="honorific-suffix" maxlength="30" placeholder="Jr., Sr., III…"')}<p class="form-error" role="alert"></p><button>See my invitations</button></form><p class="small muted">Use the name your host has on file. If you share an identical name, ask your host for help.</p></div><p class="small" style="text-align:center">${button("host-login", "Host Login", "", "quiet")}</p></section>`;
  }
  const register = state.view === "register";
  return `<section class="auth"><p class="eyebrow">A place for your people</p><h1>${register ? "Make yourself at home." : "Good things begin together."}</h1><div class="panel"><h2>${register ? "Create your host account" : "Host Login"}</h2><p class="muted">${register ? "Registration is available only for administrator-approved email addresses. No emails will be sent." : "Plan a little. Gather a lot."}</p><form data-form="${register ? "register" : "login"}">${field("Email address", "email", "", "email", 'required autocomplete="username" maxlength="254"')}${field("Password", "password", "", "password", `required minlength="12" maxlength="256" autocomplete="${register ? "new-password" : "current-password"}"`)}${register ? field("Family household name", "name", "", "text", 'required maxlength="100" placeholder="The Meyer Family"') + subdomainField(suggestedAddress) : ""}<p class="form-error" role="alert"></p><button>${register ? "Create account" : "Sign in"}</button></form></div><p class="small">${register ? "Already registered?" : "Approved to host?"} ${button(register ? "host-login" : "register", register ? "Sign in" : "Create your account", "", "quiet")}</p>${household ? button("guest-login", "Back to guest sign-in", "", "quiet") : ""}</section>`;
}
function toolbar(event) {
  const role = state.session.role;
  return `<nav class="toolbar" aria-label="Main navigation">${button("home", "⌂ Home")}${role === "host" ? `${button("new-event", '＋ <span class="host-label">Event</span>', 'aria-label="Create event"', "")}${event ? button("event-design", "✎ Appearance", 'aria-label="Edit event appearance"') : button("household", "✎ Household")}` : ""}${event ? `${button("print", "Print")}${role === "host" ? button("dashboard", "RSVPs") : button("rsvp", "RSVP", "", "")}` : ""}${event ? `<div class="totals"><div><strong>${event.totals?.attending || 0}</strong>Attending</div><div><strong>${event.totals?.invited || 0}</strong>Invited</div></div><span class="deadline">RSVP by<br>${event.deadline ? escape(dateLabel(event.deadline)) : "No deadline"}</span>` : ""}</nav>`;
}
function eventCard(event) {
  return `<article class="card">${event.icon ? `<img src="${escape(event.icon)}" alt="">` : '<span class="eyebrow">You’re invited to gather</span>'}<p class="muted small">${escape(dateLabel(event.date))}</p><h2>${escape(event.title)}</h2><p class="muted">${escape(event.description.slice(0, 120))}</p><div class="row"><span class="pill">${event.totals.attending} attending</span>${event.response?.version ? '<span class="pill">RSVP saved</span>' : ""}</div>${button("open-event", "View event", `data-id="${event.id}"`)}</article>`;
}
function eventPage(event) {
  const own = event.response;
  return `<section class="event-hero">${event.icon ? `<img class="event-icon" src="${escape(event.icon)}" alt="Event artwork">` : ""}<p class="eyebrow">${escape(state.data.household.name)} invites you</p><h1>${escape(event.title)}</h1><p class="event-details">${escape(event.description)}</p><div class="event-meta"><div><b>When</b><span>${escape(dateLabel(event.date))}</span><span>${escape(event.time)}</span></div>${event.address ? `<div><b>Where</b><span class="event-details">${escape(event.address)}</span></div>` : ""}</div></section>${state.session.role === "host" ? `<div class="row no-print" style="justify-content:center;margin-bottom:24px">${button("edit-event", "Edit event")}${button("invitation", "Preview invitation")}${button("delete-event", "Delete event", "", "danger")}</div>` : `<div class="row no-print" style="justify-content:center;margin-bottom:24px">${button("rsvp", own?.version ? "Update my RSVP" : "Save my RSVP", "", "")}${(event.registries || []).length ? `<div class="registry-buttons" aria-label="Gift registries">${event.registries.map((r) => `<a class="button registry-button" href="${escape(r.url)}" target="_blank" rel="noopener noreferrer">${escape(r.title)}</a>`).join("")}</div>` : ""}</div>`}<div class="grid"><section class="panel"><p class="eyebrow">Something to share</p><h2>At the table</h2>${event.menu.length ? event.menu.map((item) => `<div class="menu-item"><div><strong>${escape(item.name)}</strong><div class="muted small">${item.kind === "drink" ? "Drinks" : "Potluck"}</div></div><span class="pill">${Math.max(0, item.quantity - (item.claimed || 0))} needed</span></div>`).join("") : '<p class="muted">Just bring yourself. Your host hasn’t added any menu items yet.</p>'}</section>${
    own
      ? `<section class="panel"><p class="eyebrow">Your plans</p><h2>Your RSVP & items</h2>${
          own.version
            ? `<ul>${event.members.map((m) => `<li>${escape(fullName(m))}: ${own.attendance[m.id] === "yes" ? "Attending" : own.attendance[m.id] === "no" ? "Not attending" : "No response"}</li>`).join("")}</ul><h3>You’re bringing</h3>${
                Object.entries(own.claims).length
                  ? `<ul>${Object.entries(own.claims)
                      .map(
                        ([key, n]) =>
                          `<li>${escape(event.menu.find((m) => m.id === key)?.name || "Item")} × ${n}</li>`,
                      )
                      .join("")}</ul>`
                  : '<p class="muted">No items selected.</p>'
              }`
            : '<p class="muted">We’d love to know if you can join us.</p>'
        }</section>`
      : '<section class="panel"><p class="eyebrow">Made for this gathering</p><h2>Your invitation</h2><p>Choose an administrator-provided template in Edit event. Event details populate automatically.</p>' +
        button("invitation", "Preview invitation") +
        "</section>"
  }</div>`;
}
function render() {
  const role = state.session?.role;
  let content = "",
    event = null;
  if (!role) content = authPage();
  else if (role === "admin") {
    content = `<section class="hero"><p class="eyebrow">Administrator</p><h1>Open the door<br>for your next host.</h1><p>Approve email addresses and manage shared invitation artwork. No emails are sent.</p></section><div class="grid"><section class="panel"><h2>Approved emails</h2><form data-form="approval">${field("Email address", "email", "", "email", "required")}<p class="form-error" role="alert"></p><button>Approve host</button></form><ul class="guest-list">${state.data.approvals.map((a) => `<li class="row between"><span>${escape(a.email)}</span>${button("revoke", "Remove", `data-email="${escape(a.email)}"`, "quiet")}</li>`).join("") || '<li class="muted">No pending approvals.</li>'}</ul></section><section class="panel"><h2>Invitation templates</h2><form data-form="template">${field("Template name", "name", "", "text", 'required maxlength="100"')}${field("Artwork · PNG, JPEG or WebP", "image", "", "file", 'accept="image/png,image/jpeg,image/webp" required')}<p class="form-error" role="alert"></p><button>Add template</button></form><ul>${state.data.templates.map((t) => `<li>${escape(t.name)} ${button("edit-template", "Edit", `data-id="${t.id}"`, "quiet")} ${button("delete-template", "Remove", `data-id="${t.id}"`, "quiet")}</li>`).join("")}</ul></section><section class="panel"><h2>Registered hosts</h2><ul>${state.data.hosts.map((h) => `<li>${escape(h.email)}</li>`).join("") || "<li>No hosts yet.</li>"}</ul><p class="small muted">Host guest records and RSVPs are not included here.</p></section></div>`;
  } else {
    event = state.data.events.find((e) => e.id === state.event);
    applyDesign({ ...state.data.household.design, ...event?.design });
    if (event) content = eventPage(event);
    else {
      state.event = null;
      content = `<section class="hero"><p class="eyebrow">${role === "host" ? "Your gathering place" : "Welcome, " + escape(state.data.guest.first)}</p><h1>${escape(state.data.household.name)}</h1><p class="muted">${role === "host" ? "A familiar table. A new memory. Make room for your next gathering." : "Your invitations, all in one place."}</p>${role === "host" ? `<div class="row">${button("guests", "Guest list")}${button("addresses", "Address book")}${button("share", "Share household link")}</div>` : ""}</section>${state.data.events.length ? `<section class="grid" aria-label="Events">${state.data.events.map(eventCard).join("")}</section>` : `<section class="panel empty"><div class="sprig" aria-hidden="true">❧</div><h2>${role === "host" ? "Your next memory starts here." : "Nothing on the calendar yet."}</h2><p class="muted">${role === "host" ? "Use the + button to create your first event." : "Your host will add your invitations here."}</p>${role === "host" ? button("new-event", "＋ Create an event", "", "") : ""}</section>`}`;
    }
  }
  $("#app").innerHTML =
    `<header><a class="brand" href="/" data-action="home">gather<span>＊</span></a>${role ? button("logout", "Sign out", "", "quiet") : '<span class="eyebrow">Come as you are</span>'}</header><main id="main">${content}${role ? `<p id="sync-status" class="connection">Updated ${state.lastSync.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · syncs automatically</p>` : ""}</main>${role && role !== "admin" ? toolbar(event) : ""}`;
}
function modal(title, content, form = "", save = "Save") {
  const dialog = $("#editor");
  dialog.innerHTML = `<div class="dialog-head"><h2 id="dialog-title">${escape(title)}</h2>${button("close", "✕", 'aria-label="Close editor"', "quiet")}</div>${form ? `<form data-form="${form}">` : ""}<div class="dialog-body">${content}<p class="form-error" role="alert"></p></div>${form ? `<div class="dialog-foot">${button("close", "Cancel")}<button>${save}</button></div></form>` : ""}`;
  if (!dialog.open) dialog.showModal();
}
const closeModal = () => {
  $("#editor").close();
  $("#editor").replaceChildren();
};
const selectedEvent = () => state.data.events.find((e) => e.id === state.event);
function appearanceFields(d) {
  return `<div class="preview" id="design-preview"><p class="eyebrow">Appearance preview</p><h2>${escape(state.data.household.name)}</h2><p>Good company. Great memories.</p></div><div class="form-grid">${field("Background color", "background", d.background, "color")}${field("Container color", "container", d.container, "color")}${field("Container opacity (%)", "opacity", d.opacity, "number", 'min="35" max="100"')}${field("Title color", "titleColor", d.titleColor, "color")}${select(
    "Title font",
    "titleFont",
    fonts.map((f) => [f, f]),
    d.titleFont,
  )}${field("Title size", "titleSize", d.titleSize, "number", 'min="22" max="64"')}${field("Text color", "textColor", d.textColor, "color")}${select(
    "Text font",
    "textFont",
    fonts.map((f) => [f, f]),
    d.textFont,
  )}${field("Text size", "textSize", d.textSize, "number", 'min="14" max="28"')}</div>${field("Background image (optional, up to 2 MB)", "backgroundUpload", "", "file", 'accept="image/png,image/jpeg,image/webp"')}<label class="check"><input type="checkbox" name="removeBackground">Remove background image</label>`;
}
function appearanceForm(event = false) {
  const household = state.data.household,
    d = {
      ...state.data.defaults,
      ...household.design,
      ...(event ? selectedEvent().design : {}),
    };
  state.editingDesign = d;
  modal(
    event ? "Event appearance" : "Household & login appearance",
    `${event ? "<p>Changes apply only to this event.</p>" : field("Family household name", "householdName", household.name, "text", 'required maxlength="100"') + subdomainField(household.subdomain || suggestedAddress) + `<p class="small muted">Address status: ${escape(household.subdomainStatus || "unclaimed")}. Renaming retires your old address permanently; existing /h/ links remain valid.</p>` + '<p class="muted small">Sets the guest login page and defaults for events. Event overrides stay independent.</p>'}${appearanceFields(d)}${event ? '<label class="check"><input type="checkbox" name="resetDesign">Use household defaults (remove all event overrides)</label>' : ""}`,
    event ? "event-design" : "household",
  );
  updatePreview();
}
function designFrom(form) {
  const data = new FormData(form),
    d = { ...state.editingDesign };
  for (const key of [
    "background",
    "container",
    "titleColor",
    "textColor",
    "titleFont",
    "textFont",
  ])
    d[key] = data.get(key);
  for (const key of ["opacity", "titleSize", "textSize"])
    d[key] = Number(data.get(key));
  return d;
}
function updatePreview() {
  const preview = $("#design-preview");
  if (!preview) return;
  const d = designFrom(preview.closest("form"));
  preview.style.backgroundColor = d.background;
  preview.style.color = d.textColor;
  preview.style.fontFamily = d.textFont;
  preview.style.fontSize = d.textSize + "px";
  preview.querySelector("h2").style.cssText =
    `color:${d.titleColor};font-family:${d.titleFont};font-size:${d.titleSize}px`;
}
function guestEditor(guest = {}) {
  state.editingGuest = guest;
  modal(
    guest.id ? "Edit guest" : "Add guest",
    `<div class="form-grid">${field("First name", "first", guest.first, "text", 'required maxlength="80"')}${field("Last name", "last", guest.last, "text", 'required maxlength="80"')}</div>${field("Suffix (optional)", "suffix", guest.suffix, "text", 'maxlength="30"')}${select("Adult or child", "parent", [["", "Adult guest"], ...state.data.guests.filter((g) => !g.parent && g.id !== guest.id).map((g) => [g.id, "Child of " + fullName(g)])], guest.parent || "")}${select("Shared address (optional)", "address", [["", "No address"], ...state.data.addresses.map((a) => [a.id, a.label])], guest.address || "")}<p class="small muted">Children RSVP through their designated adult. Guests with identical first, last and suffix names cannot sign in until corrected.</p>`,
    "guest",
  );
}
function guestList() {
  modal(
    "Your guest list",
    `<p>Reusable people, independent invitations.</p>${button("add-guest", "＋ Add adult or child", "", "")}<ul class="guest-list">${state.data.guests.map((g) => `<li class="${g.parent ? "child" : ""}"><div class="row between"><div><strong>${escape(fullName(g))}</strong><div class="small muted">${g.parent ? "Child of " + escape(fullName(state.data.guests.find((a) => a.id === g.parent))) : "Adult guest"}${g.address ? " · " + escape(state.data.addresses.find((a) => a.id === g.address)?.label) : ""}</div></div><div>${button("edit-guest", "Edit", `data-id="${g.id}"`, "quiet")}${button("delete-guest", "Remove", `data-id="${g.id}"`, "quiet")}</div></div></li>`).join("") || '<li class="muted">Add your first guest to start inviting.</li>'}</ul>`,
  );
}
function addresses() {
  modal(
    "Address book",
    `<p>Assign the same address to as many guests as you need.</p>${button("add-address", "＋ Add address", "", "")}<ul class="guest-list">${state.data.addresses.map((a) => `<li><strong>${escape(a.label)}</strong><p class="event-details">${escape(a.lines)}</p>${button("edit-address", "Edit", `data-id="${a.id}"`, "quiet")}${button("delete-address", "Remove", `data-id="${a.id}"`, "quiet")}</li>`).join("") || '<li class="muted">Addresses are optional.</li>'}</ul>`,
  );
}
function addressEditor(address = {}) {
  state.editingAddress = address;
  modal(
    address.id ? "Edit address" : "Add address",
    `${field("Address label", "label", address.label, "text", 'required maxlength="100" placeholder="The Doe home"')}${area("Mailing address (optional)", "lines", address.lines, 'maxlength="500"')}`,
    "address",
  );
}
function menuRow(item = {}) {
  return `<div class="menu-row" data-menu-id="${item.id || crypto.randomUUID()}">${field("Item name", "menuName", item.name || "", "text", 'required maxlength="160"')}<div class="row">${select(
    "Menu",
    "menuKind",
    [
      ["potluck", "Potluck"],
      ["drink", "Drinks"],
    ],
    item.kind || "potluck",
  )}${field("Needed", "menuQuantity", item.quantity || 1, "number", 'required min="1" max="10000"')}${button("remove-menu", "Remove", "", "quiet")}</div></div>`;
}
function registryRow(registry = {}) {
  return `<div class="registry-row" data-registry-id="${registry.id || crypto.randomUUID()}">${field("Registry title", "registryTitle", registry.title || "", "text", 'required maxlength="100" placeholder="Wedding Registry"')}${field("Registry URL", "registryUrl", registry.url || "", "url", 'required maxlength="2048" placeholder="https://…"')}<div class="row">${button("registry-up", "↑ Move up", 'aria-label="Move registry up"', "quiet")}${button("registry-down", "↓ Move down", 'aria-label="Move registry down"', "quiet")}${button("remove-registry", "Remove registry", "", "quiet")}</div></div>`;
}
function eventEditor(existing) {
  state.editingEvent = existing || {
    design: {},
    invited: [],
    menu: [],
    registries: [],
  };
  const e = state.editingEvent;
  modal(
    existing ? "Edit event" : "A new reason to gather",
    `${field("Event title", "title", e.title, "text", 'required maxlength="160" placeholder="Sunday around the table"')}${area("Description", "description", e.description, 'maxlength="5000"')}<div class="form-grid">${field("Date", "date", e.date, "date")}${field("Time · numbers or words", "time", e.time, "text", 'maxlength="100" placeholder="Two O’Clock in the Afternoon"')}${field("RSVP deadline", "deadline", e.deadline, "date")}</div>${area("Event address", "eventAddress", e.address, 'maxlength="500"')}${field("Event icon / image", "iconUpload", "", "file", 'accept="image/png,image/jpeg,image/webp"')}<label class="check"><input type="checkbox" name="removeIcon">Remove current image</label>${select("Invitation template", "template", [["", "Simple invitation"], ...state.templates.map((t) => [t.id, t.name])], e.template || "")}<fieldset><legend>Gift registries · optional</legend><p class="small muted">Guest buttons appear directly below RSVP, in this order.</p><div id="registry-rows">${(e.registries || []).map(registryRow).join("")}</div>${button("add-registry", "＋ Add registry")}</fieldset><fieldset><legend>Who’s invited?</legend><p class="small muted">Choose each person. Children need their designated adult invited too.</p>${state.data.guests.map((g) => `<label class="check ${g.parent ? "child" : ""}"><input type="checkbox" name="invited" value="${g.id}" ${e.invited.includes(g.id) ? "checked" : ""}>${escape(fullName(g))}${g.parent ? " (child)" : ""}</label>`).join("") || "<p>Add guests from Home → Guest list before inviting them.</p>"}</fieldset><fieldset><legend>Potluck & drinks</legend><div class="row">${select("Copy menu from", "copyMenu", [["", "Choose a past event"], ...state.data.events.filter((p) => p.id !== e.id).map((p) => [p.id, p.title])], "")}${button("copy-menu", "Copy items")}</div><div id="menu-rows">${e.menu.map(menuRow).join("")}</div>${button("add-menu", "＋ Add item")}</fieldset>`,
    "event",
    existing ? "Save event" : "Create event",
  );
}
function rsvp() {
  const event = selectedEvent();
  state.editingResponse = structuredClone(event.response);
  modal(
    "Will you join us?",
    `<p>${escape(event.title)}</p>${event.deadline ? `<p class="muted small">RSVP by ${escape(dateLabel(event.deadline))}. After this date you can still update attendance or reduce items.</p>` : ""}<fieldset><legend>Your invited party</legend>${event.members
      .map((m) =>
        select(
          escape(fullName(m)) + (m.parent ? " · child" : ""),
          "attendance:" + m.id,
          [
            ["", "Choose…"],
            ["yes", "Attending"],
            ["no", "Not attending"],
          ],
          event.response.attendance[m.id] || "",
          "required",
        ),
      )
      .join(
        "",
      )}<p class="small muted">Children attend with their designated adult. Declining releases your menu items.</p></fieldset><fieldset><legend>Something to bring</legend>${
      event.menu
        .map((item) => {
          const mine = event.response.claims[item.id] || 0;
          return `<div class="menu-item"><label class="grow">${escape(item.name)}<small>${item.kind === "drink" ? "Drinks" : "Potluck"} · ${Math.max(0, item.quantity - item.claimed)} remaining</small></label>${field('<span class="sr-only">Quantity for ' + escape(item.name) + "</span>", "claim:" + item.id, mine, "number", `min="0" max="${Math.max(mine, item.quantity - item.claimed + mine)}" required`)}</div>`;
        })
        .join("") || "<p>No menu items yet.</p>"
    }</fieldset>`,
    "rsvp",
    "Save my RSVP",
  );
}
async function dashboard() {
  const e = selectedEvent(),
    d = await api(`/api/host/events/${e.id}/dashboard`),
    attendance = Object.assign({}, ...d.responses.map((r) => r.attendance));
  modal(
    "RSVP dashboard",
    `<p>${escape(e.title)}</p><div class="row"><span class="pill">${d.totals.invited} invited</span><span class="pill">${d.totals.attending} attending</span><span class="pill">${d.totals.declined} not attending</span><span class="pill">${d.totals.noResponse} no response</span></div>${[
      ["yes", "Attending"],
      ["no", "Not attending"],
      ["", "No response"],
    ]
      .map(
        ([status, label]) =>
          `<details open><summary>${label}</summary><ul>${
            d.guests
              .filter((g) => (attendance[g.id] || "") === status)
              .map(
                (g) =>
                  `<li>${escape(fullName(g))}${g.parent ? " · child of " + escape(fullName(d.guests.find((a) => a.id === g.parent))) : " · adult"}</li>`,
              )
              .join("") || "<li>None yet</li>"
          }</ul></details>`,
      )
      .join(
        "",
      )}<h3>Potluck & drinks</h3>${d.menu.map((item) => `<div class="menu-item"><strong>${escape(item.name)}</strong><span>${item.claimed} / ${item.quantity} · ${Math.max(0, item.quantity - item.claimed)} remaining</span></div>`).join("")}<h3>Who’s bringing what</h3><ul>${
      d.responses
        .filter((r) => Object.keys(r.claims).length)
        .map(
          (r) =>
            `<li>${escape(fullName(d.guests.find((g) => g.id === r.guest)))}: ${Object.entries(
              r.claims,
            )
              .map(
                ([key, n]) =>
                  `${escape(d.menu.find((m) => m.id === key)?.name)} × ${n}`,
              )
              .join(", ")}</li>`,
        )
        .join("") || "<li>No items claimed yet.</li>"
    }</ul>${button("refresh-dashboard", "Refresh totals")}`,
  );
}
async function share() {
  const link = householdShareUrl();
  modal(
    "One link for every gathering",
    `<p>${escape(state.data.household.name)}</p><img class="qr" src="/api/host/qr" alt="Household sign-in QR code"><p class="share-link">${escape(link)}</p><div class="row">${button("copy-link", "Copy link")}${button("native-share", "Share link")}<a class="button secondary" href="/api/host/qr" download="household-qr.svg">Download QR</a><a class="button secondary" href="${escape(link)}" target="_blank" rel="noopener">Open guest page</a></div><p class="small muted">Your link stays the same when you add events or change your design. A new web address is used after activation. Existing /h/ links always keep working. Guests still sign in with their names.</p>`,
  );
}
function invitation() {
  const e = selectedEvent(),
    template = state.templates.find((t) => t.id === e.template);
  modal(
    "Invitation preview",
    `<p class="muted small no-print">Shared template, automatically filled with this event’s details.</p><article class="invitation">${template?.image ? `<img src="${escape(template.image)}" alt="Invitation artwork">` : ""}<div class="invitation-values"><p class="eyebrow">${escape(state.data.household.name)}</p><h2>${escape(e.title)}</h2><p>${escape(e.description)}</p><p>${escape(dateLabel(e.date))}<br>${escape(e.time)}</p><p class="event-details">${escape(e.address)}</p><p>RSVP ${e.deadline ? "by " + escape(dateLabel(e.deadline)) : "at our household link"}</p><img class="qr" src="/api/host/qr" alt="Household sign-in QR code"></div></article>${button("print-invitation", "Print / save as PDF", "", "")}`,
  );
}
async function fileData(input) {
  const file = input?.files?.[0];
  if (!file) return null;
  if (file.size > 2_000_000)
    throw new Error("Choose an image smaller than 2 MB.");
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type))
    throw new Error("Choose a PNG, JPEG or WebP image.");
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Could not read that image."));
    reader.readAsDataURL(file);
  });
}
async function saved(message) {
  closeModal();
  await load();
  notify(message);
}
async function submit(form) {
  const data = new FormData(form),
    value = Object.fromEntries(data),
    kind = form.dataset.form;
  if (kind === "setup") {
    await api("/api/setup", { method: "POST", data: value });
    form.reset();
    state.view = "home";
    await load();
    notify("Your administrator account is ready.");
    return;
  }
  if (kind === "login" || kind === "register") {
    await api("/api/" + kind, { method: "POST", data: value });
    state.view = "home";
    await load();
    return;
  }
  if (kind === "guest-login") {
    await api(`/api/public/households/${state.publicHousehold.slug}/login`, {
      method: "POST",
      data: value,
    });
    await load();
    return;
  }
  if (kind === "approval") {
    await api("/api/admin/approvals", { method: "POST", data: value });
    await load();
    notify("Email approved. No email was sent.");
    return;
  }
  if (kind === "template") {
    await api("/api/admin/templates", {
      method: "POST",
      data: { name: value.name, image: await fileData(form.elements.image) },
    });
    await load();
    notify("Template added for all hosts.");
    return;
  }
  if (kind === "edit-template") {
    const t = state.editingTemplate,
      upload = await fileData(form.elements.image);
    await api("/api/admin/templates/" + t.id, {
      method: "PUT",
      version: t.version,
      data: { name: value.name, ...(upload ? { image: upload } : {}) },
    });
    await saved("Template updated.");
    return;
  }
  if (kind === "household" || kind === "event-design") {
    const d = designFrom(form),
      upload = await fileData(form.elements.backgroundUpload);
    if (upload) d.backgroundImage = upload;
    if (data.has("removeBackground")) d.backgroundImage = "";
    if (kind === "household") {
      const updated = await api("/api/host/household", {
        method: "PUT",
        version: state.data.household.version,
        data: {
          name: value.householdName,
          design: d,
          subdomain: value.subdomain,
        },
      });
      if (
        location.hostname === state.data.household.subdomain + ".ilymmd.com" &&
        updated.subdomain !== state.data.household.subdomain
      ) {
        location.assign(updated.platformUrl);
        return;
      }
    } else {
      const e = selectedEvent();
      let overrides = { ...e.design };
      for (const [key, val] of Object.entries(d))
        if (val !== state.editingDesign[key] || key in overrides)
          overrides[key] = val;
      if (data.has("resetDesign")) overrides = {};
      await api("/api/host/events/" + e.id, {
        method: "PUT",
        version: e.version,
        data: { ...e, design: overrides },
      });
    }
    await saved("Appearance saved.");
    return;
  }
  if (kind === "guest" || kind === "address") {
    const record = kind === "guest" ? state.editingGuest : state.editingAddress,
      collection = kind === "guest" ? "guests" : "addresses";
    await api("/api/host/" + collection + (record.id ? "/" + record.id : ""), {
      method: record.id ? "PUT" : "POST",
      version: record.id ? record.version : undefined,
      data: value,
    });
    await saved(kind === "guest" ? "Guest saved." : "Address saved.");
    return;
  }
  if (kind === "event") {
    const e = state.editingEvent,
      menu = [...form.querySelectorAll(".menu-row")].map((row) => ({
        id: row.dataset.menuId,
        name: row.querySelector("[name=menuName]").value,
        kind: row.querySelector("[name=menuKind]").value,
        quantity: Number(row.querySelector("[name=menuQuantity]").value),
      }));
    const icon = await fileData(form.elements.iconUpload);
    const result = await api("/api/host/events" + (e.id ? "/" + e.id : ""), {
      method: e.id ? "PUT" : "POST",
      version: e.id ? e.version : undefined,
      data: {
        title: value.title,
        description: value.description,
        date: value.date,
        time: value.time,
        address: value.eventAddress,
        deadline: value.deadline,
        icon: data.has("removeIcon") ? "" : icon || e.icon || "",
        template: value.template,
        registries: [...form.querySelectorAll(".registry-row")].map((row) => ({
          id: row.dataset.registryId,
          title: row.querySelector("[name=registryTitle]").value,
          url: row.querySelector("[name=registryUrl]").value,
        })),
        design: e.design,
        invited: data.getAll("invited"),
        menu,
      },
    });
    state.event = result.id;
    await saved("Event saved.");
    return;
  }
  if (kind === "rsvp") {
    const e = selectedEvent(),
      attendance = {},
      claims = {};
    for (const [key, val] of data) {
      if (key.startsWith("attendance:")) attendance[key.slice(11)] = val;
      if (key.startsWith("claim:")) claims[key.slice(6)] = Number(val);
    }
    await api(`/api/guest/events/${e.id}/rsvp`, {
      method: "PUT",
      data: { version: state.editingResponse.version, attendance, claims },
    });
    await saved("Your RSVP is saved. Thank you!");
  }
}
document.addEventListener("submit", async (event) => {
  const form = event.target.closest("form[data-form]");
  if (!form) return;
  event.preventDefault();
  const error = form.querySelector(".form-error"),
    buttons = [...form.querySelectorAll("button")];
  error.textContent = "";
  buttons.forEach((b) => (b.disabled = true));
  try {
    await submit(form);
  } catch (problem) {
    error.textContent =
      problem.message +
      (problem.status === 409
        ? " Close this editor and refresh before trying again."
        : "");
    error.scrollIntoView({ block: "nearest", behavior: "smooth" });
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }
});
document.addEventListener("input", (event) => {
  if (event.target.closest("form")?.querySelector("#design-preview"))
    updatePreview();
});
document.addEventListener("click", async (event) => {
  const target = event.target.closest("[data-action]");
  if (!target) return;
  event.preventDefault();
  const action = target.dataset.action,
    key = target.dataset.id;
  try {
    if (action === "close") {
      closeModal();
      return;
    }
    if (action === "reload") {
      await load();
      return;
    }
    if (["host-login", "register", "guest-login"].includes(action)) {
      state.view =
        action === "host-login"
          ? "login"
          : action === "guest-login"
            ? "home"
            : "register";
      render();
      return;
    }
    if (action === "home") {
      closeModal();
      state.event = null;
      state.view = "home";
      await load();
      return;
    }
    if (action === "logout") {
      await api("/api/logout", { method: "POST", data: {} });
      closeModal();
      state.event = null;
      state.view = "home";
      state.publicHousehold = null;
      await load();
      return;
    }
    if (action === "open-event") {
      state.event = key;
      render();
      window.scrollTo(0, 0);
      return;
    }
    if (action === "new-event") {
      eventEditor();
      return;
    }
    if (action === "edit-event") {
      eventEditor(selectedEvent());
      return;
    }
    if (action === "household") {
      appearanceForm();
      return;
    }
    if (action === "event-design") {
      appearanceForm(true);
      return;
    }
    if (action === "guests") {
      guestList();
      return;
    }
    if (action === "add-guest") {
      guestEditor();
      return;
    }
    if (action === "edit-guest") {
      guestEditor(state.data.guests.find((g) => g.id === key));
      return;
    }
    if (action === "addresses") {
      addresses();
      return;
    }
    if (action === "add-address") {
      addressEditor();
      return;
    }
    if (action === "edit-address") {
      addressEditor(state.data.addresses.find((a) => a.id === key));
      return;
    }
    if (action === "add-registry") {
      $("#registry-rows").insertAdjacentHTML("beforeend", registryRow());
      return;
    }
    if (action === "remove-registry") {
      target.closest(".registry-row").remove();
      return;
    }
    if (action === "registry-up") {
      const row = target.closest(".registry-row");
      if (row.previousElementSibling) row.previousElementSibling.before(row);
      return;
    }
    if (action === "registry-down") {
      const row = target.closest(".registry-row");
      if (row.nextElementSibling) row.nextElementSibling.after(row);
      return;
    }
    if (action === "add-menu") {
      $("#menu-rows").insertAdjacentHTML("beforeend", menuRow());
      return;
    }
    if (action === "remove-menu") {
      target.closest(".menu-row").remove();
      return;
    }
    if (action === "copy-menu") {
      const source = state.data.events.find(
        (e) => e.id === $("[name=copyMenu]").value,
      );
      if (!source) throw new Error("Choose a previous event first.");
      $("#menu-rows").insertAdjacentHTML(
        "beforeend",
        source.menu
          .map((item) => menuRow({ ...item, id: crypto.randomUUID() }))
          .join(""),
      );
      return;
    }
    if (action === "rsvp") {
      rsvp();
      return;
    }
    if (action === "dashboard" || action === "refresh-dashboard") {
      await dashboard();
      return;
    }
    if (action === "check-subdomain") {
      const form = target.closest("form");
      const label = form.elements.subdomain.value;
      const result = await api(
        "/api/subdomains?name=" + encodeURIComponent(label),
      );
      form.querySelector("#subdomain-status").textContent = result.available
        ? "Available to claim. Saving reserves the name; activation is a separate step."
        : "That address is unavailable. Choose another name.";
      return;
    }
    if (action === "share") {
      await share();
      return;
    }
    if (action === "copy-link") {
      await navigator.clipboard.writeText(householdShareUrl());
      notify("Link copied.");
      return;
    }
    if (action === "native-share") {
      if (navigator.share)
        await navigator.share({
          title: state.data.household.name,
          url: householdShareUrl(),
        });
      else {
        await navigator.clipboard.writeText(householdShareUrl());
        notify("Link copied.");
      }
      return;
    }
    if (action === "invitation") {
      invitation();
      return;
    }
    if (action === "print") {
      window.print();
      return;
    }
    if (action === "print-invitation") {
      const article = $(".invitation");
      const original = $("#app").style.display;
      $("#app").style.display = "none";
      $("#editor").classList.add("printing");
      window.print();
      $("#app").style.display = original;
      $("#editor").classList.remove("printing");
      return;
    }
    if (action === "edit-template") {
      const t = state.data.templates.find((t) => t.id === key);
      state.editingTemplate = t;
      modal(
        "Edit shared template",
        `${field("Template name", "name", t.name, "text", 'required maxlength="100"')}${field("Replace artwork (optional)", "image", "", "file", 'accept="image/png,image/jpeg,image/webp"')}<p>Updates apply to all events using this template.</p>`,
        "edit-template",
      );
      return;
    }
    if (action === "delete-template") {
      const t = state.data.templates.find((t) => t.id === key);
      if (!confirm("Remove this template? Templates in use cannot be removed."))
        return;
      await api("/api/admin/templates/" + t.id, {
        method: "DELETE",
        version: t.version,
        data: {},
      });
      await load();
      notify("Template removed.");
      return;
    }
    if (action === "revoke") {
      await api("/api/admin/approvals", {
        method: "DELETE",
        data: { email: target.dataset.email },
      });
      await load();
      return;
    }
    if (action.startsWith("delete-")) {
      const kind = action.slice(7),
        record =
          kind === "event"
            ? selectedEvent()
            : state.data[kind === "guest" ? "guests" : "addresses"].find(
                (r) => r.id === key,
              );
      if (
        !confirm(
          `Remove this ${kind}${kind === "event" ? " and all its RSVPs" : ""}? This cannot be undone.`,
        )
      )
        return;
      await api(
        `/api/host/${kind === "event" ? "events" : kind === "guest" ? "guests" : "addresses"}/${record.id}`,
        { method: "DELETE", version: record.version, data: {} },
      );
      if (kind === "event") state.event = null;
      await saved("Removed.");
    }
  } catch (error) {
    const box = $("#editor[open] .form-error");
    if (box) {
      box.textContent = error.message;
      box.scrollIntoView({ block: "nearest" });
    } else notify(error.message);
  }
});
await load();
setInterval(() => {
  if (state.session?.role && document.visibilityState === "visible")
    load({ background: true });
}, 10000);
window.addEventListener("online", () => load({ background: true }));
