// Isolated synthetic card documents only; all non-loopback requests are rejected.
import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { chromium } from "playwright";
import { Store } from "../server/node-store.js";
import { createApp } from "../server/app.js";
import { newCard } from "../public/card-system.js";
const store = new Store(),
  origin = "http://127.0.0.1:3197",
  password = "Synthetic-card-editor-password";
await store.createAdmin("admin@example.test", password);
store.run(
  "INSERT INTO approvals VALUES(?,?)",
  "cards@example.test",
  "synthetic",
);
const host = await store.register({
  email: "cards@example.test",
  password,
  name: "Card Examples",
});
const server = createApp({ store, origin });
server.listen(3197, "127.0.0.1");
await once(server, "listening");
const browser = await chromium.launch({
  executablePath:
    process.env.CHROMIUM_PATH ||
    (existsSync("/usr/bin/chromium")
      ? "/usr/bin/chromium"
      : chromium.executablePath()),
  args: ["--no-sandbox"],
});
async function api(
  path,
  data,
  cookie,
  method = data ? "POST" : "GET",
  version,
) {
  const r = await fetch(origin + path, {
    method,
    headers: {
      Origin: origin,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(data ? { "Content-Type": "application/json" } : {}),
      ...(version !== undefined ? { "If-Match": String(version) } : {}),
    },
    body: data ? JSON.stringify(data) : undefined,
  });
  assert.ok(r.ok, `Fixture ${path}: ${r.status}`);
  return {
    body: await r.json(),
    cookie: r.headers.get("set-cookie")?.split(";")[0],
  };
}
async function device(cookie, width) {
  const context = await browser.newContext({
    viewport: { width, height: 1000 },
    acceptDownloads: true,
  });
  await context.addCookies([
    { name: cookie.split("=")[0], value: cookie.split("=")[1], url: origin },
  ]);
  await context.addInitScript(() => {
    window.__printCalls = 0;
    window.print = () => window.__printCalls++;
    const read = FileReader.prototype.readAsDataURL;
    FileReader.prototype.readAsDataURL = function (file) {
      if (file.name === "slow.png")
        setTimeout(() => read.call(this, file), 400);
      else read.call(this, file);
    };
  });
  await context.route("**/*", (r) =>
    r
      .request()
      .url()
      .startsWith(origin + "/")
      ? r.continue()
      : r.abort(),
  );
  const p = await context.newPage();
  p.setDefaultTimeout(10000);
  const errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  await p.goto(origin);
  return { context, p, errors };
}
const click = (p, name) => p.getByRole("button", { name, exact: true }).click();
async function control(p, category, action, label) {
  await p
    .getByRole("toolbar", { name: "Card categories", exact: true })
    .getByRole("button", { name: category, exact: true })
    .click();
  await p
    .getByRole("toolbar", { name: "Card actions", exact: true })
    .getByRole("button", { name: action, exact: true })
    .click();
  return p.getByLabel(label, { exact: true }).filter({ visible: true });
}
try {
  await mkdir("test-results", { recursive: true });
  const owner = (
    await api("/api/login", { email: "cards@example.test", password })
  ).cookie;
  const guest = (
    await api("/api/host/guests", { first: "Casey", last: "Example" }, owner)
  ).body;
  const event = (
    await api(
      "/api/host/events",
      {
        title: "Original celebration",
        date: "2089-06-12",
        invited: [guest.id],
        menu: [],
      },
      owner,
    )
  ).body;
  const saved = (
    await api(
      "/api/host/cards",
      { ...newCard("Saved snapshot"), event: event.id, recipient: guest.id },
      owner,
    )
  ).body;
  await api(
    `/api/host/events/${event.id}`,
    { ...event, title: "New source title" },
    owner,
    "PUT",
    event.version,
  );
  let cardName = "Saved snapshot";
  for (const width of [390, 1440]) {
    console.log(
      `Cards browser: ${width}px dedicated manager, editor and preview`,
    );
    const { context, p, errors } = await device(owner, width);
    await click(p, "Open Cards & Invites");
    await p
      .getByRole("heading", { name: "Your Cards & Templates", exact: true })
      .waitFor();
    await p
      .locator("li")
      .filter({ hasText: cardName })
      .getByRole("button", { name: "Open", exact: true })
      .click();
    await p.locator("#card-preview-canvas > svg").waitFor();
    assert.ok(
      (await p.locator("#card-preview-canvas").innerText()).includes(
        "Original celebration",
      ),
    );
    assert.equal(await p.locator("#editor[open]").count(), 0);
    await click(p, "Edit");
    await p.locator("#card-editor-form").waitFor();
    await (
      await control(p, "Card", "Name", "Card name")
    ).fill(`Edited snapshot ${width}`);
    p.once("dialog", (d) => d.dismiss());
    await click(p, "Close");
    assert.ok(await p.locator("#card-editor-form").isVisible());
    await (
      await control(p, "Variables", "Select", "Selected item")
    ).selectOption("2");
    await (await control(p, "Text", "Color", "QR color")).fill("#1a5b7c");
    const transparent = await control(
      p,
      "Text",
      "QR Background",
      "Transparent QR background",
    );
    await transparent.setChecked(width === 390);
    assert.equal(
      await p.locator("#card-canvas [data-qr-background]").count(),
      width === 390 ? 0 : 1,
    );
    await (await control(p, "Variables", "QR", "Include QR code")).check();
    await click(p, "Add text above QR");
    await (
      await control(p, "Text", "Text", "Text / fallback")
    ).fill("  Scan for details");
    await (
      await control(
        p,
        "Card",
        "Save Template",
        "Save as a reusable private template",
      )
    ).check();
    await (await control(p, "Variables", "Add", "Selected item")).count();
    const variable = p.locator('[data-card-variable="recipient.inviteCode"]');
    const canvas = p.locator("#card-canvas");
    if (width === 1440) {
      const box = await canvas.locator(":scope > svg").boundingBox();
      await variable.dragTo(canvas.locator(":scope > svg"), {
        targetPosition: { x: box.width / 2, y: box.height / 2 },
      });
    } else await variable.click();
    await (await control(p, "Text", "Size", "Text size")).fill("30");
    await (await control(p, "Text", "Color", "Text color")).fill("#772233");
    if (width === 1440) {
      const x = await control(p, "Position", "Position", "Horizontal position");
      const y = p
        .getByLabel("Vertical position", { exact: true })
        .filter({ visible: true });
      await x.fill("300");
      await y.fill("400");
      const svgBox = await canvas.locator(":scope > svg").boundingBox(),
        scale = svgBox.width / 600;
      await p.mouse.move(svgBox.x + 300 * scale, svgBox.y + 420 * scale);
      await p.mouse.down();
      await p.mouse.move(svgBox.x + 123 * scale, svgBox.y + 420 * scale, {
        steps: 8,
      });
      await p.mouse.up();
      assert.equal(Number(await x.inputValue()), 120);
      const resize = await canvas.locator("[data-card-resize]").boundingBox();
      await p.mouse.move(
        resize.x + resize.width / 2,
        resize.y + resize.height / 2,
      );
      await p.mouse.down();
      await p.mouse.move(
        resize.x + resize.width / 2 + 20,
        resize.y + resize.height / 2 + 10,
        { steps: 4 },
      );
      await p.mouse.up();
      assert.ok(
        Number(
          await p
            .getByLabel("Box width", { exact: true })
            .filter({ visible: true })
            .inputValue(),
        ) > 240,
      );
      await canvas.focus();
      const before = Number(await x.inputValue());
      await canvas.press("ArrowRight");
      assert.equal(Number(await x.inputValue()), before + 1);
    }
    const asTemplate = await control(
      p,
      "Card",
      "Save Template",
      "Save as a reusable private template",
    );
    assert.equal(await asTemplate.isChecked(), true);
    await asTemplate.uncheck();
    assert.ok(
      await p.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    );
    const toolbarButtons = p.locator(".appearance-actions button");
    assert.ok(
      await toolbarButtons.evaluateAll((buttons) =>
        buttons.every((b) => b.scrollWidth <= b.clientWidth + 1),
      ),
    );
    await p.screenshot({
      path: `test-results/cards-editor-${width}.png`,
      fullPage: true,
    });
    cardName = `Edited snapshot ${width}`;
    await click(p, "Save");
    await p.locator("#card-preview-canvas > svg").waitFor();
    const current = store.get("card", saved.id, host.household);
    assert.equal(current.context.event.title, "Original celebration");
    assert.equal(current.context.recipient.name, "Casey Example");
    assert.equal(current.elements.at(-1).fontSize, 30);
    assert.equal(current.elements.at(-1).color, "#772233");
    assert.ok(current.elements.some((e) => e.text === "  Scan for details"));
    const pending = p.waitForEvent("download");
    await click(p, "Download SVG");
    const svg = await readFile(await (await pending).path(), "utf8");
    assert.equal(
      await p.evaluate(
        (s) =>
          new DOMParser()
            .parseFromString(s, "image/svg+xml")
            .querySelector("parsererror")?.textContent || "",
        svg,
      ),
      "",
    );
    assert.match(svg, /Original celebration/);
    assert.doesNotMatch(
      svg,
      /New source title|card-selection|card-snap-guide|data-card-resize/,
    );
    const pngPending = p.waitForEvent("download");
    await click(p, "Download PNG");

    assert.ok((await readFile(await (await pngPending).path())).length > 100);
    await p.evaluate(() => {
      Object.defineProperty(navigator, "canShare", {
        configurable: true,
        value: () => true,
      });
      Object.defineProperty(navigator, "share", {
        configurable: true,
        value: async ({ files }) => {
          window.__sharedType = files[0].type;
          throw new DOMException("Synthetic cancellation", "AbortError");
        },
      });
    });
    await click(p, "Share");
    await p.waitForFunction(
      () =>
        window.__sharedType === "image/png" &&
        !document
          .querySelector('[data-action="share-card"]')
          .hasAttribute("aria-busy"),
    );
    assert.doesNotMatch(
      await p.locator("#notice").innerText(),
      /Synthetic cancellation/,
    );
    await p.evaluate(() =>
      Object.defineProperty(navigator, "canShare", {
        configurable: true,
        value: () => false,
      }),
    );
    const fallback = p.waitForEvent("download");
    await click(p, "Share");
    assert.ok((await fallback).suggestedFilename().endsWith(".png"));
    await p.getByLabel("Print quantity", { exact: true }).fill("2");
    await click(p, "Print");
    assert.equal(
      await p
        .locator("iframe.print-frame")
        .contentFrame()
        .locator(".copy")
        .count(),
      2,
    );
    assert.equal(
      await p
        .locator("iframe.print-frame")
        .contentFrame()
        .locator("body")
        .evaluate(() => window.__printCalls),
      1,
    );
    await click(p, "Close");
    await p
      .getByRole("heading", { name: "Your Cards & Templates", exact: true })
      .waitFor();
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log("Cards browser: private templates and delayed artwork save");
  const privateView = await device(owner, 390),
    p = privateView.p;
  await click(p, "Open Cards & Invites");
  await click(p, "Create card / template");
  await (
    await control(p, "Card", "Name", "Card name")
  ).fill("Reusable private example");
  await (
    await control(
      p,
      "Card",
      "Save Template",
      "Save as a reusable private template",
    )
  ).check();
  const upload = await control(p, "Background", "Image", "Background artwork");
  const pixel = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlZsAAAAASUVORK5CYII=",
    "base64",
  );
  await upload.setInputFiles({
    name: "slow.png",
    mimeType: "image/png",
    buffer: pixel,
  });
  await click(p, "Save");
  await p
    .getByRole("heading", { name: "Your Cards & Templates", exact: true })
    .waitFor();
  const privateTemplate = store.list("private-template", host.household)[0];
  assert.equal(privateTemplate.name, "Reusable private example");
  assert.ok(privateTemplate.background.startsWith("data:image/png;base64,"));
  await p.locator('[data-action="edit-private-template"]').click();
  await (
    await control(p, "Card", "Name", "Card name")
  ).fill("Private revision");
  await click(p, "Save");
  await p
    .getByRole("heading", { name: "Your Cards & Templates", exact: true })
    .waitFor();
  assert.equal(store.list("private-template", host.household).length, 1);
  assert.equal(
    store.get("private-template", privateTemplate.id, host.household).name,
    "Private revision",
  );
  await p.locator('[data-action="edit-private-template"]').click();
  const nameControl = await control(p, "Card", "Name", "Card name");
  await nameControl.fill("Unsaved conflicting draft");
  const currentTemplate = store.get(
    "private-template",
    privateTemplate.id,
    host.household,
  );
  await api(
    `/api/host/private-templates/${privateTemplate.id}`,
    { ...currentTemplate, name: "Other device" },
    owner,
    "PUT",
    currentTemplate.version,
  );
  await click(p, "Save");
  await p
    .locator("#card-editor-form .form-error")
    .filter({ hasText: /changed|refresh/i })
    .waitFor();
  assert.equal(await nameControl.inputValue(), "Unsaved conflicting draft");
  assert.equal(
    await p.locator("#appearance-toolbar").evaluate((el) => el.inert),
    false,
  );
  p.once("dialog", (d) => d.accept());
  await click(p, "Close");
  await p
    .getByRole("heading", { name: "Your Cards & Templates", exact: true })
    .waitFor();
  assert.deepEqual(privateView.errors, []);
  await privateView.context.close();
  console.log(
    "Cards browser: administrator shared template editing and confirmation",
  );
  const adminCookie = (
    await api("/api/login", { email: "admin@example.test", password })
  ).cookie;
  const shared = (
    await api("/api/admin/templates", newCard("Shared example"), adminCookie)
  ).body;
  const adminView = await device(adminCookie, 1440),
    a = adminView.p;
  await a.locator('.toolbar [data-action="cards"]').click();
  await a
    .locator("li")
    .filter({ hasText: "Shared example" })
    .getByRole("button", { name: "Open", exact: true })
    .click();
  await click(a, "Edit");
  await (await control(a, "Card", "Name", "Card name")).fill("Shared revised");
  await click(a, "Save");
  await a.locator("#card-preview-canvas > svg").waitFor();
  assert.equal(
    store.get("template", shared.id, "platform").name,
    "Shared revised",
  );
  assert.equal(
    store.get("card", saved.id, host.household).context.event.title,
    "Original celebration",
  );
  await click(a, "Close");
  a.once("dialog", (d) => d.dismiss());
  await click(a, "Remove");
  assert.ok(store.get("template", shared.id, "platform"));
  a.once("dialog", (d) => d.accept());
  await click(a, "Remove");
  await a.getByText("Nothing saved yet.", { exact: true }).waitFor();
  assert.equal(store.get("template", shared.id, "platform"), null);
  assert.deepEqual(adminView.errors, []);
  await adminView.context.close();
  console.log(
    "Cards browser passed: full pages, shared toolbar, snapshot retention, draft cancel, QR formatting, variables, SVG/PNG and print at phone/desktop widths.",
  );
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
  store.db.close();
}
