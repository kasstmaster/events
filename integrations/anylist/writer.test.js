import test from "node:test";
import assert from "node:assert/strict";
import { openAddressBook, responseType } from "./reader.js";
import { applyContactPlan, buildOperations, operationType } from "./writer.js";
import { bytesField, wireFields, stringField } from "./wire.js";
function fixture() {
  return {
    shoppingListsResponse: {
      newLists: [
        {
          identifier: "book",
          name: "Address Book",
          items: [
            {
              identifier: "adult",
              name: "Casey Example",
              details:
                "Riley Example\nNote: preserve this line\nPhone: +15005550123",
              categoryAssignments: [
                { categoryGroupId: "group", categoryId: "category" },
              ],
            },
          ],
        },
        {
          identifier: "other-book",
          name: "Shopping",
          items: [{ identifier: "untouched", name: "Private unrelated item" }],
        },
      ],
      listResponses: [
        {
          listId: "book",
          categoryGroupResponses: [
            {
              categoryGroup: {
                identifier: "group",
                categories: [
                  {
                    identifier: "category",
                    categoryGroupId: "group",
                    listId: "book",
                    name: "Example - PO Box 12",
                    sortIndex: 9,
                  },
                ],
              },
            },
          ],
        },
      ],
    },
  };
}
function provider() {
  const data = fixture(),
    calls = [],
    operations = [];
  let failWrite = false;
  const fetcher = async (url, req) => {
    assert.equal(req.redirect, "error");
    calls.push(url);
    if (url.endsWith("/auth/token"))
      return Response.json({ access_token: "synthetic-provider-token" });
    if (url.endsWith("/data/user-data/get"))
      return new Response(responseType.encode(data).finish());
    assert.ok(url.endsWith("/data/shopping-lists/update-v2"));
    if (failWrite) throw Error("Synthetic unknown outcome");
    const encoded = Buffer.from(await req.body.get("operations").arrayBuffer()),
      decoded = operationType.decode(encoded).operations;
    operations.push(...decoded);
    for (const op of decoded) {
      assert.equal(op.listId, "book");
      const list = data.shoppingListsResponse.newLists[0],
        group =
          data.shoppingListsResponse.listResponses[0].categoryGroupResponses[0]
            .categoryGroup,
        handler = op.metadata.handlerId;
      if (handler === "create-category")
        group.categories.push(op.updatedCategory);
      else if (handler === "set-category-name")
        Object.assign(
          group.categories.find(
            (c) => c.identifier === op.updatedCategory.identifier,
          ),
          op.updatedCategory,
        );
      else if (handler === "add-shopping-list-item")
        list.items.push(op.listItem);
      else if (handler === "set-list-item-name")
        list.items.find((i) => i.identifier === op.listItemId).name =
          op.updatedValue;
      else if (handler === "set-list-item-details")
        list.items.find((i) => i.identifier === op.listItemId).details =
          op.updatedValue;
      else if (handler === "set-list-item-category-match-id")
        Object.assign(
          list.items.find((i) => i.identifier === op.listItemId),
          op.listItem,
        );
      else assert.equal(handler, "update-list-item-category-assignment");
    }
    return new Response(null, { status: 204 });
  };
  return {
    data,
    calls,
    operations,
    fetcher,
    set fail(value) {
      failWrite = value;
    },
  };
}
const plan = () => [
  {
    id: "group:category",
    label: "Example",
    lines: "PO Box 25",
    people: [
      {
        id: "adult",
        first: "Casey",
        last: "Example",
        suffix: "",
        phone: "+15005550124",
        children: [
          {
            id: "adult:child:taylor example",
            previousId: "adult:child:riley example",
            line: "Taylor Example",
            first: "Taylor",
          },
        ],
      },
    ],
  },
  {
    id: "group:new-category",
    label: "Another household",
    lines: "PO Box 99",
    people: [
      {
        id: "new-adult",
        first: "Jordan",
        last: "Sample",
        suffix: "",
        phone: "",
        children: [],
      },
    ],
  },
];
test("two-way wire adapter writes only selected categories/items, preserves notes and other lists, and rereads verification", async () => {
  const mock = provider(),
    client = await openAddressBook(
      { email: "synthetic@example.test", password: "synthetic" },
      mock.fetcher,
    ),
    snapshot = await client.read();
  const observed = await applyContactPlan(client, snapshot, plan());
  assert.equal(mock.calls.filter((x) => x.endsWith("update-v2")).length, 1);
  assert.equal(
    observed.addresses.find((a) => a.id === "group:category").lines,
    "PO Box 25",
  );
  const adult = observed.addresses
    .flatMap((a) => a.people)
    .find((p) => p.id === "adult");
  assert.equal(adult.phone, "+15005550124");
  assert.ok(
    observed.addresses
      .flatMap((a) => a.people)
      .some((p) => p.id === "adult:child:taylor example"),
  );
  assert.match(
    mock.data.shoppingListsResponse.newLists[0].items[0].details,
    /Note: preserve this line/,
  );
  assert.doesNotMatch(
    mock.data.shoppingListsResponse.newLists[0].items[0].details,
    /Riley Example/,
  );
  assert.equal(
    mock.data.shoppingListsResponse.newLists[1].items[0].name,
    "Private unrelated item",
  );
  assert.ok(
    mock.operations.every(
      (op) =>
        !op.metadata.handlerId.includes("remove") &&
        !op.metadata.handlerId.includes("delete"),
    ),
  );
  const fresh = await client.read();
  const unchanged = buildOperations(fresh, plan());
  assert.equal(unchanged.count, 0);
});
test("changed remote snapshots stop before writes and unknown writes are never automatically retried", async () => {
  const mock = provider(),
    client = await openAddressBook(
      { email: "synthetic", password: "synthetic" },
      mock.fetcher,
    ),
    snapshot = await client.read();
  mock.data.shoppingListsResponse.newLists[0].items[0].name =
    "Concurrent remote edit";
  await assert.rejects(
    applyContactPlan(client, snapshot, plan()),
    /changed during sync/,
  );
  assert.equal(mock.operations.length, 0);
  const fresh = await client.read();
  mock.fail = true;
  await assert.rejects(
    applyContactPlan(client, fresh, plan()),
    /Synthetic unknown outcome/,
  );
  assert.equal(mock.calls.filter((x) => x.endsWith("update-v2")).length, 1);
});
test("category moves retain unknown protobuf item fields", async () => {
  const mock = provider(),
    client = await openAddressBook(
      { email: "synthetic", password: "synthetic" },
      mock.fetcher,
    ),
    snapshot = await client.read();
  snapshot.wireItems.set(
    "adult",
    Buffer.concat([
      snapshot.wireItems.get("adult"),
      bytesField(31, Buffer.from("Unknown preserved metadata")),
    ]),
  );
  const moved = plan();
  moved[0].id = "group:moved-category";
  const batch = buildOperations(snapshot, moved),
    encoded = wireFields(batch.bytes).map((f) => f.value);
  const op = encoded.find(
    (raw) =>
      stringField(wireFields(raw).find((f) => f.id === 1).value, 2) ===
      "set-list-item-category-match-id",
  );
  assert.ok(op);
  const rawItem = wireFields(op).find((f) => f.id === 6).value;
  assert.equal(stringField(rawItem, 31), "Unknown preserved metadata");
  assert.equal(stringField(rawItem, 13), "moved-category");
});
