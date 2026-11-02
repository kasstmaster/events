// Updated visible navigation for synthetic browser suites only.
export async function clickNavigation(page, label) {
  if (
    (await page.locator(".appearance-categories").count()) &&
    ["Save", "Cancel"].includes(label)
  ) {
    await page
      .locator(
        `#appearance-toolbar [data-action=appearance-${label.toLowerCase()}]`,
      )
      .first()
      .click();
    return;
  }
  if (
    ["Sign Out", "Sign out"].includes(label) &&
    !(await page.locator("#main [data-action=logout]").count())
  ) {
    await page.locator(".toolbar [data-action=settings]").click();
  }
  const inlineGuest = page.locator("form[data-form=guest]");
  if ((await inlineGuest.count()) && ["Save", "Cancel"].includes(label)) {
    await inlineGuest.getByRole("button", { name: label, exact: true }).click();
    return;
  }
  const dialog = page.locator("#editor[open]");
  const inDialog = await dialog.count();
  let name = label;
  if (!inDialog) {
    name =
      {
        "Sign out": "Sign Out",
        "Family Workspace": "Family",
        "Edit global defaults": "Defaults",
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
    ? dialog
    : name === "RSVP"
      ? page.locator("#main")
      : page;
  let button = scope.getByRole("button", {
    name: name === "✕" ? "Close editor" : name,
    exact: true,
  });
  if (await button.count()) {
    // Fixed chrome is not included in Playwright's geometric visibility check.
    // Scroll content controls as a user would before clicking them.
    if (
      !(await button
        .first()
        .evaluate((el) => !!el.closest(".top-shell,.toolbar")))
    )
      await button
        .first()
        .evaluate((el) => el.scrollIntoView({ block: "center" }));
    await button.first().click();
    return;
  }
  const menuOnly = [
    "Create Event",
    "Edit event details",
    "Household details",
    "Preview guest experience",
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
      await page.locator(".hero h1").waitFor();
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
    if (name === "＋ Add adult or child") name = "Add Guest";
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
    if (["Hide Completed", "Show All"].includes(name))
      await page
        .getByRole("menuitem", {
          name: name === "Hide Completed" ? "Show All" : "Hide Completed",
          exact: true,
          includeHidden: true,
        })
        .waitFor({ state: "attached" });
    return;
  }
  await button.click();
}
