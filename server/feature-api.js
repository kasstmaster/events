import { fail, text, id } from "./model.js";
import {
  uiConfig,
  hostUI,
  effectiveUI,
  cardInput,
  safeEvent,
} from "./features.js";
import { resolveUI, layouts } from "../public/ui-system.js";
import { reminderRecipients, reminderInput } from "./reminders.js";
import { deletionSummary, requestDeletion } from "./account-deletion.js";
export async function featureAPI({
  path,
  method,
  req,
  res,
  store,
  session,
  requireRole,
  body,
  version,
  json,
  validateEvent,
  env,
}) {
  const owned = (kind, key, household = session.household) => {
    const record = store.get(kind, key, household);
    if (!record) fail(404, "Record not found.");
    return record;
  };
  if (path === "/api/interface" && method === "GET") {
    json(res, {
      ui: effectiveUI(store),
      version: store.get("ui", "defaults", "platform")?.version || 0,
    });
    return true;
  }
  if (path === "/api/admin/households" && method === "GET") {
    requireRole("admin");
    json(
      res,
      store
        .all("SELECT household FROM users WHERE role='host'")
        .filter(
          (h) =>
            !store.one(
              "SELECT household FROM household_deletions WHERE household=?",
              h.household,
            ),
        )
        .map((h) => {
          const record = store.household(h.household);
          return {
            id: record.id,
            name: record.name,
            events: store
              .list("event", record.id)
              .map((e) => ({ id: e.id, title: e.title })),
          };
        }),
    );
    return true;
  }
  if (path === "/api/admin/defaults") {
    requireRole("admin");
    const record = store.get("ui", "defaults", "platform");
    if (method === "GET") {
      json(res, {
        ui: resolveUI(record),
        overrides: record || {},
        version: record?.version || 0,
        layouts,
      });
      return true;
    }
    if (method === "PUT") {
      const input = await body(req),
        expected = version(req);
      const saved = store.transaction(() => {
        const current = store.get("ui", "defaults", "platform");
        if ((current?.version || 0) !== expected)
          fail(409, "Defaults changed. Reload before saving.");
        const next = uiConfig(input);
        if (
          JSON.stringify(current?.design || {}) !== JSON.stringify(next.design)
        ) {
          for (const household of store.all(
            "SELECT id,household FROM records WHERE kind='household'",
          )) {
            const existing = store.household(household.id);
            const preserved = effectiveUI(store, existing).design;
            store.put(
              "household",
              existing.id,
              existing.id,
              { ...existing, design: preserved },
              existing.version,
            );
          }
        }
        return store.put("ui", "defaults", "platform", next, current?.version);
      });
      json(res, saved);
      return true;
    }
  }
  if (path === "/api/admin/preview" && method === "POST") {
    // Preview reads use POST only to keep selected identifiers out of URLs; nothing is persisted.
    requireRole("admin");
    const input = await body(req),
      household = owned(
        "household",
        text(input.household, 100, true),
        input.household,
      );
    const events = store
      .list("event", household.id)
      .filter((e) => !input.event || e.id === input.event)
      .map((e) => ({
        ...safeEvent(e),
        invited: undefined,
        totals: store.totals(e, household.id),
        menu: store.menuView(e, household.id),
        members: [
          { id: "preview", first: "Preview", last: "Guest", suffix: "" },
        ],
        response: { version: 0, attendance: {}, claims: {} },
        ui: effectiveUI(store, household, e),
      }));
    json(res, {
      household: store.publicHousehold(household.slug),
      events,
      guest: { first: "Preview", last: "Guest" },
      defaults: effectiveUI(store).design,
      ui: effectiveUI(store, household),
      preview: true,
    });
    return true;
  }
  const editor = path.match(
    /^\/api\/(admin|host)\/interface\/(household|event)\/([a-zA-Z0-9-]+)$/,
  );
  if (editor) {
    requireRole("host");
    if (editor[1] !== "host")
      fail(403, "Administrators edit page defaults only.");
    const kind = editor[2],
      key = editor[3];
    let household;
    if (session.role === "host") household = session.household;
    else if (kind === "household") household = key;
    else
      household = store.one(
        "SELECT household FROM records WHERE kind='event' AND id=?",
        key,
      )?.household;
    if (!household) fail(404, "Record not found.");
    const record = owned(kind, key, household);
    if (method === "GET") {
      json(res, {
        record,
        ui: effectiveUI(
          store,
          store.household(household),
          kind === "event" ? record : undefined,
        ),
        inherited:
          kind === "household"
            ? effectiveUI(store)
            : effectiveUI(store, store.household(household)),
        overrides: record.ui || {},
        version: record.version,
      });
      return true;
    }
    if (method === "PUT") {
      const input = await body(req);
      let saved = { ...record, ui: hostUI(input.ui, record.ui) };
      saved.design = input.resetDesign
        ? {}
        : { ...record.design, ...saved.ui.design };
      saved.ui.design = {};
      if (input.content) {
        if (kind === "household")
          saved = {
            ...saved,
            name: text(input.content.name ?? record.name, 100, true),
          };
        else
          saved = {
            ...validateEvent(
              { ...record, ...input.content },
              store,
              household,
              record,
            ),
            ui: saved.ui,
            design: saved.design,
          };
      }
      json(res, store.put(kind, key, household, saved, version(req)));
      return true;
    }
  }
  const deletion = path.match(
    /^\/api\/admin\/hosts\/([a-zA-Z0-9-]+)\/deletion$/,
  );
  if (deletion) {
    requireRole("admin");
    if (method === "GET") {
      const summary = deletionSummary(store, deletion[1]);
      json(res, {
        ...summary,
        householdVersion: store.household(summary.household)?.version,
      });
      return true;
    }
    if (method === "POST") {
      json(res, requestDeletion(store, deletion[1], await body(req)), 202);
      return true;
    }
  }
  const library = path.match(
    /^\/api\/(admin\/templates|host\/(?:cards|private-templates))(?:\/([a-zA-Z0-9-]+))?$/,
  );
  if (library) {
    const admin = library[1] === "admin/templates";
    requireRole(admin ? "admin" : "host");
    const kind = admin
        ? "template"
        : library[1] === "host/cards"
          ? "card"
          : "private-template",
      household = admin ? "platform" : session.household,
      key = library[2],
      existing = key ? owned(kind, key, household) : null;
    if (method === "GET") {
      json(res, key ? existing : store.list(kind, household));
      return true;
    }
    if ((method === "POST" && !key) || (method === "PUT" && key)) {
      const input = await body(req);
      let record = cardInput({ ...existing, ...input });
      if (kind === "card") {
        const event = input.event
            ? owned("event", text(input.event, 100), household)
            : null,
          recipient = input.recipient
            ? owned("guest", text(input.recipient, 100), household)
            : null;
        const address = recipient?.address
          ? owned("address", recipient.address, household)
          : null;
        record = {
          ...record,
          event: event?.id || "",
          recipient: recipient?.id || "",
          context: {
            household: { name: store.household(household).name },
            event: event
              ? Object.fromEntries(
                  [
                    "title",
                    "description",
                    "date",
                    "time",
                    "address",
                    "deadline",
                  ].map((k) => [k, event[k]]),
                )
              : {},
            recipient: recipient
              ? {
                  name: [recipient.first, recipient.last, recipient.suffix]
                    .filter(Boolean)
                    .join(" "),
                  first: recipient.first,
                  last: recipient.last,
                  address: address?.lines || "",
                }
              : {},
          },
          sourceTemplate: text(input.sourceTemplate ?? "", 100),
        };
      }
      json(
        res,
        store.put(
          kind,
          key || id(),
          household,
          record,
          key ? version(req) : undefined,
        ),
        key ? 200 : 201,
      );
      return true;
    }
    if (method === "DELETE" && key) {
      if (
        admin &&
        store.one(
          "SELECT id FROM records WHERE kind='event' AND json_extract(body,'$.template')=? LIMIT 1",
          key,
        )
      )
        fail(409, "This template is in use.");
      store.remove(kind, key, household, version(req));
      json(res, { ok: true });
      return true;
    }
  }
  const reminder = path.match(
    /^\/api\/host\/events\/([a-zA-Z0-9-]+)\/reminders$/,
  );
  if (reminder) {
    requireRole("host");
    const event = owned("event", reminder[1]);
    if (method === "GET") {
      json(res, {
        reminders: event.reminders || [],
        configured:
          env?.SMS_ENABLED === "true" &&
          !!env.TWILIO_ACCOUNT_SID &&
          !!env.TWILIO_AUTH_TOKEN &&
          !!env.TWILIO_FROM,
        deliveries: store.all(
          "SELECT reminder,guest,phone,status,error,updated FROM reminder_deliveries WHERE household=? AND event=?",
          session.household,
          event.id,
        ),
      });
      return true;
    }
    if (method === "POST") {
      const input = await body(req),
        reminders = reminderInput(input.reminders);
      json(res, {
        previews: reminders.map((r) => ({
          ...r,
          recipients: reminderRecipients(
            store,
            session.household,
            event,
            r,
          ).map((g) => ({ name: [g.first, g.last].join(" "), phone: g.phone })),
        })),
      });
      return true;
    }
    if (method === "PUT") {
      const input = await body(req);
      json(
        res,
        store.put(
          "event",
          event.id,
          session.household,
          { ...event, reminders: reminderInput(input.reminders) },
          version(req),
        ),
      );
      return true;
    }
  }
  return false;
}
