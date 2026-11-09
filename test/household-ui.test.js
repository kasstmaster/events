import test from "node:test";
import assert from "node:assert/strict";
import { householdGroups } from "../public/address-system.js";
import { application } from "./helpers/application.js";

test("shared household grouping keeps adults and children in creation order without changing records", () => {
  const guests = [
    { id: "child2", address: "a", parent: "adult2" },
    { id: "adult2", address: "a" },
    { id: "adult1", address: "a" },
    { id: "child1", address: "a", parent: "adult1" },
    { id: "outside", address: "b" },
  ];
  const before = structuredClone(guests);
  const groups = householdGroups(guests, [
    { id: "a", label: "Alpha" },
    { id: "b", label: "Beta" },
  ]);
  assert.deepEqual(
    groups.map((g) => g.label),
    ["Alpha", "Beta"],
  );
  assert.deepEqual(
    groups[0].people.map((g) => g.id),
    ["adult2", "adult1", "child2", "child1"],
  );
  assert.deepEqual(guests, before);
});

test("child surnames can be omitted and legacy surnames survive unrelated edits; display content retains indentation", async (t) => {
  const f = await application(t),
    host = await f.host("Indentation"),
    adult = await f.guest(host);
  const child = await f.guest(host, {
    first: "Riley",
    parent: adult.id,
    last: "",
  });
  assert.equal(child.last, "");
  const legacy = await f.guest(host, {
    first: "Sam",
    parent: adult.id,
    last: "Legacy",
  });
  const { last, ...input } = legacy;
  const saved = await f.request("/api/host/guests/" + legacy.id, {
    method: "PUT",
    cookie: host.cookie,
    version: legacy.version,
    data: input,
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.last, "Legacy");
  const event = await f.event(host, [adult, child], {
    title: "  Indented title",
    description: "   Text is here\n  Another line",
    time: "  Two o’clock",
  });
  assert.equal(event.title, "  Indented title");
  assert.equal(event.description, "   Text is here\n  Another line");
  assert.equal(event.time, "  Two o’clock");
  const dashboard = await f.request(`/api/host/events/${event.id}/dashboard`, {
    cookie: host.cookie,
  });
  assert.equal(dashboard.status, 200);
  assert.equal(dashboard.body.guests.length, 2);
});
