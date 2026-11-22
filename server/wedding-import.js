// Owner-reviewed authoritative content only. Never imports source guests/accounts/RSVPs.
import { createHash } from "node:crypto";
import { fail, id, text } from "./model.js";
import { pageInput, eventPages, eventPerson } from "./event-pages.js";
import { confirmAdministrator, auditAccount } from "./account-management.js";
import { hostSignupEnabled } from "./host-signup.js";
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])]),
        )
      : value;
const fingerprint = (value) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
const metadataFields = [
  "title",
  "description",
  "date",
  "time",
  "address",
  "deadline",
  "icon",
  "information",
  "registries",
  "uploadURL",
  "viewURL",
];
export function weddingImportPlan(store, input, validateEvent) {
  const { household, event: target, source, memberMapping = {} } = input,
    current = store.get("event", target, household);
  if (!current || !store.household(household))
    fail(404, "Choose the existing Gather wedding event.");
  if (
    !source ||
    source.schema !== 1 ||
    source.repository !== "kasstmaster/themeyersgatherings" ||
    !/^[a-f0-9]{40}$/.test(source.sourceCommit || "") ||
    source.authoritative !== true ||
    !Array.isArray(source.pages) ||
    !Array.isArray(source.members) ||
    !source.event
  )
    fail(
      400,
      "A complete authoritative wedding content export is required. The checked-in app-state snapshot is incomplete.",
    );
  if (source.pages.length > 200 || source.members.length > 200)
    fail(400, "Wedding content exceeds the reviewed import size.");
  const people = new Map(),
    usedGuests = new Set();
  for (const person of source.members) {
    const key = text(person.sourceID, 100, true),
      guest = memberMapping[key];
    if (
      people.has(key) ||
      typeof guest !== "string" ||
      !eventPerson(store, current, household, guest) ||
      usedGuests.has(guest)
    )
      fail(
        400,
        "Explicitly map each distinct wedding-party member to a different existing invited Gather person.",
      );
    usedGuests.add(guest);
    people.set(key, {
      guest,
      roles: Array.isArray(person.roles)
        ? person.roles.map((role) => text(role, 100, true))
        : [],
    });
  }
  if (Object.keys(memberMapping).some((key) => !people.has(key)))
    fail(400, "Unknown source member mapping.");
  const sourcePages = [...source.pages];
  for (const person of source.members) {
    if (!Array.isArray(person.pages))
      fail(
        400,
        "The authoritative export must include each member's saved pages.",
      );
    for (const page of person.pages)
      sourcePages.push({
        ...page,
        sourceID: person.sourceID + ":" + page.sourceID,
        audience: "members",
        members: [person.sourceID],
      });
    if (person.responsibilities?.length)
      sourcePages.push({
        sourceID: person.sourceID + ":responsibilities",
        title: text(person.name, 160, true) + " · Responsibilities",
        audience: "members",
        members: [person.sourceID],
        content: person.responsibilities,
      });
  }
  if (sourcePages.length > 200)
    fail(400, "Wedding content exceeds the reviewed import size.");
  const ids = new Set(),
    pages = sourcePages.map((page, index) => {
      const key = text(page.sourceID, 200, true);
      if (ids.has(key) || !page.audience)
        fail(
          400,
          "Every source page needs a distinct ID and explicit visibility.",
        );
      ids.add(key);
      const members = (page.members || []).map((key) => {
        if (!people.has(key))
          fail(400, "Private page has an unresolved member.");
        return people.get(key).guest;
      });
      const next = pageInput({ ...page, members }, current, store, household, {
        position: index,
      });
      if (page.audience === "members" && !members.length)
        fail(400, "Individual private pages require mapped people.");
      const mapping = store.get(
          "wedding-import-page",
          target + ":" + key,
          household,
        ),
        existing = mapping && store.get("event-page", mapping.page, household);
      if (
        mapping &&
        (!existing || existing.version !== mapping.lastImportedVersion)
      )
        fail(
          409,
          "An imported destination page was edited or archived. Review it manually before replacing it.",
        );
      return { sourceID: key, next, mapping, existing };
    });
  const eventFields = Object.fromEntries(
    metadataFields
      .filter((key) => Object.hasOwn(source.event, key))
      .map((key) => [key, source.event[key]]),
  );
  const event = validateEvent(
    {
      ...current,
      ...eventFields,
      invited: current.invited,
      menu: current.menu,
    },
    store,
    household,
    current,
  );
  const pageFields = [
    "sourceID",
    "title",
    "content",
    "image",
    "audience",
    "roles",
    "members",
  ];
  const cleanPage = (page) =>
    Object.fromEntries(
      pageFields
        .filter((key) => Object.hasOwn(page, key))
        .map((key) => [key, page[key]]),
    );
  const safeSource = {
    schema: 1,
    repository: source.repository,
    sourceCommit: source.sourceCommit,
    authoritative: true,
    event: eventFields,
    pages: source.pages.map(cleanPage),
    members: source.members.map((person) => ({
      sourceID: person.sourceID,
      name: person.name,
      roles: person.roles || [],
      responsibilities: person.responsibilities || [],
      pages: person.pages.map(cleanPage),
    })),
  };
  const sourceFingerprint = fingerprint(safeSource),
    receipt = store.get(
      "wedding-import-receipt",
      target + ":" + sourceFingerprint,
      household,
    );
  const destination = {
    event: current.version,
    pages: eventPages(store, current, household).map((p) => [p.id, p.version]),
    roles: [...people.values()].map((person) => {
      const record = store.get(
        "event-person-roles",
        target + ":" + person.guest,
        household,
      );
      return [person.guest, record?.version || 0];
    }),
  };
  return {
    household,
    current,
    event,
    people,
    pages,
    safeSource,
    sourceFingerprint,
    receipt,
    reviewFingerprint: fingerprint({
      sourceFingerprint,
      memberMapping,
      destination,
    }),
  };
}
export async function weddingImportAPI(ctx) {
  const {
    path,
    method,
    req,
    res,
    store,
    env,
    session,
    body,
    json,
    validateEvent,
  } = ctx;
  if (path !== "/api/admin/wedding-import") return false;
  if (!hostSignupEnabled(env)) fail(404, "Page not found.");
  if (method !== "POST") fail(405, "Method not allowed.");
  const input = await body(req);
  await confirmAdministrator(store, session, input.password);
  if (input.operation === "targets") {
    const event = store.get("event", input.event, input.household);
    if (!event) fail(404, "Choose the existing Gather wedding event.");
    const contacts = store
      .list("guest", input.household)
      .filter((p) => event.invited.includes(p.id))
      .map(({ id, first, last, suffix, parent }) => ({
        id,
        first,
        last,
        suffix,
        parent,
      }));
    const family =
      store
        .get("host-family-roster", "family:" + input.household, input.household)
        ?.members.filter((p) => !p.archived)
        .map((p) => ({
          id: p.rsvpID,
          first: p.first,
          last: p.last,
          suffix: p.suffix,
          parent: p.parent,
        })) || [];
    json(res, { people: [...family, ...contacts] });
    return true;
  }
  const plan = weddingImportPlan(store, input, validateEvent);
  if (input.operation !== "apply") {
    json(res, {
      reviewFingerprint: plan.reviewFingerprint,
      sourceFingerprint: plan.sourceFingerprint,
      existingEvent: {
        id: plan.current.id,
        title: plan.current.title,
        version: plan.current.version,
      },
      pages: plan.pages.map((p) => ({
        title: p.next.title,
        audience: p.next.audience,
      })),
      members: plan.people.size,
      alreadyApplied: !!plan.receipt,
    });
    return true;
  }
  if (
    plan.receipt &&
    input.confirm === "IMPORT REVIEWED WEDDING CONTENT" &&
    input.confirmAuthoritativeSource === true
  ) {
    if (
      plan.receipt.mappingFingerprint &&
      plan.receipt.mappingFingerprint !== fingerprint(input.memberMapping || {})
    )
      fail(
        409,
        "This source was imported with different member mappings. Review the existing import.",
      );
    json(res, { ok: true, alreadyApplied: true, receipt: plan.receipt.id });
    return true;
  }
  if (
    input.confirm !== "IMPORT REVIEWED WEDDING CONTENT" ||
    input.confirmAuthoritativeSource !== true ||
    input.reviewFingerprint !== plan.reviewFingerprint
  )
    fail(
      409,
      "Review the exact source, private member mapping and destination before importing.",
    );
  if (plan.receipt) {
    json(res, { ok: true, alreadyApplied: true, receipt: plan.receipt.id });
    return true;
  }
  const receipt = store.transaction(() => {
    const current = weddingImportPlan(store, input, validateEvent);
    if (current.reviewFingerprint !== plan.reviewFingerprint)
      fail(409, "Destination content changed. Review the import again.");
    store.put(
      "wedding-import-source",
      plan.current.id + ":" + plan.sourceFingerprint,
      plan.household,
      {
        source: plan.safeSource,
        fingerprint: plan.sourceFingerprint,
        reviewedBy: session.user,
        reviewedAt: Date.now(),
      },
    );
    store.put(
      "event-history",
      plan.current.id + ":" + plan.current.version,
      plan.household,
      { event: plan.current, actor: session.user, at: Date.now() },
    );
    store.put(
      "event",
      plan.current.id,
      plan.household,
      plan.event,
      plan.current.version,
    );
    for (const page of plan.pages) {
      if (page.existing)
        store.put(
          "event-page-history",
          page.existing.id + ":" + page.existing.version,
          plan.household,
          { page: page.existing, actor: session.user, at: Date.now() },
        );
      const saved = store.put(
        "event-page",
        page.existing?.id || id(),
        plan.household,
        page.next,
        page.existing?.version,
      );
      store.put(
        "wedding-import-page",
        plan.current.id + ":" + page.sourceID,
        plan.household,
        { page: saved.id, lastImportedVersion: saved.version },
        page.mapping?.version,
      );
    }
    for (const person of plan.people.values()) {
      const key = plan.current.id + ":" + person.guest,
        existing = store.get("event-person-roles", key, plan.household);
      store.put(
        "event-person-roles",
        key,
        plan.household,
        { event: plan.current.id, guest: person.guest, roles: person.roles },
        existing?.version,
      );
    }
    const receipt = store.put(
      "wedding-import-receipt",
      plan.current.id + ":" + plan.sourceFingerprint,
      plan.household,
      {
        mappingFingerprint: fingerprint(input.memberMapping || {}),
        sourceFingerprint: plan.sourceFingerprint,
        pages: plan.pages.length,
        actor: session.user,
        at: Date.now(),
      },
    );
    auditAccount(
      store,
      session.user,
      plan.current.id,
      "wedding-content-imported",
      ["owner-reviewed-export", "no-guest-or-rsvp-import"],
    );
    return receipt;
  });
  json(res, { ok: true, receipt: receipt.id });
  return true;
}
