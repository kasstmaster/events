import { addressBookHome, topbar } from "../public/browse-ui.js";

// First paint mirrors the real Gather Home DOM and controls so hydrating the
// app does not cause the layout, cards and buttons to appear in a second wave.
const html = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ],
  );
const button = (action, label, extra = "", className = "secondary") =>
  `<button type="button" class="${className}" data-action="${html(action)}" ${extra}>${html(label)}</button>`;

function eventCard(event, logo = "") {
  const description = String(event.description || "").slice(0, 120);
  const mark = logo
    ? `<img class="family-logo" src="${html(logo)}" alt="Household icon">`
    : "";
  return `<article class="card host-event-choice"><div class="event-choice-heading">${mark}</div><div class="event-overview"><p class="muted small">${html(event.date || "")}</p><h2>${html(event.title)}</h2><p class="muted">${html(description)}</p><div class="row"><span class="pill">${html(event.totals?.attending ?? 0)} attending</span></div>${button("open-event", "View Event", `data-id="${html(event.id)}"`)}</div><div class="event-home-actions" role="group" aria-label="Event actions">${button("event-action-dashboard", "RSVPs", `data-id="${html(event.id)}"`)}${button("event-action-cards", "Invitation Cards", `data-id="${html(event.id)}"`)}</div></article>`;
}

export function initialHomeHtml({ household, events = [] } = {}) {
  if (!household)
    return '<section class="auth panel"><h1>Welcome to Gather</h1><p>Sign in to see your household and events.</p><a class="button" href="/signin">Sign in</a></section>';
  const now = new Date();
  const today = new Date(now.getTime() - now.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 10);
  const active = events.filter((event) => !event.date || event.date >= today);
  const archived = events.filter((event) => event.date && event.date < today);
  const cards = (items) =>
    `<section class="grid home-events ${items.length > 1 ? "multiple-events" : "single-event"}" aria-label="Events">${items.map((event) => eventCard(event, household.logo)).join("")}</section>`;
  const collections =
    active.length || archived.length
      ? `<section class="home-invitations"><p class="eyebrow">Your events</p>${active.length ? cards(active) : ""}${archived.length ? `<details class="panel"><summary>Archived events</summary><section class="grid home-events" aria-label="Archived events">${archived.map((event) => eventCard(event, household.logo)).join("")}</section></details>` : ""}</section>`
      : '<section class="panel empty"><div class="sprig" aria-hidden="true">❧</div><h2>Your next memory starts here.</h2><p class="muted">Choose Create event to plan your first gathering.</p></section>';
  const quickActions = `<div class="home-workspace-cards">${addressBookHome(button, "addresses", true, true)}<section class="panel" data-home-card="cards" aria-label="Cards &amp; Invites"><p>Create invitations, cards and reusable templates.</p>${button("cards", "Cards & Invites")}</section><section class="panel" data-home-card="family" aria-label="Family Workspace"><p>Share lists, tasks, records and chores with your household.</p>${button("family-workspace", "Family Workspace")}</section></div>`;
  return `${topbar({ title: "", plus: [{ action: "new-event", label: "Create Event" }] })}<section class="hero"><p class="eyebrow">Your gathering place</p><h1>${html(household.name)}</h1></section>${quickActions}${collections}`;
}
