import test from "node:test";
import assert from "node:assert/strict";
import { application } from "./helpers/application.js";
import { folderInSection } from "../public/browse-ui.js";

test("tasks reuse assignment permissions, occurrences and private linked-record protection", async (t) => {
  const f = await application(t),
    host = await f.host("Alpha"),
    kid = await f.member(host, "kid", "Child"),
    sibling = await f.member(host, "kid", "Sibling"),
    regular = await f.member(host, "member", "Regular");
  const folder = await f.record(host, "folder", { section: "tasks" }),
    record = await f.record(host, "record", { title: "Restricted manual" });
  const task = await f.record(host, "task", {
    title: "Homework",
    folder: folder.id,
    assignees: [kid.id],
    linkedRecord: record.id,
    dueLocal: "2089-06-12T17:00",
    timezone: "UTC",
  });
  const view = (await f.request("/api/family", { cookie: kid.cookie })).body;
  assert.equal(view.records.find((r) => r.id === task.id).linkedRecord, "");
  assert.equal(
    view.records.some((r) => r.id === folder.id || r.id === record.id),
    false,
  );
  assert.equal(
    (
      await f.request("/api/family/records/" + task.id, {
        cookie: sibling.cookie,
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await f.request("/api/family/records", {
        cookie: regular.cookie,
        method: "POST",
        data: {
          type: "task",
          title: "Unauthorized child task",
          assignees: [kid.id],
        },
      })
    ).status,
    403,
  );
  const occurrence = view.occurrences.find((o) => o.chore === task.id);
  assert.ok(occurrence);
  assert.equal(
    (
      await f.request(
        "/api/family/occurrences/" + encodeURIComponent(occurrence.id),
        {
          cookie: kid.cookie,
          method: "PUT",
          version: occurrence.version,
          data: { completed: true },
        },
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await f.request("/api/family/records/" + record.id, {
        cookie: kid.cookie,
      })
    ).status,
    404,
  );
});
test("record and contact manual positions persist with versions, household boundaries and credentials intact", async (t) => {
  const f = await application(t),
    a = await f.host("Alpha"),
    b = await f.host("Beta"),
    record = await f.record(a, "record", {
      notes: "Keep this content",
      position: 100,
    }),
    guest = await f.guest(a, {
      phone: "+15551234567",
      notes: "Keep private notes",
    });
  const result = await f.request("/api/family/records/" + record.id, {
    cookie: a.cookie,
    method: "PUT",
    version: record.version,
    data: { ...record, position: 20 },
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.position, 20);
  assert.equal(result.body.notes, record.notes);
  assert.equal(
    (
      await f.request("/api/family/records/" + record.id, {
        cookie: a.cookie,
        method: "PUT",
        version: record.version,
        data: { ...record, position: 0 },
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await f.request("/api/family/records/" + record.id, {
        cookie: b.cookie,
        method: "PUT",
        version: result.body.version,
        data: { ...result.body, position: 0 },
      })
    ).status,
    404,
  );
  const contact = await f.request("/api/host/guests/" + guest.id, {
    cookie: a.cookie,
    method: "PUT",
    version: guest.version,
    data: { ...guest, position: 5 },
  });
  assert.equal(contact.status, 200);
  assert.equal(contact.body.inviteCode, guest.inviteCode);
  assert.equal(contact.body.notes, guest.notes);
  const pref = await f.request("/api/family/preferences", {
    cookie: a.cookie,
    method: "PUT",
    data: { collectionSort: "alpha", contactSort: "manual" },
  });
  assert.equal(pref.status, 200);
  const saved = (
    await f.request("/api/family/preferences", { cookie: a.cookie })
  ).body;
  assert.equal(saved.collectionSort, "alpha");
  assert.equal(saved.contactSort, "manual");
});
test("legacy mixed folders remain discoverable in each applicable section without treating unsupported records as supported", () => {
  const folder = { id: "mixed", type: "folder" },
    nested = { id: "nested", type: "folder", folder: "mixed" };
  const records = [
    folder,
    nested,
    { id: "list", type: "list", folder: "mixed" },
    { id: "record", type: "record", folder: "nested" },
    { id: "old", type: "recipe", folder: "mixed" },
  ];
  assert.equal(folderInSection(folder, "lists", records), true);
  assert.equal(folderInSection(folder, "records", records), true);
  assert.equal(folderInSection(folder, "tasks", records), false);
  assert.equal(folderInSection(folder, "chores", records), false);
  assert.equal(
    folderInSection({ id: "empty", type: "folder" }, "lists", []),
    true,
  );
  assert.equal(
    folderInSection(
      { id: "empty", type: "folder", section: "tasks" },
      "tasks",
      [],
    ),
    true,
  );
});
