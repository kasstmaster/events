import { copyCatalog } from "./ui-copy.js";
import { roleDefaults } from "./ui-system.js";
// Browser-only fixtures. Never read/write tenant records or create a session.
export function exampleState(view, ui) {
  const illustration = (content) =>
    "data:image/svg+xml," +
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="160" viewBox="0 0 240 160"><rect width="240" height="160" rx="18" fill="#edf2e9"/>${content}</svg>`,
    );
  const household = {
    id: "example-household",
    slug: "example-household",
    name: "Example household",
    notes: "Bring everyone together for a relaxed afternoon.",
    design: ui.design,
    ui,
    logo: illustration(
      '<circle cx="120" cy="80" r="48" fill="#294d42"/><text x="120" y="95" text-anchor="middle" font-size="42" fill="white">E</text>',
    ),
  };
  const members = [
    { id: "example-adult", first: "Alex", last: "Example", suffix: "" },
    {
      id: "example-child",
      first: "Robin",
      last: "Example",
      suffix: "",
      parent: "example-adult",
    },
  ];
  const event = {
    id: "example-event",
    version: 1,
    invited: members.map((member) => member.id),
    title: "An afternoon together",
    description: "Good food, familiar faces and a little time together.",
    date: "2089-06-12",
    time: "Two o’clock in the afternoon",
    address: "123 Example Lane\nExample Town, CA 90000",
    deadline: "2089-06-01",
    icon: illustration(
      '<circle cx="174" cy="45" r="20" fill="#b7784c"/><path d="M0 160L85 55L140 115L185 80L240 160" fill="#64786a"/>',
    ),
    menu: [
      { id: "salad", name: "Salad", kind: "potluck", quantity: 4, claimed: 1 },
      {
        id: "lemonade",
        name: "Lemonade",
        kind: "drink",
        quantity: 3,
        claimed: 1,
      },
    ],
    registries: [
      {
        id: "registry",
        title: "Our gift registry",
        url: "https://example.invalid/registry",
      },
    ],
    uploadURL: "https://example.invalid/photos",
    totals: { attending: 8, invited: 12 },
    design: ui.design,
    ui,
    members,
    customItemsEnabled: true,
  };
  if (view === "eventInvitation") event.informationLayout = "invitation";
  if (view === "eventSingleContainer") event.containerLayout = "single";
  const guestView = [
    "guestHome",
    "guestSettings",
    "guestEvent",
    "guestEventUnanswered",
  ].includes(view);
  if (guestView) {
    event.invitingHousehold = household;
    event.response =
      view === "guestEventUnanswered"
        ? { version: 0, attendance: {}, claims: {} }
        : {
            version: 1,
            attendance: { "example-adult": "yes", "example-child": "yes" },
            claims: { salad: 1 },
            customItems: [],
          };
  }
  const familyView =
    (view.startsWith("family") && view !== "familyLogin") ||
    ["hostSettings", "eventSettings"].includes(view);
  const kid = view.startsWith("familyKid");
  const familyMembers = [
    { id: "example-owner", name: "Alex", role: "owner" },
    { id: "example-kid", name: "Robin", role: "kid" },
  ];
  const common = {
    version: 1,
    createdBy: "example-owner",
    categories: [],
    childAccess: ["example-kid"],
    folder: "",
  };
  const records = [
    {
      ...common,
      id: "example-list",
      type: "list",
      title: "Groceries",
      categories: ["Produce", "Pantry"],
    },
    {
      ...common,
      id: "example-record",
      type: "record",
      title: "Washing machine",
      model: "Example model",
      serial: "EXAMPLE-001",
      details: { Purchased: "2089-01-10" },
      notes: "Keep the warranty with the manual.",
      history: [{ date: "2089-02-01", notes: "Checked the filter." }],
    },
    {
      ...common,
      id: "example-chore",
      type: "chore",
      title: "Water the garden",
      instructions: "Water the planters by the front door.",
      assignees: familyMembers.map((m) => m.id),
      repeat: "weekly",
      timezone: "America/Los_Angeles",
      completionMode: "each",
      linkedRecord: "",
      cancelled: false,
    },
  ];
  const family = {
    household,
    ui,
    defaults: roleDefaults,
    member: familyMembers[kid ? 1 : 0],
    members: kid ? [familyMembers[1]] : familyMembers,
    records: kid
      ? records.filter((r) => ["list", "chore"].includes(r.type))
      : records,
    items: [
      {
        id: "example-apples",
        list: "example-list",
        title: "Apples",
        category: "Produce",
        completed: false,
        position: 1,
        version: 1,
      },
      {
        id: "example-bread",
        list: "example-list",
        title: "Bread",
        category: "Pantry",
        completed: true,
        position: 2,
        version: 1,
      },
    ],
    occurrences: [
      {
        id: "example-occurrence",
        chore: "example-chore",
        assignees: familyMembers.map((m) => m.id),
        due: "2089-06-12T17:00:00Z",
        completed: {},
        completionMode: "each",
        version: 1,
      },
    ],
    preferences: {},
    notifications: [],
    storage: { used: 0, limit: 20000000, fileLimit: 2000000 },
    timezone: "America/Los_Angeles",
  };
  const anonymous = [
    "login",
    "guestLoginSuffix",
    "hostLogin",
    "registration",
    "familyLogin",
  ].includes(view);
  return {
    example: true,
    settingsEvent: view === "eventSettings" ? event.id : null,
    eventLayoutDraft:
      view === "eventSettings"
        ? {
            event: event.id,
            record: event,
            informationLayout: "default",
            containerLayout: "separate",
            dirty: false,
          }
        : null,
    setup: { required: false, enabled: false },
    preview: null,
    platformUI: ui,
    activeUI: ui,
    templates: [],
    session: {
      role: anonymous
        ? null
        : ["hostSettings", "eventSettings"].includes(view)
          ? "host"
          : familyView
            ? "family"
            : view.startsWith("admin")
              ? "admin"
              : guestView
                ? "guest"
                : "host",
    },
    publicHousehold: ["login", "guestLoginSuffix", "familyLogin"].includes(view)
      ? household
      : null,
    view:
      view === "adminApprovals"
        ? "admin-approvals"
        : view === "adminHosts"
          ? "admin-hosts"
          : ["adminSettings", "guestSettings"].includes(view)
            ? "settings"
            : view === "contacts"
              ? "contacts"
              : view === "registration"
                ? "register"
                : view === "hostLogin"
                  ? "login"
                  : view === "familyLogin"
                    ? "family-login"
                    : familyView
                      ? "family"
                      : "home",
    event: [
      "event",
      "guestEvent",
      "guestEventUnanswered",
      "eventInformation",
      "eventInvitation",
      "eventSingleContainer",
      "eventButtons",
      "toolbar",
    ].includes(view)
      ? event.id
      : null,
    data: familyView
      ? {
          ...family,
          ...(["hostSettings", "eventSettings"].includes(view)
            ? { events: [event], guests: members, addresses: [] }
            : {}),
        }
      : {
          household,
          ui,
          defaults: roleDefaults,
          events: [event],
          guest: members[0],
          guests: members,
          addresses: [],
          approvals: [{ email: "approved@example.invalid" }],
          hosts: [
            {
              id: "example-owner",
              email: "owner@example.invalid",
              household: household.id,
            },
          ],
          deletions: [],
        },
    familyData: familyView ? family : null,
    exampleRecord:
      {
        hostSettings: "__settings__",
        eventSettings: "__settings__",
        familySettings: "__settings__",
        familyList: "example-list",
        familyRecord: "example-record",
        familyChore: "example-chore",
        familyTasks: "__mine__",
        familyKidList: "example-list",
        familyKidTasks: "__mine__",
      }[view] || "",
    lastSync: new Date("2089-06-12T12:00:00Z"),
  };
}
export function annotateExample(root, config) {
  const wording = new Map(
    copyCatalog.map((key) => [config.copy?.[key] ?? key, key]),
  );
  const escapePattern = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const phrases = [...wording.keys()]
    .filter((value) => /[\p{L}]/u.test(value))
    .sort((a, b) => b.length - a.length);
  const pattern = new RegExp(
    "(?<![\\p{L}\\p{N}])(?:" +
      phrases.map(escapePattern).join("|") +
      ")(?![\\p{L}\\p{N}])",
    "gu",
  );
  const doc = root.ownerDocument;
  // These values belong to the host, even if their sample happens to resemble interface wording.
  for (const el of root.querySelectorAll(
    ".event-hero>h1,.event-hero>p.event-details,.event-meta:not(.event-information-invitation)>div>span,.event-information-invitation [data-event-edit],.layout-information-preview [data-event-edit],.hero>h1,.card h2,.card h3,.card p.muted,.private-notes textarea",
  ))
    el.dataset.hostContent = "";
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT),
    nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    if (
      node.parentElement.closest(
        "svg,textarea,option,script,style,[data-host-content]",
      )
    )
      continue;
    const value = node.textContent,
      matches = [...value.matchAll(pattern)];
    if (!matches.length) continue;
    if (
      matches.length === 1 &&
      value.trim() === matches[0][0] &&
      node.parentElement.childNodes.length === 1
    ) {
      node.parentElement.dataset.defaultCopy = wording.get(matches[0][0]);
      continue;
    }
    const fragment = doc.createDocumentFragment();
    let offset = 0;
    for (const match of matches) {
      fragment.append(value.slice(offset, match.index));
      const span = doc.createElement("span");
      span.dataset.defaultCopy = wording.get(match[0]);
      span.textContent = match[0];
      fragment.append(span);
      offset = match.index + match[0].length;
    }
    fragment.append(value.slice(offset));
    node.replaceWith(fragment);
  }
  for (const el of root.querySelectorAll(
    "section,article,main,nav,header,form,fieldset,.row,.event-meta,.event-meta>div,.event-deadline,.registry-buttons,.rsvp-stack,[data-layout-item],h1,h2,h3,p,span,b,strong,label,li,dt,dd,button,a,input,textarea,select,[data-default-copy]",
  )) {
    let role = el.matches("h1,h2,h3")
      ? "title"
      : el.matches("button,.button")
        ? "button"
        : el.matches("input,textarea,select")
          ? "input"
          : el.matches(
                "section,article,main,nav,header,form,fieldset,.row,.event-meta,.event-meta>div,.event-deadline,.registry-buttons,.rsvp-stack",
              )
            ? "container"
            : "text";
    if (el.matches(".eyebrow")) role = "eyebrow";
    else if (el.closest(".toolbar .nav-control")) role = "toolbar";
    else if (el.closest(".private-notes"))
      role = el.matches("button") ? "button" : "notes";
    else if (
      el.matches(
        ".pill,.stat,.event-meta b,.event-meta span,.event-deadline b,.event-deadline span,.totals,.totals *",
      )
    )
      role = "status";
    else if (el.matches(".muted,.event-details,.connection"))
      role = "description";
    el.dataset.defaultRole = role;
    el.tabIndex = 0;
  }
  const nav = root.querySelector(".toolbar");
  if (nav) {
    for (const el of nav.querySelectorAll(":scope > [data-action]"))
      el.removeAttribute("data-layout-item");
  }
}
