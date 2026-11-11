export async function setAppearance(page, category, action, label, value) {
  await page
    .getByLabel("Appearance categories", { exact: true })
    .getByRole("button", { name: category, exact: true })
    .click();
  await page
    .getByLabel("Appearance actions", { exact: true })
    .getByRole("button", { name: action, exact: true })
    .click();
  const input = page.getByLabel(label, { exact: true });
  if (await input.evaluate((el) => el.tagName === "SELECT"))
    await input.selectOption(value);
  else await input.fill(value);
}
export async function saveAppearance(page) {
  await page
    .locator("#appearance-toolbar [data-action=appearance-save]")
    .first()
    .click();
  await page.locator(".appearance-categories").waitFor({ state: "hidden" });
}
