import { appearanceEditor } from "/appearance-editor.js";
import {
  bindBrowseMenus,
  tool,
  menu,
  sorting,
  topbar,
  bottom,
  row,
  searchBox,
  ordered,
} from "/browse-ui.js";
import { addressPicker } from "/address-picker.js";
import { exampleState, annotateExample } from "/default-examples.js";
import { familyTools } from "/family-ui.js";
import { ui, M, C, H, configureCopy } from "/ui-runtime.js";
import { featureTools } from "/editor-tools.js";
import {
  resolveUI,
  order,
  roleDefaults,
  categoryDesign,
  appearanceKeys,
  independentAppearanceKeys,
  appearancePreset,
} from "/ui-system.js";
import { icon } from "/icons.js";
import { suggestLabel } from "/household-address.js";
bindBrowseMenus();
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
let contactSearch = "",
  contactSearchOpen = false,
  contactPreferences = null,
  contactInviteMode = false,
  contactUninvite = false,
  contactInviteEventsOpen = false,
  contactInviteSaving = false,
  contactInviteError = "";
const contactInviteSelection = new Set();
function resetContactInvites() {
  contactInviteMode = false;
  contactUninvite = false;
  contactInviteEventsOpen = false;
  contactInviteSaving = false;
  contactInviteError = "";
  contactInviteSelection.clear();
}
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
  ui`<label>${label}<textarea aria-label="${label}" name="${name}" ${M(extra)}>${escape(value)}</textarea></label>`;
const select = (label, name, options, value, extra = "") =>
  ui`<label>${label}<select aria-label="${label}" name="${name}" ${extra}>${options.map(([key, label]) => ui`<option value="${escape(key)}" ${key === value ? "selected" : ""}>${escape(label)}</option>`).join("")}</select></label>`;
const dateLabel = (value) =>
  value
    ? new Intl.DateTimeFormat(undefined, {
        dateStyle: "long",
        timeZone: "UTC",
      }).format(new Date(value + "T12:00:00Z"))
    : C("Date to come");
function applyDesign(settings = {}, target = document.documentElement) {
  const d = categoryDesign({
    ...roleDefaults,
    ...state.data?.defaults,
    ...state.publicHousehold?.defaults,
    ...settings,
  });
  if (!d.background) return;
  const root = target.style;
  root.setProperty("--bg", d.background);
  root.setProperty("--panel-solid", d.container);
  root.setProperty(
    "--panel",
    d.containerImage
      ? d.background
      : `color-mix(in srgb, ${d.container} ${d.opacity}%, transparent)`,
  );
  for (const prefix of ["toolbar", "button"]) {
    root.setProperty(`--${prefix}-surface`, d[prefix + "Surface"]);
    root.setProperty(
      `--${prefix}-panel`,
      `color-mix(in srgb, ${d[prefix + "Surface"]} ${d[prefix + "Opacity"]}%, transparent)`,
    );
    root.setProperty(`--${prefix}-border-color`, d[prefix + "BorderColor"]);
    root.setProperty(
      `--${prefix}-border-width`,
      d[prefix + "BorderWidth"] + "px",
    );
    root.setProperty(`--${prefix}-border-style`, d[prefix + "BorderStyle"]);
    root.setProperty(`--${prefix}-label-color`, d[prefix + "LabelColor"]);
    root.setProperty(`--${prefix}-label-font`, d[prefix + "LabelFont"]);
    root.setProperty(`--${prefix}-label-size`, d[prefix + "LabelSize"] + "px");
    root.setProperty(
      `--${prefix}-label-weight`,
      d[prefix + "LabelStyle"].includes("bold") ? "700" : "400",
    );
    root.setProperty(
      `--${prefix}-label-style`,
      /italic/i.test(d[prefix + "LabelStyle"]) ? "italic" : "normal",
    );
  }
  root.setProperty("--heading", d.titleColor);
  root.setProperty("--ink", d.textColor);
  root.setProperty("--title-font", d.titleFont);
  root.setProperty("--body-font", d.textFont);
  root.setProperty("--title-size", `${d.titleSize}px`);
  root.setProperty("--text-size", `${d.textSize}px`);
  for (const role of [
    "description",
    "button",
    "eyebrow",
    "status",
    "toolbar",
    "notes",
  ]) {
    root.setProperty(`--${role}-font`, d[role + "Font"]);
    root.setProperty(`--${role}-size`, d[role + "Size"] + "px");
    root.setProperty(`--${role}-color`, d[role + "Color"]);
  }
  root.setProperty("--button-text", d.buttonText);
  for (const key of [
    "borderColor",
    "statusBackground",
    "toolbarBackground",
    "inputColor",
    "inputBackground",
    "linkColor",
    "accentColor",
    "dangerColor",
    "dangerBackground",
    "notesBackground",
  ])
    root.setProperty(
      "--" + key.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase()),
      d[key],
    );
  for (const prefix of ["title", "description", "text"]) {
    root.setProperty(
      `--${prefix}-weight`,
      d[prefix + "Style"].includes("bold") ? "700" : "400",
    );
    root.setProperty(
      `--${prefix}-style`,
      /italic/i.test(d[prefix + "Style"]) ? "italic" : "normal",
    );
  }
  root.setProperty(
    "--container-image",
    d.containerImage ? `url("${d.containerImage}")` : "none",
  );
  root.setProperty(
    "--container-image-opacity",
    String(d.containerImageOpacity / 100),
  );
  root.setProperty("--border-width", d.borderWidth + "px");
  root.setProperty("--border-style", d.borderStyle);
  root.setProperty(
    "--background-image",
    d.backgroundImage ? `url("${d.backgroundImage}")` : "none",
  );
  fitEventSummary();
}
let loadGeneration = 0,
  pendingActions = 0,
  pointerInteraction = false;
document.addEventListener(
  "pointerdown",
  () => {
    pointerInteraction = true;
  },
  true,
);
const finishPointer = () =>
  setTimeout(() => {
    pointerInteraction = false;
  }, 0);
document.addEventListener("pointerup", finishPointer, true);
document.addEventListener("pointercancel", finishPointer, true);
document.addEventListener(
  "keydown",
  (event) => {
    if (
      ["Enter", " "].includes(event.key) &&
      event.target.closest("button,summary,a")
    )
      pointerInteraction = true;
  },
  true,
);
document.addEventListener("keyup", finishPointer, true);
window.addEventListener("blur", () => {
  pointerInteraction = false;
});
const isEditing = () =>
  !!state.eventLayoutDraft ||
  pointerInteraction ||
  pendingActions > 0 ||
  state.view === "card-editor" ||
  appearance.active() ||
  contactInviteMode ||
  !!document.querySelector(
    "form[data-form=guest],:is(.inline-household-details,.inline-event-details)[data-dirty=true]",
  ) ||
  $("#editor").open ||
  !!document.querySelector(".browse-menu[open]") ||
  document.activeElement?.matches("input,select,textarea");
