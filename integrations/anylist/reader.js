import { createHash } from "node:crypto";
import { listWire } from "./wire.js";
import { randomUUID } from "node:crypto";
import protobuf from "protobufjs";
import { convertAddressBook } from "./convert.js";

// Read-only wire field mapping from the MIT-licensed codetheweb/anylist 0.8.6
// definitions (see THIRD-PARTY-NOTICES.md). Ignore unrelated account/list data.
export const responseType = protobuf
  .parse(
    `syntax = "proto2";
message PBUserDataResponse { optional ShoppingListsResponse shoppingListsResponse = 1; }
message ShoppingListsResponse { repeated ShoppingList newLists = 1; repeated ShoppingList modifiedLists = 2; repeated PBListResponse listResponses = 6; }
message ShoppingList { required string identifier = 1; optional string name = 3; repeated ListItem items = 4; }
message ListItem { required string identifier = 1; optional string listId = 3; optional string name = 4; optional string details = 5; optional bool checked = 6; optional string category = 11; optional string userId = 12; optional string categoryMatchId = 13; repeated PBListItemCategoryAssignment categoryAssignments = 20; }
message PBListItemCategoryAssignment { optional string identifier = 1; optional string categoryGroupId = 2; optional string categoryId = 3; }
message PBListResponse { optional string listId = 1; repeated PBListCategoryGroupResponse categoryGroupResponses = 7; }
message PBListCategoryGroupResponse { optional PBListCategoryGroup categoryGroup = 1; }
message PBListCategoryGroup { optional string identifier = 1; repeated PBListCategory categories = 5; }
message PBListCategory { optional string identifier = 1; optional uint64 logicalTimestamp = 2; optional string categoryGroupId = 3; optional string listId = 4; optional string name = 5; optional string icon = 6; optional string systemCategory = 7; optional int32 sortIndex = 9; }
`,
  )
  .root.lookupType("PBUserDataResponse");

export async function boundedBytes(response) {
  if (!response.body) return Buffer.alloc(0);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 20 * 1024 * 1024) throw Error("AnyList response too large.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
export async function openAddressBook(
  { email, password, listName = "Address Book" },
  fetcher = fetch,
) {
  if (!email || !password) throw Error("Missing AnyList configuration.");
  const headers = { "X-AnyLeaf-API-Version": "3" },
    body = new FormData();
  body.set("email", email);
  body.set("password", password);
  const auth = await fetcher("https://www.anylist.com/auth/token", {
    method: "POST",
    headers,
    body,
    redirect: "error",
    signal: AbortSignal.timeout(30000),
  });
  if (!auth.ok) throw Error("AnyList authentication failed.");
  const token = JSON.parse((await boundedBytes(auth)).toString()).access_token;
  if (typeof token !== "string" || !token)
    throw Error("AnyList authentication failed.");
  const authenticated = {
    ...headers,
    Authorization: "Bearer " + token,
    "X-AnyLeaf-Client-Identifier": randomUUID().replaceAll("-", ""),
  };
  let selectedList = "";
  return {
    async read() {
      const response = await fetcher(
        "https://www.anylist.com/data/user-data/get",
        {
          method: "POST",
          headers: authenticated,
          redirect: "error",
          signal: AbortSignal.timeout(30000),
        },
      );
      if (!response.ok) throw Error("AnyList read failed.");
      const bytes = await boundedBytes(response),
        data = responseType.decode(bytes);
      const norm = (value) =>
        String(value || "")
          .trim()
          .toLowerCase();
      const lists = [
        ...(data.shoppingListsResponse?.newLists || []),
        ...(data.shoppingListsResponse?.modifiedLists || []),
      ].filter((list) => norm(list.name) === norm(listName));
      if (lists.length !== 1)
        throw Error("AnyList Address Book not uniquely found.");
      selectedList = lists[0].identifier;
      const reply = data.shoppingListsResponse.listResponses.find(
        (r) => r.listId === selectedList,
      );
      const categories = (reply?.categoryGroupResponses || []).flatMap((g) =>
        (g.categoryGroup?.categories || []).map((c) => ({
          ...c,
          categoryGroupId: c.categoryGroupId || g.categoryGroup.identifier,
        })),
      );
      const groupId =
        reply?.categoryGroupResponses?.[0]?.categoryGroup?.identifier || "";
      const wire = listWire(bytes, selectedList);
      return {
        listId: selectedList,
        groupId,
        items: lists[0].items || [],
        categories,
        addresses: convertAddressBook(data, selectedList),
        wireItems: wire.items,
        fingerprint: createHash("sha256")
          .update(wire.list)
          .update(wire.response)
          .digest("hex"),
      };
    },
    async write(bytes, listId) {
      if (!selectedList || listId !== selectedList)
        throw Error("AnyList write target differs.");
      if (bytes.length > 10 * 1024 * 1024)
        throw Error("AnyList write is too large.");
      const body = new FormData();
      body.set(
        "operations",
        new Blob([bytes], { type: "application/octet-stream" }),
        "operations.pb",
      );
      const response = await fetcher(
        "https://www.anylist.com/data/shopping-lists/update-v2",
        {
          method: "POST",
          headers: authenticated,
          body,
          redirect: "error",
          signal: AbortSignal.timeout(30000),
        },
      );
      if (!response.ok) throw Error("AnyList write was not confirmed.");
      await boundedBytes(response);
    },
  };
}
export async function readAddressBook(config, fetcher = fetch) {
  return (await (await openAddressBook(config, fetcher)).read()).addresses;
}
