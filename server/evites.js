import { createHash, randomBytes } from "node:crypto";
import { fail, image } from "./model.js";
import { smsEnabled, sendText } from "./sms-provider.js";
import { recipientBlocked } from "./personal-accounts.js";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const keyFor = (event, guest) => hash(event + ":" + guest);
function invitedAdults(store, household, event) {
  return store
    .list("guest", household)
    .filter((g) => !g.parent && event.invited.includes(g.id));
}
export function eviteStatus(store, household, event, env = {}) {
  const rows = invitedAdults(store, household, event).map((g) => {
    const record = store.get(
      "evite-delivery",
      keyFor(event.id, g.id),
      household,
    );
    return {
      id: g.id,
      name: [g.first, g.last, g.suffix].filter(Boolean).join(" "),
      household:
        store.get("address", g.address, household)?.label ||
        "No shared address",
      status: record?.status || (!g.phone ? "missing-phone" : "not-sent"),
      hasPhone: !!g.phone,
      canResend: record?.status === "missing-phone" && !!g.phone,
    };
  });
  return {
    enabled: smsEnabled(env),
    recipients: rows,
    missing: rows.filter((r) => r.status === "missing-phone"),
    resendEligible: rows.filter((r) => r.canResend).length,
  };
}
export function prepareEvites(store, env, household, event, input, origin) {
  if (!smsEnabled(env))
    fail(503, "Text invitations are not configured. No messages were sent.");
  const mode = input.mode || "send";
  if (!["send", "resend-missing"].includes(mode))
    fail(400, "Choose a supported invitation action.");
  const data = image(input.image);
  if (!data) fail(400, "Preview and select an invitation image first.");
  store.limit("evites:" + household + ":" + event.id, 6, 3600000);
  return store.transaction(() => {
    const current = store.get("event", event.id, household);
    if (current.version !== input.version)
      fail(409, "The invitation changed. Refresh the preview first.");
    const people = invitedAdults(store, household, current),
      eligible = [];
    for (const guest of people) {
      const previous = store.get(
        "evite-delivery",
        keyFor(event.id, guest.id),
        household,
      );
      if (
        (mode === "send" && previous) ||
        (mode === "resend-missing" &&
          (!previous || previous.status !== "missing-phone"))
      )
        continue;
      if (
        recipientBlocked(store, household, guest.id) ||
        (guest.phone &&
          store.one("SELECT phone FROM sms_optouts WHERE phone=?", guest.phone))
      ) {
        store.put(
          "evite-delivery",
          keyFor(event.id, guest.id),
          household,
          {
            event: event.id,
            guest: guest.id,
            status: "blocked",
            updated: Date.now(),
          },
          previous?.version,
        );
        continue;
      }
      if (!guest.phone) {
        if (!previous)
          store.put(
            "evite-delivery",
            keyFor(event.id, guest.id),
            household,
            {
              event: event.id,
              guest: guest.id,
              status: "missing-phone",
              updated: Date.now(),
            },
            undefined,
          );
      } else eligible.push({ guest, previous });
    }
    if (!eligible.length) return eviteStatus(store, household, current, env);
    const token = randomBytes(32).toString("base64url"),
      media = store.put("evite-media", hash(token), household, {
        data,
        expires: Date.now() + 30 * 86400000,
      });
    const mediaUrl = new URL("/api/public/evite-media/" + token, origin).href;
    for (const { guest, previous } of eligible)
      store.put(
        "evite-delivery",
        keyFor(event.id, guest.id),
        household,
        {
          event: event.id,
          guest: guest.id,
          phone: guest.phone,
          status: "queued",
          media: media.id,
          mediaUrl,
          message: `${store.household(household).name} invited you to ${event.title}. ${new URL("/h/" + store.household(household).slug, origin).href}`,
          updated: Date.now(),
        },
        previous?.version,
      );
    return eviteStatus(store, household, current, env);
  });
}
export async function runEvites(store, env, { fetcher = fetch } = {}) {
  if (!smsEnabled(env)) return;
  const rows = store.all(
    "SELECT id,household FROM records WHERE kind='evite-delivery' AND json_extract(body,'$.status')='queued'",
  );
  for (const pending of rows) {
    const claim = store.transaction(() => {
      const row = store.get("evite-delivery", pending.id, pending.household);
      if (row?.status !== "queued") return null;
      const event = store.get("event", row.event, pending.household),
        guest = store.get("guest", row.guest, pending.household),
        media = store.get("evite-media", row.media, pending.household);
      if (
        !event?.invited.includes(row.guest) ||
        !guest?.phone ||
        guest.phone !== row.phone ||
        !media ||
        media.expires < Date.now() ||
        recipientBlocked(store, pending.household, row.guest) ||
        store.one("SELECT phone FROM sms_optouts WHERE phone=?", row.phone) ||
        store.one(
          "SELECT household FROM household_deletions WHERE household=?",
          pending.household,
        )
      ) {
        store.put(
          "evite-delivery",
          row.id,
          pending.household,
          { ...row, status: "cancelled", updated: Date.now() },
          row.version,
        );
        return null;
      }
      const phoneId = hash(row.event + ":" + row.phone),
        prior = store.get("evite-phone", phoneId, pending.household);
      if (prior) {
        store.put(
          "evite-delivery",
          row.id,
          pending.household,
          {
            ...row,
            status: prior.status,
            providerId: prior.providerId || null,
            updated: Date.now(),
          },
          row.version,
        );
        return null;
      }
      const phone = store.put("evite-phone", phoneId, pending.household, {
        status: "sending",
        phone: row.phone,
        event: row.event,
        updated: Date.now(),
      });
      store.put(
        "evite-delivery",
        row.id,
        pending.household,
        { ...row, status: "sending", updated: Date.now() },
        row.version,
      );
      return { row, phone };
    });
    if (!claim) continue;
    const result = await sendText(
      env,
      claim.row.phone,
      claim.row.message,
      fetcher,
      { mediaUrl: claim.row.mediaUrl },
    );
    store.transaction(() => {
      const phone = store.get("evite-phone", claim.phone.id, pending.household);
      store.put(
        "evite-phone",
        phone.id,
        pending.household,
        { ...phone, ...result, updated: Date.now() },
        phone.version,
      );
      for (const row of store
        .list("evite-delivery", pending.household)
        .filter(
          (r) =>
            r.event === claim.row.event &&
            r.phone === claim.row.phone &&
            ["queued", "sending"].includes(r.status),
        ))
        store.put(
          "evite-delivery",
          row.id,
          pending.household,
          { ...row, ...result, updated: Date.now() },
          row.version,
        );
    });
  }
}
export function processEviteStatus(store, params) {
  const providerId = params.get("MessageSid"),
    status = params.get("MessageStatus");
  if (
    !providerId ||
    !["sent", "delivered", "failed", "undelivered"].includes(status)
  )
    return;
  for (const kind of ["evite-delivery", "evite-phone"])
    for (const ref of store.all(
      "SELECT id,household FROM records WHERE kind=? AND json_extract(body,'$.providerId')=?",
      kind,
      providerId,
    )) {
      const record = store.get(kind, ref.id, ref.household);
      if (["delivered", "failed", "undelivered"].includes(record.status))
        continue;
      store.put(
        kind,
        ref.id,
        ref.household,
        { ...record, status, updated: Date.now() },
        record.version,
      );
    }
}
export function eviteMedia(store, token) {
  const row = store.one(
    "SELECT household FROM records WHERE kind='evite-media' AND id=?",
    hash(token),
  );
  const record = row && store.get("evite-media", hash(token), row.household);
  if (
    !record ||
    record.expires < Date.now() ||
    store.one(
      "SELECT household FROM household_deletions WHERE household=?",
      row.household,
    )
  )
    fail(404, "Image not found.");
  return record.data;
}
