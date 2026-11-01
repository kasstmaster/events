import { roleDefaults, resolveUI } from "../public/ui-system.js";
import { Buffer } from "node:buffer";
import {
  randomBytes,
  randomUUID,
  scrypt as scryptCallback,
  timingSafeEqual,
  createHash,
} from "node:crypto";
import { promisify } from "node:util";
import { normalizeLabel, suggestLabel } from "./household-domains.js";
const scrypt = promisify(scryptCallback);
export const id = () => randomUUID();
export class Problem extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
export const fail = (status, message) => {
  throw new Problem(status, message);
};
export const text = (value, max = 200, required = false) => {
  if (
    typeof value !== "string" ||
    value.length > max ||
    (required && !value.trim())
  )
    fail(400, "Please check the supplied fields.");
  return value.trim();
};
export const email = (value) => {
  const result = text(value, 254, true).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result))
    fail(400, "Enter a valid email address.");
  return result;
};
export const normalizeName = (value) =>
  value
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/\s+/g, " ");
export async function hashPassword(password) {
  if (
    typeof password !== "string" ||
    password.length < 12 ||
    password.length > 256
  )
    fail(400, "Use a password between 12 and 256 characters.");
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${(await scrypt(password, salt, 64)).toString("hex")}`;
}
const dummyHash = `${"0".repeat(32)}:${"0".repeat(128)}`;
export async function checkPassword(password, stored = dummyHash) {
  const [salt, expected] = stored.split(":");
  const actual = await scrypt(
    typeof password === "string" && password.length <= 256 ? password : "",
    salt,
    64,
  );
  return timingSafeEqual(actual, Buffer.from(expected, "hex"));
}
export const defaults = Object.freeze(roleDefaults);
export function image(value) {
  const source = text(value ?? "", 2_800_000);
  if (
    source &&
    !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(source)
  )
    fail(400, "Upload a PNG, JPEG or WebP image (up to 2 MB).");
  if (source && Buffer.from(source.split(",")[1], "base64").length > 2_000_000)
    fail(400, "Image must be 2 MB or smaller.");
  return source;
}
export function design(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(400, "Invalid appearance.");
  const result = {};
  for (const [key, val] of Object.entries(value)) {
    if (!(key in defaults)) fail(400, "Unknown appearance setting.");
    if (key === "backgroundImage") result[key] = image(val);
    else if (
      key.endsWith("Color") ||
      key.endsWith("Background") ||
      ["background", "container", "buttonText"].includes(key)
    ) {
      if (!/^#[0-9a-f]{6}$/i.test(val)) fail(400, "Choose a valid color.");
      result[key] = val;
    } else if (key.endsWith("Font")) {
      if (
        ![
          "Georgia",
          "system-ui",
          "Arial",
          "Verdana",
          "Times New Roman",
        ].includes(val)
      )
        fail(400, "Choose a supported font.");
      result[key] = val;
    } else {
      const [min, max] =
        key === "opacity"
          ? [35, 100]
          : key === "titleSize"
            ? [22, 64]
            : [14, 28];
      if (!Number.isInteger(val) || val < min || val > max)
        fail(400, "Appearance value is out of range.");
      result[key] = val;
    }
  }
  return result;
}
export class Store {
  constructor(database) {
    this.db = database;
    this.transactionDepth = 0;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','host')), household TEXT);
      CREATE TABLE IF NOT EXISTS household_deletions(household TEXT PRIMARY KEY,user TEXT NOT NULL,email TEXT NOT NULL,label TEXT NOT NULL,phase TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_attempt INTEGER NOT NULL DEFAULT 0,error TEXT);
      CREATE TABLE IF NOT EXISTS reminder_deliveries(id TEXT PRIMARY KEY,household TEXT NOT NULL,event TEXT NOT NULL,reminder TEXT NOT NULL,guest TEXT NOT NULL,phone TEXT NOT NULL,status TEXT NOT NULL,provider_id TEXT,error TEXT,updated INTEGER NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS reminder_guest_once ON reminder_deliveries(event,reminder,guest);
      CREATE TABLE IF NOT EXISTS guest_identity_links(household TEXT NOT NULL,guest TEXT NOT NULL,identity TEXT NOT NULL,linked INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(household,guest));
      CREATE INDEX IF NOT EXISTS identity_guests ON guest_identity_links(identity);
      CREATE TABLE IF NOT EXISTS guest_identity_history(household TEXT NOT NULL,guest TEXT NOT NULL,position INTEGER NOT NULL,identity TEXT NOT NULL,linked INTEGER NOT NULL,PRIMARY KEY(household,guest,position));
      CREATE TABLE IF NOT EXISTS guest_identity_sessions(token TEXT PRIMARY KEY,identity TEXT NOT NULL,entry_household TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS family_members(id TEXT PRIMARY KEY,household TEXT NOT NULL,login TEXT NOT NULL COLLATE NOCASE,name TEXT NOT NULL,password TEXT NOT NULL,role TEXT NOT NULL,disabled INTEGER NOT NULL DEFAULT 0,version INTEGER NOT NULL DEFAULT 1,UNIQUE(household,login));
      CREATE TABLE IF NOT EXISTS family_owners(household TEXT PRIMARY KEY,owner TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sms_optouts(phone TEXT PRIMARY KEY,created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS setup_state(id INTEGER PRIMARY KEY CHECK(id=1), completed INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS approvals(email TEXT PRIMARY KEY, created TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS records(kind TEXT NOT NULL, id TEXT NOT NULL, household TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, body TEXT NOT NULL, PRIMARY KEY(kind,id));
      CREATE INDEX IF NOT EXISTS tenant_records ON records(household,kind);
      CREATE UNIQUE INDEX IF NOT EXISTS guest_code_hash ON records(json_extract(body,'$.codeHash')) WHERE kind='guest-identity';
      CREATE UNIQUE INDEX IF NOT EXISTS household_slugs ON records(json_extract(body,'$.slug')) WHERE kind='household';
      CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user TEXT, household TEXT, guest TEXT, role TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS session_origins(token TEXT PRIMARY KEY, origin TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS gateway_nonces(nonce TEXT PRIMARY KEY, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS household_domains(label TEXT PRIMARY KEY COLLATE NOCASE, household TEXT NOT NULL, retired INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS household_routing(label TEXT PRIMARY KEY COLLATE NOCASE, household TEXT NOT NULL, id TEXT NOT NULL, probe TEXT NOT NULL, phase TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL DEFAULT 0, dns_id TEXT, route_id TEXT, error TEXT, verified_at INTEGER);
      CREATE TABLE IF NOT EXISTS limits(key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS record_chunks(kind TEXT NOT NULL, id TEXT NOT NULL, household TEXT NOT NULL, chunk INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(kind,id,household,chunk));`);
  }
  all(sql, ...args) {
    return this.db.prepare(sql).all(...args);
  }
  one(sql, ...args) {
    return this.db.prepare(sql).get(...args);
  }
  run(sql, ...args) {
    return this.db.prepare(sql).run(...args);
  }
  transaction(callback) {
    if (this.transactionDepth) return callback();
    this.transactionDepth++;
    try {
      if (this.db.transaction) return this.db.transaction(callback);
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const result = callback();
        this.db.exec("COMMIT");
        return result;
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    } finally {
      this.transactionDepth--;
    }
  }
  unpack(row) {
    if (!row) return null;
    let body = JSON.parse(row.body);
    if (body.$chunked)
      body = JSON.parse(
        this.all(
          "SELECT body FROM record_chunks WHERE kind=? AND id=? AND household=? ORDER BY chunk",
          row.kind,
          row.id,
          row.household,
        )
          .map((chunk) => chunk.body)
          .join(""),
      );
    return { ...body, id: row.id, version: row.version };
  }
  get(kind, recordId, household) {
    return this.unpack(
      this.one(
        "SELECT * FROM records WHERE kind=? AND id=? AND household=?",
        kind,
        recordId,
        household,
      ),
    );
  }
  list(kind, household) {
    return this.all(
      "SELECT * FROM records WHERE kind=? AND household=? ORDER BY rowid",
      kind,
      household,
    ).map((row) => this.unpack(row));
  }
  put(kind, recordId, household, body, version) {
    return this.transaction(() => {
      const serialized = JSON.stringify(body),
        chunked = serialized.length > 250000;
      const stored = chunked
        ? JSON.stringify({
            $chunked: true,
            ...(kind === "household" ? { slug: body.slug } : {}),
            ...(kind === "event" ? { template: body.template } : {}),
            ...(kind === "family-record"
              ? { type: body.type, cancelled: body.cancelled || false }
              : {}),
            ...(kind === "family-file"
              ? {
                  size: body.size,
                  record: body.record,
                  name: body.name,
                  mime: body.mime,
                }
              : {}),
          })
        : serialized;
      if (version === undefined)
        this.run(
          "INSERT INTO records(kind,id,household,body) VALUES(?,?,?,?)",
          kind,
          recordId,
          household,
          stored,
        );
      else if (
        !this.run(
          "UPDATE records SET body=?,version=version+1 WHERE kind=? AND id=? AND household=? AND version=?",
          stored,
          kind,
          recordId,
          household,
          version,
        ).changes
      )
        fail(
          409,
          "This changed on another device. Reload the latest version before saving.",
        );
      this.run(
        "DELETE FROM record_chunks WHERE kind=? AND id=? AND household=?",
        kind,
        recordId,
        household,
      );
      if (chunked) {
        let offset = 0,
          index = 0;
        while (offset < serialized.length) {
          let end = Math.min(offset + 250000, serialized.length);
          const last = serialized.charCodeAt(end - 1);
          if (end < serialized.length && last >= 0xd800 && last <= 0xdbff)
            end--;
          this.run(
            "INSERT INTO record_chunks VALUES(?,?,?,?,?)",
            kind,
            recordId,
            household,
            index++,
            serialized.slice(offset, end),
          );
          offset = end;
        }
      }
      return this.get(kind, recordId, household);
    });
  }
  remove(kind, recordId, household, version) {
    return this.transaction(() => {
      if (
        !this.run(
          "DELETE FROM records WHERE kind=? AND id=? AND household=? AND version=?",
          kind,
          recordId,
          household,
          version,
        ).changes
      )
        fail(409, "This changed on another device. Reload before removing.");
      this.run(
        "DELETE FROM record_chunks WHERE kind=? AND id=? AND household=?",
        kind,
        recordId,
        household,
      );
    });
  }
  household(household) {
    return this.get("household", household, household);
  }
  domainAvailable(value, household = null) {
    const label = normalizeLabel(value);
    if (!label) return false;
    const claim = this.one(
      "SELECT * FROM household_domains WHERE label=?",
      label,
    );
    return !claim || (claim.household === household && !claim.retired);
  }
  routingClaim(label, household) {
    const claim = this.one(
      "SELECT * FROM household_domains WHERE label=? AND household=? AND retired=0",
      label,
      household,
    );
    return !!claim && this.household(household)?.subdomain === label;
  }
  routingJob(label) {
    return this.one("SELECT * FROM household_routing WHERE label=?", label);
  }
  nextRoutingJob(now) {
    return this.one(
      "SELECT * FROM household_routing WHERE phase NOT IN ('active','deleting') AND next_attempt<=? ORDER BY next_attempt,label LIMIT 1",
      now,
    );
  }
  routingDue() {
    return this.one(
      "SELECT min(next_attempt) AS due FROM household_routing WHERE phase NOT IN ('active','deleting')",
    )?.due;
  }
  routingReceipt(label, receipt) {
    this.run(
      "UPDATE household_routing SET dns_id=COALESCE(?,dns_id), route_id=COALESCE(?,route_id) WHERE label=?",
      receipt.dns_id || null,
      receipt.route_id || null,
      label,
    );
  }
  routingPhase(label, phase) {
    this.run(
      "UPDATE household_routing SET phase=? WHERE label=?",
      phase,
      label,
    );
  }
  retryRouting(label, code, now) {
    const attempts = (this.routingJob(label)?.attempts || 0) + 1;
    this.run(
      "UPDATE household_routing SET phase='pending', attempts=?, next_attempt=?, error=? WHERE label=?",
      attempts,
      now + Math.min(3600000, 30000 * 2 ** Math.min(attempts - 1, 7)),
      code,
      label,
    );
  }
  activateRouting(label, household, now) {
    this.transaction(() => {
      if (!this.routingClaim(label, household))
        fail(409, "Household address unavailable.");
      this.run(
        "UPDATE household_routing SET phase='active', verified_at=?, error=NULL WHERE label=? AND household=?",
        now,
        label,
        household,
      );
    });
  }
  activeRoutingHosts() {
    return this.all(
      "SELECT label,household FROM household_routing WHERE phase='active'",
    )
      .filter((j) => this.routingClaim(j.label, j.household))
      .map((j) => `${j.label}.ilymmd.com`);
  }
  routingAllowed(label, probe) {
    const job = this.routingJob(label);
    if (!job || !this.routingClaim(label, job.household)) return false;
    return (
      job.phase === "active" ||
      (job.phase === "verifying" &&
        typeof probe === "string" &&
        /^[a-f0-9]{64}$/.test(probe) &&
        probe.length === job.probe.length &&
        timingSafeEqual(Buffer.from(probe), Buffer.from(job.probe)))
    );
  }
  consumeGatewayNonce(nonce) {
    this.transaction(() => {
      this.run("DELETE FROM gateway_nonces WHERE expires<?", Date.now());
      if (this.one("SELECT nonce FROM gateway_nonces WHERE nonce=?", nonce))
        fail(403, "Request already used.");
      this.run(
        "INSERT INTO gateway_nonces VALUES(?,?)",
        nonce,
        Date.now() + 120_000,
      );
    });
  }
  claimDomain(value, household, previous = "") {
    const label = normalizeLabel(value);
    if (!label)
      fail(
        400,
        "Use an available 3–63 character address: letters, numbers and internal hyphens only.",
      );
    if (!this.domainAvailable(label, household))
      fail(409, "That household address is unavailable.");
    // Called only inside the same transaction as registration or version-checked editing.
    this.run(
      "INSERT OR IGNORE INTO household_domains(label,household) VALUES(?,?)",
      label,
      household,
    );
    if (previous && previous !== label)
      this.run(
        "UPDATE household_domains SET retired=1 WHERE label=? AND household=?",
        previous,
        household,
      );
    return label;
  }
  updateHousehold(household, input, version) {
    return this.transaction(() => {
      const existing = this.household(household);
      if (!existing) fail(404, "Household not found.");
      if (
        input.subdomain !== undefined &&
        input.subdomain !== existing.subdomain
      )
        fail(403, "Household web addresses cannot be changed.");
      const timezone = text(input.timezone ?? existing.timezone ?? "UTC", 100);
      try {
        new Intl.DateTimeFormat("en", { timeZone: timezone });
      } catch {
        fail(400, "Choose a valid household IANA timezone.");
      }
      const nextDesign = design(input.design);
      const before = resolveUI(
        this.get("ui", "defaults", "platform"),
        { design: existing.ui?.design },
        { design: existing.design },
      ).design;
      const after = resolveUI(
        this.get("ui", "defaults", "platform"),
        { design: existing.ui?.design },
        { design: nextDesign },
      ).design;
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        for (const event of this.list("event", household)) {
          const preserved = resolveUI(
            { design: before },
            { design: event.ui?.design },
            { design: event.design },
          ).design;
          this.put(
            "event",
            event.id,
            household,
            { ...event, design: preserved },
            event.version,
          );
        }
      }
      const subdomain = existing.subdomain;
      return this.put(
        "household",
        household,
        household,
        {
          name: text(input.name, 100, true),
          slug: existing.slug,
          logo: image(input.logo ?? existing.logo ?? ""),
          timezone,
          design: nextDesign,
          notes: text(input.notes ?? existing.notes ?? "", 20000),
          ui: input.ui ?? existing.ui ?? {},
          ...(subdomain ? { subdomain } : {}),
        },
        version,
      );
    });
  }
  hostnameHousehold(label) {
    const claim = this.one(
      "SELECT * FROM household_domains WHERE label=? AND retired=0",
      label,
    );
    const household = claim && this.household(claim.household);
    if (!household || household.subdomain !== label)
      fail(404, "This household address is unavailable.");
    return this.publicHousehold(household.slug);
  }
  publicHousehold(slug) {
    const row = this.one(
      "SELECT * FROM records WHERE kind='household' AND json_extract(body,'$.slug')=?",
      slug,
    );
    if (!row) fail(404, "Household not found.");
    const record = this.unpack(row);
    if (
      this.one(
        "SELECT household FROM household_deletions WHERE household=?",
        record.id,
      )
    )
      fail(404, "Household not found.");
    return {
      id: record.id,
      slug: record.slug,
      name: record.name,
      design: record.design,
      logo: record.logo || "",
      ui: record.ui || {},
    };
  }
  session(raw, origin, allowLegacy = true) {
    if (!raw) return null;
    const session = this.one(
      "SELECT * FROM sessions WHERE token=? AND expires>?",
      createHash("sha256").update(raw).digest("hex"),
      Date.now(),
    );
    if (!session) return null;
    if (
      session.household &&
      this.one(
        "SELECT household FROM household_deletions WHERE household=?",
        session.household,
      )
    )
      return null;
    if (origin) {
      const scope = this.one(
        "SELECT origin FROM session_origins WHERE token=?",
        session.token,
      );
      if (scope ? scope.origin !== origin : !allowLegacy) return null;
    }
    if (session.guest) {
      const guest = this.get("guest", session.guest, session.household);
      if (
        !guest ||
        guest.parent ||
        !this.one(
          "SELECT identity FROM guest_identity_sessions WHERE token=?",
          session.token,
        )
      )
        return null;
    }
    if (
      session.role === "host" &&
      this.one("SELECT disabled FROM family_members WHERE id=?", session.user)
        ?.disabled
    )
      return null;
    if (session.role === "family") {
      const member = this.one(
        "SELECT disabled FROM family_members WHERE id=? AND household=?",
        session.user,
        session.household,
      );
      if (!member || member.disabled) return null;
    }
    return session;
  }
  newSession(
    {
      user = null,
      household = null,
      guest = null,
      role,
      identity = null,
      entryHousehold = household,
    },
    origin,
  ) {
    const token = randomBytes(32).toString("base64url");
    const seconds = role === "guest" ? 7 * 86400 : 8 * 3600;
    this.run("DELETE FROM sessions WHERE expires<?", Date.now());
    this.run(
      "DELETE FROM guest_identity_sessions WHERE token NOT IN (SELECT token FROM sessions)",
    );
    this.run(
      "DELETE FROM session_origins WHERE token NOT IN (SELECT token FROM sessions)",
    );
    this.run(
      "INSERT INTO sessions VALUES(?,?,?,?,?,?)",
      createHash("sha256").update(token).digest("hex"),
      user,
      household,
      guest,
      role,
      Date.now() + seconds * 1000,
    );
    if (origin)
      this.run(
        "INSERT INTO session_origins VALUES(?,?)",
        createHash("sha256").update(token).digest("hex"),
        origin,
      );
    if (identity)
      this.run(
        "INSERT INTO guest_identity_sessions VALUES(?,?,?)",
        createHash("sha256").update(token).digest("hex"),
        identity,
        entryHousehold,
      );
    return { token, seconds };
  }
  limit(key, max = 15, window = 15 * 60_000) {
    this.run("DELETE FROM limits WHERE expires<?", Date.now());
    this.run(
      "INSERT INTO limits VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1",
      key,
      Date.now() + window,
    );
    if (this.one("SELECT count FROM limits WHERE key=?", key).count > max)
      fail(429, "Too many attempts. Please try again later.");
  }
  adminSetupComplete() {
    return Boolean(
      this.one("SELECT id FROM users WHERE role='admin' LIMIT 1") ||
      this.one("SELECT id FROM setup_state WHERE id=1 AND completed=1"),
    );
  }
  async setupAdmin(address, password) {
    if (this.adminSetupComplete())
      fail(410, "Administrator setup is already complete.");
    const normalized = email(address),
      hash = await hashPassword(password);
    return this.transaction(() => {
      if (this.adminSetupComplete())
        fail(410, "Administrator setup is already complete.");
      if (this.one("SELECT id FROM users WHERE email=?", normalized))
        fail(409, "These administrator details are unavailable.");
      const user = id();
      this.run(
        "INSERT INTO users VALUES(?,?,?,?,NULL)",
        user,
        normalized,
        hash,
        "admin",
      );
      this.run(
        "INSERT INTO setup_state VALUES(1,1) ON CONFLICT(id) DO UPDATE SET completed=1",
      );
      return { user, role: "admin" };
    });
  }
  async createAdmin(address, password) {
    this.run(
      "INSERT INTO users VALUES(?,?,?,?,NULL)",
      id(),
      email(address),
      await hashPassword(password),
      "admin",
    );
  }
  async register(input) {
    const address = email(input.email),
      name = text(input.name, 100, true),
      password = await hashPassword(input.password);
    return this.transaction(() => {
      if (
        !this.one("SELECT email FROM approvals WHERE email=?", address) ||
        this.one("SELECT id FROM users WHERE email=?", address)
      )
        fail(
          403,
          "Registration is unavailable for these details. Contact the administrator.",
        );
      const label = suggestLabel(name);
      if (
        input.subdomain !== undefined &&
        normalizeLabel(input.subdomain) !== label
      )
        fail(400, "The address must match the household name.");
      const household = id(),
        user = id();
      this.put("household", household, household, {
        name,
        slug: randomBytes(18).toString("base64url"),
        design: {},
        subdomain: this.claimDomain(label, household),
      });
      this.run(
        "INSERT INTO household_routing(label,household,id,probe) VALUES(?,?,?,?)",
        label,
        household,
        id(),
        randomBytes(32).toString("hex"),
      );
      this.run(
        "INSERT INTO users VALUES(?,?,?,?,?)",
        user,
        address,
        password,
        "host",
        household,
      );
      this.run("DELETE FROM approvals WHERE email=?", address);
      return { user, household, role: "host" };
    });
  }
  totals(event, household) {
    const invited = new Set(event.invited);
    const answers = this.list("response", household).filter(
      (r) => r.event === event.id,
    );
    const attendance = Object.assign({}, ...answers.map((r) => r.attendance));
    return {
      invited: invited.size,
      attending: [...invited].filter((key) => attendance[key] === "yes").length,
      declined: [...invited].filter((key) => attendance[key] === "no").length,
      noResponse: [...invited].filter((key) => !attendance[key]).length,
    };
  }
  menuView(event, household) {
    const answers = this.list("response", household).filter(
      (r) => r.event === event.id,
    );
    return event.menu.map((item) => ({
      ...item,
      claimed: answers.reduce((sum, r) => sum + (r.claims[item.id] || 0), 0),
    }));
  }
  guestEvent(event, session) {
    const guest = this.get("guest", session.guest, session.household);
    const children = this.list("guest", session.household).filter(
      (g) => g.parent === guest.id && event.invited.includes(g.id),
    );
    const response = this.get(
      "response",
      `${event.id}:${guest.id}`,
      session.household,
    );
    const { invited, notes, reminders, ...safe } = event;
    return {
      ...safe,
      totals: this.totals(event, session.household),
      menu: this.menuView(event, session.household),
      members: [guest, ...children].map(
        ({ id, first, last, suffix, parent }) => ({
          id,
          first,
          last,
          suffix,
          parent,
        }),
      ),
      response: response || { version: 0, attendance: {}, claims: {} },
    };
  }
  saveResponse(event, session, input) {
    return this.transaction(() => {
      const current = this.get("event", event.id, session.household);
      if (!current?.invited.includes(session.guest))
        fail(404, "Event not found.");
      const key = `${event.id}:${session.guest}`,
        previous = this.get("response", key, session.household);
      if ((previous?.version || 0) !== input.version)
        fail(409, "Your RSVP changed on another device. Reload before saving.");
      if (
        current.deadline &&
        current.deadline < new Date().toISOString().slice(0, 10)
      )
        fail(409, "The RSVP deadline has passed. Responses are closed.");
      const members = this.guestEvent(current, session).members,
        allowed = new Set(members.map((m) => m.id));
      if (
        !input.attendance ||
        typeof input.attendance !== "object" ||
        Array.isArray(input.attendance) ||
        Object.keys(input.attendance).some((key) => !allowed.has(key))
      )
        fail(400, "Invalid RSVP members.");
      const attendance = {};
      for (const member of members) {
        if (!["yes", "no"].includes(input.attendance[member.id]))
          fail(400, "Choose attendance for each invited person.");
        attendance[member.id] = input.attendance[member.id];
      }
      if (
        attendance[session.guest] === "no" &&
        members.some((m) => m.parent && attendance[m.id] === "yes")
      )
        fail(400, "Children must attend with their designated adult.");
      if (
        !input.claims ||
        typeof input.claims !== "object" ||
        Array.isArray(input.claims)
      )
        fail(400, "Invalid menu selections.");
      const claims = {},
        menu = this.menuView(current, session.household),
        attending = Object.values(attendance).includes("yes");
      for (const [itemId, quantity] of Object.entries(input.claims)) {
        if (
          !Number.isInteger(quantity) ||
          quantity < 0 ||
          quantity > 10000 ||
          !current.menu.some((m) => m.id === itemId)
        )
          fail(400, "Invalid menu quantity.");
      }
      const deadlinePassed =
        current.deadline &&
        current.deadline < new Date().toISOString().slice(0, 10);
      for (const item of menu) {
        const desired = attending ? input.claims[item.id] || 0 : 0,
          old = previous?.claims[item.id] || 0;
        if (deadlinePassed && desired > old)
          fail(
            409,
            "The RSVP deadline has passed. You may reduce items or update attendance.",
          );
        if (desired > old && item.claimed - old + desired > item.quantity)
          fail(
            409,
            "An item was just claimed. Refresh and choose an available quantity.",
          );
        if (desired) claims[item.id] = desired;
      }
      let customItems = input.customItems ?? previous?.customItems ?? [];
      if (!Array.isArray(customItems) || customItems.length > 20)
        fail(400, "Use up to 20 custom menu items.");
      if (!current.customItemsEnabled) {
        const previousItems = previous?.customItems || [];
        if (
          customItems.length &&
          JSON.stringify(customItems) !== JSON.stringify(previousItems)
        )
          fail(400, "Custom menu items are not enabled.");
        customItems = previousItems;
      }
      const custom = attending
        ? customItems.map((item) => {
            const name = text(item.name, 160, true),
              quantity = Number(item.quantity ?? 1);
            if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10000)
              fail(400, "Choose a valid custom item quantity.");
            return { name, quantity };
          })
        : [];
      if (current.saveCustomItems)
        for (const item of custom) {
          const normalized = normalizeName(item.name);
          if (
            !this.list("menu-saved", session.household).some(
              (saved) => normalizeName(saved.name) === normalized,
            )
          )
            this.put("menu-saved", id(), session.household, {
              name: item.name,
              quantity: 1,
              kind: "potluck",
            });
        }
      this.put(
        "response",
        key,
        session.household,
        {
          event: event.id,
          guest: session.guest,
          attendance,
          claims,
          customItems: custom,
          updated: new Date().toISOString(),
        },
        previous?.version,
      );
      return this.guestEvent(current, session);
    });
  }
}
