import { addressBookHome, bottom, topbar } from "./browse-ui.js";
import {
  dateLabel,
  eventIntroduction,
  renderInformation,
} from "./event-information.js";
import { C, H, M, ui } from "./ui-runtime.js";
import { order } from "./ui-system.js";

const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export const button = (action, label, extra = "", className = "secondary") =>
  ui`<button type="button" class="${className}" data-action="${action}" ${extra}>${label}</button>`;

export const mainContent = (content, sync = true, layout = "") =>
  ui`<main id="main"${layout ? ` data-layout="${layout}"` : ""}>${content}${sync ? '<p id="sync-status" class="connection" role="status" aria-live="polite"></p>' : ""}</main>`;

const administratorMenuItems = [
  { action: "admin-approvals", label: "Approvals" },
  { action: "admin-hosts", label: "Hosts" },
  { action: "global-defaults", label: "Defaults" },
  { action: "admin-templates", label: "Templates" },
];

export function homeTopbar(platformAdmin) {
  return topbar({
    title: "",
    plus: [{ action: "new-event", label: "Create Event" }],
    labeledCreate: true,
    sort: platformAdmin
      ? [
          ...administratorMenuItems,
          { action: "preview-guest", label: "Preview guest experience" },
        ]
      : [],
  });
}

export function adminTopbar(templateEditor = false) {
  return topbar({
    title: "",
    plus: templateEditor
      ? [{ action: "new-card", label: "Create shared template" }]
      : [{ action: "admin-approvals", label: "Approve host" }],
    labeledCreate: true,
    sort: [{ action: "preview-guest", label: "Preview guest experience" }],
  });
}

export function adminHomeContent(layout = []) {
  const intro = orderedMarkup(
    [
      [
        "eyebrow",
        ui`<p class="eyebrow" data-layout-item="eyebrow">Administrator</p>`,
      ],
      [
        "title",
        ui`<h1 data-layout-item="title">Open the door<br>for your next host.</h1>`,
      ],
      [
        "description",
        ui`<p data-layout-item="description">Approve email addresses and manage shared invitation artwork. No emails are sent.</p>`,
      ],
    ],
    layout,
  );
  return ui`<section class="hero" data-layout="introText">${intro}</section><section class="panel"><h2>Administration</h2><p>Use the toolbar to manage approvals, hosts, templates and shared page defaults.</p></section>`;
}

export function eventTopbar(session) {
  return topbar({
    title: "",
    sort:
      session.role === "host" && session.platformAdmin
        ? [{ action: "preview-guest", label: "Preview guest experience" }]
        : [],
  });
}

export function pageHeader({ event, role, navigation = "" } = {}) {
  return ui`<header class="top-shell no-print ${event ? "event-toolbar" : ""}"><div class="top-primary"><a class="brand" href="/" data-action="home">gather<span>＊</span></a>${event ? eventSummary(event, role) : ""}<div id="top-navigation">${navigation}</div></div><div id="appearance-toolbar"></div></header>`;
}

export function pageToolbarExtras(role, recipientGrant, guestHasSignOut) {
  if (role === "host")
    return [
      { action: "share-details", label: "Share Invitation", icon: "share" },
      { action: "settings", label: "Settings", icon: "settings" },
    ];
  if (role === "guest")
    return guestHasSignOut
      ? []
      : [{ action: "logout", label: "Sign Out", icon: "logout" }];
  if (role === "visitor")
    return recipientGrant
      ? [{ action: "recipient-sign-out", label: "Sign Out", icon: "logout" }]
      : [];
  return [{ action: "settings", label: "Settings", icon: "settings" }];
}

