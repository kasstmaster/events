import { featureAPI } from "./feature-api.js";
import {
  uiConfig,
  hostUI,
  effectiveUI,
  webURL,
  contactPhone,
} from "./features.js";
import {
  reminderInput,
  cancelReminders,
  verifyTwilio,
  processTwilio,
} from "./reminders.js";
import { suggestLabel } from "./household-domains.js";
import { Buffer } from "node:buffer";
import { createHash, timingSafeEqual } from "node:crypto";
import QRCode from "qrcode";
import { householdLink, hostnameLabel } from "./household-domains.js";
import {
  Problem,
  fail,
  text,
  email,
  normalizeName,
  checkPassword,
  id,
  image,
  design,
  defaults,
} from "./model.js";
const files = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  [
    "/household-address.js",
    ["household-address.js", "text/javascript; charset=utf-8"],
  ],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/style.css", ["style.css", "text/css; charset=utf-8"]],
  ...[
    "editor-tools.js",
    "ui-system.js",
    "ui-runtime.js",
    "ui-copy.js",
    "icons.js",
    "card-system.js",
    "reminder-time.js",
  ].map((file) => ["/" + file, [file, "text/javascript; charset=utf-8"]]),
]);
const date = (value) => {
  const result = text(value ?? "", 10);
  if (
    result &&
    (!/^\d{4}-\d{2}-\d{2}$/.test(result) ||
      Number.isNaN(Date.parse(result + "T12:00:00Z")) ||
      new Date(result + "T12:00:00Z").toISOString().slice(0, 10) !== result)
  )
    fail(400, "Choose a valid date.");
  return result;
};
const version = (req) => {
  const raw = req.headers["if-match"];
  if (!/^\d+$/.test(raw || "")) fail(428, "A record version is required.");
  return Number(raw);
};
async function body(req) {
  if (!(req.headers["content-type"] || "").startsWith("application/json"))
    fail(415, "Send JSON data.");
  let size = 0,
    parts = [];
  for await (const part of req) {
    size += part.length;
    if (size > 8_000_000) fail(413, "This upload is too large.");
    parts.push(part);
  }
  try {
    const result = JSON.parse(Buffer.concat(parts).toString());
    if (!result || typeof result !== "object" || Array.isArray(result))
      fail(400, "Invalid request.");
    return result;
  } catch (error) {
    if (error instanceof Problem) throw error;
    fail(400, "Invalid JSON.");
  }
}
function guestInput(input, store, household, existing) {
  const parent = text(input.parent ?? "", 100),
    address = text(input.address ?? "", 100);
  if (parent) {
    const adult = store.get("guest", parent, household);
    if (!adult || adult.parent || parent === existing?.id)
      fail(400, "Choose an adult in your household.");
  }
  if (
    existing &&
    parent !== existing.parent &&
    store.list("guest", household).some((g) => g.parent === existing.id)
  )
    fail(400, "Move this adult’s children first.");
  if (
    existing &&
    parent !== existing.parent &&
    store.list("event", household).some((e) => e.invited.includes(existing.id))
  )
    fail(
      409,
      "Remove this guest from event invitations before changing their adult association.",
    );
  if (address && !store.get("address", address, household))
    fail(400, "Choose an address in your household.");
  return {
    first: text(input.first, 80, true),
    phone: contactPhone(input.phone ?? existing?.phone ?? ""),
    smsConsent:
      input.smsConsent === true ||
      (input.smsConsent === undefined && existing?.smsConsent === true),
    consentRecorded:
      input.smsConsent === true
        ? new Date().toISOString()
        : existing?.consentRecorded || null,
    last: text(input.last, 80, true),
    suffix: text(input.suffix ?? "", 30),
    parent,
    address,
  };
}
function eventInput(input, store, household, existing) {
  if (
    !Array.isArray(input.invited) ||
    input.invited.length > 10000 ||
    new Set(input.invited).size !== input.invited.length
  )
    fail(400, "Choose invited guests.");
  const guests = store.list("guest", household),
    available = new Map(guests.map((g) => [g.id, g]));
  for (const key of input.invited) {
    const guest = available.get(key);
    if (!guest || (guest.parent && !input.invited.includes(guest.parent)))
      fail(400, "Invite each child with their designated adult.");
  }
  if (!Array.isArray(input.menu) || input.menu.length > 500)
    fail(400, "Invalid menu.");
  const menu = input.menu.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item))
      fail(400, "Invalid menu item.");
    if (
      !Number.isInteger(item.quantity) ||
      item.quantity < 1 ||
      item.quantity > 10000 ||
      !["potluck", "drink"].includes(item.kind)
    )
      fail(400, "Menu quantities must be between 1 and 10,000.");
    const key = item.id || id();
    if (
      typeof key !== "string" ||
      !/^[a-zA-Z0-9-]{1,80}$/.test(key) ||
      Object.hasOwn(Object.prototype, key)
    )
      fail(400, "Invalid item.");
    return {
      id: key,
      name: text(item.name, 160, true),
      quantity: item.quantity,
      kind: item.kind,
    };
  });
  if (new Set(menu.map((m) => m.id)).size !== menu.length)
    fail(400, "Menu items must have unique identifiers.");
  if (existing) {
    for (const response of store
      .list("response", household)
      .filter((r) => r.event === existing.id)) {
      if (
        Object.keys(response.attendance).some(
          (key) => !input.invited.includes(key),
        )
      )
        fail(409, "Guests with an RSVP must remain invited.");
      if (
        Object.keys(response.claims).some(
          (key) => !menu.some((m) => m.id === key),
        )
      )
        fail(
          409,
          "Items with claims cannot be removed. Keep them or have guests release their claims.",
        );
    }
  }
  const registries = input.registries ?? [];
  if (!Array.isArray(registries) || registries.length > 50)
    fail(400, "Use up to 50 registries per event.");
  const savedRegistries = registries.map((registry) => {
    if (!registry || typeof registry !== "object" || Array.isArray(registry))
      fail(400, "Invalid registry.");
    const title = text(registry.title, 100, true),
      raw = text(registry.url, 2048, true);
    let link;
    try {
      link = new URL(raw);
    } catch {
      fail(400, "Enter a complete registry URL.");
    }
    if (
      !["https:", "http:"].includes(link.protocol) ||
      link.username ||
      link.password
    )
      fail(
        400,
        "Registry links must use HTTP or HTTPS without embedded credentials.",
      );
    const key = text(registry.id || id(), 100, true);
    if (!/^[a-zA-Z0-9-]{1,100}$/.test(key))
      fail(400, "Invalid registry identifier.");
    return { id: key, title, url: link.href };
  });
  if (new Set(savedRegistries.map((r) => r.id)).size !== savedRegistries.length)
    fail(400, "Registry identifiers must be unique.");
  const template = text(input.template ?? "", 100);
  if (template && !store.get("template", template, "platform"))
    fail(400, "Choose an available template.");
  return {
    title: text(input.title, 160, true),
    description: text(input.description ?? "", 5000),
    date: date(input.date),
    time: text(input.time ?? "", 100),
    address: text(input.address ?? "", 500),
    deadline: date(input.deadline),
    icon: image(input.icon),
    design: design(input.design),
    invited: input.invited,
    menu,
    template,
    notes: text(input.notes ?? existing?.notes ?? "", 20000),
    uploadURL: webURL(input.uploadURL ?? existing?.uploadURL ?? ""),
    ui:
      input.ui === undefined
        ? existing?.ui || {}
        : hostUI(input.ui, existing?.ui),
    reminders: reminderInput(input.reminders ?? existing?.reminders ?? []),
    registries: savedRegistries,
  };
}
export function createHandler({
  store,
  readAsset,
  origin = "http://127.0.0.1:3000",
  secureCookies = new URL(origin).protocol === "https:",
  logger = console,
  setupSecret = "",
  setupEmail = "",
  requireAdmin = false,
  env = {},
  householdHostname = "",
  householdHosts = new Set(),
  canonicalOrigin = origin,
} = {}) {
  if (new URL(origin).origin !== origin)
    throw new Error(
      "APP_ORIGIN must be a canonical origin without a path or trailing slash.",
    );
  const cookie = (res, session) =>
    res.setHeader(
      "Set-Cookie",
      `${householdHostname ? "__Host-events_session" : "events_session"}=${session?.token || ""}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${session?.seconds || 0}${secureCookies ? "; Secure" : ""}`,
    );
  const json = (res, data, status = 200) => {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
    });
    res.end(JSON.stringify(data));
  };
  return async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (secureCookies)
      res.setHeader("Strict-Transport-Security", "max-age=31536000");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
    );
    try {
      const url = new URL(req.url, origin),
        path = url.pathname,
        method = req.method;
      // This context comes only from a verified runtime adapter, never a client header.
      const selected = householdHostname
        ? store.hostnameHousehold(hostnameLabel(householdHostname))
        : null;
      const presentHousehold = (household) => ({
        ...household,
        shareUrl: householdLink(household, canonicalOrigin, householdHosts),
        platformUrl: canonicalOrigin + "/",
        subdomainStatus: !household.subdomain
          ? "unclaimed"
          : householdHosts.has(`${household.subdomain}.ilymmd.com`)
            ? "active"
            : "pending",
      });
      if (selected && (path === "/setup" || path === "/api/setup")) {
        if (method === "GET" && path === "/api/setup") {
          json(res, { required: false, enabled: false });
          return;
        }
        fail(404, "This household address is unavailable.");
      }
      const pageSlug = path.match(/^\/h\/([A-Za-z0-9_-]+)$/)?.[1];
      if (selected && pageSlug && pageSlug !== selected.slug)
        fail(404, "This household address is unavailable.");
      if (method === "GET" && !path.startsWith("/api/")) {
        const entry =
          files.get(path) ||
          (path === "/setup" ? files.get("/") : null) ||
          (/^\/h\/[A-Za-z0-9_-]+$/.test(path) ? files.get("/") : null);
        if (!entry) fail(404, "Page not found.");
        res.writeHead(200, { "Content-Type": entry[1] });
        res.end(await readAsset(entry[0]));
        return;
      }
      if (!["GET", "POST", "PUT", "DELETE"].includes(method))
        fail(405, "Method not allowed.");
      if (path === "/api/messaging/twilio" && method === "POST") {
        let size = 0,
          parts = [];
        for await (const part of req) {
          size += part.length;
          if (size > 64000) fail(413, "Webhook too large.");
          parts.push(part);
        }
        const params = new URLSearchParams(Buffer.concat(parts).toString());
        if (
          !verifyTwilio(
            origin + req.url,
            params,
            req.headers["x-twilio-signature"],
            env.TWILIO_AUTH_TOKEN,
          )
        )
          fail(403, "Invalid webhook signature.");
        processTwilio(store, params);
        res.writeHead(200, { "Content-Type": "text/xml" });
        res.end("<Response/>");
        return;
      }
      if (method !== "GET" && req.headers.origin !== origin)
        fail(403, "Please use the application’s own page to submit changes.");
      if (path === "/api/setup") {
        const required = !store.adminSetupComplete();
        const enabled =
          typeof setupSecret === "string" &&
          setupSecret.length >= 32 &&
          setupSecret.length <= 256;
        if (method === "GET") {
          json(res, { required, enabled: required && enabled });
          return;
        }
        if (method === "POST") {
          if (!required) fail(410, "Administrator setup is already complete.");
          if (!enabled)
            fail(
              503,
              "Administrator setup is not enabled. The owner must configure ADMIN_SETUP_TOKEN.",
            );
          store.limit("setup-ip:" + req.socket.remoteAddress, 5);
          store.limit("setup-global", 20);
          const input = await body(req),
            token = text(input.token, 256, true);
          const digest = (value) => createHash("sha256").update(value).digest();
          if (!timingSafeEqual(digest(token), digest(setupSecret)))
            fail(403, "Unable to authorize administrator setup.");
          if (setupEmail && email(input.email) !== email(setupEmail))
            fail(403, "Unable to authorize administrator setup.");
          if (input.password !== input.confirmPassword)
            fail(400, "The passwords must match.");
          const account = await store.setupAdmin(input.email, input.password);
          cookie(res, store.newSession(account, origin));
          json(res, { ok: true }, 201);
          return;
        }
        fail(405, "Method not allowed.");
      }
      if (requireAdmin && !store.adminSetupComplete())
        fail(503, "Administrator setup is pending. Open /setup to continue.");
      const raw = req.headers.cookie
        ?.split(";")
        .map((p) => p.trim())
        .find((p) =>
          p.startsWith(
            `${selected ? "__Host-events_session" : "events_session"}=`,
          ),
        )
        ?.split("=")[1];
      const session = store.session(raw, origin, !selected);
      if (
        selected &&
        session &&
        (session.role === "admin" || session.household !== selected.id)
      )
        fail(403, "This account is not available at this household address.");
      const newSession = (account) => store.newSession(account, origin);
      const requireRole = (role) => {
        if (!session) fail(401, "Please sign in.");
        if (session.role !== role)
          fail(403, "This action is not available to your account.");
      };
      const owned = (kind, key) => {
        const item = store.get(kind, key, session.household);
        if (!item) fail(404, "Record not found.");
        return item;
      };
      const authLimit = (scope, input) => {
        // Trust the TCP peer, not attacker-controlled forwarding headers. Configure a trusted edge before Internet use.
        store.limit(`ip:${scope}:${req.socket.remoteAddress}`, 30);
        store.limit(
          `account:${scope}:${createHash("sha256").update(input).digest("hex")}`,
          10,
        );
      };
      if (
        await featureAPI({
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
          validateEvent: eventInput,
          env,
        })
      )
        return;
      if (path === "/api/session" && method === "GET") {
        json(
          res,
          session
            ? {
                role: session.role,
                household: session.household
                  ? presentHousehold(store.household(session.household))
                  : null,
              }
            : { role: null },
        );
        return;
      }
      if (path === "/api/register" && method === "POST") {
        if (selected) fail(403, "Create host accounts on the main platform.");
        const input = await body(req);
        authLimit("register", String(input.email).toLowerCase());
        const account = await store.register(input);
        cookie(res, store.newSession(account, origin));
        json(res, { ok: true }, 201);
        return;
      }
      if (path === "/api/login" && method === "POST") {
        const input = await body(req),
          address = email(input.email);
        authLimit("login", address);
        const user = store.one("SELECT * FROM users WHERE email=?", address);
        const valid = await checkPassword(input.password, user?.password);
        if (
          !valid ||
          !user ||
          (user.household &&
            store.one(
              "SELECT household FROM household_deletions WHERE household=?",
              user.household,
            ))
        )
          fail(401, "Unable to sign in with these details.");
        if (
          selected &&
          (user.role !== "host" || user.household !== selected.id)
        )
          fail(401, "Unable to sign in with these details.");
        cookie(
          res,
          newSession({
            user: user.id,
            household: user.household,
            role: user.role,
          }),
        );
        json(res, { ok: true });
        return;
      }
      if (path === "/api/logout" && method === "POST") {
        if (session)
          store.run("DELETE FROM sessions WHERE token=?", session.token);
        cookie(res, null);
        json(res, { ok: true });
        return;
      }
      if (path === "/api/public/context" && method === "GET") {
        json(res, {
          household: selected
            ? {
                ...selected,
                defaults: effectiveUI(store).design,
                ui: effectiveUI(store, store.household(selected.id)),
              }
            : null,
        });
        return;
      }
      if (path === "/api/subdomains" && method === "GET") {
        store.limit(`availability:${req.socket.remoteAddress}`, 120);
        const fromName = url.searchParams.has("householdName");
        const name = fromName
          ? suggestLabel(
              (url.searchParams.get("householdName") || "").slice(0, 100),
            )
          : url.searchParams.get("name");
        json(res, {
          available: store.domainAvailable(
            name,
            fromName
              ? null
              : session?.role === "host"
                ? session.household
                : null,
          ),
          ...(fromName ? { suggested: name, status: "pending" } : {}),
        });
        return;
      }
      const publicMatch = path.match(
        /^\/api\/public\/households\/([A-Za-z0-9_-]+)(\/login)?$/,
      );
      if (publicMatch) {
        const household = store.publicHousehold(publicMatch[1]);
        if (selected && selected.id !== household.id)
          fail(404, "This household address is unavailable.");
        if (method === "GET" && !publicMatch[2]) {
          json(res, {
            ...household,
            defaults: effectiveUI(store).design,
            ui: effectiveUI(store, store.household(household.id)),
          });
          return;
        }
        if (method === "POST" && publicMatch[2]) {
          const input = await body(req),
            first = normalizeName(text(input.first, 80, true)),
            last = normalizeName(text(input.last, 80, true)),
            suffix = normalizeName(text(input.suffix ?? "", 30));
          authLimit("guest", `${household.id}:${first}:${last}`);
          const candidates = store
            .list("guest", household.id)
            .filter(
              (g) =>
                !g.parent &&
                normalizeName(g.first) === first &&
                normalizeName(g.last) === last &&
                normalizeName(g.suffix) === suffix,
            );
          if (candidates.length !== 1)
            fail(
              401,
              "Unable to sign in with these details. Check with your host.",
            );
          cookie(
            res,
            newSession({
              household: household.id,
              guest: candidates[0].id,
              role: "guest",
            }),
          );
          json(res, { ok: true });
          return;
        }
      }
      if (path.startsWith("/api/admin")) {
        requireRole("admin");
        if (path === "/api/admin" && method === "GET") {
          json(res, {
            approvals: store.all("SELECT email,created FROM approvals"),
            templates: store.list("template", "platform"),
            deletions: store.all(
              "SELECT household,email,label,phase,error FROM household_deletions",
            ),
            hosts: store.all(
              "SELECT id,email,household FROM users WHERE role='host'",
            ),
          });
          return;
        }
        if (path === "/api/admin/approvals" && method === "POST") {
          const input = await body(req),
            address = email(input.email);
          if (store.one("SELECT id FROM users WHERE email=?", address))
            fail(409, "That account already exists.");
          store.run(
            "INSERT OR IGNORE INTO approvals VALUES(?,?)",
            address,
            new Date().toISOString(),
          );
          json(res, { ok: true }, 201);
          return;
        }
        if (path === "/api/admin/approvals" && method === "DELETE") {
          store.run(
            "DELETE FROM approvals WHERE email=?",
            email((await body(req)).email),
          );
          json(res, { ok: true });
          return;
        }
      }
      if (path === "/api/templates" && method === "GET") {
        if (!session) fail(401, "Please sign in.");
        json(res, store.list("template", "platform"));
        return;
      }
      if (path.startsWith("/api/host")) {
        requireRole("host");
        const household = session.household;
        if (path === "/api/host" && method === "GET") {
          json(res, {
            household: presentHousehold(store.household(household)),
            guests: store.list("guest", household),
            addresses: store.list("address", household),
            events: store.list("event", household).map((e) => ({
              ...e,
              menu: store.menuView(e, household),
              totals: store.totals(e, household),
              ui: effectiveUI(store, store.household(household), e),
            })),
            templates: store.list("template", "platform"),
            defaults: effectiveUI(store).design,
            ui: effectiveUI(store, store.household(household)),
          });
          return;
        }
        if (path === "/api/host/household" && method === "PUT") {
          const input = await body(req);
          json(
            res,
            presentHousehold(
              store.updateHousehold(
                household,
                {
                  ...input,
                  ui:
                    input.ui === undefined
                      ? store.household(household)?.ui || {}
                      : hostUI(input.ui, store.household(household)?.ui),
                },
                version(req),
              ),
            ),
          );
          return;
        }
        if (path === "/api/host/qr" && method === "GET") {
          const link = householdLink(
            store.household(household),
            canonicalOrigin,
            householdHosts,
          );
          res.writeHead(200, {
            "Content-Type": "image/svg+xml",
            "Content-Disposition": 'inline; filename="household-qr.svg"',
          });
          res.end(
            await QRCode.toString(link, {
              type: "svg",
              margin: 4,
              errorCorrectionLevel: "M",
            }),
          );
          return;
        }
        const match = path.match(
          /^\/api\/host\/(guests|addresses|events)(?:\/([a-zA-Z0-9-]+))?(\/dashboard)?$/,
        );
        if (match) {
          const kind = {
              guests: "guest",
              addresses: "address",
              events: "event",
            }[match[1]],
            key = match[2],
            existing = key ? owned(kind, key) : null;
          if (method === "GET" && kind === "event" && match[3]) {
            json(res, {
              event: existing,
              totals: store.totals(existing, household),
              guests: store
                .list("guest", household)
                .filter((g) => existing.invited.includes(g.id)),
              responses: store
                .list("response", household)
                .filter((r) => r.event === key),
              menu: store.menuView(existing, household),
            });
            return;
          }
          if (
            (method === "POST" && !key) ||
            (method === "PUT" && key && !match[3])
          ) {
            const input = await body(req),
              record =
                kind === "guest"
                  ? guestInput(input, store, household, existing)
                  : kind === "address"
                    ? {
                        label: text(input.label, 100, true),
                        lines: text(input.lines ?? "", 500),
                        phone: contactPhone(
                          input.phone ?? existing?.phone ?? "",
                        ),
                      }
                    : eventInput(input, store, household, existing);
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
            return;
          }
          if (method === "DELETE" && key && !match[3]) {
            store.transaction(() => {
              if (kind === "guest") {
                if (
                  store
                    .list("guest", household)
                    .some((g) => g.parent === key) ||
                  store
                    .list("event", household)
                    .some((e) => e.invited.includes(key))
                )
                  fail(
                    409,
                    "Remove this guest’s children and event invitations first.",
                  );
                store.run(
                  "DELETE FROM sessions WHERE household=? AND guest=?",
                  household,
                  key,
                );
              }
              if (
                kind === "address" &&
                store.list("guest", household).some((g) => g.address === key)
              )
                fail(409, "Unassign this address from guests first.");
              store.remove(kind, key, household, version(req));
              if (kind === "event") cancelReminders(store, household, key);
              if (kind === "event")
                for (const r of store
                  .list("response", household)
                  .filter((r) => r.event === key))
                  store.remove("response", r.id, household, r.version);
            });
            json(res, { ok: true });
            return;
          }
        }
      }
      if (path.startsWith("/api/guest")) {
        requireRole("guest");
        if (path === "/api/guest" && method === "GET") {
          const guest = owned("guest", session.guest);
          json(res, {
            household: store.publicHousehold(
              store.household(session.household).slug,
            ),
            guest: {
              id: guest.id,
              first: guest.first,
              last: guest.last,
              suffix: guest.suffix,
            },
            events: store
              .list("event", session.household)
              .filter((e) => e.invited.includes(session.guest))
              .map((e) => ({
                ...store.guestEvent(e, session),
                ui: effectiveUI(store, store.household(session.household), e),
              })),
            defaults: effectiveUI(store).design,
            ui: effectiveUI(store, store.household(session.household)),
          });
          return;
        }
        const match = path.match(
          /^\/api\/guest\/events\/([a-zA-Z0-9-]+)\/rsvp$/,
        );
        if (match && method === "PUT") {
          const event = owned("event", match[1]);
          if (!event.invited.includes(session.guest))
            fail(404, "Event not found.");
          json(res, store.saveResponse(event, session, await body(req)));
          return;
        }
      }
      fail(404, "Page not found.");
    } catch (error) {
      if (!(error instanceof Problem))
        logger.error("Request failed:", error.code || error.name); // Never log submitted names, passwords or bodies.
      if (
        !res.headersSent &&
        householdHostname &&
        req.method === "GET" &&
        !req.url.startsWith("/api/")
      ) {
        res.writeHead(error.status || 500, {
          "Content-Type": "text/html; charset=utf-8",
        });
        res.end(
          "<!doctype html><html lang=en><meta name=viewport content='width=device-width, initial-scale=1'><title>Household unavailable</title><h1>This household address is unavailable.</h1><p>Please check the link with your host.</p></html>",
        );
      } else if (!res.headersSent)
        json(
          res,
          {
            error:
              error instanceof Problem
                ? error.message
                : "Something went wrong. Please try again.",
          },
          error.status || 500,
        );
      else res.end();
    }
  };
}
