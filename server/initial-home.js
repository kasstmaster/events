// Lightweight first-paint HTML for a validated host's Home page.
// Authentication, navigation, RSVP, and editing remain in the shared application.
const html = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ],
  );

function eventCard(event) {
  const date = typeof event.date === "string" ? event.date : "";
  const description = String(event.description || "").slice(0, 120);
  return `<article class="card host-event-choice"><div class="event-overview"><p class="muted small">${html(date)}</p><h2>${html(event.title)}</h2><p class="muted">${html(description)}</p></div></article>`;
}

export function initialHomeHtml({ household, events = [] } = {}) {
  if (!household) {
    // This contains no private data; the original authentication UI hydrates it.
    return '<section class="auth panel"><h1>Welcome to Gather</h1><p>Sign in to see your household and events.</p><a class="button" href="/signin">Sign in</a></section>';
  }
  const today = new Date().toISOString().slice(0, 10);
  const active = events.filter((event) => !event.date || event.date >= today);
  const archived = events.filter((event) => event.date && event.date < today);
  const cards = (items) =>
    `<section class="grid home-events ${items.length > 1 ? "multiple-events" : "single-event"}" aria-label="Events">${items.map(eventCard).join("")}</section>`;
  return `<section class="hero"><p class="eyebrow">Your gathering place</p><h1>${html(household.name)}</h1></section><div class="home-workspace-cards"><section class="panel" data-home-card="contacts"><p>Keep everyone together in your Address Book.</p><button type="button" class="secondary" data-action="addresses">Address Book</button></section><section class="panel" data-home-card="cards"><p>Create invitations, cards and reusable templates.</p><button type="button" class="secondary" data-action="cards">Cards &amp; Invites</button></section><section class="panel" data-home-card="family"><p>Share lists, tasks, records and chores with your household.</p><button type="button" class="secondary" data-action="family-workspace">Family Workspace</button></section></div>${active.length || archived.length ? `<section class="home-invitations"><p class="eyebrow">Your events</p>${active.length ? cards(active) : ""}${archived.length ? `<details class="panel"><summary>Archived events</summary>${cards(archived)}</details>` : ""}</section>` : '<section class="panel empty"><h2>Your next memory starts here.</h2><p class="muted">Choose Create event to plan your first gathering.</p></section>'}`;
}