function renderRefresh(preserveScroll) {
  // Replacing/reordering the page can temporarily shrink it and clamp scrolling.
  // Capture at adoption time, after requests, so in-flight scrolling is retained.
  const position = preserveScroll ? { left: scrollX, top: scrollY } : null;
  render();
  if (position) window.scrollTo({ ...position, behavior: "instant" });
}
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
    const [context, platform, session] = await Promise.all([
      api("/api/public/context"),
      api("/api/interface"),
      api("/api/session"),
    ]);
    state.platformUI = platform.ui;
    if (state.preview) {
      const data = await api(state.preview.endpoint || "/api/admin/preview", {
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
      renderRefresh(background);
      return;
    }
    let data = null,
      templates = [],
      publicHousehold = context.household;
    if (session.role) {
      data = await api(
        session.role === "admin" ? "/api/admin" : `/api/${session.role}`,
      );
      if (session.role === "host" && session.platformAdmin) {
        const admin = await api("/api/admin");
        Object.assign(data, {
          approvals: admin.approvals,
          hosts: admin.hosts,
          deletions: admin.deletions,
          legacyAdministrators: admin.legacyAdministrators,
        });
      }
      if (session.role === "guest") templates = await api("/api/templates");
      else if (session.role === "host") templates = data.templates;
    } else {
      const match = location.pathname.match(/^\/h\/([A-Za-z0-9_-]+)$/);
      if (match)
        publicHousehold = await api(`/api/public/households/${match[1]}`);
    }
    const familyData =
      session.role === "family"
        ? data
        : session.role === "host" && state.view === "family"
          ? await api("/api/family")
          : null;
    // An editor may have opened while a background request was in flight.
    // Never adopt newer versions behind an older unsaved form.
    if (generation !== loadGeneration || (background && isEditing())) return;
    const preserveScroll = background && state.session?.role === session.role;
    const previousSync = state.data?.integrations?.anylistStatus;
    const nextSync = data?.integrations?.anylistStatus;
    const syncCompleted =
      previousSync?.state === "running" &&
      nextSync?.state === "complete" &&
      previousSync.id === nextSync.id;
    const unchanged =
      background &&
      JSON.stringify([
        state.session,
        state.data,
        state.templates,
        state.publicHousehold,
        state.familyData,
      ]) ===
        JSON.stringify([
          session,
          data,
          templates,
          publicHousehold,
          familyData || state.familyData,
        ]);
    if (familyData) state.familyData = familyData;
    Object.assign(state, {
      session,
      data,
      templates,
      publicHousehold,
      lastSync: new Date(),
    });
    if (!unchanged) renderRefresh(preserveScroll);
    else $("#sync-status")?.replaceChildren();
    if (syncCompleted && state.view === "contacts")
      notify(C("Contacts synced."));
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
function authPage(designTarget) {
  if (
    state.setup?.required ||
    (location.pathname === "/setup" && state.view !== "login")
  )
    return setupPage();
  const household = state.publicHousehold;
  if (household) applyDesign(household.design, designTarget);
  if (
    household &&
    !["login", "register", "family-login"].includes(state.view)
  ) {
    return ui`<section class="auth"><div class="panel"><p class="eyebrow">You’re in good company</p><h1>${escape(household.name)}</h1><p>Welcome. Enter your name to see your invitations.</p><form data-form="guest-login" class="stack">${field(H("First name"), "first", "", "text", 'required autocomplete="given-name" maxlength="80"')}${field(H("Last name"), "last", "", "text", 'required autocomplete="family-name" maxlength="80"')}${field(H("Invite Code"), "inviteCode", "", "password", 'required autocomplete="off" inputmode="numeric" placeholder="4-digit code" maxlength="100"')}<div id="guest-suffix" hidden>${field(H("Suffix, if applicable"), "suffix", "", "text", 'autocomplete="honorific-suffix" maxlength="30" placeholder="Jr., Sr., III…"')}</div><p class="form-error" role="alert"></p><button>See my invitations</button></form><p class="small muted">Use the name your host has on file. If you share an identical name, ask your host for help.</p></div><p class="small centered">${button("host-login", H("Host Login"), "", "quiet")}${button("family-login", H("Family member sign-in"))}${button("guest-code-claim", H("Link another invitation"))}</p></section>`;
  }
  if (state.view === "family-login" && household)
    return ui`<section class="auth"><div class="panel"><h1>${escape(household.name)}</h1><h2>Family member sign-in</h2><form data-form="family-login">${field(H("Sign-in name"), "login", "", "text", 'required autocomplete="username"')}${field(H("Password"), "password", "", "password", 'required autocomplete="current-password"')}<p class="form-error" role="alert"></p><button>Sign in</button></form></div></section>`;
  const register = state.view === "register";
  return ui`<section class="auth"><p class="eyebrow">A place for your people</p><h1>${register ? C("Make yourself at home.") : C("Good things begin together.")}</h1><div class="panel"><h2>${register ? C("Create your host account") : C("Host Login")}</h2><p class="muted">${register ? C("Registration is available only for administrator-approved email addresses. No emails will be sent.") : C("Plan a little. Gather a lot.")}</p><form data-form="${register ? "register" : "login"}">${field(H("Email address"), "email", "", "email", 'required autocomplete="username" maxlength="254"')}${field(H("Password"), "password", "", "password", `required minlength="12" maxlength="256" autocomplete="${register ? "new-password" : "current-password"}"`)}${register ? field(H("Family household name"), "name", "", "text", 'required maxlength="100" placeholder="Household name"') + subdomainField() : ""}<p class="form-error" role="alert"></p><button>${register ? C("Create account") : C("Sign in")}</button></form></div><p class="small">${register ? C("Already registered?") : C("Approved to host?")} ${button(register ? "host-login" : "register", register ? C("Sign in") : C("Create your account"), "", "quiet")}</p>${household ? button("page-back", H("Back"), "", "quiet") : ""}</section>`;
}
function toolbar(event) {
  if (state.preview)
    return bottom([
      { action: "exit-preview", label: "Exit read-only preview", icon: "back" },
    ]);
  const role = state.session.role;
  if (role === "host")
    return bottom([
      { action: "home", label: "Home", icon: "home" },
      ...(event
        ? [{ action: "share", label: "Share Invitation", icon: "share" }]
        : []),
    ]);
  if (role === "admin")
    return bottom([
      { action: "home", label: "Home", icon: "home" },
      { action: "admin-approvals", label: "Approvals", icon: "contacts" },
      { action: "admin-hosts", label: "Hosts", icon: "contacts" },
      { action: "global-defaults", label: "Defaults", icon: "edit" },
      { action: "cards", label: "Templates", icon: "list" },
    ]);
  return bottom([
    { action: "home", label: "Home", icon: "home" },
    ...(event ? [{ action: "print", label: "Print", icon: "print" }] : []),
  ]);
}
function topActions(event) {
  const role = state.session?.role;
  if (role === "admin" || (role === "host" && state.adminMode))
    return topbar({
      title: "",
      plus:
        state.view === "management" && state.managementKind === "cards"
          ? [{ action: "new-card", label: "Create shared template" }]
          : [{ action: "admin-approvals", label: "Approve host" }],
      sort: [{ action: "preview-guest", label: "Preview guest experience" }],
    });
  if (event)
    return topbar({
      title: "",
      extra: tool("print", "Print", "", "print"),
      sort:
        role === "host" && state.session.platformAdmin
          ? [{ action: "preview-guest", label: "Preview guest experience" }]
          : [],
    });
  return "";
}
function settingsPage() {
  return ui`<section class="panel"><h1>Settings</h1>${state.session.role === "admin" ? `<form data-form="admin-password">${field(H("Current password"), "currentPassword", "", "password", "required")}${field(H("New password"), "password", "", "password", 'required minlength="12"')}<p class="form-error" role="alert"></p><button>${C("Change Password")}</button></form>` : ""}${button("logout", H("Sign Out"))}</section>`;
}
function eventSummary(event) {
  const host = state.session.role === "host";
  if (!host && !event.menu.some((i) => i.kind === "potluck")) return "";
  const items = host
    ? [
        [event.totals.attending, "Attending"],
        [event.totals.invited, "Invited"],
        [event.totals.declined || 0, "Not attending"],
        [event.totals.noResponse || 0, "No response"],
      ]
    : [
        [
          event.menu.reduce(
            (n, i) => n + Math.max(0, i.quantity - (i.claimed || 0)),
            0,
          ),
          "Items needed",
        ],
        [
          Object.values(event.response?.claims || {}).reduce(
            (a, b) => a + b,
            0,
          ),
          "Your items",
        ],
      ];
  return `<div class="event-summary no-print" role="group" tabindex="0" aria-label="${H("Event summary")}"><div class="totals" style="--summary-items:${items.length}">${items.map(([value, label]) => `<div><strong>${value}</strong><span>${H(label)}</span></div>`).join("")}</div></div>`;
}

function orderedInvitations(events) {
  const today = new Date().toISOString().slice(0, 10);
  const rank = (event) => (!event.date ? 1 : event.date >= today ? 0 : 2);
  return [...events].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (rank(a) === 2
        ? String(b.date || "").localeCompare(a.date || "")
        : String(a.date || "").localeCompare(b.date || "")) ||
      a.title.localeCompare(b.title) ||
      a.id.localeCompare(b.id),
  );
}
function eventCard(event) {
  const logo = event.invitingHousehold
    ? event.invitingHousehold.logo
    : state.data.household.logo;
  const heading = ui`<div class="event-choice-heading">${logo ? ui`<img class="family-logo" src="${escape(logo)}" alt="Family logo">` : M('<span class="eyebrow">You’re invited to gather</span>')}</div>`;
  const content = ui`${event.invitingHousehold ? ui`<p class="eyebrow">${escape(event.invitingHousehold.name)}</p>` : ""}<p class="muted small">${escape(dateLabel(event.date))}</p><h2>${escape(event.title)}</h2><p class="muted">${escape(event.description.slice(0, 120))}</p><div class="row"><span class="pill">${event.totals.attending} attending</span>${event.response?.version ? M('<span class="pill">RSVP saved</span>') : ""}</div>${button("open-event", H("View Event"), `data-id="${event.invitationKey || event.id}"`)}`;
  if (state.session.role !== "host")
    return ui`<article class="card event-choice">${heading}<div class="event-overview">${content}</div></article>`;
  return ui`<article class="card host-event-choice">${heading}<div class="event-overview">${content}</div><div class="event-home-actions" role="group" aria-label="${H("Event actions")}">${[
    ["dashboard", "RSVPs"],
    ["reminders", "Reminders"],
    ["cards", "Invitation Cards"],
  ]
    .map(([action, label]) =>
      button("event-action-" + action, H(label), `data-id="${event.id}"`),
    )
    .join("")}</div></article>`;
}

function eventInformation(
  event,
  preview = false,
  layout = event.informationLayout,
) {
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
    return ui`<div class="event-meta event-information-invitation"><div class="invitation-date" ${edit("date")}>${escape(date)}</div>${event.time ? ui`<div class="invitation-time" ${edit("time")}>${escape(event.time)}</div>` : ""}${event.address ? ui`<div class="invitation-address" ${edit("eventAddress")}>${escape(event.address)}</div>` : ""}${deadline ? ui`<div class="invitation-rsvp"><span>${C("Kindly RSVP by")}</span> <span ${edit("deadline")}>${escape(rsvp)}</span></div>` : ""}</div>`;
  }
  return ui`<div class="event-meta"><div><b>When</b><span ${edit("date")}>${escape(dateLabel(event.date))}</span><span ${edit("time")}>${escape(event.time)}</span></div>${event.address ? ui`<div><b>Where</b><span class="event-details" ${edit("eventAddress")}>${escape(event.address)}</span></div>` : ""}</div>${event.deadline ? ui`<div class="event-deadline"><b>RSVP By</b><span ${edit("deadline")}>${escape(dateLabel(event.deadline))}</span></div>` : ""}`;
}
function eventPage(event) {
  const own = event.response || { version: 0, attendance: {}, claims: {} };
  const content = ui`<section class="event-hero">${event.icon ? ui`<img class="event-icon" data-event-edit="iconUpload" src="${escape(event.icon)}" alt="Event artwork">` : ""}<h1 data-event-edit="title">${escape(event.title)}</h1><p class="event-details" data-event-edit="description">${escape(event.description)}</p>${eventInformation(event)}</section><div class="row no-print" data-event-actions>${button("rsvp", C("RSVP"), "", "")}${(event.registries || []).length ? ui`<div class="registry-buttons" aria-label="Gift registries">${event.registries.map((r) => ui`<a class="button registry-button" href="${escape(r.url)}" target="_blank" rel="noopener noreferrer">${escape(r.title)}</a>`).join("")}</div>` : ""}${event.uploadURL ? ui`<a class="button secondary" data-event-edit="uploadURL" href="${escape(event.uploadURL)}" target="_blank" rel="noopener noreferrer">Upload Photos & Videos</a>` : ""}</div><div class="grid"><section class="panel" data-event-section="menus"><p class="eyebrow">Something to share</p><h2>At the table</h2>${event.menu.length ? event.menu.map((item) => ui`<div class="menu-item" data-event-edit="table" data-menu-item="${escape(item.id)}"><div><strong>${escape(item.name)}</strong><div class="muted small">${item.kind === "drink" ? C("Drinks") : C("Potluck")}</div></div><span class="pill">${Math.max(0, item.quantity - (item.claimed || 0))} needed</span></div>`).join("") : M('<p class="muted">Just bring yourself. Your host hasn’t added any menu items yet.</p>')}</section>${
    own
      ? ui`<section class="panel" data-event-section="personal"><p class="eyebrow">Your plans</p><h2>Your RSVP & items</h2>${
          own.version
            ? ui`<ul>${event.members.map((m) => ui`<li>${escape(fullName(m))}: ${(event.partyAttendance || own.attendance)[m.id] === "yes" ? C("Attending") : (event.partyAttendance || own.attendance)[m.id] === "no" ? C("Not attending") : C("No response")}</li>`).join("")}</ul><h3>You’re bringing</h3>${
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
        ) + "</section>"
  }</div>`;
  return event.containerLayout === "single"
    ? ui`<section class="panel event-content-shell" data-event-shell>${content}</section>`
    : content;
}
const pageTrail = [];
let currentPage = null,
  pageIdentity = "",
  returningToPage = false,
  pageTransition = false;
function rememberPage() {
  const identity = JSON.stringify([
    state.session?.role,
    state.session?.user,
    state.session?.household?.id || state.session?.household?.slug,
    state.publicHousehold?.slug,
  ]);
  if (identity !== pageIdentity) {
    pageTrail.length = 0;
    currentPage = null;
    state.settingsReturn = null;
    state.eventLayoutDraft = null;
    state.settingsEvent = null;
    state.settingsOpen = false;
    pageIdentity = identity;
  }
  if (
    !state.session ||
    pageTransition ||
    state.preview ||
    state.example ||
    ["management", "card-editor"].includes(state.view)
  )
    return;
  const page = {
    view: state.view,
    event: state.event,
    settingsOpen: !!state.settingsOpen,
    adminMode: !!state.adminMode,
    family: family.navigation(),
    scroll: scrollY,
  };
  const route = (p) =>
    JSON.stringify([
      p.view,
      p.event,
      p.settingsOpen,
      p.adminMode,
      p.view === "family" ? [p.family.selected, p.family.section] : null,
    ]);
  if (currentPage && route(currentPage) !== route(page) && !returningToPage) {
    currentPage.scroll = scrollY;
    pageTrail.push(currentPage);
    if (pageTrail.length > 50) pageTrail.shift();
  }
  currentPage = page;
}
async function returnFromSettings() {
  const target = state.settingsReturn;
  if (!target) {
    state.settingsOpen = false;
    return previousPage();
  }
  if (
    target.view === "family" &&
    !(await family.restoreNavigation(target.family))
  )
    throw new Error("The previous page is no longer available.");
  if (
    target.view === "home" &&
    target.event &&
    !state.data.events?.some((e) => (e.invitationKey || e.id) === target.event)
  )
    throw new Error("The previous page is no longer available.");
  pageTrail.splice(0, pageTrail.length, ...target.trail);
  currentPage = target.page;
  Object.assign(state, {
    view: target.view,
    event: target.event,
    adminMode: target.adminMode,
    settingsOpen: false,
    settingsReturn: null,
    actionEvent:
      state.data.events?.find((e) => e.id === target.actionEvent) || null,
  });
  returningToPage = true;
  try {
    render();
  } finally {
    returningToPage = false;
  }
  requestAnimationFrame(() => window.scrollTo(0, target.scroll || 0));
}
async function previousPage() {
  if (state.settingsOpen && state.settingsReturn) return returnFromSettings();
  const previous = pageTrail.at(-1);
  if (!previous) {
    notify(C("No previous page in this session."));
    return;
  }
  if (
    previous.view === "family" &&
    !(await family.restoreNavigation(previous.family))
  ) {
    notify(C("The previous page is no longer available."));
    return;
  }
  if (
    previous.event &&
    !state.data?.events?.some(
      (e) => (e.invitationKey || e.id) === previous.event,
    )
  ) {
    notify(C("The previous page is no longer available."));
    return;
  }
  pageTrail.pop();
  resetContactInvites();
  state.actionEvent = null;
  Object.assign(state, {
    view: previous.view,
    event: previous.event,
    settingsOpen: previous.settingsOpen,
    adminMode: previous.adminMode,
  });
  returningToPage = true;
  try {
    render();
  } finally {
    returningToPage = false;
  }
  requestAnimationFrame(() => window.scrollTo(0, previous.scroll || 0));
}
function render(target = $("#app"), example = false) {
  if (!example) rememberPage();
  const designTarget = example ? target : document.documentElement;
  const existingEditor = !example && document.querySelector("#editor");
  if (existingEditor && target.contains(existingEditor))
    document.body.append(existingEditor);
  const existingGuest =
    !example && document.querySelector("form[data-form=guest]");
  const keepGuest =
    state.editingGuest &&
    existingGuest &&
    existingGuest.dataset.guest === (state.editingGuest?.id || "new");
  if (keepGuest) existingGuest.remove();
  const activeEvent = state.data?.events?.find(
    (e) => (e.invitationKey || e.id) === state.event,
  );
  const active =
    activeEvent?.ui ||
    state.data?.ui ||
    resolveUI(state.platformUI, state.publicHousehold?.ui, {
      design: state.publicHousehold?.design,
    });
  configureCopy(active);
  applyDesign(active.design, designTarget);
  const role = state.session?.role;
  let content = "",
    event = null;
  if (state.view === "card-editor" && ["host", "admin"].includes(role))
    content = tools.cardEditorPage();
  else if (role && state.view === "management") content = "";
  else if (role && state.view === "settings") content = settingsPage();
  else if (role === "host" && state.view === "contacts")
    content = contactsPage();
  else if (!role) content = authPage(designTarget);
  else if (role === "family" || state.view === "family")
    content = example
      ? family.renderExample(state.exampleRecord)
      : family.render();
  else if (role === "admin" || (role === "host" && state.adminMode)) {
    content =
      state.view === "admin-approvals"
        ? ui`<section class="panel"><h2>Approved emails</h2><form data-form="approval">${field(H("Email address"), "email", "", "email", "required")}<p class="form-error" role="alert"></p><button>Approve host</button></form><ul class="guest-list">${state.data.approvals.map((a) => ui`<li class="row between"><span>${escape(a.email)}</span>${button("revoke", H("Remove"), `data-email="${escape(a.email)}"`, "quiet")}</li>`).join("") || M('<li class="muted">No pending approvals.</li>')}</ul></section>`
        : state.view === "admin-hosts"
          ? ui`<section class="panel"><h2>Registered hosts</h2><ul>${state.data.hosts.map((h) => ui`<li>${escape(h.email)} ${button("recover-owner", H("Recover owner sign-in"), `data-id="${h.id}"`)}${h.platformAdmin ? ui`<span>Administrator tools enabled</span>` : button("grant-platform-access", H("Make administrator"), `data-id="${h.id}"`)}${button("delete-host", H("Delete account"), `data-id="${h.id}"`, "danger")}</li>`).join("") || M("<li>No hosts yet.</li>")}</ul><p class="small muted">Host guest records and RSVPs are not included here.</p></section>` +
            tools.cleanupPanel() +
            (role === "host"
              ? ui`<section class="panel"><h2>Old administrator accounts</h2>${(state.data.legacyAdministrators || []).map((a) => ui`<p>${escape(a.email)} ${button("retire-legacy-admin", H("Remove old administrator"), `data-email="${escape(a.email)}"`, "danger")}</p>`).join("") || M("<p>No old administrator accounts remain.</p>")}</section>`
              : "")
          : ui`<section class="hero"><p class="eyebrow">Administrator</p><h1>Open the door<br>for your next host.</h1><p>Approve email addresses and manage shared invitation artwork. No emails are sent.</p></section><section class="panel"><h2>Administration</h2><p>Use the toolbar to manage approvals, hosts, templates and shared page defaults.</p></section>`;
  } else {
    event = state.data.events.find(
      (e) => (e.invitationKey || e.id) === state.event,
    );
    state.activeUI =
      event?.ui ||
      state.data.ui ||
      resolveUI(
        state.platformUI,
        { design: state.data.household.design },
        { design: event?.design },
      );
    applyDesign(state.activeUI.design, designTarget);
    if (event) content = eventPage(event);
    else {
      state.event = null;
      content =
        (role === "host"
          ? topbar({
              title: "",
              plus: [{ action: "new-event", label: "Create Event" }],
              extra: state.session.platformAdmin
                ? ui`<div class="admin-home-actions" role="toolbar" aria-label="Administrator tools">${button("admin-approvals", H("Approvals"))}${button("admin-hosts", H("Hosts"))}${button("global-defaults", H("Defaults"))}${button("admin-templates", H("Templates"))}</div>`
                : "",
              sort: [
                ...(state.session.platformAdmin
                  ? [
                      {
                        action: "preview-guest",
                        label: "Preview guest experience",
                      },
                    ]
                  : []),
              ],
            })
          : "") +
        ui`<section class="hero"><p class="eyebrow">${role === "host" ? C("Your gathering place") : H("Welcome,") + " " + escape(state.data.guest.first)}</p><h1>${escape(state.data.household.name)}</h1>${role === "guest" ? M('<p class="muted">Your invitations, all in one place.</p>') : ""}</section>${role === "guest" ? button("guest-link-requests", H("Review shared guest links")) : ""}${state.data.events.length ? ui`<section class="grid home-events ${state.data.events.length > 1 ? "multiple-events" : "single-event"}" aria-label="Events">${(role === "guest" ? orderedInvitations(state.data.events) : state.data.events).map(eventCard).join("")}</section>` : ui`<section class="panel empty"><div class="sprig" aria-hidden="true">❧</div><h2>${role === "host" ? C("Your next memory starts here.") : C("Nothing on the calendar yet.")}</h2><p class="muted">${role === "host" ? C("Choose Create event to plan your first gathering.") : C("Your host will add your invitations here.")}</p></section>`}`;
    }
  }
  target.innerHTML = ui`<header class="top-shell no-print ${event ? "event-toolbar" : ""}"><div class="top-primary"><a class="brand" href="/" data-action="home">gather<span>＊</span></a>${event ? eventSummary(event) : ""}<div id="top-navigation">${topActions(event)}</div></div><div id="appearance-toolbar"></div></header><main id="main">${content}${role && state.view !== "card-editor" ? '<p id="sync-status" class="connection" role="status" aria-live="polite"></p>' : ""}</main>${role || state.preview ? toolbar(event) : ""}`;
  if (keepGuest)
    target
      .querySelector(
        `[data-contact-editor="${state.editingGuest?.id || "new"}"]`,
      )
      ?.append(existingGuest);
  const embeddedTop = target.querySelector("#main .app-topbar");
  if (embeddedTop)
    target.querySelector("#top-navigation").replaceChildren(embeddedTop);
  if (role && !state.preview) {
    const footer = target.querySelector(":scope > .toolbar");
    if (footer) {
      for (const control of target.querySelectorAll(
        '#top-navigation .browse-menu:has(summary[aria-label="' +
          H("Create") +
          '"]), #top-navigation .nav-control[data-icon="search"], #top-navigation .nav-control[data-icon="plus"]',
      )) {
        if (control.matches(".browse-menu")) {
          control.classList.add("toolbar-create");
          control
            .querySelector("summary")
            .insertAdjacentHTML("beforeend", ui`<span>${C("Create")}</span>`);
        }
        footer.append(control);
      }
      const sortItems = [
        ...target.querySelectorAll(
          '#top-navigation [data-action^="family-sort-"]',
        ),
      ];
      if (sortItems.length) {
        footer.insertAdjacentHTML(
          "beforeend",
          menu(
            "Sort",
            "sort",
            sortItems.map((el) => ({
              action: el.dataset.action,
              label: el.textContent,
              checked: el.getAttribute("aria-checked") === "true",
            })),
          ),
        );
        const sortingMenu = footer.lastElementChild;
        sortingMenu.classList.add("toolbar-create");
        sortingMenu
          .querySelector("summary")
          .insertAdjacentHTML("beforeend", ui`<span>${C("Sort")}</span>`);
        sortItems.forEach((el) => el.remove());
      }
      const tasks = target.querySelector(
        '#top-navigation [data-action="family-mine"]',
      );
      if (tasks) {
        footer.insertAdjacentHTML(
          "beforeend",
          tool("family-mine", "My Tasks", "", "task"),
        );
        tasks.remove();
      }
      for (const control of target.querySelectorAll(
        ".contacts-invite-tools > .row button",
      )) {
        const labels = {
          "contacts-select": ["Select Contacts", "contacts"],
          "contacts-invite": ["Invite", "invite"],
          "contacts-uninvite": ["Uninvite", "uninvite"],
          "contacts-anylist-sync": [
            state.data.integrations?.anylistStatus?.state === "running"
              ? "Syncing…"
              : "Sync",
            "sync",
          ],
          "contacts-select-event": ["Select Event", "rsvp"],
          "contacts-invite-cancel": ["Cancel", "back"],
        };
        const [label, symbol] = labels[control.dataset.action] || [
          control.textContent,
          "contacts",
        ];
        control.setAttribute("aria-label", control.textContent.trim());
        control.classList.add("nav-control");
        control.innerHTML = ui`${icon(symbol)}<span>${C(label)}</span>`;
        footer.append(control);
      }
      for (const details of target.querySelectorAll(
        "#top-navigation .browse-menu",
      ))
        if (!details.querySelector('[role="menu"]')?.children.length)
          details.remove();
      if (role === "host")
        footer.insertAdjacentHTML(
          "beforeend",
          tool("share-details", "Share Link", "", "share"),
        );
      footer.insertAdjacentHTML(
        "beforeend",
        tool("settings", "Settings", "", "settings"),
      );
    }
  }
  const layoutEvent = settingsAppearanceEvent();
  if (layoutEvent)
    for (const preview of target.querySelectorAll(
      ".layout-information-preview",
    ))
      applyDesign(layoutEvent.ui.design, preview);
  if (!example) {
    if (state.view === "management" && existingEditor)
      target.querySelector("#main").append(existingEditor);
    measureChrome();
    if (appearance.active()) appearance.chrome();
  }
  if (!example)
    document.body.classList.toggle(
      "card-editor-active",
      state.view === "card-editor",
    );
  if (state.view === "card-editor") {
    tools.mountCardEditor();
    return;
  }
  if (
    role !== "family" &&
    ![
      "family",
      "contacts",
      "management",
      "settings",
      "admin-hosts",
      "admin-approvals",
    ].includes(state.view)
  )
    applyLayoutDOM(event, role, target);
}
function modal(title, content, form = "", save = C("Save")) {
  const dialog = $("#editor");
  const inline =
    ((state.session?.role === "admin" || state.adminMode) &&
      form !== "delete-host") ||
    state.settingsOpen;
  if (inline) state.managementKind = state.nextManagementKind || form;
  state.nextManagementKind = null;
  if (inline && state.view !== "management") {
    state.managementReturn = state.view;
    state.view = "management";
    render();
  }
  dialog.classList.toggle("inline-management", !!inline);
  dialog.setAttribute("role", inline ? "region" : "dialog");
  dialog.innerHTML = ui`<div class="dialog-head"><h2 id="dialog-title">${escape(title)}</h2>${button("close", "✕", 'aria-label="Close editor"', "quiet")}</div>${form ? ui`<form data-form="${form}">` : ""}<div class="dialog-body">${content}<p class="form-error" role="alert"></p></div>${form && form !== "ui-settings" ? ui`<div class="dialog-foot">${button("close", H("Cancel"))}<button>${save}</button></div>` : ""}${form ? "</form>" : ""}`;
  if (inline) {
    $("#main").append(dialog);
    if (!dialog.open) dialog.show();
  } else if (!dialog.open) dialog.showModal();
  measureChrome();
}
const closeModal = () => {
  const dialog = $("#editor"),
    inline = dialog.classList.contains("inline-management");
  dialog.close();
  document.body.append(dialog);
  dialog.replaceChildren();
  dialog.classList.remove("inline-management");
  state.actionEvent = null;
  if (inline) {
    state.view = state.managementReturn || "home";
    if (state.session?.role === "host" && state.view === "home")
      state.adminMode = false;
    state.managementReturn = null;
    render();
  }
  measureChrome();
};
const selectedEvent = () =>
  (state.settingsOpen && settingsAppearanceEvent()) ||
  state.actionEvent ||
  state.data.events?.find((e) => (e.invitationKey || e.id) === state.event);
function householdDetailsFields() {
  const household = state.data.household;
  return ui`${field(H("Family household name"), "householdName", household.name, "text", 'required maxlength="100"')}<p class="small muted">Display-name edits preserve the household address and existing links.</p>${household.logo ? ui`<img class="family-logo-preview" src="${escape(household.logo)}" alt="Current family logo">` : ""}${field(H("Family logo / icon"), "familyLogo", "", "file", 'accept="image/png,image/jpeg,image/webp"')}<p>You can ask Kassandra to create a family logo for you. This appears when guests choose an event; event artwork is separate.</p><label class="check"><input type="checkbox" name="removeLogo">Remove family logo</label>${field(H("Household IANA timezone"), "householdTimezone", household.timezone || "UTC")}`;
}
function householdDetails() {
  modal(C("Details"), householdDetailsFields(), "household");
}
function inlineHouseholdDetails() {
  if (state.session.role !== "host") return "";
  const event = settingsAppearanceEvent();
  if (state.settingsEvent && !event) return "";
  if (event) {
    state.editingEvent = event;
    return ui`<section class="settings-details"><h2>Event Details</h2><form class="inline-event-details" data-form="event" data-version="${event.version}" data-event="${event.id}">${eventDetailsFields(event)}<p class="form-error" role="alert"></p><button>${C("Save event")}</button></form></section>`;
  }
  return ui`<section class="settings-details"><h2>Details</h2><form class="inline-household-details" data-form="household" data-version="${state.data.household.version}">${householdDetailsFields()}<p class="form-error" role="alert"></p><button>${C("Save")}</button></form></section>`;
}
let guestMatchTimer,
  guestMatchSequence = 0;
const guestMatchInput = (form) => ({
  first: form.elements.first.value,
  last: form.elements.last.value,
  suffix: form.elements.suffix.value,
  address: form.elements.address.value,
  addressLines: form.elements.addressLines?.value,
  existingId: state.editingGuest?.id,
});
async function findGuestMatches(form, force = false) {
  clearTimeout(guestMatchTimer);
  const input = guestMatchInput(form),
    fingerprint = JSON.stringify(input),
    box = form.querySelector("#guest-matches");
  if (!force && form.dataset.matchFingerprint === fingerprint)
    return form.dataset.matchReviewed === "true";
  const sequence = ++guestMatchSequence;
  form.dataset.matchReviewed = "false";
  form.dataset.matchTicket = "";
  const matches = await api("/api/host/guest-matches", {
    method: "POST",
    data: input,
  });
  if (
    !form.isConnected ||
    sequence !== guestMatchSequence ||
    JSON.stringify(guestMatchInput(form)) !== fingerprint
  )
    return false;
  form.dataset.matchFingerprint = fingerprint;
  form.dataset.matchReviewed = matches.length ? "false" : "true";
  box.innerHTML = ui`${matches.map((m) => ui`<p>Is this the same ${escape(m.name)} in ${escape(m.household)}’s guest book?</p>${button("guest-use-existing", H("Use Existing Guest"), `data-id="${m.ticket}"`)}`).join("") || ""}${matches.length ? button("guest-create-separate", H("Create Separate Guest")) : ""}`;
  return !matches.length;
}
function queueGuestMatches(form, delay = 600) {
  clearTimeout(guestMatchTimer);
  form.dataset.matchReviewed = "false";
  form.dataset.matchFingerprint = "";
  form.dataset.matchTicket = "";
  if (!form.elements.first.value.trim() || !form.elements.last.value.trim())
    return;
  guestMatchTimer = setTimeout(
    () =>
      findGuestMatches(form).catch((error) => {
        if (form.isConnected)
          form.querySelector("#guest-matches").innerHTML =
            ui`<p>${escape(error.message)}</p>${button("guest-create-separate", H("Create Separate Guest"))}`;
      }),
    delay,
  );
}
function guestEditor(guest = {}) {
  state.editingGuest = guest;
  const markup = ui`<div class="form-grid">${field(H("First name"), "first", guest.first, "text", 'required maxlength="80"')}${field(H("Last name"), "last", guest.last, "text", 'required maxlength="80"')}</div>${field(H("Suffix (optional)"), "suffix", guest.suffix, "text", 'maxlength="30"')}${field(H("Phone number (international)"), "phone", guest.phone || "", "tel", 'placeholder="+15551234567"')}${select(H("Adult or child"), "parent", [["", C("Adult guest")], ...state.data.guests.filter((g) => !g.parent && g.id !== guest.id).map((g) => [g.id, "Child of " + fullName(g)])], guest.parent || "")}${guestAddresses.markup(guest)}`;
  render();
  const host = document.querySelector(
    `[data-contact-editor="${guest.id || "new"}"]`,
  );
  host.innerHTML = ui`<form data-form="guest" data-guest="${guest.id || "new"}"><h3>${guest.id ? C("Edit guest") : C("Add guest")}</h3>${markup}<div class="inline-identity"></div><p class="form-error" role="alert"></p><div class="row">${button("guest-cancel", H("Cancel"))}<button>${C("Save")}</button></div></form>`;
  document
    .querySelector(".inline-identity")
    .insertAdjacentHTML(
      "beforeend",
      ui`<h3>Shared guest identity</h3><p>Guest ID belongs to the shared address and appears beside its title in Contacts.</p>${button("guest-find-matches", H("Check for a shared guest"))}<div id="guest-matches"></div>${guest.linked ? button("guest-unlink", H("Correct a mistaken shared link"), `data-id="${guest.id}"`) : ""}`,
    );
  guestAddresses.mount();
  measureChrome();
  host.querySelector("input")?.focus();
  queueGuestMatches(document.querySelector("form[data-form=guest]"), 0);
}
function contactSelectionTargets() {
  const selected = new Set(contactInviteSelection);
  if (contactInviteEventsOpen) {
    const guests = new Map(state.data.guests.map((g) => [g.id, g]));
    const children = new Map();
    for (const g of state.data.guests)
      if (g.parent) {
        if (!children.has(g.parent)) children.set(g.parent, []);
        children.get(g.parent).push(g.id);
      }
    for (const id of contactInviteSelection) {
      const guest = guests.get(id);
      if (!guest) continue;
      if (!contactUninvite && guest.parent) selected.add(guest.parent);
      if (contactUninvite && !guest.parent)
        for (const child of children.get(id) || []) selected.add(child);
    }
  }
  return selected;
}
function contactsInviteTools() {
  const disabled =
    !contactInviteSelection.size || contactInviteSaving ? "disabled" : "";
  return ui`<section class="contacts-invite-tools" aria-busy="${contactInviteSaving}" aria-label="${H("Guest invitations")}"><div class="row">${contactInviteMode ? ui`${button("contacts-invite", H("Invite"), disabled)}${button("contacts-uninvite", H("Uninvite"), disabled)}${button("contacts-invite-cancel", H("Cancel"), contactInviteSaving ? "disabled" : "")}` : button("contacts-select", H("Select Contacts"))}${contactsSyncTools()}</div>${state.data.integrations?.anylist ? ui`<p class="small" role="status" aria-live="polite" id="contacts-sync-status">${anyListStatusMessage(state.data.integrations.anylistStatus)}</p>` : ""}
    ${contactInviteMode ? ui`<p class="contacts-invite-status" role="status">${contactSelectionTargets().size} ${C("contacts selected")}. ${contactInviteEventsOpen ? (contactUninvite ? C("Selecting an adult also selects their children.") : C("Selecting a child also selects their designated adult.")) : ""}</p>` : ""}
    ${contactInviteError ? ui`<p role="alert">${escape(contactInviteError)}</p>` : ""}
    ${contactInviteEventsOpen ? ui`<div class="contacts-event-picker"><h2>Select Event</h2><p>${contactUninvite ? C("Choose an event to uninvite the selected guests. Saved RSVPs are protected. No messages are sent.") : C("Choose an event to add the selected guests. Existing invitations and responses stay saved. No messages are sent.")}</p><ul class="browse-rows">${state.data.events.map((event) => row({ title: escape(event.title), meta: escape(dateLabel(event.date)), action: "contacts-invite-event", id: event.id, symbol: "list", attributes: contactInviteSaving ? "inert" : "" })).join("") || M('<li class="browse-empty">Create an event from Home first.</li>')}</ul></div>` : ""}</section>`;
}
function anyListStatusMessage(status) {
  return (
    {
      running: C("Syncing contacts…"),
      conflict: C(
        "Contacts changed while syncing. No import was applied. Start a new sync when editing is finished.",
      ),
      expired: C("Sync expired. Check configuration and start a new sync."),
      failed: C(
        "Sync failed. Check the Events AnyList configuration before trying again.",
      ),
    }[status?.state] || ""
  );
}
function contactsSyncTools() {
  if (!state.data.integrations?.anylist) return "";
  const status = state.data.integrations.anylistStatus;
  const running = status?.state === "running";
  return ui`<section class="contacts-sync"><button type="button" data-action="contacts-anylist-sync" ${running || contactInviteMode ? "disabled" : ""} aria-busy="${running}">${running ? C("Syncing…") : C("Sync AnyList")}</button></section>`;
}
function notePencil(a) {
  return a ? tool("address-notes", "Edit private notes", a.id, "edit") : "";
}
function householdNotes(a) {
  return a
    ? ui`<div class="household-private-notes"><small>${escape(a.notes || "")}</small></div>`
    : "";
}
function contactsPage() {
  const guests = state.data.guests.filter((g) =>
    [
      fullName(g),
      g.phone,
      ...[state.data.addresses.find((a) => a.id === g.address)].flatMap((a) => [
        a?.label,
        a?.lines,
      ]),
    ]
      .join(" ")
      .toLowerCase()
      .includes(contactSearch.toLowerCase()),
  );
  const selectedContacts = contactSelectionTargets();
  const groups = new Map();
  for (const g of guests) {
    const key = g.address || "";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(g);
  }
  const label = (key) =>
    key
      ? state.data.addresses.find((a) => a.id === key)?.label ||
        String(C("Address unavailable"))
      : String(C("No shared address"));
  const entries = [...groups];
  entries.sort(
    ([a], [b]) => label(a).localeCompare(label(b)) || a.localeCompare(b),
  );
  return ui`<div class="browse-shell">${topbar({ title: C("Contacts"), back: "home", search: "contacts-search", plus: contactInviteMode ? [] : [{ action: "add-guest", label: "Add Guest" }], sort: [] })}${contactSearchOpen ? searchBox("contacts", contactSearch, escape, "Search contacts") : ""}<div class="browse-content">${contactsInviteTools()}<ul class="browse-rows">${state.editingGuest && !state.editingGuest.id ? ui`<li class="browse-row"><strong>${C("New guest")}</strong></li><li class="inline-contact" data-contact-editor="new"></li>` : ""}${
    entries
      .map(
        ([key, rows]) =>
          ui`<li class="browse-category" data-address-group="${key}"><div class="address-title-row"><div class="address-title-content"><span data-address-title>${escape(label(key))}</span>${key && rows[0]?.inviteCode ? ui`<span class="address-guest-id">${C("Guest ID")} · <code>${escape(rows[0].inviteCode)}</code></span>` : ""}</div>${notePencil(state.data.addresses.find((a) => a.id === key))}</div>${key ? ui`<small class="contact-mailing-address">${escape(state.data.addresses.find((a) => a.id === key)?.lines || "")}</small>${householdNotes(state.data.addresses.find((a) => a.id === key))}` : ""}</li>${rows
            .sort((a, b) => Number(!!a.parent) - Number(!!b.parent))
            .map(
              (g) =>
                row({
                  title: escape(fullName(g)),
                  meta: escape(
                    [
                      g.parent
                        ? "Child of " +
                          fullName(
                            state.data.guests.find((a) => a.id === g.parent),
                          )
                        : String(C("Adult guest")),
                      g.phone,
                    ]
                      .filter(Boolean)
                      .join(" · "),
                  ),
                  symbol: g.parent ? "child" : "contacts",
                  action: contactInviteMode
                    ? "contacts-toggle-invite"
                    : "edit-guest",
                  id: g.id,
                  attributes:
                    `data-contact-kind="${g.parent ? "child" : "adult"}" ` + "",
                  controls: contactInviteMode
                    ? ui`<label class="check"><input type="checkbox" data-contact-invite="${g.id}" aria-label="${H("Select")} ${escape(fullName(g))}" ${selectedContacts.has(g.id) ? "checked" : ""} ${contactInviteSaving ? "disabled" : ""}></label>`
                    : tool("edit-guest", "Edit contact", g.id, "edit") +
                      menu("Contact actions", "more", [
                        { action: "delete-guest", label: "Remove", id: g.id },
                      ]),
                }) +
                (state.editingGuest?.id === g.id
                  ? ui`<li class="inline-contact" data-contact-editor="${g.id}"></li>`
                  : ""),
            )
            .join("")}`,
      )
      .join("") ||
    ui`<li class="browse-empty">${C("No matching contacts. Use the plus menu to add someone.")}</li>`
  }</ul></div></div>`;
}
function toggleContactInvite(
  key,
  checked = !contactSelectionTargets().has(key),
) {
  if (contactInviteSaving) return;
  const checkboxFocus = document.activeElement?.matches(
    "[data-contact-invite]",
  );
  const guest = state.data.guests.find((g) => g.id === key);
  if (!guest) return;
  if (checked) {
    contactInviteSelection.add(key);
  } else {
    contactInviteSelection.delete(key);
    if (contactInviteEventsOpen && contactUninvite) {
      if (guest.parent) contactInviteSelection.delete(guest.parent);
    } else if (contactInviteEventsOpen)
      for (const child of state.data.guests.filter((g) => g.parent === key))
        contactInviteSelection.delete(child.id);
  }
  contactInviteError = "";
  if (!contactInviteSelection.size) contactInviteEventsOpen = false;
  render();
  const selector = checkboxFocus
    ? `[data-contact-invite="${CSS.escape(key)}"]`
    : `[data-action="contacts-toggle-invite"][data-id="${CSS.escape(key)}"]`;
  document.querySelector(selector)?.focus({ preventScroll: true });
}
function guestList() {
  state.view = "contacts";
  state.event = null;
  state.actionEvent = null;
  render();
}
function addresses() {
  guestList();
}
async function moveContact(key, direction, target) {
  const g = state.data.guests.find((g) => g.id === key);
  if (!g) return;
  if (target) {
    const destination = state.data.guests.find((row) => row.id === target);
    if (
      !destination ||
      (destination.address || "") !== (g.address || "") ||
      !!destination.parent !== !!g.parent
    )
      return;
  }
  const rows = ordered(
      state.data.guests.filter(
        (candidate) =>
          candidate.id !== key &&
          !!candidate.parent === !!g.parent &&
          (candidate.address || "") === (g.address || ""),
      ),
      "manual",
    ),
    all = ordered([...rows, g], "manual"),
    index = target
      ? rows.findIndex((g) => g.id === target)
      : all.findIndex((g) => g.id === key) + (direction > 0 ? 1 : -1),
    at = Math.max(0, Math.min(rows.length, index)),
    before = rows[at - 1]?.position,
    after = rows[at]?.position;
  const position =
    before === undefined
      ? (after ?? Date.now()) - 1024
      : after === undefined
        ? before + 1024
        : (before + after) / 2;
  await api("/api/host/guests/" + g.id, {
    method: "PUT",
    version: g.version,
    data: { ...g, position },
  });
  await load();
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
function readMenuRows(form) {
  return [...form.querySelectorAll(".menu-row")].map((row) => ({
    id: row.dataset.menuId,
    name: row.querySelector("[name=menuName]").value,
    kind: row.querySelector("[name=menuKind]").value,
    quantity: Number(row.querySelector("[name=menuQuantity]").value),
  }));
}
function registryRow(registry = {}) {
  return ui`<div class="registry-row" data-registry-id="${registry.id || crypto.randomUUID()}">${field(H("Registry title"), "registryTitle", registry.title || "", "text", 'required maxlength="100" placeholder="Wedding Registry"')}${field(H("Registry URL"), "registryUrl", registry.url || "", "url", 'required maxlength="2048" placeholder="https://…"')}<div class="row">${button("registry-up", H("↑ Move up"), 'aria-label="Move registry up"', "quiet")}${button("registry-down", H("↓ Move down"), 'aria-label="Move registry down"', "quiet")}${button("remove-registry", H("Remove registry"), "", "quiet")}</div></div>`;
}
function eventDetailsFields(e, existing = true) {
  return ui`${field(H("Event title"), "title", e.title, "text", 'required maxlength="160" placeholder="Sunday around the table"')}${area(H("Description"), "description", e.description, 'maxlength="5000"')}<div class="form-grid">${field(H("Date"), "date", e.date, "date")}${field(H("Time · numbers or words"), "time", e.time, "text", 'maxlength="100" placeholder="Two O’Clock in the Afternoon"')}${field(H("RSVP deadline"), "deadline", e.deadline, "date")}</div>${area(H("Event address"), "eventAddress", e.address, 'maxlength="500"')}${field(H("Photo / video upload link (optional)"), "uploadURL", e.uploadURL || "", "url", 'maxlength="2048" placeholder="https://…"')}<p class="small muted">Use Dropbox File Requests, Google Drive, OneDrive, or another sharing service. Configure upload permissions at that destination. Clear the link to remove the guest upload button.</p>${field(H("Event artwork / image"), "iconUpload", "", "file", 'accept="image/png,image/jpeg,image/webp"')}<label class="check"><input type="checkbox" name="removeIcon">Remove current image</label>${select(H("Invitation template"), "template", [["", C("Simple invitation")], ...state.templates.map((t) => [t.id, t.name])], e.template || "")}<fieldset><legend>Gift registries · optional</legend><p class="small muted">Guest buttons appear directly below RSVP, in this order.</p><div id="registry-rows">${(e.registries || []).map(registryRow).join("")}</div>${button("add-registry", H("＋ Add registry"))}</fieldset><fieldset><legend>Potluck & drinks</legend><label class="check"><input type="checkbox" name="customItemsEnabled" ${e.customItemsEnabled ? "checked" : ""}>Allow guests to enter custom menu items</label><label class="check"><input type="checkbox" name="saveCustomItems" ${e.saveCustomItems ? "checked" : ""}>Save custom items to future menus</label><div class="row">${select(H("Copy menu from"), "copyMenu", [["", C("Choose a past event")], ...state.data.events.filter((p) => p.id !== e.id).map((p) => [p.id, p.title])], "")}${button("copy-menu", H("Copy items"))}</div><fieldset><legend>Table templates</legend>${select(H("Table template"), "tableTemplate", [["", C("New table template")], ...(state.data.tableTemplates || []).map((t) => [t.id, t.name])], "")}${field(H("Table template name"), "tableTemplateName", "", "text", 'maxlength="160"')}<div class="row">${button("table-template-apply", H("Apply Table Template"))}${button("table-template-save", H("Save Table Template"))}${button("table-template-delete", H("Delete Table Template"))}</div><p class="small">Applying a template adds items to this draft. Save the event to keep them. Existing menu items and guest claims stay unchanged.</p></fieldset><div id="menu-rows">${e.menu.map(menuRow).join("")}</div>${button("add-menu", H("＋ Add item"))}</fieldset><fieldset><legend>Who’s invited?</legend><p class="small muted">Choose each person. Children need their designated adult invited too.</p>${state.data.guests.map((g) => ui`<label class="check ${g.parent ? "child" : ""}"><input type="checkbox" name="invited" value="${g.id}" ${e.invited.includes(g.id) ? "checked" : ""}>${escape(fullName(g))}${g.parent ? C(" (child)") : ""}</label>`).join("") || M("<p>Add guests from Home → Contacts before inviting them.</p>")}</fieldset>${existing ? ui`<hr>${button("delete-event", H("Delete event"), "", "danger")}` : ""}`;
}
function eventEditor(existing, focus = "") {
  state.editingEvent = existing || {
    design: {},
    invited: [],
    menu: (state.data.savedMenu || []).map((item) => ({
      ...item,
      id: crypto.randomUUID(),
    })),
    registries: [],
  };
  const e = state.editingEvent;
  modal(
    existing ? C("Edit event") : C("A new reason to gather"),
    eventDetailsFields(e, !!existing),
    "event",
    existing ? C("Save event") : C("Create event"),
  );
  const input =
    focus === "table"
      ? document.querySelector("#menu-rows")?.closest("fieldset")
      : document.querySelector(`form[data-form=event] [name="${focus}"]`);
  if (input) {
    input.scrollIntoView({ block: "center" });
    input.focus({ preventScroll: true });
  }
}
function rsvp(event = selectedEvent(), manual = false) {
  state.manualRSVP = manual ? event : null;
  if (
    !manual &&
    event.deadline &&
    event.deadline < new Date().toISOString().slice(0, 10)
  ) {
    notify(C("The RSVP deadline has passed. Responses are closed."));
    return;
  }
  state.editingResponse = structuredClone(event.response);
  modal(
    C(manual ? "Record guest RSVP" : "Will you join us?"),
    ui`<p>${escape(event.title)}</p>${manual ? "" : M('<p class="small">An RSVP confirmation may be texted to the phone number your host has on file. Reply STOP to opt out.</p>')}${event.deadline && !manual ? ui`<p class="muted small">RSVP by ${escape(dateLabel(event.deadline))}. Responses close after this date.</p>` : ""}<fieldset><legend>Your invited party</legend>${event.members
      .map((m) =>
        select(
          escape(fullName(m)) + (m.parent ? C(" · child") : ""),
          "attendance:" + m.id,
          [
            ["", C("Skip · keep existing response")],
            ["yes", C("Attending")],
            ["no", C("Not attending")],
          ],
          (event.partyAttendance || event.response.attendance)[m.id] || "",
          "",
        ),
      )
      .join("")}</fieldset><fieldset><legend>Something to bring</legend>${
      event.menu
        .map((item) => {
          const mine = event.response.claims[item.id] || 0;
          return ui`<div class="menu-item"><label class="grow">${escape(item.name)}<small>${item.kind === "drink" ? C("Drinks") : C("Potluck")} · ${Math.max(0, item.quantity - item.claimed)} remaining</small></label>${field(M('<span class="sr-only">Quantity for ') + escape(item.name) + "</span>", "claim:" + item.id, mine, "number", `min="0" max="${Math.max(mine, item.quantity - item.claimed + mine)}" required`)}</div>`;
        })
        .join("") || M("<p>No menu items yet.</p>")
    }</fieldset>${event.customItemsEnabled ? area(H("Custom items · one per line"), "customItems", (event.response.customItems || []).map((i) => i.name).join("\n"), 'maxlength="5000"') : ""}`,
    "rsvp",
    "RSVP",
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
                  ui`<li>${escape(fullName(g))} ${button("manual-rsvp", H("Record RSVP"), `data-id="${g.id}"`)}${g.parent ? " · child of " + escape(fullName(d.guests.find((a) => a.id === g.parent))) : C(" · adult")}</li>`,
              )
              .join("") || M("<li>None yet</li>")
          }</ul></details>`,
      )
      .join(
        "",
      )}<h3>Potluck & drinks</h3>${d.menu.map((item) => ui`<div class="menu-item"><strong>${escape(item.name)}</strong><span>${item.claimed} / ${item.quantity} · ${Math.max(0, item.quantity - item.claimed)} remaining</span></div>`).join("")}<h3>Custom menu items</h3><ul>${d.responses.flatMap((r) => (r.customItems || []).map((i) => ui`<li>${escape(fullName(d.guests.find((g) => g.id === r.guest)))}: ${escape(i.name)} × ${i.quantity}</li>`)).join("") || "<li>No custom items.</li>"}</ul><h3>Who’s bringing what</h3><ul>${
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
    }</ul><h3>Private household notes</h3>${(d.addresses || []).map((a) => ui`<section><div class="address-title-row"><strong>${escape(a.label)}</strong>${notePencil(a)}</div>${householdNotes(a)}</section>`).join("")}${button("refresh-dashboard", H("Refresh totals"))}`,
  );
}
async function copyHouseholdLink() {
  const link = householdShareUrl();
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(link);
      notify(C("Link copied."));
      return;
    }
  } catch {}
  const input = document.createElement("textarea");
  input.value = link;
  input.setAttribute("aria-label", String(C("Household link")));
  input.style.position = "fixed";
  document.body.append(input);
  input.select();
  const copied = document.execCommand("copy");
  input.remove();
  if (copied) notify(C("Link copied."));
  else {
    await share();
    notify(C("Select the household link to copy it."));
  }
}
async function share() {
  const link = householdShareUrl();
  modal(
    C("One link for every gathering"),
    ui`<p>${escape(state.data.household.name)}</p><img class="qr" src="/api/host/qr" alt="Household sign-in QR code"><p class="share-link">${escape(link)}</p><div class="row">${button("copy-link", H("Copy link"))}${button("native-share", H("Share link"))}<a class="button secondary" href="/api/host/qr" download="household-qr.svg">Download QR</a><a class="button secondary" href="${escape(link)}" target="_blank" rel="noopener">Open guest page</a></div><p class="small muted">Your link stays the same when you add events or change your design. A new web address is used after activation. Existing /h/ links always keep working. Guests sign in with their names and address invite code.</p>`,
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
  const editor = $("#editor"),
    contents = editor.firstElementChild,
    wasOpen = editor.open;
  await load();
  // An unrelated inline save must not close an editor opened while it refreshed.
  if (wasOpen && editor.firstElementChild === contents) closeModal();
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
  if (kind === "guest-code-claim") {
    await api(
      `/api/public/households/${state.publicHousehold.slug}/claim-code`,
      { method: "POST", data: value },
    );
    closeModal();
    notify(
      C(
        "Your invitations are linked. Sign in using your current address code.",
      ),
    );
    return;
  }
  if (kind === "family-login") {
    await api(
      `/api/public/households/${state.publicHousehold.slug}/members/login`,
      { method: "POST", data: value },
    );
    state.view = "family";
    await load();
    return;
  }
  if (kind === "recover-owner") {
    await api("/api/admin/hosts/" + state.recoveryHost + "/recover", {
      method: "POST",
      data: value,
    });
    await saved("Owner password reset. Share the new password privately.");
    return;
  }
  if (await family.submit(form, kind)) return;
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
  if (kind === "grant-platform-access") {
    await api("/api/admin/platform-access/" + state.promotingHost.id, {
      method: "POST",
      data: value,
    });
    await saved(
      C(
        "Administrator tools enabled. Sign in to that host account again before removing the old administrator.",
      ),
    );
    return;
  }
  if (kind === "retire-legacy-admin") {
    if (value.confirmEmail !== state.retiringAdmin)
      throw new Error(C("Confirm the old administrator email."));
    if (
      !confirm(String(C("Permanently remove this old administrator sign-in?")))
    )
      return;
    await api("/api/admin/retire-legacy", { method: "POST", data: value });
    await saved(C("Old administrator removed. Setup remains closed."));
    return;
  }
  if (kind === "admin-password") {
    await api("/api/admin/password", { method: "PUT", data: value });
    await saved(C("Password changed. Sign in again."));
    return;
  }
  if (kind === "household") {
    await api("/api/host/household", {
      method: "PUT",
      version: Number(form.dataset.version ?? state.data.household.version),
      data: {
        name: value.householdName,
        logo: data.has("removeLogo")
          ? ""
          : (await fileData(form.elements.familyLogo)) ||
            state.data.household.logo ||
            "",
        timezone: value.householdTimezone,
        design: state.data.household.design,
      },
    });
    await saved("Details saved.");
    return;
  }
  if (kind === "guest") {
    const addressDraft = guestAddresses.value(form);
    if (kind === "guest" && !(await findGuestMatches(form)))
      throw new Error(
        "Choose Use Existing Guest or Create Separate Guest before saving. Existing shared links are corrected with the separate confirmation action.",
      );
    const record = kind === "guest" ? state.editingGuest : state.editingAddress,
      collection = kind === "guest" ? "guests" : "addresses";
    await api("/api/host/" + collection + (record.id ? "/" + record.id : ""), {
      method: record.id ? "PUT" : "POST",
      version: record.id ? record.version : undefined,
      data:
        kind === "guest"
          ? {
              ...value,
              addressDraft,
              matchTicket: form.dataset.matchTicket || undefined,
            }
          : value,
    });
    state.editingGuest = null;
    await saved(C("Guest saved."));
    return;
  }
  if (kind === "event") {
    const e = form.classList.contains("inline-event-details")
        ? state.data.events.find((e) => e.id === form.dataset.event)
        : state.editingEvent,
      menu = readMenuRows(form);
    const icon = await fileData(form.elements.iconUpload);
    const result = await api("/api/host/events" + (e.id ? "/" + e.id : ""), {
      method: e.id ? "PUT" : "POST",
      version: e.id ? Number(form.dataset.version ?? e.version) : undefined,
      data: {
        title: value.title,
        description: value.description,
        date: value.date,
        time: value.time,
        address: value.eventAddress,
        deadline: value.deadline,
        icon: data.has("removeIcon") ? "" : icon || e.icon || "",
        template: value.template,
        customItemsEnabled: data.has("customItemsEnabled"),
        saveCustomItems: data.has("saveCustomItems"),
        uploadURL: value.uploadURL,
        registries: [...form.querySelectorAll(".registry-row")].map((row) => ({
          id: row.dataset.registryId,
          title: row.querySelector("[name=registryTitle]").value,
          url: row.querySelector("[name=registryUrl]").value,
        })),
        design: e.design || {},
        invited: data.getAll("invited"),
        menu,
      },
    });
    if (!form.classList.contains("inline-event-details"))
      state.event = result.id;
    await saved("Event saved.");
    return;
  }
  if (kind === "address-notes") {
    const a = state.editingAddressNotes;
    await api(`/api/host/addresses/${a.id}`, {
      method: "PUT",
      version: a.version,
      data: { notes: value.notes },
    });
    await saved("Household notes saved.");
    return;
  }
  if (kind === "rsvp") {
    const e = state.manualRSVP || selectedEvent(),
      attendance = {},
      claims = {};
    for (const [key, val] of data) {
      if (key.startsWith("attendance:")) attendance[key.slice(11)] = val;
      if (key.startsWith("claim:")) claims[key.slice(6)] = Number(val);
    }
    await api(
      state.manualRSVP
        ? `/api/host/events/${e.id}/rsvp/${state.manualRSVPGuest}`
        : `/api/guest/events/${e.id}/rsvp`,
      {
        method: "PUT",
        data: {
          version: state.editingResponse.version,
          guestEntry: e.guestEntry,
          partyVersions: e.partyVersions,
          attendance,
          claims,
          customItems: value.customItems
            ? value.customItems
                .split("\n")
                .map((name) => name.trim())
                .filter(Boolean)
                .map((name) => ({
                  name,
                  quantity:
                    e.response.customItems?.find((item) => item.name === name)
                      ?.quantity || 1,
                }))
            : [],
        },
      },
    );
    await saved("Your RSVP is saved. Thank you!");
  }
}
document.addEventListener("submit", async (event) => {
  const form = event.target.closest("form[data-form]");
  if (!form) return;
  event.preventDefault();
  if (!leaveEventLayout(form)) return;
  if (form.dataset.saving === "true") return;
  form.dataset.saving = "true";
  pendingActions++;
  loadGeneration++;
  const error = form.querySelector(".form-error"),
    buttons = [...form.querySelectorAll("button")];
  error.textContent = "";
  buttons.forEach((b) => (b.disabled = true));
  try {
    await submit(form);
  } catch (problem) {
    if (form.dataset.form.startsWith("family-"))
      family.saving("Save failed · " + problem.message);
    error.textContent =
      problem.message +
      (problem.status === 409 && form.dataset.form !== "register"
        ? C(" Close this editor and refresh before trying again.")
        : "");
    if (problem.status === 409 && form.dataset.form === "register")
      void checkAddress(form);
    error.scrollIntoView({ block: "nearest", behavior: "smooth" });
  } finally {
    pendingActions--;
    delete form.dataset.saving;
    buttons.forEach((b) => (b.disabled = false));
  }
});
document.addEventListener("click", (event) => {
  if (
    state.session?.role === "host" &&
    appearance.active() &&
    event.target.closest("[data-event-edit=uploadURL]")
  )
    event.preventDefault();
});
document.addEventListener("dblclick", async (event) => {
  if (state.preview || state.example || state.session?.role !== "host") return;
  const target = event.target.closest("#main [data-event-edit]");
  if (!target || !selectedEvent()) return;
  event.preventDefault();
  if (appearance.active() && !(await appearance.leave())) return;
  eventEditor(selectedEvent(), target.dataset.eventEdit);
});
document.addEventListener("input", (event) => {
  const form = event.target.closest("form[data-form=guest]");
  if (
    form &&
    ["first", "last", "suffix", "address", "parent"].includes(event.target.name)
  )
    queueGuestMatches(form);
});
let recognitionTimer,
  recognitionRequest = 0;
document.addEventListener("input", (event) => {
  const form = event.target.closest("form[data-form=guest-login]");
  if (!form) return;
  clearTimeout(recognitionTimer);
  const request = ++recognitionRequest;
  const fd = new FormData(form);
  if (!fd.get("inviteCode") || !fd.get("first") || !fd.get("last")) {
    form.querySelector("#guest-suffix").hidden = true;
    return;
  }
  recognitionTimer = setTimeout(async () => {
    try {
      const result = await api(
        `/api/public/households/${state.publicHousehold.slug}/recognize`,
        { method: "POST", data: Object.fromEntries(fd) },
      );
      if (request === recognitionRequest && form.isConnected) {
        form.querySelector("#guest-suffix").hidden = !result.suffixRequired;
        if (!result.suffixRequired) form.elements.suffix.value = "";
      }
    } catch {}
  }, 400);
});
document.addEventListener("input", (event) => {
  void appearance.input(event);
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
});
document.addEventListener("click", async (event) => {
  const target = event.target.closest("[data-action]");
  if (!target) return;
  event.preventDefault();
  if (target.dataset.actionPending === "true") return;
  const action = target.dataset.action,
    key = target.dataset.id;
  target.dataset.actionPending = "true";
  target.setAttribute("aria-busy", "true");
  const inlineDraft = target.closest(".inline-event-details");
  if (inlineDraft) inlineDraft.dataset.dirty = "true";
  pendingActions++;
  loadGeneration++;
  target.closest('[role="menu"]')?.closest("details")?.removeAttribute("open");
  try {
    if (!leaveEventLayout(target)) return;
    if (await appearance.action(action, target)) return;
    if (
      appearance.active() &&
      !["print", "visual-up", "visual-down"].includes(action) &&
      !(await appearance.leave())
    )
      return;

    const detailsForm = document.querySelector(
      ":is(.inline-household-details,.inline-event-details)[data-dirty=true]",
    );
    if (
      detailsForm &&
      !target.closest(".inline-household-details,.inline-event-details")
    ) {
      if (!confirm(String(C("Discard unsaved details changes?")))) return;
      detailsForm.dataset.dirty = "false";
    }
    if (
      [
        "home",
        "family-workspace",
        "addresses",
        "open-event",
        "admin-approvals",
        "admin-hosts",
      ].includes(action)
    )
      state.settingsOpen = false;
    const guestForm = document.querySelector("form[data-form=guest]");
    if (guestForm && !target.closest("form[data-form=guest]")) {
      if (action === "edit-guest" && key === state.editingGuest?.id) {
        guestForm.querySelector("input")?.focus();
        return;
      }
      if (!confirm(String(C("Discard unsaved guest changes?")))) return;
      state.editingGuest = null;
    }
    if (action === "guest-cancel") {
      state.editingGuest = null;
      render();
      return;
    }
    if (action === "page-back") {
      if (state.preview || state.example) return;
      await previousPage();
      return;
    }
    if (action === "settings") {
      if (document.querySelector("#editor[open]")) closeModal();
      if (!state.settingsOpen || !state.settingsReturn) {
        state.settingsEvent = visibleAppearanceEvent()?.id || null;
        state.settingsReturn = structuredClone({
          view: state.view,
          event: state.event,
          adminMode: !!state.adminMode,
          family: family.navigation(),
          trail: pageTrail,
          page: currentPage,
          scroll: scrollY,
          actionEvent: state.actionEvent?.id || null,
        });
      }
      state.adminMode = false;
      resetContactInvites();
      state.settingsOpen = true;
      if (["host", "family"].includes(state.session.role)) {
        pageTransition = true;
        try {
          await family.action("family-settings", target);
          state.settingsOpen = true;
        } finally {
          pageTransition = false;
        }
        render();
      } else {
        state.event = null;
        state.view = "settings";
        render();
      }
      return;
    }
    if (
      [
        "admin-approvals",
        "admin-hosts",
        "global-defaults",
        "admin-templates",
      ].includes(action) &&
      state.session.role === "host"
    ) {
      if (!state.session.platformAdmin) return;
      state.adminMode = true;
    }
    if (
      [
        "home",
        "settings",
        "addresses",
        "family-workspace",
        "household",
        "open-event",
        "edit-event",
      ].includes(action)
    )
      state.adminMode = false;
    if (action === "admin-templates") {
      await tools.action("cards", target);
      return;
    }
    if (action === "grant-platform-access") {
      const host = state.data.hosts.find((h) => h.id === key);
      state.promotingHost = host;
      modal(
        C("Make host administrator"),
        ui`<p>The host keeps their household, events and normal pages. Administrator tools are added to their Home toolbar.</p>${field(H("Confirm host email"), "confirmEmail", "", "email", "required")}${field(H("Your administrator password"), "password", "", "password", "required")}`,
        "grant-platform-access",
      );
      return;
    }
    if (action === "retire-legacy-admin") {
      state.retiringAdmin = target.dataset.email;
      modal(
        C("Remove old administrator"),
        ui`<p>Continue only after signing in to the promoted host and checking administrator tools. This removes the old sign-in and revokes its sessions. Household data is preserved.</p>${field(H("Confirm old administrator email"), "confirmEmail", "", "email", "required")}${field(H("Your current host password"), "password", "", "password", "required")}`,
        "retire-legacy-admin",
        C("Remove old administrator"),
      );
      return;
    }
    if (action === "admin-approvals" || action === "admin-hosts") {
      closeModal();
      state.view = action;
      render();
      return;
    }
    if (action === "household-details") {
      householdDetails();
      return;
    }
    if (action === "event-details") {
      eventEditor(selectedEvent());
      return;
    }
    if (["event-template", "event-table"].includes(action)) {
      if (state.preview || state.session.role !== "host") return;
      if (action === "event-template") await tools.invitation();
      else eventEditor(selectedEvent(), "table");
      return;
    }
    if (guestAddresses.action(action, target)) return;
    if (action.startsWith("event-action-")) {
      state.actionEvent = state.data.events.find((e) => e.id === key);
      if (!state.actionEvent) return;
      const kind = action.slice(13);
      if (kind === "dashboard") await dashboard();
      else if (kind === "invitation") await tools.invitation();
      else await tools.action(kind, target);
      return;
    }
    if (["contacts-anylist-sync", "contacts-anylist-status"].includes(action)) {
      if (
        state.preview ||
        state.session.role !== "host" ||
        !state.data.integrations?.anylist
      )
        return;
      if (state.editingGuest || contactInviteMode) {
        notify(C("Finish editing or selecting contacts before syncing."));
        return;
      }
      target.disabled = true;
      const syncHousehold = state.data.household.id;
      try {
        const result = await api("/api/host/integrations/anylist", {
          method: action === "contacts-anylist-sync" ? "POST" : "GET",
        });
        if (
          state.session?.role !== "host" ||
          state.data?.household?.id !== syncHousehold
        )
          return;
        state.data.integrations.anylistStatus = result;
        if (
          state.view === "contacts" &&
          !state.editingGuest &&
          !contactInviteMode
        ) {
          if (result.state === "complete") await load();
          else renderRefresh(true);
        }
        notify(
          result.state === "complete"
            ? C("Contacts synced.")
            : anyListStatusMessage(result),
        );
      } finally {
        target.disabled =
          state.data.integrations?.anylistStatus?.state === "running";
      }
      return;
    }
    if (
      action.startsWith("contacts-invite") ||
      [
        "contacts-uninvite",
        "contacts-select",
        "contacts-select-event",
        "contacts-toggle-invite",
      ].includes(action)
    ) {
      if (state.preview || state.session.role !== "host") {
        notify(C("This action is available only to the host."));
        return;
      }
      if (contactInviteSaving) return;
      if (action === "contacts-invite-cancel") {
        resetContactInvites();
        render();
        return;
      }
      if (action === "contacts-select") {
        resetContactInvites();
        contactInviteMode = true;
        render();
        return;
      }
      if (action === "contacts-toggle-invite") {
        toggleContactInvite(key);
        return;
      }
      if (["contacts-invite", "contacts-uninvite"].includes(action)) {
        if (!contactInviteMode || !contactInviteSelection.size) return;
        contactUninvite = action === "contacts-uninvite";
        contactInviteSaving = true;
        render();
        try {
          state.data = await api("/api/host");
          for (const id of contactInviteSelection)
            if (!state.data.guests.some((g) => g.id === id))
              contactInviteSelection.delete(id);
          contactInviteEventsOpen = true;
        } catch (error) {
          contactInviteError = error.message;
        } finally {
          contactInviteSaving = false;
          render();
        }
        return;
      }
      if (action === "contacts-invite-event") {
        const event = state.data.events.find((e) => e.id === key);
        if (!event || !contactInviteSelection.size) return;
        const uninvite = contactUninvite;
        if (
          uninvite &&
          !confirm(
            String(C("Uninvite the selected guests from")) +
              " “" +
              event.title +
              "”? " +
              String(C("Saved RSVPs are protected. No messages will be sent.")),
          )
        )
          return;
        contactInviteSaving = true;
        contactInviteError = "";
        render();
        try {
          const result = await api(
            "/api/host/events/" +
              event.id +
              (uninvite ? "/uninvite-guests" : "/invite-guests"),
            {
              method: "POST",
              version: event.version,
              data: { guestIds: [...contactSelectionTargets()] },
            },
          );
          resetContactInvites();
          await load();
          notify(
            uninvite
              ? result.removed
                ? C("Guests uninvited. No messages were sent.")
                : C("Selected guests were not invited. No messages were sent.")
              : result.added
                ? C("Guests invited. No messages were sent.")
                : C(
                    "Selected guests are already invited. No messages were sent.",
                  ),
          );
        } catch (error) {
          contactInviteError = error.message;
          // Refresh versions while retaining selection; require a fresh click and confirmation.
          try {
            state.data = await api("/api/host");
          } catch {}
        } finally {
          contactInviteSaving = false;
          if (contactInviteMode) render();
        }
        return;
      }
    }
    if (action === "contacts-search") {
      contactSearchOpen = !contactSearchOpen;
      if (!contactSearchOpen) contactSearch = "";
      render();
      document.querySelector("[data-browse-search=contacts]")?.focus();
      return;
    }
    if (action === "contacts-sort-alpha" || action === "contacts-sort-manual") {
      const current = await api("/api/family/preferences");
      await api("/api/family/preferences", {
        method: "PUT",
        version: current.version || 0,
        data: {
          ...current,
          contactSort: action.endsWith("alpha") ? "alpha" : "manual",
        },
      });
      contactPreferences = await api("/api/family/preferences");
      render();
      return;
    }
    if (action === "contacts-up" || action === "contacts-down") {
      await moveContact(key, action.endsWith("up") ? -1 : 1);
      return;
    }

    if (
      state.preview &&
      !["exit-preview", "open-event", "home", "print", "close"].includes(action)
    ) {
      notify(C("Read-only preview: no guest data will be changed."));
      return;
    }
    if (action === "guest-code-claim") {
      modal(
        C("Link another invitation"),
        ui`<p>Confirm the address codes for both invitations using your own name. Only this guest-book relationship is linked; private host records stay separate.</p>${field(H("First name"), "first", "", "text", "required")}${field(H("Last name"), "last", "", "text", "required")}${field(H("Suffix, if applicable"), "suffix")}${field(H("New invitation code"), "inviteCode", "", "password", "required")}${field(H("Other invitation’s address code"), "permanentCode", "", "password", "required")}`,
        "guest-code-claim",
      );
      return;
    }
    if (action === "recover-owner") {
      state.recoveryHost = key;
      const host = state.data.hosts.find((h) => h.id === key);
      modal(
        C("Recover household owner sign-in"),
        ui`<p>This resets the current household owner’s password and revokes their sessions. No email is sent. Share the new password privately.</p><p>${escape(host.email)}</p>${field(H("Confirm registered host email"), "confirmEmail", "", "email", "required")}${field(H("Your platform administrator password"), "adminPassword", "", "password", "required")}${field(H("New owner password"), "password", "", "password", 'required minlength="12"')}${field(H("Confirm new password"), "confirmPassword", "", "password", "required")}`,
        "recover-owner",
      );
      return;
    }
    if (action === "family-login") {
      state.view = "family-login";
      render();
      return;
    }
    if (action === "family-workspace") resetContactInvites();
    if (await family.action(action, target)) return;
    if (action === "guest-link-requests") {
      const requests = await api("/api/guest/link-requests");
      modal(
        C("Confirm shared guest links"),
        ui`<p>Approve only your own guest-book relationships. This lets your invite code show invitations from that household; it does not share private contact records.</p>${requests.map((r) => ui`<p>${escape(r.name)} · ${escape(r.household)}</p>${button("guest-link-approve", H("Approve shared identity"), `data-id="${r.id}"`)}${button("guest-link-reject", H("Not the same person"), `data-id="${r.id}"`)}`).join("") || "<p>No pending shared links.</p>"}`,
      );
      return;
    }
    if (action === "guest-link-approve" || action === "guest-link-reject") {
      await api("/api/guest/link-requests", {
        method: "POST",
        data: { id: key, approve: action === "guest-link-approve" },
      });
      await saved("Guest link reviewed.");
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
      resetContactInvites();
      closeModal();
      state.event = null;
      state.settingsOpen = false;
      state.editingGuest = null;
      family.reset();
      state.view = "home";
      render();
      await load({ background: true });
      return;
    }
    if (action === "logout") {
      resetContactInvites();
      state.editingGuest = null;
      state.settingsOpen = false;
      family.reset();
      await api("/api/logout", { method: "POST", data: {} });
      closeModal();
      state.event = null;
      state.view = "home";
      state.publicHousehold = null;
      await load();
      return;
    }
    if (action === "open-event") {
      resetContactInvites();
      state.actionEvent = null;
      state.view = "home";
      state.event = key;
      render();
      window.scrollTo(0, 0);
      return;
    }
    if (action === "new-event") {
      eventEditor();
      return;
    }
    if (action.startsWith("event-layout-")) {
      if (
        state.session.role !== "host" ||
        state.preview ||
        state.eventLayoutSaving
      )
        return;
      const event = settingsAppearanceEvent();
      if (!state.settingsOpen || !event) return;
      if (action === "event-layout-open") {
        if (!state.eventLayoutDraft) {
          const fresh = await api("/api/host");
          const current = fresh.events.find((e) => e.id === event.id);
          if (!current) throw new Error(C("The event is no longer available."));
          state.data = { ...state.data, ...fresh };
          state.eventLayoutError = "";
          state.eventLayoutDraft = {
            event: current.id,
            record: structuredClone(current),
            informationLayout: current.informationLayout || "default",
            containerLayout: current.containerLayout || "separate",
            dirty: false,
          };
        }
      } else if (action === "event-layout-select" && state.eventLayoutDraft) {
        const field = target.dataset.layoutField;
        if (
          !{
            informationLayout: ["default", "invitation"],
            containerLayout: ["separate", "single"],
          }[field]?.includes(key)
        )
          return;
        state.eventLayoutDraft[field] = key;
        state.eventLayoutDraft.dirty = true;
      } else if (action === "event-layout-cancel")
        state.eventLayoutDraft = null;
      else if (action === "event-layout-save" && state.eventLayoutDraft) {
        const draft = state.eventLayoutDraft,
          record = draft.record;
        state.eventLayoutSaving = true;
        state.eventLayoutError = "";
        render();
        try {
          await api("/api/host/events/" + record.id, {
            method: "PUT",
            version: record.version,
            data: {
              ...Object.fromEntries(
                Object.entries(record).filter(([key]) => key !== "ui"),
              ),
              informationLayout: draft.informationLayout,
              containerLayout: draft.containerLayout,
            },
          });
          state.eventLayoutDraft = null;
          await load();
          notify(C("Layout saved."));
        } catch (error) {
          state.eventLayoutError = error.message;
        } finally {
          state.eventLayoutSaving = false;
        }
      }
      render();
      return;
    }
    if (
      [
        "page-light-mode",
        "page-dark-mode",
        "page-custom-mode",
        "page-default-mode",
      ].includes(action)
    ) {
      if (state.session.role !== "host" || !state.settingsOpen) return;
      if (appearanceModeSaving) return;
      const event = settingsAppearanceEvent();
      if (state.settingsEvent && !event)
        throw new Error("The event is no longer available.");
      const scope = event ? "event" : "household";
      if (action === "page-custom-mode") {
        await returnFromSettings();
        await startAppearance(scope);
        return;
      }
      appearanceModeSaving = true;
      document
        .querySelectorAll(".page-appearance-settings button")
        .forEach((b) => (b.disabled = true));
      try {
        if (action === "page-default-mode") {
          if (!event) return;
          await persistPageAppearance("event", event, {}, "inherit");
        } else {
          if (event) return;
          const mode = action === "page-dark-mode" ? "dark" : "light";
          await persistPageAppearance(
            "household",
            state.data.household,
            appearancePreset(mode, state.data.defaults),
            mode,
          );
        }
        await load();
        await returnFromSettings();
      } finally {
        appearanceModeSaving = false;
        document
          .querySelectorAll(".page-appearance-settings button")
          .forEach((b) => (b.disabled = false));
      }
      return;
    }
    if (action === "edit-event") {
      await startAppearance("event");
      return;
    }
    if (action === "household") {
      await startAppearance("household");
      return;
    }
    if (action === "guest-find-matches") {
      await findGuestMatches(
        document.querySelector("form[data-form=guest]"),
        true,
      );
      return;
    }
    if (action === "guest-use-existing" || action === "guest-create-separate") {
      const form = document.querySelector("form[data-form=guest]");
      form.dataset.matchTicket = action === "guest-use-existing" ? key : "";
      form.dataset.matchReviewed = "true";
      form.dataset.matchFingerprint = JSON.stringify(guestMatchInput(form));
      notify(
        C(
          action === "guest-use-existing"
            ? "Save the guest to request their approval."
            : "This guest will keep a separate identity.",
        ),
      );
      return;
    }
    if (action === "guest-unlink") {
      const g = state.data.guests.find((g) => g.id === key);
      if (
        !confirm(
          "Restore this entry’s previous guest identity? Its address code stays the same. Affected sessions will be revoked. Other hosts keep their records and codes.",
        )
      )
        return;
      await api(`/api/host/guests/${key}/unlink`, {
        method: "POST",
        version: g.version,
        data: { confirm: fullName(g) },
      });
      await saved(
        "Guest link corrected. This address’s invite code is unchanged.",
      );
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
    if (action.startsWith("table-template-")) {
      if (state.session.role !== "host" || state.preview) return;
      const form = document.querySelector("form[data-form=event]"),
        select = form.elements.tableTemplate;
      const source = (state.data.tableTemplates || []).find(
        (t) => t.id === select.value,
      );
      if (action === "table-template-apply") {
        if (!source) throw new Error(C("Choose a table template first."));
        form
          .querySelector("#menu-rows")
          .insertAdjacentHTML(
            "beforeend",
            source.menu
              .map((item) => menuRow({ ...item, id: crypto.randomUUID() }))
              .join(""),
          );
        return;
      }
      if (action === "table-template-delete") {
        if (!source) throw new Error(C("Choose a table template first."));
        if (
          !confirm(
            String(
              C(
                "Delete this table template? Existing events keep their menus.",
              ),
            ),
          )
        )
          return;
        await api("/api/host/table-templates/" + source.id, {
          method: "DELETE",
          version: source.version,
          data: {},
        });
      } else {
        const saved = await api(
          "/api/host/table-templates" + (source ? "/" + source.id : ""),
          {
            method: source ? "PUT" : "POST",
            version: source?.version,
            data: {
              name: form.elements.tableTemplateName.value,
              menu: readMenuRows(form),
            },
          },
        );
        form.dataset.savedTableTemplate = saved.id;
      }
      state.data.tableTemplates = await api("/api/host/table-templates");
      select.innerHTML =
        `<option value="">${escape(C("New table template"))}</option>` +
        state.data.tableTemplates
          .map((t) => `<option value="${t.id}">${escape(t.name)}</option>`)
          .join("");
      select.value = form.dataset.savedTableTemplate || "";
      if (!select.value) form.elements.tableTemplateName.value = "";
      notify(
        C(
          action === "table-template-delete"
            ? "Table template deleted."
            : "Table template saved.",
        ),
      );
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
    if (action === "address-notes") {
      const a = state.data.addresses.find((a) => a.id === target.dataset.id);
      if (!a) throw new Error("Address not found.");
      state.editingAddressNotes = structuredClone(a);
      modal(
        C("Private household notes"),
        area(
          H("Only you can see these notes"),
          "notes",
          a.notes || "",
          'maxlength="20000"',
        ),
        "address-notes",
        "Save",
      );
      return;
    }
    if (action === "manual-rsvp") {
      state.manualRSVPGuest = target.dataset.id;
      const projection = await api(
        `/api/host/events/${selectedEvent().id}/rsvp/${state.manualRSVPGuest}`,
      );
      rsvp(projection, true);
      return;
    }
    if (action === "rsvp") {
      if (state.session.role === "host") {
        const e = selectedEvent();
        modal(
          C("Choose an invited guest"),
          state.data.guests
            .filter((g) => e.invited.includes(g.id))
            .map((g) =>
              button("manual-rsvp", escape(fullName(g)), `data-id="${g.id}"`),
            )
            .join("") || M("<p>No invited guests.</p>"),
        );
        return;
      }
      rsvp();
      return;
    }
    if (action === "dashboard" || action === "refresh-dashboard") {
      await dashboard();
      return;
    }
    if (action === "share-details") {
      await share();
      return;
    }
    if (action === "copy-link") {
      await copyHouseholdLink();
      return;
    }
    if (action === "native-share" || action === "share") {
      if (navigator.share) {
        try {
          await navigator.share({
            title: state.data.household.name,
            url: householdShareUrl(),
          });
        } catch (error) {
          if (error.name !== "AbortError") throw error;
        }
      } else {
        await copyHouseholdLink();
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
      if (kind === "event") {
        state.event = null;
        state.settingsOpen = false;
        state.settingsReturn = null;
        state.settingsEvent = null;
        state.view = "home";
      }
      await saved("Removed.");
    }
  } catch (error) {
    const box =
      target.closest("form")?.querySelector(".form-error") ||
      $("#editor[open] .form-error");
    if (box) {
      box.textContent = error.message;
      box.scrollIntoView({ block: "nearest" });
    } else notify(error.message);
  } finally {
    pendingActions--;
    delete target.dataset.actionPending;
    target.removeAttribute("aria-busy");
  }
});
document.addEventListener("input", (event) => {
  if (event.target.matches("[data-browse-search=contacts]")) {
    contactSearch = event.target.value;
    render();
    document.querySelector("[data-browse-search=contacts]")?.focus();
  }
});
document.addEventListener("change", (event) => {
  if (event.target.matches("[name=tableTemplate]")) {
    const source = (state.data.tableTemplates || []).find(
      (t) => t.id === event.target.value,
    );
    event.target.form.elements.tableTemplateName.value = source?.name || "";
  }
});
document.addEventListener("change", (event) => {
  if (event.target.matches("[data-contact-invite]"))
    toggleContactInvite(
      event.target.dataset.contactInvite,
      event.target.checked,
    );
});
let draggedContact = null;
document.addEventListener("dragstart", (event) => {
  const row = event.target.closest("[data-contact-row]");
  if (row) {
    draggedContact = row.dataset.contactRow;
    event.dataTransfer.setData("text/plain", draggedContact);
  }
});
document.addEventListener("dragover", (event) => {
  if (draggedContact && event.target.closest("[data-contact-row]"))
    event.preventDefault();
});
document.addEventListener("drop", (event) => {
  const row = event.target.closest("[data-contact-row]");
  if (!row || !draggedContact) return;
  event.preventDefault();
  const key = draggedContact;
  draggedContact = null;
  moveContact(key, 0, row.dataset.contactRow).catch((error) =>
    notify(error.message),
  );
});
const guestAddresses = addressPicker({
  state,
  field,
  area,
  button,
  escape,
  onChange: queueGuestMatches,
});
guestAddresses.bind();
document.addEventListener("input", (event) => {
  const form = event.target.closest(
    ".inline-household-details,.inline-event-details",
  );
  if (form) form.dataset.dirty = "true";
});
document.addEventListener("input", (event) => guestAddresses.input(event));
let chromeObserver, observedTop, observedFooter;
function fitEventSummary() {
  const items = [
    ...document.querySelectorAll(".top-shell .event-summary .totals > div"),
  ];
  if (!items.length) return;
  for (const item of items) item.style.removeProperty("font-size");
  const context = document.createElement("canvas").getContext("2d");
  if (!context) return;
  let ratio = 1;
  const base = parseFloat(getComputedStyle(items[0]).fontSize);
  for (const item of items) {
    const available = item.getBoundingClientRect().width - 1;
    for (const label of item.children) {
      context.font = getComputedStyle(label).font;
      const width = Math.max(
        0,
        ...label.textContent
          .split(/\s+/)
          .map((word) => context.measureText(word).width),
      );
      if (width) ratio = Math.min(ratio, Math.max(0, available) / width);
    }
  }
  for (const item of items) item.style.fontSize = `${base * ratio}px`;
}
function measureChrome() {
  fitEventSummary();
  document.body.classList.toggle(
    "editing-active",
    appearance.active() ||
      !!document.querySelector(
        "#editor[open] form, form[data-form=guest], .card-editor-page, .inline-household-details, .inline-event-details",
      ),
  );
  const top = document.querySelector(".top-shell"),
    footer = document.querySelector(".toolbar");
  const primary = top?.querySelector(".top-primary");
  if (primary) {
    const rect = primary.getBoundingClientRect();
    const left = Math.max(
      ...[
        ...primary.querySelectorAll(
          '.brand,[data-action="page-back"],[data-action="family-back"]',
        ),
      ].map((el) => el.getBoundingClientRect().right - rect.left),
      0,
    );
    const right =
      primary.querySelector(".browse-top-actions")?.getBoundingClientRect()
        .width || 0;
    primary.style.setProperty(
      "--heading-inset",
      Math.max(left, right) + 8 + "px",
    );
    const heading = primary.querySelector(".browse-heading"),
      title = heading?.querySelector("h1");
    if (title) {
      title.style.fontSize = "";
      const style = getComputedStyle(title),
        canvas = document.createElement("canvas"),
        context = canvas.getContext("2d");
      if (context) {
        context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
        const width = context.measureText(title.textContent).width;
        if (width > heading.clientWidth)
          title.style.fontSize =
            Math.max(
              12,
              (parseFloat(style.fontSize) * heading.clientWidth) / width,
            ) + "px";
      }
      primary.style.minHeight = Math.max(64, heading.scrollHeight + 16) + "px";
    }
  }
  document.documentElement.style.setProperty(
    "--top-height",
    (top?.getBoundingClientRect().height || 0) + "px",
  );
  document.documentElement.style.setProperty(
    "--bottom-height",
    (footer?.getBoundingClientRect().height || 0) + "px",
  );
  if (!chromeObserver) chromeObserver = new ResizeObserver(measureChrome);
  if (top !== observedTop || footer !== observedFooter) {
    chromeObserver.disconnect();
    if (top) chromeObserver.observe(top);
    if (footer) chromeObserver.observe(footer);
    observedTop = top;
    observedFooter = footer;
  }
}
window.addEventListener("resize", measureChrome);
document.fonts?.ready.then(measureChrome);
const appearance = appearanceEditor({
  field,
  select,
  fileData,
  notify,
  apply: applyDesign,
  mount: () => {
    const header = document.querySelector(".top-shell");
    header.classList.add("appearance-active");
    return header.querySelector("#appearance-toolbar");
  },
  measure: measureChrome,
});
let appearanceModeSaving = false;
function settingsAppearanceEvent() {
  return state.settingsEvent
    ? state.data.events?.find((e) => e.id === state.settingsEvent)
    : null;
}
function appearanceSettingsMarkup() {
  if (state.session.role !== "host") return "";
  const event = settingsAppearanceEvent();
  const unavailable = !state.example && state.settingsEvent && !event;
  const modes = event
    ? [
        ["page-default-mode", "Default Mode", "home"],
        ["page-custom-mode", "Custom Colors Mode", "palette"],
        ["event-layout-open", "Layout", "layout"],
      ]
    : [
        ["page-light-mode", "Light Mode", "sun"],
        ["page-dark-mode", "Dark Mode", "moon"],
        ["page-custom-mode", "Custom Colors Mode", "palette"],
      ];
  return ui`<li class="browse-row page-appearance-settings"><div class="settings-mode-row" role="group" aria-label="${H("Appearance")}">${modes.map(([action, label, symbol]) => button(action, ui`${icon(symbol)}<span>${C(label)}</span>`, unavailable ? "disabled" : "", "browse-open mode-option")).join("")}</div></li>${event && state.eventLayoutDraft?.event === event.id ? eventLayoutEditor(event) : ""}`;
}
function eventLayoutEditor(event) {
  const draft = state.eventLayoutDraft;
  return ui`<li class="event-layout-editor" aria-busy="${!!state.eventLayoutSaving}"><h2>Layout</h2><fieldset ${state.eventLayoutSaving ? "disabled" : ""}><legend>Event information</legend><div class="event-layout-options" role="radiogroup" aria-label="${H("Event information layout")}">${[
    ["default", "Default"],
    ["invitation", "Invitation style"],
  ]
    .map(
      ([value, label]) =>
        ui`<button type="button" role="radio" aria-checked="${draft.informationLayout === value}" data-action="event-layout-select" data-layout-field="informationLayout" data-id="${value}"><strong>${C(label)}</strong><div class="layout-information-preview">${eventInformation(event, true, value)}</div></button>`,
    )
    .join(
      "",
    )}</div></fieldset><fieldset ${state.eventLayoutSaving ? "disabled" : ""}><legend>Containers</legend><div class="event-layout-options" role="radiogroup" aria-label="${H("Event container layout")}">${[
    ["separate", "Separate containers"],
    ["single", "One container"],
  ]
    .map(
      ([value, label]) =>
        ui`<button type="button" role="radio" aria-checked="${draft.containerLayout === value}" data-action="event-layout-select" data-layout-field="containerLayout" data-id="${value}"><strong>${C(label)}</strong><div class="layout-container-preview ${value}" aria-hidden="true"><span>${C("Event information")}</span><span>${C("RSVP")}</span><span>${C("Menus and plans")}</span></div></button>`,
    )
    .join(
      "",
    )}</div></fieldset><div class="row">${button("event-layout-save", H("Save Layout"), state.eventLayoutSaving ? "disabled" : "")}${button("event-layout-cancel", H("Cancel"), state.eventLayoutSaving ? "disabled" : "")}</div><p role="alert">${escape(state.eventLayoutError || "")}</p></li>`;
}
function leaveEventLayout(target) {
  if (
    !state.eventLayoutDraft ||
    target.closest(".event-layout-editor") ||
    target.dataset.action === "event-layout-open"
  )
    return true;
  if (
    state.eventLayoutDraft.dirty &&
    !confirm(String(C("Discard unsaved layout changes?")))
  )
    return false;
  state.eventLayoutDraft = null;
  return true;
}
function visibleAppearanceEvent() {
  return !state.adminMode && state.view === "home"
    ? state.data.events?.find((e) => (e.invitationKey || e.id) === state.event)
    : null;
}
async function persistPageAppearance(scope, record, design, mode = "custom") {
  await api(
    scope === "event" ? "/api/host/events/" + record.id : "/api/host/household",
    {
      method: "PUT",
      version: record.version,
      data: {
        ...Object.fromEntries(
          Object.entries(record).filter(([key]) => key !== "ui"),
        ),
        design: categoryDesign(design),
        appearanceMode:
          scope === "event" ? (mode === "custom" ? "custom" : "inherit") : mode,
        ...(scope === "household" ? { applyAppearanceMode: true } : {}),
      },
    },
  );
}
async function startAppearance(scope, globalOptions) {
  if (!["host", "admin"].includes(state.session.role)) return;
  const event = scope === "event" ? selectedEvent() : null;
  if (scope === "event" && !event) return;
  const household = state.data.household;
  const record = event || household;
  const initial =
    globalOptions?.design || event?.ui?.design || state.data.ui.design;
  appearance.start({
    design: initial,
    contentActions: [],
    defaults: globalOptions?.defaults || state.data.defaults,
    sources: globalOptions?.sources || [
      { label: String(C("Household")), design: state.data.ui.design },
      ...state.data.events.map((e) => ({
        label: e.title,
        design:
          e.ui?.design ||
          resolveUI(
            state.platformUI,
            { design: household.design },
            { design: e.design },
          ).design,
      })),
    ],
    preview: globalOptions?.preview,
    cancel: () => {
      document
        .querySelector(".top-shell")
        ?.classList.remove("appearance-active");
      if (globalOptions) globalOptions.cancel();
      else render();
    },
    save: async (design) => {
      if (globalOptions) {
        await globalOptions.save(design);
        return;
      }
      const overrides = { ...(record.design || {}) };
      for (const key of appearanceKeys)
        if (
          independentAppearanceKeys.includes(key) ||
          design[key] !== initial[key] ||
          Object.hasOwn(overrides, key)
        )
          overrides[key] = design[key];
      await persistPageAppearance(scope, record, overrides);
      document
        .querySelector(".top-shell")
        ?.classList.remove("appearance-active");
      await load();
      notify(C("Appearance saved."));
    },
  });
}
const family = familyTools({
  appearanceSettings: appearanceSettingsMarkup,
  householdDetails: inlineHouseholdDetails,
  back: previousPage,
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
});
family.bind();
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
  renderDefaultExample,
  render,
  startAppearance,
});
tools.bind();
await load();
setInterval(() => {
  if (state.session?.role && document.visibilityState === "visible")
    load({ background: true });
}, 3000);
window.addEventListener("online", () => load({ background: true }));

function applyLayoutDOM(event, role, target = $("#app")) {
  const config = event?.ui || state.data?.ui || state.platformUI;
  if (!config) return;
  const main = target.querySelector("#main"),
    move = (container, items, keys, layout) => {
      if (!container) return;
      if (layout) container.dataset.layout = layout;
      for (const item of order(
        items.filter((i) => i.element),
        keys || [],
      )) {
        if (layout && keys?.includes(item.id))
          item.element.dataset.layoutItem = item.id;
        container.append(item.element);
      }
    };
  for (const intro of main.querySelectorAll(".hero,.auth,.auth .panel")) {
    const children = [...intro.children];
    const items = [
      { id: "eyebrow", element: children.find((el) => el.matches(".eyebrow")) },
      { id: "title", element: children.find((el) => el.matches("h1,h2")) },
      {
        id: "description",
        element: children.find(
          (el) => el.matches("p:not(.eyebrow)") && !el.querySelector("button"),
        ),
      },
    ].filter((i) => i.element);
    if (items.some((item) => item.id === "title" || item.id === "eyebrow")) {
      intro.dataset.layout = "introText";
      for (const item of items) item.element.dataset.layoutItem = item.id;
      const anchor = document.createComment("intro order");
      intro.insertBefore(anchor, children[0]);
      for (const item of order(items, config.layouts.introText || []))
        anchor.before(item.element);
      anchor.remove();
    }
  }
  if (event) {
    const info = main.querySelector(".event-hero"),
      actions = info?.nextElementSibling,
      grid = main.querySelector(".grid");
    move(
      info,
      [
        { id: "artwork", element: info?.querySelector(".event-icon") },
        { id: "eyebrow", element: info?.querySelector(".eyebrow") },
        { id: "title", element: info?.querySelector("h1") },
        { id: "description", element: info?.querySelector("p.event-details") },
        { id: "details", element: info?.querySelector(".event-meta") },
        { id: "deadline", element: info?.querySelector(".event-deadline") },
      ],
      config.layouts.eventInformation,
      "eventInformation",
    );
    const sections = grid ? [...grid.children] : [];
    if (grid) grid.remove();
    move(
      main.querySelector("[data-event-shell]") || main,
      [
        { id: "information", element: info },
        { id: "actions", element: actions },
        {
          id: "menus",
          element: sections.find((el) => el.dataset.eventSection === "menus"),
        },
        {
          id: "personal",
          element:
            sections.find((el) => el.dataset.eventSection === "personal") ||
            sections.find((el) => el.dataset.eventSection !== "menus"),
        },
      ],
      config.layouts.event,
      "event",
    );
    if (actions && ["guest", "host"].includes(role)) {
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
      move(actions, list, config.layouts.eventButtons, "eventButtons");
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
      move(actions, items, config.layouts.homeButtons, "homeButtons");
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
      role === "host" ? "hostHome" : "guestHome",
    );
    if (role === "host" && hero && !state.adminMode) {
      const cards = document.createElement("div");
      cards.className = "home-workspace-cards";
      cards.innerHTML = ui`<section class="panel" data-home-card="contacts"><h2>Contacts</h2><p>Keep your guests and shared addresses together, then invite them to an event.</p>${button("addresses", H("Open Contacts"))}</section><section class="panel" data-home-card="cards"><h2>${C("Cards & Invites")}</h2><p>Create invitations, cards and reusable templates.</p>${button("cards", H("Open Cards & Invites"))}</section><section class="panel" data-home-card="family"><h2>Family Workspace</h2><p>Share lists, tasks, records and chores with your household.</p>${button("family-workspace", H("Open Family Workspace"))}</section>`;
      if (events) events.before(cards);
      else hero.after(cards);
    }
  } else if (!role) {
    const panel = main.querySelector(".auth .panel"),
      form = panel?.querySelector("form");
    if (panel && form) {
      panel.dataset.layout = "login";
      form.dataset.layoutItem = "form";
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
        "admin",
      );
    }
  }
}

// Render synthetic examples through exactly the same page functions and DOM layout pass.
// Synchronous state substitution is restored before any event/network callback can run.
function renderDefaultExample(view, config) {
  const previous = { ...state };
  const active = state.activeUI || state.data?.ui || state.platformUI;
  const root = document.createElement("div");
  root.id = "app";
  try {
    Object.assign(state, { adminMode: false }, exampleState(view, config));
    render(root, true);
    annotateExample(root, config);
    return { markup: root.innerHTML, style: root.getAttribute("style") || "" };
  } finally {
    for (const key of Object.keys(state)) delete state[key];
    Object.assign(state, previous);
    configureCopy(active);
  }
}