export function pageToolbar(
  event,
  { role, preview, guestNeedsUsername, recipientGrant },
  complete = false,
) {
  const render = (items) =>
    bottom(
      complete && !preview
        ? [
            ...items,
            ...pageToolbarExtras(role, recipientGrant, guestNeedsUsername),
          ]
        : items,
    );
  if (preview)
    return render([
      { action: "exit-preview", label: "Exit read-only preview", icon: "back" },
      ...(event ? [{ action: "print", label: "Print", icon: "print" }] : []),
    ]);
  if (role === "visitor")
    return render([{ action: "print", label: "Print", icon: "print" }]);
  if (role === "guest" && guestNeedsUsername)
    return render([{ action: "logout", label: "Sign Out", icon: "settings" }]);
  if (role === "host")
    return render([
      { action: "home", label: "Home", icon: "home" },
      ...(event && !event.invitingHousehold
        ? [{ action: "invite-guests", label: "Invite", icon: "invite" }]
        : []),
      ...(event ? [{ action: "print", label: "Print", icon: "print" }] : []),
    ]);
  if (role === "admin")
    return render([
      { action: "home", label: "Home", icon: "home" },
      { action: "admin-approvals", label: "Approvals", icon: "contacts" },
      { action: "admin-hosts", label: "Hosts", icon: "contacts" },
      { action: "global-defaults", label: "Defaults", icon: "edit" },
      { action: "cards", label: "Templates", icon: "list" },
    ]);
  return render([
    { action: "home", label: "Home", icon: "home" },
    ...(event ? [{ action: "print", label: "Print", icon: "print" }] : []),
  ]);
}

