const array = (value) =>
  Array.isArray(value)
    ? value
    : value instanceof Map
      ? [...value.values()]
      : value && typeof value === "object"
        ? Object.values(value)
        : [];
const clean = (value) =>
  String(value || "")
    .trim()
    .replace(/\s+/g, " ");
export function personName(value, surname = "") {
  const words = clean(value).split(" ").filter(Boolean);
  if (words.length === 1 && surname) words.push(surname);
  const suffix =
    words.length > 2 &&
    /^(jr\.?|sr\.?|ii|iii|iv|v|vi|vii|viii|ix|x)$/i.test(words.at(-1))
      ? words.pop()
      : "";
  const last = words.pop(),
    first = words.join(" ");
  return first && last && !/[,/]/.test(first) ? { first, last, suffix } : null;
}
export function convertAddressBook(userData, listId) {
  const shopping = userData?.shoppingListsResponse;
  const raw = [
    ...array(shopping?.newLists),
    ...array(shopping?.modifiedLists),
  ].find((l) => String(l.identifier) === String(listId));
  const response = array(shopping?.listResponses).find(
    (r) => String(r.listId) === String(listId),
  );
  if (!raw || !response) throw Error("Unsupported AnyList response.");
  const categories = array(response.categoryGroupResponses).flatMap((g) =>
    array(g.categoryGroup?.categories).map((c) => ({
      ...c,
      groupId: c.categoryGroupId || g.categoryGroup.identifier,
    })),
  );
  const output = [];
  for (const category of categories) {
    if (category.identifier == null || !clean(category.name)) continue;
    const [label, ...address] = clean(category.name).split(/\s+-\s+/);
    const people = [],
      seen = new Set();
    for (const item of array(raw.items)) {
      if (
        !array(item.categoryAssignments).some(
          (a) =>
            String(a.categoryId) === String(category.identifier) &&
            (!a.categoryGroupId ||
              String(a.categoryGroupId) === String(category.groupId)),
        )
      )
        continue;
      const parsed = personName(item.name),
        key = item.identifier;
      if (!parsed || key == null || seen.has(String(key))) continue;
      seen.add(String(key));
      people.push({ id: String(key), ...parsed });
      for (const child of String(item.details ?? item.notes ?? "")
        .split(/\r?\n/)
        .map(clean)
        .filter(Boolean)) {
        const name = personName(child, parsed.last),
          childId = String(key) + ":child:" + child.toLowerCase();
        if (name && !seen.has(childId)) {
          people.push({ id: childId, ...name, parentId: String(key) });
          seen.add(childId);
        }
      }
    }
    // Never delete absent source contacts or grant event invitations.
    if (people.length)
      output.push({
        id: String(category.groupId) + ":" + String(category.identifier),
        label,
        lines: address.join(" - "),
        people,
      });
  }
  return output;
}
