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
message ListItem { required string identifier = 1; optional string name = 4; optional string details = 5; repeated PBListItemCategoryAssignment categoryAssignments = 20; }
message PBListItemCategoryAssignment { optional string categoryGroupId = 2; optional string categoryId = 3; }
message PBListResponse { optional string listId = 1; repeated PBListCategoryGroupResponse categoryGroupResponses = 7; }
message PBListCategoryGroupResponse { optional PBListCategoryGroup categoryGroup = 1; }
message PBListCategoryGroup { optional string identifier = 1; repeated PBListCategory categories = 5; }
message PBListCategory { optional string identifier = 1; optional string categoryGroupId = 3; optional string name = 5; }
`,
  )
  .root.lookupType("PBUserDataResponse");

async function boundedBytes(response) {
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 20 * 1024 * 1024) throw Error("AnyList response too large.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
export async function readAddressBook(
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
  const response = await fetcher("https://www.anylist.com/data/user-data/get", {
    method: "POST",
    headers: {
      ...headers,
      Authorization: "Bearer " + token,
      "X-AnyLeaf-Client-Identifier": randomUUID().replaceAll("-", ""),
    },
    redirect: "error",
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw Error("AnyList read failed.");
  const data = responseType.decode(await boundedBytes(response));
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
  return convertAddressBook(data, lists[0].identifier);
}
