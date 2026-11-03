import test from "node:test";
import assert from "node:assert/strict";
import { readAddressBook, responseType } from "./reader.js";
const fixture = {
  shoppingListsResponse: {
    newLists: [
      {
        identifier: "book",
        name: "Address Book",
        items: [
          {
            identifier: "adult",
            name: "Casey Example",
            details: "Riley",
            categoryAssignments: [{ categoryId: "c", categoryGroupId: "g" }],
          },
        ],
      },
    ],
    listResponses: [
      {
        listId: "book",
        categoryGroupResponses: [
          {
            categoryGroup: {
              identifier: "g",
              categories: [
                {
                  identifier: "c",
                  name: "Example - PO Box 12, Sample City, CA 90210",
                },
              ],
            },
          },
        ],
      },
    ],
  },
};
test("read-only transport authenticates, decodes actual protobuf bytes and imports only the selected book", async () => {
  const paths = [];
  const result = await readAddressBook(
    { email: "synthetic@example.test", password: "synthetic-password" },
    async (url, options) => {
      paths.push(url);
      assert.equal(options.method, "POST");
      assert.equal(options.redirect, "error");
      if (url.endsWith("/auth/token")) {
        assert.equal(options.body.get("password"), "synthetic-password");
        return Response.json({ access_token: "synthetic-token" });
      }
      assert.equal(options.headers.Authorization, "Bearer synthetic-token");
      assert.match(
        options.headers["X-AnyLeaf-Client-Identifier"],
        /^[a-f0-9]{32}$/,
      );
      return new Response(responseType.encode(fixture).finish());
    },
  );
  assert.deepEqual(paths, [
    "https://www.anylist.com/auth/token",
    "https://www.anylist.com/data/user-data/get",
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].people.length, 2);
  assert.equal(result[0].people[1].parentId, "adult");
  assert.equal(result[0].lines, "PO Box 12, Sample City, CA 90210");
  assert.doesNotMatch(
    JSON.stringify(result),
    /synthetic-password|synthetic-token/,
  );
});
test("authentication and missing/ambiguous books fail closed without raw provider diagnostics", async () => {
  await assert.rejects(
    readAddressBook(
      { email: "synthetic", password: "synthetic" },
      async () => new Response("private-provider-detail", { status: 401 }),
    ),
    /^Error: AnyList authentication failed\.$/,
  );
  let calls = 0;
  const fetcher = async () =>
    ++calls === 1
      ? Response.json({ access_token: "synthetic" })
      : new Response(
          responseType
            .encode({
              ...fixture,
              shoppingListsResponse: {
                ...fixture.shoppingListsResponse,
                newLists: [],
              },
            })
            .finish(),
        );
  await assert.rejects(
    readAddressBook({ email: "synthetic", password: "synthetic" }, fetcher),
    /not uniquely found/,
  );
});
test("oversized provider responses stop before decoding", async () => {
  let calls = 0;
  await assert.rejects(
    readAddressBook({ email: "synthetic", password: "synthetic" }, async () =>
      ++calls === 1
        ? Response.json({ access_token: "synthetic" })
        : new Response(new Uint8Array(20 * 1024 * 1024 + 1)),
    ),
    /response too large/,
  );
});
