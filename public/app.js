import { ui, M, C, H, configureCopy } from "/ui-runtime.js";
import { featureTools } from "/editor-tools.js";
import { resolveUI, order, designControls } from "/ui-system.js";
import { icon } from "/icons.js";
import { suggestLabel } from "/household-address.js";
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
    const error = new Error(String(C(result.error || "Unable to save.")));
    error.status = response.status;
    throw error;
  }
  return result;
}
const button = (action, label, extra = "", className = "secondary") =>
  ui`<button type="button" class="${className}" data-action="${action}" ${extra}>${label}</button>`;
const field = (label, name, value = "", type = "text", extra = "") =>
  ui`<label>${label}<input name="${name}" type="${type}" value="${escape(value)}" ${M(extra)}></label>`;
const area = (label, name, value = "", extra = "") =>
  ui`<label>${label}<textarea name="${name}" ${M(extra)}>${escape(value)}</textarea></label>`;
const select = (label, name, options, value, extra = "") =>
  ui`<label>${label}<select aria-label="${label}" name="${name}" ${extra}>${options.map(([key, label]) => ui`<option value="${escape(key)}" ${key === value ? "selected" : ""}>${escape(label)}</option>`).join("")}</select></label>`;
const dateLabel = (value) =>
  value
    ? new Intl.DateTimeFormat(undefined, {
        dateStyle: "long",
        timeZone: "UTC",
      }).format(new Date(value + "T12:00:00Z"))
    : C("Date to come");
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
  for (const role of ["description", "button"]) {
    root.setProperty(`--${role}-font`, d[role + "Font"]);
    root.setProperty(`--${role}-size`, d[role + "Size"] + "px");
    root.setProperty(`--${role}-color`, d[role + "Color"]);
  }
  root.setProperty("--button-text", d.buttonText);
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
    const platform = await api("/api/interface");
    state.platformUI = platform.ui;
    if (state.preview) {
      const data = await api("/api/admin/preview", {
        method: "POST",
        data: state.preview,
      });
      Object.assign(state, {
        data,
        publicHousehold:
          state.preview.mode === "login"
            ? { ...data.household, defaults: data.defaults, ui: data.ui }
            : null,
        session: { role: state.preview.mode === "login" ? null : "guest" },
        lastSync: new Date(),
      });
      state.templates = [];
      render();
      return;
    }
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
        ui`<main id="main"><div class="panel"><h1>${error.status === 404 ? C("This household address is unavailable.") : C("Couldn’t open this page")}</h1><p>${escape(error.message)}</p>${button("reload", H("Try again"))}</div></main>`;
  }
}

function setupPage() {
  const setup = state.setup;
  if (!setup?.required)
    return ui`<section class="auth panel"><h1>Setup is complete</h1><p>This site already has an administrator. Setup cannot replace the account.</p>${button("host-login", H("Host Login"), "", "")}</section>`;
  if (!setup.enabled)
    return ui`<section class="auth panel"><h1>Administrator setup</h1><p>The site owner must first add an encrypted <strong>ADMIN_SETUP_TOKEN</strong> secret to the <strong>events</strong> Worker in Cloudflare, then refresh this page.</p><p>Use a unique random token of 32–256 characters from a password manager. No installation or local server is needed.</p>${button("reload", H("Check again"), "", "")}</section>`;
  return ui`<section class="auth"><p class="eyebrow">One-time owner setup</p><h1>Make Gather yours.</h1><div class="panel"><p>Enter the setup token you saved in Cloudflare, then choose your administrator login. This page locks after setup.</p><form data-form="setup">${field(H("Setup token"), "token", "", "password", 'required minlength="32" maxlength="256" autocomplete="off"')}${field(H("Administrator email"), "email", "", "email", 'required maxlength="254" autocomplete="username"')}${field(H("Choose administrator password"), "password", "", "password", 'required minlength="12" maxlength="256" autocomplete="new-password"')}${field(H("Confirm password"), "confirmPassword", "", "password", 'required minlength="12" maxlength="256" autocomplete="new-password"')}<p class="form-error" role="alert"></p><button>Create administrator</button></form></div><p class="small muted">Use HTTPS. Do not put the setup token in the URL or send it through chat.</p></section>`;
}
function subdomainField() {
  return (
    M(
      '<p class="small">Your household address: <output id="household-address" aria-label="Household web address"></output></p>',
    ) +
    M(
      '<p class="small muted">Generated automatically from your household name. Routing activates automatically after verification; your invitation link works while pending.</p>',
    ) +
    M('<p id="subdomain-status" class="small" role="status"></p>')
  );
}