function eventSummary(event, role) {
  const host = role === "host" && !event.invitingHousehold;
  const items = host
    ? [
        [event.totals.attending, "Attending"],
        [event.totals.invited, "Invited"],
        [event.totals.declined || 0, "Not attending"],
        [event.totals.noResponse || 0, "No response"],
      ]
    : [
        [event.totals.attending, "Attending"],
        [event.totals.invited, "Invited"],
        ...(event.menu.some((item) => item.kind === "potluck")
          ? [
              [
                event.menu.reduce(
                  (n, item) =>
                    n + Math.max(0, item.quantity - (item.claimed || 0)),
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
            ]
          : []),
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
function eventCard(event, role, household) {
  const logo = event.invitingHousehold
    ? event.invitingHousehold.logo
    : household.logo;
  const heading = ui`<div class="event-choice-heading">${logo ? ui`<img class="family-logo" src="${escape(logo)}" alt="Household icon">` : ""}</div>`;
  const content = ui`${event.invitingHousehold ? ui`<p class="eyebrow">${escape(event.invitingHousehold.name)}</p>` : ""}<p class="muted small">${escape(dateLabel(event.date))}</p><h2>${escape(event.title)}</h2><p class="muted">${escape((event.description || "").slice(0, 120))}</p><div class="row"><span class="pill">${event.totals?.attending ?? 0} attending</span>${event.response?.version && !event.response.uninvited ? M('<span class="pill">RSVP saved</span>') : ""}</div>${button("open-event", H("View Event"), `data-id="${escape(event.invitationKey || event.id)}"`)}`;
  if (role !== "host" || event.invitingHousehold)
    return ui`<article class="card event-choice">${heading}<div class="event-overview">${content}</div></article>`;
  return ui`<article class="card host-event-choice">${heading}<div class="event-overview">${content}</div><div class="event-home-actions" role="group" aria-label="${H("Event actions")}">${[
    ["dashboard", "RSVPs"],
    ["cards", "Invitation Cards"],
  ]
    .map(([action, label]) =>
      button(
        "event-action-" + action,
        H(label),
        `data-id="${escape(event.id)}"`,
      ),
    )
    .join("")}</div></article>`;
}

// Home's event collection can be updated without replacing the surrounding
// toolbar, quick actions, focused controls, or scrollable document.
export function homeEventCollections(
  role,
  household,
  events,
  receivedEvents = [],
) {
  const card = (event) => eventCard(event, role, household);
  const homeEvents =
    role === "host"
      ? events.filter((event) => !eventHasPassed(event))
      : orderedInvitations(events);
  const archivedEvents = role === "host" ? events.filter(eventHasPassed) : [];
  const home =
    homeEvents.length || archivedEvents.length
      ? ui`<section class="home-invitations">${role === "host" ? ui`<p class="eyebrow">${C("Your events")}</p>` : ui`<h2 class="invitations-title">${C("You’re invited to gather")}</h2>`}${homeEvents.length ? ui`<section class="grid home-events ${homeEvents.length > 1 ? "multiple-events" : "single-event"}" aria-label="Events">${homeEvents.map(card).join("")}</section>` : ""}${archivedEvents.length ? ui`<details class="archived-events"><summary>${C("Archived events")}</summary><section class="grid home-events" aria-label="${H("Archived events")}">${archivedEvents.map(card).join("")}</section></details>` : ""}</section>`
      : ui`<section class="panel empty"><div class="sprig" aria-hidden="true">❧</div><h2>${role === "host" ? C("Your next memory starts here.") : C("Nothing on the calendar yet.")}</h2><p class="muted">${role === "host" ? C("Choose Create event to plan your first gathering.") : C("Your host will add your invitations here.")}</p></section>`;
  const received =
    role === "host" && receivedEvents.length
      ? ui`<section class="home-invitations received-invitations"><h2 class="invitations-title">${C("You’re invited to gather")}</h2><section class="grid home-events multiple-events">${orderedInvitations(receivedEvents).map(card).join("")}</section></section>`
      : "";
  return { home, received };
}

export function eventHasPassed(event) {
  if (!event.date) return false;
  const now = new Date();
  const today = new Date(now.getTime() - now.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 10);
  return event.date < today;
}

export function hostHomeContent(
  { household, events = [], receivedEvents = [], ui: config },
  hostOnly,
) {
  const layouts = config?.layouts || {};
  const { home, received } = homeEventCollections(
    "host",
    household,
    events,
    receivedEvents,
  );
  const intro = orderedMarkup(
    [
      [
        "eyebrow",
        ui`<p class="eyebrow" data-layout-item="eyebrow">Your gathering place</p>`,
      ],
      ["title", `<h1 data-layout-item="title">${escape(household.name)}</h1>`],
    ],
    layouts.introText,
  );
  const workspace = ui`<div class="home-workspace-cards">${addressBookHome(button, "addresses", true, hostOnly)}<section class="panel" data-home-card="cards" aria-label="${H("Cards & Invites")}"><p>Create invitations, cards and reusable templates.</p>${button("cards", H(hostOnly ? "Cards & Invites" : "Open Cards & Invites"))}</section><section class="panel" data-home-card="family" aria-label="${H("Family Workspace")}"><p>Share lists, tasks, records and chores with your household.</p>${button("family-workspace", H(hostOnly ? "Family Workspace" : "Open Family Workspace"))}</section></div>`;
  return (
    orderedMarkup(
      [
        [
          "intro",
          `<section class="hero" data-layout="introText"${layoutItem("intro", layouts.hostHome)}>${intro}</section>`,
        ],
        [
          "events",
          workspace +
            home.replace(
              /^<section/,
              "<section" + layoutItem("events", layouts.hostHome),
            ),
        ],
      ],
      layouts.hostHome,
    ) + received
  );
}

function layoutItem(id, keys = []) {
  return keys.includes(id) ? ` data-layout-item="${id}"` : "";
}

function orderedMarkup(entries, keys = []) {
  return order(
    entries
      .filter(([, markup]) => markup)
      .map(([id, markup]) => ({ id, markup })),
    keys,
  )
    .map(({ markup }) => markup)
    .join("");
}

export function memberName(member, hostOnly) {
  return (
    [
      member.first,
      ...(member.parent
        ? hostOnly
          ? [member.suffix]
          : []
        : [member.last, member.suffix]),
    ]
      .filter(Boolean)
      .join(" ") + (member.plusOne && member.first !== "+1" ? " · +1" : "")
  );
}

export function eventActions(event, { role, hostOnly, layouts }) {
  const archived = eventHasPassed(event);
  const actionItems = {
    rsvp: archived ? "" : button("rsvp", C("RSVP"), "", ""),
    "event-extra-page": (event.extraPages || [])
      .map((p) =>
        button(
          "event-extra-page",
          escape(p.title),
          `data-id="${escape(p.id)}"`,
        ),
      )
      .join(""),
    "event-pages-manage":
      !archived && hostOnly && role === "host" && !event.invitingHousehold
        ? button("event-pages-manage", H("Manage event pages"))
        : "",
    registries: (event.registries || []).length
      ? ui`<div class="registry-buttons" aria-label="Gift registries">${event.registries.map((r) => ui`<a class="button registry-button" href="${escape(r.url)}" target="_blank" rel="noopener noreferrer">${escape(r.title)}</a>`).join("")}</div>`
      : "",
    uploads: event.uploadURL
      ? ui`<a class="button" data-event-edit="uploadURL" href="${escape(event.uploadURL)}" target="_blank" rel="noopener noreferrer">Upload Photos & Videos</a>`
      : "",
    viewURL: event.viewURL
      ? ui`<a class="button" data-event-edit="viewURL" href="${escape(event.viewURL)}" target="_blank" rel="noopener noreferrer">View Photos & Videos</a>`
      : "",
  };
  if (actionItems.rsvp && ["guest", "host"].includes(role)) {
    actionItems.rsvp = `<div class="rsvp-stack" data-layout-action="rsvp">${actionItems.rsvp}${actionItems.registries}${actionItems.uploads}${actionItems.viewURL}</div>`;
    for (const id of ["registries", "uploads", "viewURL"])
      delete actionItems[id];
  }
  const actions = orderedMarkup(
    Object.entries(actionItems).map(([id, markup]) => [
      id,
      markup.replace(/^(<\w+)/, "$1" + layoutItem(id, layouts.eventButtons)),
    ]),
    layouts.eventButtons,
  );
  return `<div class="row no-print" data-event-actions data-layout="eventButtons"${layoutItem("actions", layouts.event)}>${actions}</div>`;
}

export function eventPage(
  event,
  { role, hostOnly, layouts = event.ui?.layouts || {} },
) {
  const archived = eventHasPassed(event);
  const own = event.response || { version: 0, attendance: {}, claims: {} };
  const menus =
    !archived && event.menu.length
      ? ui`<section class="panel" data-event-section="menus"><p class="eyebrow">Something to share</p><h2>At the table</h2>${event.menu.map((item) => ui`<div class="menu-item" data-event-edit="table" data-menu-item="${escape(item.id)}"><div><strong>${escape(item.name)}</strong><div class="muted small">${item.kind === "drink" ? C("Drinks") : C("Potluck")}</div></div><span class="pill">${Math.max(0, item.quantity - (item.claimed || 0))} needed</span></div>`).join("")}</section>`
      : "";
  const personal = archived
    ? ""
    : ui`<section class="panel" data-event-section="personal"><p class="eyebrow">Your plans</p><h2>Your RSVP & items</h2>${
        own.version && !own.uninvited
          ? ui`<ul>${event.members.map((m) => ui`<li>${escape(memberName(m, hostOnly))}: ${(event.partyAttendance || own.attendance)[m.id] === "yes" ? C("Attending") : (event.partyAttendance || own.attendance)[m.id] === "no" ? C("Not attending") : C("No response")}</li>`).join("")}</ul><h3>You’re bringing</h3>${
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
      }</section>`;
  const additional = (event.information || []).some((run) => run.text.trim())
    ? ui`<section class="panel" data-event-section="additional-information"><h2>Information</h2><div class="event-additional-content" data-event-edit="information" data-host-content>${renderInformation(event.information)}</div></section>`
    : "";
  const plans = {
    id: "personal",
    markup: personal.replace(
      /^<section/,
      "<section" + layoutItem("personal", layouts.event),
    ),
  };
  const parts = order(
    [
      {
        id: "information",
        markup: eventIntroduction(
          event,
          layouts.eventInformation,
          layoutItem("information", layouts.event),
        ),
      },
      {
        id: "actions",
        markup: eventActions(event, { role, hostOnly, layouts }),
      },
      {
        id: "menus",
        markup: menus.replace(
          /^<section/,
          "<section" + layoutItem("menus", layouts.event),
        ),
      },
      plans,
    ].filter(({ markup }) => markup),
    layouts.event,
  );
  if (additional) {
    const following = parts.findIndex(
      ({ id }) => id === (menus ? "menus" : "personal"),
    );
    parts.splice(following < 0 ? parts.length : following, 0, {
      id: "additional",
      markup: additional,
    });
  }
  if (personal) {
    parts.splice(parts.indexOf(plans), 1);
    parts.splice(parts.findIndex(({ id }) => id === "actions") + 1, 0, plans);
  }
  const content = parts.map(({ markup }) => markup).join("");
  return event.containerLayout === "single"
    ? `<section class="panel event-content-shell" data-event-shell data-layout="event">${content}</section>`
    : content;
}

export const recipientAccessTopbar = () =>
  topbar({ title: C("RSVP"), back: "rsvp-cancel" });
export function recipientAccessContent() {
  return ui`<section class="panel"><h1>Household ID</h1><p>You can find your Household ID on your RSVP card.</p><form data-form="recipient-access"><label>Household ID<input name="householdID" type="text" value="" required maxlength="64" autocomplete="off"></label><p class="form-error" role="alert"></p><div class="row"><button>Continue</button>${button("rsvp-cancel", H("Cancel"))}</div></form></section>`;
}
