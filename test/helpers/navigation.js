// Updated visible navigation for synthetic browser suites only.
export async function clickNavigation(page, label) {
  if (
    [
      "Edit House",
      "Edit Event",
      "Edit event",
      "Light Mode",
      "Dark Mode",
      "Default Mode",
      "Custom Colors Mode",
    ].includes(label)
  ) {
    if (!(await page.locator(".page-appearance-settings").count()))
      await clickNavigation(page, "Settings");
    await page
      .getByRole("button", {
        name: ["Light Mode", "Dark Mode", "Default Mode"].includes(label)
          ? label
          : "Custom Colors Mode",
        exact: true,
      })
      .click();
    if (["Light Mode", "Dark Mode", "Default Mode"].includes(label))
      await page
        .locator(".page-appearance-settings")
        .waitFor({ state: "hidden" });
    else
      await page.getByLabel("Appearance categories", { exact: true }).waitFor();
    return;
  }
  if (["Household details", "Details"].includes(label)) {
    if (!(await page.locator(".inline-household-details").count()))
      await clickNavigation(page, "Settings");
    await page.getByRole("heading", { name: "Details", exact: true }).waitFor();
    return;
  }
  if (
    ["Share", "Share Household Link", "Share Guest Link"].includes(label) &&
    !(await page.locator(".toolbar [data-action=share]").count())
  ) {
    await clickNavigation(page, "Household link and QR");
    await page.getByRole("button", { name: "Share link", exact: true }).click();
    await page
      .getByRole("button", { name: "Close editor", exact: true })
      .click();
    return;
  }
  if (["Household link and QR", "Household Link and QR"].includes(label))
    label = "Share Link";
  if (["Settings", "Share Link"].includes(label)) {
    await page
      .locator(
        `.toolbar [data-action="${label === "Settings" ? "settings" : "share-details"}"]`,
      )
      .click();
    if (label === "Settings")
      await page
        .getByRole("heading", { name: "Settings", exact: true })
        .waitFor();
    return;
  }
  if (
    [
      "Share",
      "Share Household Link",
      "Share Guest Link",
      "Share Invitation",
    ].includes(label) &&
    (await page.locator(".toolbar [data-action=share]").count())
  ) {
    await page.locator(".toolbar [data-action=share]").click();
    return;
  }
  if (
    ["Cards", "Invitation"].includes(label) &&
    !(await page.locator("#editor[open]").count()) &&
    (await page.locator(".event-home-actions").count())
  ) {
    await page
      .getByRole("button", { name: "Invitation Cards", exact: true })
      .first()
      .click();
    if (label === "Invitation")
      await page
        .getByRole("button", { name: "Edit invitation", exact: true })
        .click();
    return;
  }
  if (label === "Edit event") label = "Edit Event";
  if (
    ["Cards & Templates", "Cards & templates"].includes(label) &&
    (await page
      .getByRole("button", { name: "Open Cards & Invites", exact: true })
      .count())
  ) {
    await page
      .getByRole("button", { name: "Open Cards & Invites", exact: true })
      .click();
    return;
  }
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
    ["Contacts", "Family", "Family Workspace"].includes(label) &&
    !(await page.locator("#editor[open]:not(.inline-management)").count())
  ) {
    const target =
      label === "Contacts" ? "Open Contacts" : "Open Family Workspace";
    if (
      !(await page.getByRole("button", { name: target, exact: true }).count())
    ) {
      await page.locator(".toolbar [data-action=home]").click();
      await page.getByRole("button", { name: target, exact: true }).waitFor();
    }
    await page.getByRole("button", { name: target, exact: true }).click();
    await page
      .getByRole("heading", {
        name: label === "Contacts" ? "Contacts" : "Family Workspace",
        level: 1,
        exact: true,
      })
      .waitFor();
    return;
  }
  if (
    [
      "Edit House",
      "Edit Event",
      "Share",
      "Share Household Link",
      "Settings",
      "Household Link and QR",
    ].includes(label) &&
    !(await page.locator("#editor[open]:not(.inline-management)").count())
  ) {
    const name =
      label === "Share"
        ? "Share Household Link"
        : label === "Edit Event"
          ? "Custom Colors Mode"
          : label;
    await page.getByLabel("Sorting and options", { exact: true }).click();
    await page
      .getByRole("menuitem", {
        name:
          name === "Share Household Link" &&
          (await page
            .getByRole("menuitem", { name: "Share Guest Link", exact: true })
            .count())
            ? "Share Guest Link"
            : name,
        exact: true,
      })
      .click();
    if (label === "Settings")
      await page
        .getByRole("heading", { name: "Settings", exact: true })
        .waitFor();
    return;
  }
  if (
    ["Sign Out", "Sign out"].includes(label) &&
    !(await page.locator("#main [data-action=logout]").count())
  ) {
    await page.getByLabel("Sorting and options", { exact: true }).click();
    await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
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
        "Text reminders": "Reminders",
        "Preview invitation": "Invitation",
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
    const leavingEvent =
      name === "Home" && (await page.locator(".event-hero").count());
    await button.first().click();
    if (leavingEvent)
      await page.locator(".event-hero").waitFor({ state: "hidden" });
    return;
  }
  const menuOnly = [
    "Create Event",
    "Edit event details",
    "Household details",
    "Preview guest experience",
    "Cards & Templates",
    "Household Link and QR",
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
      "Reminders",
      "Cards",
      "Invitation",
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
      ["RSVPs", "Reminders", "Cards", "Invitation"].includes(name) &&
      (await page.locator(".event-hero").count())
    ) {
      await page.getByRole("button", { name: "Home", exact: true }).click();
      await page.locator(".event-home-actions").first().waitFor();
      await page
        .getByRole("button", {
          name: ["Cards", "Invitation"].includes(name)
            ? "Invitation Cards"
            : name,
          exact: true,
        })
        .first()
        .click();
      if (name === "Invitation")
        await page
          .getByRole("button", { name: "Edit invitation", exact: true })
          .click();
      return;
    }
    const create =
      name.startsWith("Create ") ||
      name === "＋ Add adult or child" ||
      name === "Cards & templates";
    if (name === "＋ Add adult or child") name = "Add Guest";
    if (name === "Cards & templates") name = "Cards & Templates";
    await page
      .getByLabel(
        create
          ? "Create"
          : ["Sort alphabetically", "Manual ordering"].includes(name)
            ? "Sort"
            : "Sorting and options",
        { exact: true },
      )
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
