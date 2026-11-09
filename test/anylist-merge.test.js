import test from "node:test";
import assert from "node:assert/strict";
import { mergeAnyListFields } from "../server/anylist-merge.js";
test("AnyList merges independent edits, retains Gather conflicts across repeat pulls and permits later remote-only changes", () => {
  const keys = ["label", "lines"],
    original = { label: "Example", lines: "4128 Willow Trail" };
  const initial = mergeAnyListFields(null, original, null, keys);
  const local = { ...original, lines: "PO Box 25" },
    remote = { label: "Example Updated", lines: "PO Box 20" };
  const conflict = mergeAnyListFields(local, remote, initial.baseline, keys);
  assert.deepEqual(conflict.merged, {
    label: "Example Updated",
    lines: "PO Box 25",
  });
  const repeated = mergeAnyListFields(
    conflict.merged,
    remote,
    conflict.baseline,
    keys,
  );
  assert.equal(repeated.merged.lines, "PO Box 25");
  const remoteOnly = mergeAnyListFields(
    repeated.merged,
    { ...remote, label: "New remote label" },
    repeated.baseline,
    keys,
  );
  assert.deepEqual(remoteOnly.merged, {
    label: "New remote label",
    lines: "PO Box 25",
  });
});
test("first reconciliation conservatively preserves existing Gather fields", () => {
  const local = { first: "Casey", last: "Local" },
    remote = { first: "Casey", last: "Remote" };
  assert.deepEqual(
    mergeAnyListFields(local, remote, null, ["first", "last"]).merged,
    local,
  );
});
