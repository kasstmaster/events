import { effectiveUI } from "./features.js";
import { Buffer } from "node:buffer";
import { fail, id, text, hashPassword, checkPassword } from "./model.js";
import {
  familyMember,
  manager,
  requireManager,
  canRead,
  accessInput,
  familyRecord,
  folderInput,
} from "./family-permissions.js";
import {
  choreInput,
  materializeTasks,
  runFamilyReminders,
  occurrenceComplete,
  notificationAllowed,
} from "./family-tasks.js";
import { importRecipe, publicRecipeURL } from "./recipe-import.js";

function storageUsed(store, household) {
  return store.one(
    "SELECT coalesce(sum(CAST(json_extract(body,'$.size') AS INTEGER)),0) AS used FROM records WHERE kind='family-file' AND household=?",
    household,
  ).used;
}
function fileMetadata(store, household, record) {
  return store.all(
    "SELECT id,version,json_extract(body,'$.name') AS name,json_extract(body,'$.mime') AS mime,json_extract(body,'$.size') AS size FROM records WHERE kind='family-file' AND household=? AND json_extract(body,'$.record')=?",
    household,
    record,
  );
}
const types = ["folder", "list", "recipe", "record", "chore"];
export function membersView(store, household) {
  const primary = store.one(
      "SELECT id,email FROM users WHERE household=? AND role='host'",
      household,
    ),
    owner =
      store.one("SELECT owner FROM family_owners WHERE household=?", household)
        ?.owner || primary?.id;
  if (
    primary &&
    !store.one("SELECT id FROM family_members WHERE id=?", primary.id)
  )
    store.run(
      "INSERT INTO family_members(id,household,login,name,password,role) VALUES(?,?,?,?,?,?)",
      primary.id,
      household,
      primary.email,
      "Household owner",
      "",
      "member",
    );
  const members = store.all(
    "SELECT id,login,name,role,disabled,version FROM family_members WHERE household=?",
    household,
  );
  if (primary && !members.some((m) => m.id === primary.id))
    members.unshift({
      id: primary.id,
      login: primary.email,
      name: "Household owner",
      role: "member",
      disabled: 0,
      version: 1,
    });
  return members.map((m) => ({
    ...m,
    role: m.id === owner ? "owner" : m.role,
  }));
}
function calendarDate(value, required = false) {
  const date = text(value || "", 10, required);
  if (
    date &&
    (!/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      Number.isNaN(Date.parse(date + "T12:00:00Z")) ||
      new Date(date + "T12:00:00Z").toISOString().slice(0, 10) !== date)
  )
    fail(400, "Choose a valid calendar date.");
  return date;
}
function recordInput(store, member, input, current) {
  const type = current?.type || input.type;
  if (!types.includes(type)) fail(400, "Choose a supported household section.");
  if (member.role === "kid") fail(403, "Adults manage household records.");
  if (type === "chore" && !manager(member)) {
    const kidIds = new Set(
      store
        .all(
          "SELECT id FROM family_members WHERE household=? AND role='kid'",
          member.household,
        )
        .map((m) => m.id),
    );
    if (
      (input.assignees || []).some((key) => kidIds.has(key)) ||
      (current?.assignees || []).some((key) => kidIds.has(key))
    )
      fail(
        403,
        "A household administrator manages chores assigned to children.",
      );
  }
  if (
    !manager(member) &&
    current &&
    (input.folder || "") !== (current.folder || "") &&
    ((current.childAccess || []).length || current.type === "folder")
  )
    fail(
      403,
      "A household administrator must move child-shared content between permission scopes.",
    );
  const base = {
    type,
    categories: input.categories ?? current?.categories ?? [],
    title: text(input.title, 200, true),
    folder: folderInput(store, member, input.folder, current?.id),
    childAccess: accessInput(store, member, input, current),
    createdBy: current?.createdBy || member.id,
  };
  if (
    !Array.isArray(base.categories) ||
    base.categories.length > 100 ||
    new Set(base.categories).size !== base.categories.length ||
    base.categories.some(
      (v) => typeof v !== "string" || !v.trim() || v.length > 100,
    )
  )
    fail(400, "Use unique category names up to 100 characters.");
  if (type === "folder") return base;
  if (type === "list") {
    const categories = input.categories || [];
    if (
      !Array.isArray(categories) ||
      categories.length > 100 ||
      categories.some(
        (v) => typeof v !== "string" || !v.trim() || v.length > 100,
      ) ||
      new Set(categories).size !== categories.length
    )
      fail(400, "Use unique category names, up to 100 characters each.");
    if (
      current &&
      store
        .list("family-item", member.household)
        .some(
          (item) =>
            item.list === current.id &&
            item.category &&
            !categories.includes(item.category),
        )
    )
      fail(409, "Move items out of a category before removing or renaming it.");
    return { ...base, categories };
  }
  if (type === "recipe")
    return {
      ...base,
      ingredients: text(input.ingredients || "", 20000),
      instructions: text(input.instructions || "", 30000),
      source: input.source ? publicRecipeURL(input.source).href : "",
      notes: text(input.notes || "", 20000),
    };
  if (type === "record") {
    const details = input.details || {};
    if (
      !details ||
      typeof details !== "object" ||
      Array.isArray(details) ||
      Object.keys(details).length > 50
    )
      fail(400, "Use up to 50 custom record details.");
    const safe = Object.fromEntries(
      Object.entries(details).map(([key, value]) => [
        text(key, 100, true),
        text(value, 5000),
      ]),
    );
    const history = input.history || [];
    if (!Array.isArray(history) || history.length > 500)
      fail(400, "Use up to 500 maintenance entries.");
    return {
      ...base,
      model: text(input.model || "", 200),
      serial: text(input.serial || "", 200),
      notes: text(input.notes || "", 20000),
      date: calendarDate(input.date),
      details: safe,
      history: history.map((entry) => ({
        date: calendarDate(entry.date, true),
        notes: text(entry.notes, 5000, true),
      })),
    };
  }
  const chore = choreInput(store, member, input, current);
  if (chore.linkedRecord) {
    const linked = familyRecord(store, member, chore.linkedRecord);
    if (linked.type !== "record")
      fail(400, "Link maintenance to a home record.");
  }
  return {
    ...base,
    ...chore,
    instructions: text(input.instructions || "", 20000),
  };
}
function safeRecord(store, member, record) {
  const safe = { ...record };
  if (
    record.type === "chore" &&
    record.linkedRecord &&
    !canRead(
      store,
      member,
      store.get("family-record", record.linkedRecord, member.household),
    )
  )
    safe.linkedRecord = "";
  return safe;
}
function canEdit(member, record) {
  if (member.role === "kid")
    fail(403, "This action is available only to adults.");
  if (
    record.type === "chore" &&
    !manager(member) &&
    (record.assignees || []).some((key) => member.kids?.includes(key))
  )
    requireManager(member);
}
function fileInput(input) {
  const name = text(input.name, 150, true).replace(/[^a-zA-Z0-9_. ()-]/g, "_");
  const type = input.mime,
    allowed = [
      "application/pdf",
      "image/png",
      "image/jpeg",
      "image/webp",
      "text/plain",
    ];
  if (
    !allowed.includes(type) ||
    typeof input.base64 !== "string" ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(input.base64)
  )
    fail(400, "Upload a PDF, raster image or plain text file.");
  const bytes = Buffer.from(input.base64, "base64");
  if (!bytes.length || bytes.length > 2000000)
    fail(413, "Each file may be up to 2 MB.");
  if (
    (type === "application/pdf" &&
      bytes.subarray(0, 5).toString() !== "%PDF-") ||
    (type === "image/png" &&
      bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") ||
    (type === "image/jpeg" &&
      bytes.subarray(0, 3).toString("hex") !== "ffd8ff") ||
    (type === "image/webp" &&
      (bytes.subarray(0, 4).toString() !== "RIFF" ||
        bytes.subarray(8, 12).toString() !== "WEBP")) ||
    (type === "text/plain" && bytes.includes(0))
  )
    fail(400, "The file content does not match its type.");
  return {
    name,
    mime: type,
    base64: bytes.toString("base64"),
    size: bytes.length,
  };
}
export async function familyAPI(ctx) {
  const { path, method, req, res, store, session, body, version, json, env } =
    ctx;
  if (!path.startsWith("/api/family")) return false;
  const member = familyMember(store, session),
    household = member.household;
  if (path === "/api/family" && method === "GET") {
    store.limit("family-read:" + member.id, 120, 60000);
    runFamilyReminders(store, Date.now(), household);
    const records = store
      .list("family-record", household)
      .filter((r) => canRead(store, member, r));
    const ids = new Set(records.map((r) => r.id));
    const members = membersView(store, household);
    json(res, {
      member,
      ui: effectiveUI(store, store.household(household)),
      defaults: effectiveUI(store).design,
      timezone: store.household(household).timezone || "UTC",
      household: store.publicHousehold(store.household(household).slug),
      records: records.map((r) => safeRecord(store, member, r)),
      items: store
        .list("family-item", household)
        .filter((i) => ids.has(i.list)),
      occurrences: store
        .list("family-occurrence", household)
        .filter(
          (o) =>
            ids.has(o.chore) &&
            (member.role !== "kid" || o.assignees.includes(member.id)),
        ),
      members:
        member.role === "kid"
          ? members.filter((m) => m.id === member.id)
          : manager(member)
            ? members
            : members.map(({ id, name, role }) => ({ id, name, role })),
      preferences: store.get("family-preferences", member.id, household) || {},
      notifications: store
        .list("family-notification", household)
        .filter((n) => notificationAllowed(store, member, n)),
      storage: {
        limit: 20000000,
        fileLimit: 2000000,
        used: storageUsed(store, household),
      },
      pendingHistory: store
        .list("family-task-cursor", household)
        .some((c) => c.pending),
      connection: "poll",
      pollSeconds: 3,
    });
    return true;
  }
  if (path === "/api/family/members" && method === "POST") {
    requireManager(member);
    const input = await body(req),
      role = input.role;
    if (
      !["administrator", "member", "kid"].includes(role) ||
      (role === "administrator" && member.role !== "owner")
    )
      fail(403, "Only the owner appoints household administrators.");
    const login = text(input.login, 100, true).toLowerCase();
    if (!/^[a-z0-9][a-z0-9._@+-]{2,99}$/.test(login))
      fail(400, "Use a unique sign-in name with at least three characters.");
    const password = await hashPassword(input.password),
      key = id();
    store.transaction(() => {
      if (
        store.one(
          "SELECT id FROM family_members WHERE household=? AND login=?",
          household,
          login,
        )
      )
        fail(409, "That sign-in name is already used.");
      store.run(
        "INSERT INTO family_members(id,household,login,name,password,role) VALUES(?,?,?,?,?,?)",
        key,
        household,
        login,
        text(input.name, 100, true),
        password,
        role,
      );
    });
    json(
      res,
      membersView(store, household).find((m) => m.id === key),
      201,
    );
    return true;
  }
  const account = path.match(/^\/api\/family\/members\/([\w-]+)$/);
  if (account && ["PUT", "DELETE"].includes(method)) {
    requireManager(member);
    const current = store.one(
      "SELECT * FROM family_members WHERE id=? AND household=?",
      account[1],
      household,
    );
    if (!current) fail(404, "Member not found.");
    const owner = membersView(store, household).find((m) => m.role === "owner");
    if (current.id === owner?.id || current.id === member.id)
      fail(
        403,
        "The owner and your own account cannot be removed or disabled here.",
      );
    if (current.role === "administrator" && member.role !== "owner")
      fail(403, "Only the owner manages administrators.");
    const input = await body(req),
      role = input.role ?? current.role;
    if (
      !["administrator", "member", "kid"].includes(role) ||
      (role === "administrator" && member.role !== "owner")
    )
      fail(403, "Only the owner appoints administrators.");
    if (current.role === "kid" && role !== "kid" && member.role !== "owner")
      fail(403, "Only the owner can promote a child to adult access.");
    const password = input.password
      ? await hashPassword(input.password)
      : current.password;
    store.transaction(() => {
      if (current.version !== version(req))
        fail(409, "Member changed. Reload before saving.");
      // Removal disables and retires this sign-in; history and references are retained.
      store.run(
        "UPDATE family_members SET name=?,role=?,password=?,disabled=?,version=version+1 WHERE id=? AND household=?",
        text(input.name ?? current.name, 100, true),
        role,
        password,
        method === "DELETE" || input.disabled === true ? 1 : 0,
        current.id,
        household,
      );
      if (input.password)
        store.run(
          "UPDATE users SET password=? WHERE id=?",
          password,
          current.id,
        );
      store.run(
        "DELETE FROM sessions WHERE user=? AND household=?",
        current.id,
        household,
      );
    });
    json(res, { ok: true });
    return true;
  }
  if (path === "/api/family/password" && method === "PUT") {
    const input = await body(req),
      user =
        store.one("SELECT password FROM users WHERE id=?", member.id) ||
        store.one(
          "SELECT password FROM family_members WHERE id=? AND household=?",
          member.id,
          household,
        );
    if (!(await checkPassword(input.currentPassword, user?.password)))
      fail(403, "Current password is incorrect.");
    const hash = await hashPassword(input.password);
    store.transaction(() => {
      store.run("UPDATE users SET password=? WHERE id=?", hash, member.id);
      store.run(
        "UPDATE family_members SET password=?,version=version+1 WHERE id=? AND household=?",
        hash,
        member.id,
        household,
      );
      store.run("DELETE FROM sessions WHERE user=?", member.id);
    });
    json(res, { ok: true, signInAgain: true });
    return true;
  }
  if (path === "/api/family/transfer-owner" && method === "POST") {
    if (member.role !== "owner")
      fail(403, "Only the household owner can transfer ownership.");
    const input = await body(req),
      user =
        store.one("SELECT password FROM users WHERE id=?", member.id) ||
        store.one(
          "SELECT password FROM family_members WHERE id=? AND household=?",
          member.id,
          household,
        );
    if (!(await checkPassword(input.password, user?.password)))
      fail(403, "Current password is incorrect.");
    const target = store.one(
      "SELECT id FROM family_members WHERE id=? AND household=? AND disabled=0 AND role!='kid'",
      input.member,
      household,
    );
    if (!target) fail(400, "Choose an active adult member.");
    store.transaction(() => {
      store.run(
        "INSERT INTO family_owners VALUES(?,?) ON CONFLICT(household) DO UPDATE SET owner=excluded.owner",
        household,
        target.id,
      );
      store.run("DELETE FROM sessions WHERE household=?", household);
    });
    json(res, { ok: true, signInAgain: true });
    return true;
  }
  if (path === "/api/family/preferences" && method === "GET") {
    const key =
      new URL(req.url, "http://local").searchParams.get("member") || member.id;
    if (key !== member.id) {
      requireManager(member);
      if (
        !store.one(
          "SELECT id FROM family_members WHERE id=? AND household=? AND role='kid'",
          key,
          household,
        )
      )
        fail(403, "Only child preferences can be managed for another member.");
    }
    json(res, store.get("family-preferences", key, household) || {});
    return true;
  }
  if (path === "/api/family/preferences" && method === "PUT") {
    const input = await body(req);
    let target = member.id;
    const own = store.get("family-preferences", member.id, household) || {};
    if (
      member.role === "kid" &&
      ["timezone", "quietStart", "quietEnd", "notifications", "member"].some(
        (key) => input[key] !== undefined && input[key] !== own[key],
      )
    )
      fail(403, "A parent manages child notification preferences.");
    if (input.member && input.member !== member.id) {
      requireManager(member);
      const kid = store.one(
        "SELECT id FROM family_members WHERE id=? AND household=? AND role='kid'",
        input.member,
        household,
      );
      if (!kid) fail(403, "Adults manage child notification settings only.");
      target = kid.id;
    }
    const timezone = text(input.timezone || "UTC", 100);
    try {
      new Intl.DateTimeFormat("en", { timeZone: timezone });
    } catch {
      fail(400, "Choose a valid IANA timezone.");
    }
    const quietStart = Number(input.quietStart ?? 0),
      quietEnd = Number(input.quietEnd ?? 0);
    if (
      ![quietStart, quietEnd].every(
        (v) => Number.isInteger(v) && v >= 0 && v <= 23,
      )
    )
      fail(400, "Quiet hours use hours from 0 to 23.");
    const current = store.get("family-preferences", target, household);
    json(
      res,
      store.put(
        "family-preferences",
        target,
        household,
        {
          timezone,
          quietStart,
          quietEnd,
          notifications: input.notifications !== false,
          hideCompleted: input.hideCompleted === true,
          alphabetical: input.alphabetical === true,
        },
        current ? version(req) : undefined,
      ),
    );
    return true;
  }
  if (path === "/api/family/import-recipe" && method === "POST") {
    if (member.role === "kid") fail(403, "Adults import recipes.");
    store.limit("recipe-import:" + household, 20);
    const input = await body(req);
    try {
      json(res, await importRecipe(input.url, env.recipeTransport));
    } catch (error) {
      if (error.status) throw error;
      fail(422, "This recipe could not be imported. Please use manual entry.");
    }
    return true;
  }
  if (path === "/api/family/records" && method === "POST") {
    const input = recordInput(store, member, await body(req));
    json(res, store.put("family-record", id(), household, input), 201);
    return true;
  }
  const historyPath = path.match(/^\/api\/family\/records\/([\w-]+)\/history$/);
  if (historyPath && method === "GET") {
    const record = familyRecord(store, member, historyPath[1]);
    if (record.type !== "chore") fail(404, "Task history not found.");
    const offset = Number(
      new URL(req.url, "http://local").searchParams.get("offset") || 0,
    );
    if (!Number.isSafeInteger(offset) || offset < 0)
      fail(400, "Invalid history page.");
    const occurrences = store
      .list("family-occurrence", household)
      .filter(
        (o) =>
          o.chore === record.id &&
          (member.role !== "kid" || o.assignees.includes(member.id)),
      )
      .sort(
        (a, b) =>
          (b.due || "").localeCompare(a.due || "") || a.id.localeCompare(b.id),
      );
    json(res, {
      occurrences: occurrences.slice(offset, offset + 100),
      next: offset + 100 < occurrences.length ? offset + 100 : null,
    });
    return true;
  }
  const recordPath = path.match(/^\/api\/family\/records\/([\w-]+)$/);
  if (recordPath) {
    const record = familyRecord(store, member, recordPath[1]);
    if (method === "GET") {
      json(res, {
        ...safeRecord(store, member, record),
        files: fileMetadata(store, household, record.id),
      });
      return true;
    }
    if (method === "PUT") {
      canEdit(member, record);
      const input = recordInput(store, member, await body(req), record);
      json(
        res,
        store.put("family-record", record.id, household, input, version(req)),
      );
      return true;
    }
    if (method === "DELETE") {
      canEdit(member, record);
      if (
        record.type === "chore" &&
        !manager(member) &&
        record.assignees.some((key) =>
          store.one(
            "SELECT id FROM family_members WHERE id=? AND household=? AND role='kid'",
            key,
            household,
          ),
        )
      )
        requireManager(member);
      if (!manager(member) && record.createdBy !== member.id)
        fail(
          403,
          "Only the creator or an administrator can delete this record.",
        );
      store.transaction(() => {
        if (
          record.type === "folder" &&
          store
            .list("family-record", household)
            .some((r) => r.folder === record.id)
        )
          fail(409, "Move records out of this folder first.");
        if (record.type === "chore")
          store.put(
            "family-record",
            record.id,
            household,
            { ...record, cancelled: true, archived: true },
            version(req),
          );
        else store.remove("family-record", record.id, household, version(req));
        for (const kind of ["family-file", "family-item"])
          for (const r of store
            .list(kind, household)
            .filter((r) => r.record === record.id || r.list === record.id))
            store.remove(kind, r.id, household, r.version);
      });
      json(res, { ok: true });
      return true;
    }
  }
  if (path === "/api/family/items" && method === "POST") {
    const input = await body(req),
      list = familyRecord(store, member, input.list);
    if (list.type !== "list") fail(400, "Choose a list.");
    const category = text(input.category || "", 100);
    if (category && !list.categories.includes(category))
      fail(400, "Choose a category in this list.");
    json(
      res,
      store.put("family-item", id(), household, {
        list: list.id,
        title: text(input.title, 500, true),
        category,
        completed: false,
        position: Date.now(),
        createdBy: member.id,
      }),
      201,
    );
    return true;
  }
  const itemPath = path.match(/^\/api\/family\/items\/([\w-]+)$/);
  if (itemPath) {
    const item = store.get("family-item", itemPath[1], household);
    if (!item) fail(404, "Item not found.");
    const list = familyRecord(store, member, item.list);
    if (method === "PUT") {
      const input = await body(req);
      if (
        member.role === "kid" &&
        Object.keys(input).some((k) => !["completed"].includes(k))
      )
        fail(403, "Children can add and check off items.");
      const category = text(input.category ?? item.category, 100);
      if (category && !list.categories.includes(category))
        fail(400, "Choose a list category.");
      const position = Number(input.position ?? item.position);
      if (!Number.isFinite(position) || Math.abs(position) > 1e15)
        fail(400, "Invalid item position.");
      json(
        res,
        store.put(
          "family-item",
          item.id,
          household,
          {
            ...item,
            title: text(input.title ?? item.title, 500, true),
            category,
            position,
            completed:
              input.completed === undefined
                ? item.completed
                : input.completed === true,
          },
          version(req),
        ),
      );
      return true;
    }
    if (method === "DELETE") {
      if (member.role === "kid") fail(403, "Adults delete items.");
      store.remove("family-item", item.id, household, version(req));
      json(res, { ok: true });
      return true;
    }
  }
  const occurrencePath = path.match(/^\/api\/family\/occurrences\/([^/]+)$/);
  if (occurrencePath && method === "PUT") {
    const occurrence = store.get(
      "family-occurrence",
      decodeURIComponent(occurrencePath[1]),
      household,
    );
    if (!occurrence) fail(404, "Task occurrence not found.");
    const chore = familyRecord(store, member, occurrence.chore);
    if (
      chore.cancelled ||
      occurrence.cancelled ||
      (!chore.assignees.includes(member.id) && !manager(member))
    )
      fail(403, "This task is not assigned to you.");
    const input = await body(req),
      target = manager(member) && input.member ? input.member : member.id;
    if (!chore.assignees.includes(target))
      fail(400, "Choose a current assignee.");
    const completed = { ...occurrence.completed },
      key = occurrence.completionMode === "shared" ? "shared" : target;
    if (input.completed === true) completed[key] = new Date().toISOString();
    else delete completed[key];
    json(
      res,
      store.put(
        "family-occurrence",
        occurrence.id,
        household,
        { ...occurrence, completed },
        version(req),
      ),
    );
    return true;
  }
  if (path === "/api/family/files" && method === "POST") {
    if (member.role === "kid") fail(403, "Adults upload files.");
    const input = await body(req),
      record = familyRecord(store, member, input.record);
    if (record.type !== "record")
      fail(400, "Attach documents to a home record.");
    const file = fileInput(input);
    const saved = store.transaction(() => {
      if (storageUsed(store, household) + file.size > 20000000)
        fail(413, "This household has reached its 20 MB document limit.");
      return store.put("family-file", id(), household, {
        ...file,
        record: record.id,
        createdBy: member.id,
      });
    });
    const { base64, ...safe } = saved;
    json(res, safe, 201);
    return true;
  }
  const filePath = path.match(/^\/api\/family\/files\/([\w-]+)$/);
  if (filePath) {
    const file = store.get("family-file", filePath[1], household);
    if (!file) fail(404, "File not found.");
    familyRecord(store, member, file.record);
    if (method === "GET") {
      res.writeHead(200, {
        "Content-Type": file.mime,
        "Content-Disposition": 'attachment; filename="' + file.name + '"',
        "Content-Security-Policy": "default-src 'none'; sandbox",
      });
      res.end(Buffer.from(file.base64, "base64"));
      return true;
    }
    if (method === "DELETE") {
      if (member.role === "kid") fail(403, "Adults delete documents.");
      store.remove("family-file", file.id, household, version(req));
      json(res, { ok: true });
      return true;
    }
  }
  const notificationPath = path.match(
    /^\/api\/family\/notifications\/([^/]+)$/,
  );
  if (notificationPath && method === "PUT") {
    const current = store.get(
      "family-notification",
      decodeURIComponent(notificationPath[1]),
      household,
    );
    if (!current || !notificationAllowed(store, member, current))
      fail(404, "Notification not found.");
    json(
      res,
      store.put(
        "family-notification",
        current.id,
        household,
        { ...current, read: true },
        version(req),
      ),
    );
    return true;
  }
  fail(404, "Family operation not found.");
}
