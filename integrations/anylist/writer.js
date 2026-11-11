import { randomUUID } from "node:crypto";
import protobuf from "protobufjs";
import { responseType } from "./reader.js";
import { bytesField, wireFields } from "./wire.js";
const root = protobuf.parse(
  `syntax="proto2";
message PBOperationMetadata {optional string operationId=1;optional string handlerId=2;optional string userId=3;optional int32 operationClass=4;}
message PBListOperation {optional PBOperationMetadata metadata=1;optional string listId=2;optional string listItemId=3;optional string updatedValue=4;optional string originalValue=5;optional ListItem listItem=6;optional PBListCategory updatedCategory=17;optional PBListCategory originalCategory=18;}
message PBListOperationList {repeated PBListOperation operations=1;}`,
  responseType.root,
).root;
export const operationType = root.lookupType("PBListOperationList");
const opType = root.lookupType("PBListOperation"),
  itemType = root.lookupType("ListItem");
const norm = (s) =>
  String(s || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
const name = (p) => [p.first, p.last, p.suffix].filter(Boolean).join(" ");
export function contactDetails(item, people, allPeople, remotePeople) {
  const oldLines = String(item?.details || "").split(/\r?\n/),
    next = [],
    wanted = new Map(people.map((c) => [norm(c.line), c]));
  const previous = new Map(
    allPeople.filter((c) => c.previousId).map((c) => [c.previousId, c]),
  );
  const remoteChildren = remotePeople.filter(
    (c) => c.parentId === item?.identifier,
  );
  for (const line of oldLines) {
    if (
      /^\s*(?:phone|tel)\s*:/i.test(line) &&
      /^\+[1-9][0-9]{7,14}$/.test(
        line.replace(/^\s*(?:phone|tel)\s*:\s*/i, "").replace(/[() .-]/g, ""),
      )
    )
      continue;
    const prior = remoteChildren.find((c) =>
        c.id.endsWith(":child:" + norm(line)),
      ),
      move = prior && previous.get(prior.id);
    // Remove a recognized line only when that same Gather child is explicitly
    // renamed/moved elsewhere. All unrelated notes and remote-only people survive.
    if (move && (move.id !== prior.id || !wanted.has(norm(line)))) continue;
    next.push(line);
  }
  for (const child of people)
    if (!next.some((line) => norm(line) === norm(child.line)))
      next.push(child.line);
  return next.join("\n").replace(/^\n+|\n+$/g, "");
}
export function buildOperations(snapshot, addresses) {
  if (!Array.isArray(addresses) || addresses.length > 2000)
    throw Error("Invalid outbound contacts.");
  const operations = [],
    allChildren = addresses.flatMap((a) =>
      a.people.flatMap((p) => p.children || []),
    ),
    remotePeople = snapshot.addresses.flatMap((a) => a.people);
  const add = (handler, fields, category = false) =>
    operations.push({
      metadata: {
        operationId: randomUUID(),
        handlerId: handler,
        ...(category ? { operationClass: 3 } : {}),
      },
      listId: snapshot.listId,
      ...fields,
    });
  for (const address of addresses) {
    const ids = address.id.split(":");
    if (ids.length !== 2 || !ids.every((x) => /^[a-zA-Z0-9-]+$/.test(x)))
      throw Error("Invalid outbound address.");
    const [groupId, categoryId] = ids;
    if (
      groupId !== snapshot.groupId &&
      !snapshot.categories.some((c) => c.categoryGroupId === groupId)
    )
      throw Error("AnyList category group differs.");
    const category = snapshot.categories.find(
        (c) => c.identifier === categoryId && c.categoryGroupId === groupId,
      ),
      categoryName = [address.label, address.lines].filter(Boolean).join(" - ");
    if (category) {
      if (category.name !== categoryName)
        add(
          "set-category-name",
          {
            originalCategory: category,
            updatedCategory: {
              ...category,
              listId: snapshot.listId,
              name: categoryName,
            },
          },
          true,
        );
    } else
      add(
        "create-category",
        {
          updatedCategory: {
            identifier: categoryId,
            categoryGroupId: groupId,
            listId: snapshot.listId,
            name: categoryName,
            sortIndex: snapshot.categories.length,
          },
        },
        true,
      );
    for (const person of address.people) {
      const existing = snapshot.items.find(
        (item) => item.identifier === person.id,
      );
      let details = contactDetails(
        existing,
        person.children || [],
        allChildren,
        remotePeople,
      );
      if (person.phone)
        details += (details ? "\n" : "") + "Phone: " + person.phone;
      if (!existing) {
        add("add-shopping-list-item", {
          listItemId: person.id,
          listItem: {
            identifier: person.id,
            listId: snapshot.listId,
            name: name(person),
            details,
            category: categoryName,
            categoryMatchId: categoryId,
            categoryAssignments: [
              {
                identifier: randomUUID(),
                categoryGroupId: groupId,
                categoryId,
              },
            ],
          },
        });
        continue;
      }
      if (existing.name !== name(person))
        add("set-list-item-name", {
          listItemId: person.id,
          originalValue: existing.name || "",
          updatedValue: name(person),
        });
      if ((existing.details || "") !== details)
        add("set-list-item-details", {
          listItemId: person.id,
          originalValue: existing.details || "",
          updatedValue: details,
        });
      if (
        !(existing.categoryAssignments || []).some(
          (a) => a.categoryId === categoryId && a.categoryGroupId === groupId,
        )
      ) {
        const raw = snapshot.wireItems.get(person.id);
        if (!raw) throw Error("Missing original AnyList item.");
        const rest = Buffer.concat(
          wireFields(raw)
            .filter((f) => ![11, 13, 20].includes(f.id))
            .map((f) => f.raw),
        );
        const changes = itemType
          .encode({
            identifier: person.id,
            category: categoryName,
            categoryMatchId: categoryId,
            categoryAssignments: [
              ...(existing.categoryAssignments || []).filter(
                (a) => a.categoryGroupId !== groupId,
              ),
              {
                identifier: randomUUID(),
                categoryGroupId: groupId,
                categoryId,
              },
            ],
          })
          .finish();
        add("update-list-item-category-assignment", {
          listItemId: person.id,
          rawItem: raw,
        });
        add("set-list-item-category-match-id", {
          listItemId: person.id,
          originalValue: categoryId,
          rawItem: Buffer.concat([rest, changes]),
        });
      }
    }
  }
  if (operations.length > 10000)
    throw Error("Outbound contact batch is too large.");
  return {
    count: operations.length,
    bytes: Buffer.concat(
      operations.map(({ rawItem, ...operation }) =>
        bytesField(
          1,
          Buffer.concat([
            opType.encode(operation).finish(),
            ...(rawItem ? [bytesField(6, rawItem)] : []),
          ]),
        ),
      ),
    ),
  };
}
export async function applyContactPlan(client, snapshot, addresses) {
  const current = await client.read();
  if (
    current.fingerprint !== snapshot.fingerprint ||
    current.listId !== snapshot.listId
  )
    throw Error("AnyList changed during sync.");
  const operations = buildOperations(current, addresses);
  if (operations.count) await client.write(operations.bytes, current.listId);
  return client.read();
}