let addressTimer;
async function checkAddress(form) {
  const name = form.elements.name.value;
  const status = form.querySelector("#subdomain-status");
  status.textContent = "Checking address…";
  try {
    const result = await api(
      "/api/subdomains?householdName=" + encodeURIComponent(name),
    );
    if (!form.isConnected || form.elements.name.value !== name) return;
    form.querySelector("#household-address").textContent = result.suggested
      ? `${result.suggested}.ilymmd.com`
      : "";
    status.textContent = result.available
      ? `${result.suggested}.ilymmd.com is available. Registration will claim it; routing activation is pending.`
      : C(
          "That household address is unavailable or invalid. Enter a different household name.",
        );
  } catch {
    if (form.isConnected && form.elements.name.value === name)
      status.textContent =
        "Preview unavailable. Registration will recheck before claiming.";
  }
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
    return ui`<section class="auth"><div class="panel"><p class="eyebrow">You’re in good company</p><h1>${escape(household.name)}</h1><p>Welcome. Enter your name to see your invitations.</p><form data-form="guest-login" class="stack">${field(H("First name"), "first", "", "text", 'required autocomplete="given-name" maxlength="80"')}${field(H("Last name"), "last", "", "text", 'required autocomplete="family-name" maxlength="80"')}${field(H("Suffix, if applicable"), "suffix", "", "text", 'autocomplete="honorific-suffix" maxlength="30" placeholder="Jr., Sr., III…"')}<p class="form-error" role="alert"></p><button>See my invitations</button></form><p class="small muted">Use the name your host has on file. If you share an identical name, ask your host for help.</p></div><p class="small centered">${button("host-login", H("Host Login"), "", "quiet")}</p></section>`;
  }
  const register = state.view === "register";
  return ui`<section class="auth"><p class="eyebrow">A place for your people</p><h1>${register ? C("Make yourself at home.") : C("Good things begin together.")}</h1><div class="panel"><h2>${register ? C("Create your host account") : C("Host Login")}</h2><p class="muted">${register ? C("Registration is available only for administrator-approved email addresses. No emails will be sent.") : C("Plan a little. Gather a lot.")}</p><form data-form="${register ? "register" : "login"}">${field(H("Email address"), "email", "", "email", 'required autocomplete="username" maxlength="254"')}${field(H("Password"), "password", "", "password", `required minlength="12" maxlength="256" autocomplete="${register ? "new-password" : "current-password"}"`)}${register ? field(H("Family household name"), "name", "", "text", 'required maxlength="100" placeholder="Household name"') + subdomainField() : ""}<p class="form-error" role="alert"></p><button>${register ? C("Create account") : C("Sign in")}</button></form></div><p class="small">${register ? C("Already registered?") : C("Approved to host?")} ${button(register ? "host-login" : "register", register ? C("Sign in") : C("Create your account"), "", "quiet")}</p>${household ? button("guest-login", H("Back to guest sign-in"), "", "quiet") : ""}</section>`;
}
function toolbar(event) {
  if (state.preview)
    return ui`<nav class="toolbar" aria-label="Preview controls">${button("exit-preview", H("Exit read-only preview"))}</nav>`;
  const role = state.session.role,
    items = [
      { id: "home", label: "Home" },
      ...(event
        ? [
            { id: "print", label: "Print" },
            ...(role === "host"
              ? [{ id: "dashboard", label: "RSVPs" }]
              : [{ id: "rsvp", label: "RSVP" }]),
          ]
        : []),
      { id: "logout", label: "Sign out" },
    ];
  const config = event?.ui || state.data?.ui || state.platformUI;
  return ui`<nav class="toolbar" aria-label="Main navigation">${order(
    items,
    config?.layouts?.toolbar || [],
  )
    .map(
      (item) =>
        ui`<button type="button" data-action="${item.id}" class="nav-control" aria-label="${H(item.label)}" ${item.id === "home" && !event ? 'aria-current="page"' : ""}>${icon(item.id)}<span>${C(item.label)}</span></button>`,
    )
    .join(
      "",
    )}${event ? ui`<div class="totals"><div><strong>${event.totals?.attending || 0}</strong>Attending</div><div><strong>${event.totals?.invited || 0}</strong>Invited</div></div>` : ""}</nav>`;
}
function eventCard(event) {
  return ui`<article class="card">${event.icon ? ui`<img src="${escape(event.icon)}" alt="">` : M('<span class="eyebrow">You’re invited to gather</span>')}<p class="muted small">${escape(dateLabel(event.date))}</p><h2>${escape(event.title)}</h2><p class="muted">${escape(event.description.slice(0, 120))}</p><div class="row"><span class="pill">${event.totals.attending} attending</span>${event.response?.version ? M('<span class="pill">RSVP saved</span>') : ""}</div>${button("open-event", H("View event"), `data-id="${event.id}"`)}</article>`;
}
function eventPage(event) {
  const own = event.response;
  return ui`<section class="event-hero">${event.icon ? ui`<img class="event-icon" src="${escape(event.icon)}" alt="Event artwork">` : ""}<p class="eyebrow">${escape(state.data.household.name)} invites you</p><h1>${escape(event.title)}</h1><p class="event-details">${escape(event.description)}</p><div class="event-meta"><div><b>When</b><span>${escape(dateLabel(event.date))}</span><span>${escape(event.time)}</span></div>${event.address ? ui`<div><b>Where</b><span class="event-details">${escape(event.address)}</span></div>` : ""}</div>${event.deadline ? ui`<div class="event-deadline"><b>RSVP By</b><span>${escape(dateLabel(event.deadline))}</span></div>` : ""}</section>${state.session.role === "host" ? ui`<div class="row no-print" data-event-actions>${button("edit-event", H("Edit event"))}${button("invitation", H("Preview invitation"))}${button("reminders", H("Text reminders"))}${button("cards", H("Cards"))}${button("host-ui", H("Page wording & layout"))}${button("delete-event", H("Delete event"), "", "danger")}</div>` : ui`<div class="row no-print" data-event-actions>${button("rsvp", own?.version ? C("Update my RSVP") : C("Save my RSVP"), "", "")}${(event.registries || []).length ? ui`<div class="registry-buttons" aria-label="Gift registries">${event.registries.map((r) => ui`<a class="button registry-button" href="${escape(r.url)}" target="_blank" rel="noopener noreferrer">${escape(r.title)}</a>`).join("")}</div>` : ""}${event.uploadURL ? ui`<a class="button secondary" href="${escape(event.uploadURL)}" target="_blank" rel="noopener noreferrer">Upload Photos & Videos</a>` : ""}</div>`}<div class="grid"><section class="panel"><p class="eyebrow">Something to share</p><h2>At the table</h2>${event.menu.length ? event.menu.map((item) => ui`<div class="menu-item"><div><strong>${escape(item.name)}</strong><div class="muted small">${item.kind === "drink" ? C("Drinks") : C("Potluck")}</div></div><span class="pill">${Math.max(0, item.quantity - (item.claimed || 0))} needed</span></div>`).join("") : M('<p class="muted">Just bring yourself. Your host hasn’t added any menu items yet.</p>')}</section>${
    own
      ? ui`<section class="panel"><p class="eyebrow">Your plans</p><h2>Your RSVP & items</h2>${
          own.version
            ? ui`<ul>${event.members.map((m) => ui`<li>${escape(fullName(m))}: ${own.attendance[m.id] === "yes" ? C("Attending") : own.attendance[m.id] === "no" ? C("Not attending") : C("No response")}</li>`).join("")}</ul><h3>You’re bringing</h3>${
                Object.entries(own.claims).length
                  ? ui`<ul>${Object.entries(own.claims)
                      .map(
                        ([key, n]) =>
                          ui`<li>${escape(event.menu.find((m) => m.id === key)?.name || "Item")} × ${n}</li>`,
                      )
                      .join("")}</ul>`
                  : M('<p class="muted">No items selected.</p>')
              }`
            : M('<p class="muted">We’d love to know if you can join us.</p>')
        }</section>`
      : M(
          '<section class="panel"><p class="eyebrow">Made for this gathering</p><h2>Your invitation</h2><p>Choose an administrator-provided template in Edit event. Event details populate automatically.</p>',
        ) +
        button("invitation", H("Preview invitation")) +
        "</section>"
  }</div>`;
}
function render() {
  const activeEvent = state.data?.events?.find((e) => e.id === state.event);
  const active =
    activeEvent?.ui ||
    state.data?.ui ||
    resolveUI(state.platformUI, state.publicHousehold?.ui, {
      design: state.publicHousehold?.design,
    });
  configureCopy(active);
  applyDesign(active.design);
  const role = state.session?.role;
  let content = "",
    event = null;
  if (!role) content = authPage();
  else if (role === "admin") {
    content = ui`<section class="hero"><p class="eyebrow">Administrator</p><h1>Open the door<br>for your next host.</h1><p>Approve email addresses and manage shared invitation artwork. No emails are sent.</p></section><div class="grid">${tools.adminPanel()}<section class="panel"><h2>Approved emails</h2><form data-form="approval">${field(H("Email address"), "email", "", "email", "required")}<p class="form-error" role="alert"></p><button>Approve host</button></form><ul class="guest-list">${state.data.approvals.map((a) => ui`<li class="row between"><span>${escape(a.email)}</span>${button("revoke", H("Remove"), `data-email="${escape(a.email)}"`, "quiet")}</li>`).join("") || M('<li class="muted">No pending approvals.</li>')}</ul></section><section class="panel"><h2>Cards & invitation templates</h2><p>Shared templates for invitations, thank-you cards and holiday cards.</p>${button("cards", H("Manage card templates"))}</section><section class="panel"><h2>Registered hosts</h2><ul>${state.data.hosts.map((h) => ui`<li>${escape(h.email)} ${button("delete-host", H("Delete account"), `data-id="${h.id}"`, "danger")}</li>`).join("") || M("<li>No hosts yet.</li>")}</ul><p class="small muted">Host guest records and RSVPs are not included here.</p></section></div>`;
  } else {
    event = state.data.events.find((e) => e.id === state.event);
    state.activeUI =
      event?.ui ||
      state.data.ui ||
      resolveUI(
        state.platformUI,
        { design: state.data.household.design },
        { design: event?.design },
      );
    applyDesign(state.activeUI.design);
    if (event) content = eventPage(event);
    else {
      state.event = null;
      content = ui`<section class="hero"><p class="eyebrow">${role === "host" ? C("Your gathering place") : H("Welcome,") + " " + escape(state.data.guest.first)}</p><h1>${escape(state.data.household.name)}</h1><p class="muted">${role === "host" ? C("A familiar table. A new memory. Make room for your next gathering.") : C("Your invitations, all in one place.")}</p>${role === "host" ? ui`<div class="row">${button("household", H("Edit household"), "", "")}${button("new-event", H("Create event"), 'aria-label="Create event"', "")}${button("guests", H("Guest list"))}${button("addresses", H("Address book"))}${button("share", H("Share household link"))}${button("cards", H("Cards & templates"))}${button("host-ui", H("Page wording & layout"))}</div>` : ""}</section>${state.data.events.length ? ui`<section class="grid" aria-label="Events">${state.data.events.map(eventCard).join("")}</section>` : ui`<section class="panel empty"><div class="sprig" aria-hidden="true">❧</div><h2>${role === "host" ? C("Your next memory starts here.") : C("Nothing on the calendar yet.")}</h2><p class="muted">${role === "host" ? C("Choose Create event to plan your first gathering.") : C("Your host will add your invitations here.")}</p></section>`}`;
    }
  }
  $("#app").innerHTML =
    ui`<header><a class="brand" href="/" data-action="home">gather<span>＊</span></a>${state.preview ? M('<span class="pill">Read-only guest preview</span>') : !role ? M('<span class="eyebrow">Come as you are</span>') : ""}</header><main id="main">${content}${role ? ui`<p id="sync-status" class="connection">Updated ${state.lastSync.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · syncs automatically</p>` : ""}</main>${role || state.preview ? toolbar(event) : ""}`;
  if (role === "host" && !event) {
    const panel = document.createElement("section");
    panel.className = "panel private-notes";
    panel.innerHTML = ui`<h2>Private household notes</h2><form data-form="household-notes">${area(H("Notes"), "notes", state.data.household.notes || "", 'maxlength="20000"')}<p class="form-error" role="alert"></p><button>Save private notes</button></form>`;
    document.querySelector("#main .hero")?.after(panel);
  }
  applyLayoutDOM(event, role);
}
function modal(title, content, form = "", save = C("Save")) {
  const dialog = $("#editor");
  dialog.innerHTML = ui`<div class="dialog-head"><h2 id="dialog-title">${escape(title)}</h2>${button("close", "✕", 'aria-label="Close editor"', "quiet")}</div>${form ? ui`<form data-form="${form}">` : ""}<div class="dialog-body">${content}<p class="form-error" role="alert"></p></div>${form ? ui`<div class="dialog-foot">${button("close", H("Cancel"))}<button>${save}</button></div></form>` : ""}`;
  if (!dialog.open) dialog.showModal();
}
const closeModal = () => {
  $("#editor").close();
  $("#editor").replaceChildren();
};
const selectedEvent = () => state.data.events.find((e) => e.id === state.event);
function appearanceFields(d) {
  return ui`<div class="preview" id="design-preview"><p class="eyebrow">Appearance preview</p><h2>${escape(state.data.household.name)}</h2><p>Good company. Great memories.</p></div>${designControls(d, { field, select, label: H })}<label class="check"><input type="checkbox" name="removeBackground">Remove background image</label>`;
}
function appearanceForm() {
  const household = state.data.household,
    d = { ...state.data.defaults, ...household.design };
  state.editingDesign = d;
  modal(
    C("Household & login appearance"),
    ui`${field(H("Family household name"), "householdName", household.name, "text", 'required maxlength="100"')}<p class="small muted">Display-name edits preserve the household address and existing links.</p>${appearanceFields(d)}`,
    "household",
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
    "descriptionColor",
    "descriptionFont",
    "buttonColor",
    "buttonText",
    "buttonFont",
  ])
    d[key] = data.get(key);
  for (const key of [
    "opacity",
    "titleSize",
    "textSize",
    "descriptionSize",
    "buttonSize",
  ])
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
    guest.id ? C("Edit guest") : C("Add guest"),
    ui`<div class="form-grid">${field(H("First name"), "first", guest.first, "text", 'required maxlength="80"')}${field(H("Last name"), "last", guest.last, "text", 'required maxlength="80"')}</div>${field(H("Suffix (optional)"), "suffix", guest.suffix, "text", 'maxlength="30"')}${field(H("Phone number (international)"), "phone", guest.phone || "", "tel", 'placeholder="+15551234567"')}<label class="check"><input name="smsConsent" type="checkbox" ${guest.smsConsent ? "checked" : ""}>This adult has consented to event text reminders. They may reply STOP to opt out.</label>${select(H("Adult or child"), "parent", [["", C("Adult guest")], ...state.data.guests.filter((g) => !g.parent && g.id !== guest.id).map((g) => [g.id, "Child of " + fullName(g)])], guest.parent || "")}${select(H("Shared address (optional)"), "address", [["", C("No address")], ...state.data.addresses.map((a) => [a.id, a.label])], guest.address || "")}<p class="small muted">Children RSVP through their designated adult. Guests with identical first, last and suffix names cannot sign in until corrected.</p>`,
    "guest",
  );
}
function guestList() {
  modal(
    C("Your guest list"),
    ui`<p>Reusable people, independent invitations.</p>${button("add-guest", H("＋ Add adult or child"), "", "")}<ul class="guest-list">${state.data.guests.map((g) => ui`<li class="${g.parent ? "child" : ""}"><div class="row between"><div><strong>${escape(fullName(g))}</strong><div class="small muted">${g.parent ? H("Child of") + " " + escape(fullName(state.data.guests.find((a) => a.id === g.parent))) : C("Adult guest")}${g.address ? " · " + escape(state.data.addresses.find((a) => a.id === g.address)?.label) : ""}</div></div><div>${button("edit-guest", H("Edit"), `data-id="${g.id}"`, "quiet")}${button("delete-guest", H("Remove"), `data-id="${g.id}"`, "quiet")}</div></div></li>`).join("") || M('<li class="muted">Add your first guest to start inviting.</li>')}</ul>`,
  );
}
function addresses() {
  modal(
    C("Address book"),
    ui`<p>Assign the same address to as many guests as you need.</p>${button("add-address", H("＋ Add address"), "", "")}<ul class="guest-list">${state.data.addresses.map((a) => ui`<li><strong>${escape(a.label)}</strong><p class="event-details">${escape(a.lines)}</p>${button("edit-address", H("Edit"), `data-id="${a.id}"`, "quiet")}${button("delete-address", H("Remove"), `data-id="${a.id}"`, "quiet")}</li>`).join("") || M('<li class="muted">Addresses are optional.</li>')}</ul>`,
  );
}
function addressEditor(address = {}) {
  state.editingAddress = address;
  modal(
    address.id ? C("Edit address") : C("Add address"),
    `${field(H("Address label"), "label", address.label, "text", 'required maxlength="100" placeholder="The Doe home"')}${area(H("Mailing address (optional)"), "lines", address.lines, 'maxlength="500"')}${field(H("Contact phone (optional)"), "phone", address.phone || "", "tel", 'placeholder="+15551234567"')}`,
    "address",
  );
}
function menuRow(item = {}) {
  return ui`<div class="menu-row" data-menu-id="${item.id || crypto.randomUUID()}">${field(H("Item name"), "menuName", item.name || "", "text", 'required maxlength="160"')}<div class="row">${select(
    H("Menu"),
    "menuKind",
    [
      ["potluck", C("Potluck")],
      ["drink", C("Drinks")],
    ],
    item.kind || "potluck",
  )}${field(H("Needed"), "menuQuantity", item.quantity || 1, "number", 'required min="1" max="10000"')}${button("remove-menu", H("Remove"), "", "quiet")}</div></div>`;
}
function registryRow(registry = {}) {
  return ui`<div class="registry-row" data-registry-id="${registry.id || crypto.randomUUID()}">${field(H("Registry title"), "registryTitle", registry.title || "", "text", 'required maxlength="100" placeholder="Wedding Registry"')}${field(H("Registry URL"), "registryUrl", registry.url || "", "url", 'required maxlength="2048" placeholder="https://…"')}<div class="row">${button("registry-up", H("↑ Move up"), 'aria-label="Move registry up"', "quiet")}${button("registry-down", H("↓ Move down"), 'aria-label="Move registry down"', "quiet")}${button("remove-registry", H("Remove registry"), "", "quiet")}</div></div>`;
}
function eventEditor(existing) {
  state.editingEvent = existing || {
    design: {},
    invited: [],
    menu: [],
    registries: [],
  };
  const e = state.editingEvent;
  state.editingDesign = {
    ...state.data.defaults,
    ...state.data.household.design,
    ...e.design,
  };
  modal(
    existing ? C("Edit event") : C("A new reason to gather"),
    ui`${field(H("Event title"), "title", e.title, "text", 'required maxlength="160" placeholder="Sunday around the table"')}${area(H("Description"), "description", e.description, 'maxlength="5000"')}<div class="form-grid">${field(H("Date"), "date", e.date, "date")}${field(H("Time · numbers or words"), "time", e.time, "text", 'maxlength="100" placeholder="Two O’Clock in the Afternoon"')}${field(H("RSVP deadline"), "deadline", e.deadline, "date")}</div>${area(H("Event address"), "eventAddress", e.address, 'maxlength="500"')}${field(H("Photo / video upload link (optional)"), "uploadURL", e.uploadURL || "", "url", 'maxlength="2048" placeholder="https://…"')}<p class="small muted">Use Dropbox File Requests, Google Drive, OneDrive, or another sharing service. Configure upload permissions at that destination. Clear the link to remove the guest upload button.</p>${area(H("Private event notes"), "eventNotes", e.notes || "", 'maxlength="20000"')}<details><summary>Event appearance</summary>${appearanceFields(state.editingDesign)}<label class="check"><input type="checkbox" name="resetDesign">Use household appearance defaults</label></details>${field(H("Event icon / image"), "iconUpload", "", "file", 'accept="image/png,image/jpeg,image/webp"')}<label class="check"><input type="checkbox" name="removeIcon">Remove current image</label>${select(H("Invitation template"), "template", [["", C("Simple invitation")], ...state.templates.map((t) => [t.id, t.name])], e.template || "")}<fieldset><legend>Gift registries · optional</legend><p class="small muted">Guest buttons appear directly below RSVP, in this order.</p><div id="registry-rows">${(e.registries || []).map(registryRow).join("")}</div>${button("add-registry", H("＋ Add registry"))}</fieldset><fieldset><legend>Who’s invited?</legend><p class="small muted">Choose each person. Children need their designated adult invited too.</p>${state.data.guests.map((g) => ui`<label class="check ${g.parent ? "child" : ""}"><input type="checkbox" name="invited" value="${g.id}" ${e.invited.includes(g.id) ? "checked" : ""}>${escape(fullName(g))}${g.parent ? C(" (child)") : ""}</label>`).join("") || M("<p>Add guests from Home → Guest list before inviting them.</p>")}</fieldset><fieldset><legend>Potluck & drinks</legend><div class="row">${select(H("Copy menu from"), "copyMenu", [["", C("Choose a past event")], ...state.data.events.filter((p) => p.id !== e.id).map((p) => [p.id, p.title])], "")}${button("copy-menu", H("Copy items"))}</div><div id="menu-rows">${e.menu.map(menuRow).join("")}</div>${button("add-menu", H("＋ Add item"))}</fieldset>`,
    "event",
    existing ? C("Save event") : C("Create event"),
  );
}
function rsvp() {
  const event = selectedEvent();
  state.editingResponse = structuredClone(event.response);
  modal(
    C("Will you join us?"),
    ui`<p>${escape(event.title)}</p>${event.deadline ? ui`<p class="muted small">RSVP by ${escape(dateLabel(event.deadline))}. After this date you can still update attendance or reduce items.</p>` : ""}<fieldset><legend>Your invited party</legend>${event.members
      .map((m) =>
        select(
          escape(fullName(m)) + (m.parent ? C(" · child") : ""),
          "attendance:" + m.id,
          [
            ["", C("Choose…")],
            ["yes", C("Attending")],
            ["no", C("Not attending")],
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
          return ui`<div class="menu-item"><label class="grow">${escape(item.name)}<small>${item.kind === "drink" ? C("Drinks") : C("Potluck")} · ${Math.max(0, item.quantity - item.claimed)} remaining</small></label>${field(M('<span class="sr-only">Quantity for ') + escape(item.name) + "</span>", "claim:" + item.id, mine, "number", `min="0" max="${Math.max(mine, item.quantity - item.claimed + mine)}" required`)}</div>`;
        })
        .join("") || M("<p>No menu items yet.</p>")
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
    C("RSVP dashboard"),
    ui`<p>${escape(e.title)}</p><div class="row"><span class="pill">${d.totals.invited} invited</span><span class="pill">${d.totals.attending} attending</span><span class="pill">${d.totals.declined} not attending</span><span class="pill">${d.totals.noResponse} no response</span></div>${[
      ["yes", C("Attending")],
      ["no", C("Not attending")],
      ["", C("No response")],
    ]
      .map(
        ([status, label]) =>
          ui`<details open><summary>${label}</summary><ul>${
            d.guests
              .filter((g) => (attendance[g.id] || "") === status)
              .map(
                (g) =>
                  ui`<li>${escape(fullName(g))}${g.parent ? " · child of " + escape(fullName(d.guests.find((a) => a.id === g.parent))) : C(" · adult")}</li>`,
              )
              .join("") || M("<li>None yet</li>")
          }</ul></details>`,
      )
      .join(
        "",
      )}<h3>Potluck & drinks</h3>${d.menu.map((item) => ui`<div class="menu-item"><strong>${escape(item.name)}</strong><span>${item.claimed} / ${item.quantity} · ${Math.max(0, item.quantity - item.claimed)} remaining</span></div>`).join("")}<h3>Who’s bringing what</h3><ul>${
      d.responses
        .filter((r) => Object.keys(r.claims).length)
        .map(
          (r) =>
            ui`<li>${escape(fullName(d.guests.find((g) => g.id === r.guest)))}: ${Object.entries(
              r.claims,
            )
              .map(
                ([key, n]) =>
                  `${escape(d.menu.find((m) => m.id === key)?.name)} × ${n}`,
              )
              .join(", ")}</li>`,
        )
        .join("") || M("<li>No items claimed yet.</li>")
    }</ul>${button("refresh-dashboard", H("Refresh totals"))}`,
  );
}
async function share() {
  const link = householdShareUrl();
  modal(
    C("One link for every gathering"),
    ui`<p>${escape(state.data.household.name)}</p><img class="qr" src="/api/host/qr" alt="Household sign-in QR code"><p class="share-link">${escape(link)}</p><div class="row">${button("copy-link", H("Copy link"))}${button("native-share", H("Share link"))}<a class="button secondary" href="/api/host/qr" download="household-qr.svg">Download QR</a><a class="button secondary" href="${escape(link)}" target="_blank" rel="noopener">Open guest page</a></div><p class="small muted">Your link stays the same when you add events or change your design. A new web address is used after activation. Existing /h/ links always keep working. Guests still sign in with their names.</p>`,
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
  if (state.preview) {
    notify(C("Read-only preview: no guest data will be changed."));
    return;
  }
  if (await tools.submit(form, kind)) return;
  if (kind === "setup") {
    await api("/api/setup", { method: "POST", data: value });
    form.reset();
    state.view = "home";
    await load();
    notify(C("Your administrator account is ready."));
    return;
  }
  if (kind === "login" || kind === "register") {
    if (kind === "register") delete value.subdomain;
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
    notify(C("Email approved. No email was sent."));
    return;
  }
  if (kind === "household") {
    const d = designFrom(form),
      upload = await fileData(form.elements.backgroundUpload);
    if (upload) d.backgroundImage = upload;
    if (data.has("removeBackground")) d.backgroundImage = "";
    await api("/api/host/household", {
      method: "PUT",
      version: state.data.household.version,
      data: {
        name: value.householdName,
        design: Object.fromEntries(
          Object.entries(d).filter(
            ([key, value]) =>
              value !== state.editingDesign[key] ||
              key in (state.data.household.design || {}),
          ),
        ),
      },
    });
    await saved("Appearance saved.");
    return;
  }
  if (kind === "guest" || kind === "address") {
    const record = kind === "guest" ? state.editingGuest : state.editingAddress,
      collection = kind === "guest" ? "guests" : "addresses";
    await api("/api/host/" + collection + (record.id ? "/" + record.id : ""), {
      method: record.id ? "PUT" : "POST",
      version: record.id ? record.version : undefined,
      data:
        kind === "guest"
          ? { ...value, smsConsent: data.has("smsConsent") }
          : value,
    });
    await saved(kind === "guest" ? C("Guest saved.") : C("Address saved."));
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
        notes: value.eventNotes,
        uploadURL: value.uploadURL,
        registries: [...form.querySelectorAll(".registry-row")].map((row) => ({
          id: row.dataset.registryId,
          title: row.querySelector("[name=registryTitle]").value,
          url: row.querySelector("[name=registryUrl]").value,
        })),
        design: await eventDesign(form, e),
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
      (problem.status === 409 && form.dataset.form !== "register"
        ? C(" Close this editor and refresh before trying again.")
        : "");
    if (problem.status === 409 && form.dataset.form === "register")
      void checkAddress(form);
    error.scrollIntoView({ block: "nearest", behavior: "smooth" });
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }
});
document.addEventListener("input", (event) => {
  tools.input(event);
  const form = event.target.closest("form");
  if (form?.dataset.form === "register" && event.target.name === "name") {
    form.querySelector("#household-address").textContent = suggestLabel(
      event.target.value,
    )
      ? `${suggestLabel(event.target.value)}.ilymmd.com`
      : "";
    form.querySelector("#subdomain-status").textContent = "Checking address…";
    clearTimeout(addressTimer);
    addressTimer = setTimeout(() => void checkAddress(form), 400);
  }
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
    if (
      state.preview &&
      !["exit-preview", "open-event", "home", "print", "close"].includes(action)
    ) {
      notify(C("Read-only preview: no guest data will be changed."));
      return;
    }
    if (await tools.action(action, target)) return;
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
    if (action === "share") {
      await share();
      return;
    }
    if (action === "copy-link") {
      await navigator.clipboard.writeText(householdShareUrl());
      notify(C("Link copied."));
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
        notify(C("Link copied."));
      }
      return;
    }
    if (action === "invitation") {
      await tools.invitation();
      return;
    }
    if (action === "print") {
      window.print();
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
          `Remove this ${kind}${kind === "event" ? C(" and all its RSVPs") : ""}? This cannot be undone.`,
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
const tools = featureTools({
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
});
tools.bind();
await load();
setInterval(() => {
  if (state.session?.role && document.visibilityState === "visible")
    load({ background: true });
}, 10000);
window.addEventListener("online", () => load({ background: true }));

async function eventDesign(form, event) {
  if (new FormData(form).has("resetDesign")) return {};
  const d = designFrom(form),
    upload = await fileData(form.elements.backgroundUpload);
  if (upload) d.backgroundImage = upload;
  if (new FormData(form).has("removeBackground")) d.backgroundImage = "";
  const result = { ...event.design };
  for (const [key, value] of Object.entries(d))
    if (value !== state.editingDesign[key] || key in result)
      result[key] = value;
  return result;
}
function applyLayoutDOM(event, role) {
  const config = event?.ui || state.data?.ui || state.platformUI;
  if (!config) return;
  const main = document.querySelector("#main"),
    move = (container, items, keys) => {
      if (!container) return;
      for (const item of order(
        items.filter((i) => i.element),
        keys || [],
      ))
        container.append(item.element);
    };
  if (event) {
    const info = main.querySelector(".event-hero"),
      actions = info?.nextElementSibling,
      grid = main.querySelector(".grid");
    const sections = grid ? [...grid.children] : [];
    if (grid) grid.remove();
    move(
      main,
      [
        { id: "information", element: info },
        { id: "actions", element: actions },
        { id: "menus", element: sections[0] },
        { id: "personal", element: sections[1] },
      ],
      config.layouts.event,
    );
    if (actions && role === "guest") {
      const rsvp = actions.querySelector("[data-action=rsvp]"),
        registries = actions.querySelector(".registry-buttons");
      if (rsvp) {
        const group = document.createElement("div");
        group.className = "rsvp-stack";
        group.dataset.layoutAction = "rsvp";
        rsvp.before(group);
        group.append(rsvp);
        if (registries) group.append(registries);
      }
    }
    if (actions) {
      const list = [...actions.children].map((el) => ({
        id:
          el.dataset.layoutAction ||
          (el.dataset.action === "edit-event"
            ? "edit-event"
            : el.dataset.action === "rsvp"
              ? "rsvp"
              : el.dataset.action === "invitation"
                ? "invitation"
                : el.dataset.action === "delete-event"
                  ? "delete-event"
                  : el.classList.contains("registry-buttons")
                    ? "registries"
                    : el.textContent === String(C("Upload Photos & Videos"))
                      ? "uploads"
                      : el.dataset.action || ""),
        element: el,
      }));
      move(actions, list, config.layouts.eventButtons);
    }
  } else if (role === "host" || role === "guest") {
    const hero = main.querySelector(".hero"),
      actions = hero?.querySelector(".row"),
      notes = main.querySelector(".private-notes"),
      events = main.querySelector(".grid,.empty");
    if (actions) {
      hero.after(actions);
      const items = [...actions.children].map((el) => ({
        id: el.dataset.action,
        element: el,
      }));
      move(actions, items, config.layouts.homeButtons);
    }
    move(
      main,
      [
        { id: "intro", element: hero },
        { id: "actions", element: actions },
        { id: "notes", element: notes },
        { id: "events", element: events },
      ],
      config.layouts[role === "host" ? "hostHome" : "guestHome"],
    );
  } else if (!role) {
    const panel = main.querySelector(".auth .panel"),
      form = panel?.querySelector("form");
    if (panel && form) {
      form.dataset.layoutKey = "form";
      for (const el of [...panel.children])
        if (el !== form) el.dataset.layoutKey = "intro";
      for (const key of config.layouts.login)
        for (const el of [...panel.children].filter(
          (el) => el.dataset.layoutKey === key,
        ))
          panel.append(el);
    }
  }
  if (role === "admin") {
    const grid = main.querySelector(".grid");
    if (grid) {
      const panels = [...grid.children];
      move(
        grid,
        [
          { id: "intro", element: main.querySelector(".hero") },
          { id: "defaults", element: panels[0] },
          { id: "approvals", element: panels[1] },
          { id: "templates", element: panels[2] },
          { id: "hosts", element: panels[3] },
        ],
        config.layouts.admin,
      );
    }
  }
}
