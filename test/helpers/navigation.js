// Updated visible navigation for synthetic browser suites only.
export async function clickNavigation(page, label) {
  const dialog = page.locator("#editor[open]");
  const inDialog = await dialog.count();
  let name = label;
  if (!inDialog) {
    name =
      {
        "Sign out": "Sign Out",
        "Create event": "Create Event",
        "Edit event": "Edit Event",
        "Text reminders": "Text Reminders",
        "Preview invitation": "Preview Invitation",
        "All household tools": "Home",
        "Create home record": "Create record",
        "Create chore / routine": "Create chore",
        "Sort alphabetically within categories": "Sort alphabetically",
        "Return to manual ordering": "Manual ordering",
      }[name] || name;
  }
  if (
    (name === "Close editor" || name === "✕") &&
    !inDialog &&
    !(await page
      .getByRole("button", { name: "Close editor", exact: true })
      .count())
  ) {
    await page.getByRole("button", { name: "Home", exact: true }).click();
    return;
  }
  const scope = inDialog
    ? page.getByRole("dialog")
    : name === "RSVP"
      ? page.locator("#main")
      : page;
  let button = scope.getByRole("button", {
    name: name === "✕" ? "Close editor" : name,
    exact: true,
  });
  if (await button.count()) {
    await button.first().click();
    return;
  }
  const menuOnly = [
    "Create Event",
    "Cards & Templates",
    "Household link and QR",
    "Create list",
    "Create folder",
    "Create task",
    "Create record",
    "Create chore",
    "＋ Add adult or child",
    "Hide Completed",
    "Show All",
    "Sort alphabetically",
    "Manual ordering",
    "My Tasks",
    "Refresh household",
  ];
  if (
    !inDialog &&
    !menuOnly.includes(name) &&
    ![
      "RSVPs",
      "Text Reminders",
      "Cards",
      "Preview Invitation",
      "Cards & templates",
    ].includes(name)
  ) {
    await button.click();
    return;
  }
  if (!inDialog) {
    if (name === "＋ Add adult or child")
      await page
        .getByRole("heading", { name: "Contacts", exact: true })
        .waitFor();
    if (
      name === "Create Event" &&
      (await page
        .getByRole("heading", { name: "Contacts", exact: true })
        .count())
    ) {
      await page.getByRole("button", { name: "Home", exact: true }).click();
      await page.locator(".hero [data-action=family-workspace]").waitFor();
    }
    if (
      ["RSVPs", "Text Reminders", "Cards", "Preview Invitation"].includes(
        name,
      ) &&
      (await page.locator(".event-hero").count())
    ) {
      await page.getByRole("button", { name: "Home", exact: true }).click();
      await page.locator(".event-home-actions").first().waitFor();
      await page.getByRole("button", { name, exact: true }).first().click();
      return;
    }
    const create =
      name.startsWith("Create ") ||
      name === "＋ Add adult or child" ||
      name === "Cards & templates";
    if (name === "＋ Add adult or child") name = "Create contact";
    if (name === "Cards & templates") name = "Cards & Templates";
    await page
      .getByLabel(create ? "Create" : "Sorting and options", { exact: true })
      .click();
    await page
      .getByRole(
        ["Sort alphabetically", "Manual ordering"].includes(name)
          ? "menuitemradio"
          : "menuitem",
        { name, exact: true },
      )
      .click();
    return;
  }
  await button.click();
}
