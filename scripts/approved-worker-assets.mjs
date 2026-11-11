import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";
import { chromium } from "playwright";
const roots = [
  "https://events.kassandraraudman.workers.dev",
  "https://name.ilymmd.com",
];
const files = await readdir(".approved-application/public");
const results = [];
for (const origin of roots) {
  const mismatches = [];
  for (const file of files) {
    const bytes = await readFile(join(".approved-application/public", file));
    const r = await fetch(
      `${origin}/${file === "index.html" ? "" : encodeURIComponent(file)}`,
      { redirect: "error", signal: AbortSignal.timeout(20000) },
    );
    const actual = Buffer.from(await r.arrayBuffer());
    const hash = (x) => createHash("sha256").update(x).digest("hex");
    if (!r.ok || hash(bytes) !== hash(actual))
      mismatches.push({ file, status: r.status });
  }
  results.push({ origin, checked: files.length, mismatches });
}
await mkdir("recovery/screenshots", { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  for (const [name, viewport] of [
    ["phone", { width: 390, height: 844 }],
    ["desktop", { width: 1440, height: 1000 }],
  ]) {
    const context = await browser.newContext({ viewport });
    // Public read-only navigation only. No sign-in, setup, account creation or RSVP submissions.
    await context.route("**/*", (route) => {
      const request = route.request();
      const url = new URL(request.url());
      return request.method() === "GET" && roots.includes(url.origin)
        ? route.continue()
        : route.abort();
    });
    for (const [i, origin] of roots.entries()) {
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", () => errors.push("page-error"));
      const response = await page.goto(origin, {
        waitUntil: "networkidle",
        timeout: 30000,
      });
      await page.locator("#main").waitFor({ state: "visible" });
      const text = await page.locator("body").innerText();
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth + 1,
      );
      const rendered =
        !text.includes("This household address is unavailable.") &&
        !text.includes("Getting things ready…");
      results.push({
        origin,
        viewport: name,
        status: response.status(),
        rendered,
        horizontal_overflow: overflow,
        page_errors: errors.length,
        interactive_private_flows: "unverified",
      });
      await page.screenshot({
        path: `recovery/screenshots/${name}-${i}.png`,
        fullPage: true,
      });
      await page.close();
    }
    await context.close();
  }
} finally {
  await browser.close();
}
await writeFile(
  "recovery/live-assets-and-browser.json",
  JSON.stringify(results, null, 2) + "\n",
);
console.log(JSON.stringify(results));
if (
  results.some(
    (x) =>
      x.mismatches?.length ||
      x.rendered === false ||
      x.horizontal_overflow ||
      x.page_errors,
  )
)
  process.exitCode = 1;
