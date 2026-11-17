import { chromium } from "playwright";
import { existsSync } from "node:fs";
import { lstat, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readPrivateConfig,
  requireTest,
  HarnessError,
  CENTRAL,
} from "./policy.mjs";
import { isolatedFixture, PREFIX } from "./fixture.mjs";
import { attachBrowser, checks, showEvent } from "./browser.mjs";
export async function cleanupStale() {
  let removed = 0;
  for (const name of await readdir(tmpdir())) {
    if (!name.startsWith(PREFIX)) continue;
    const directory = join(tmpdir(), name);
    try {
      const info = await lstat(directory);
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        (typeof process.getuid === "function" && info.uid !== process.getuid())
      )
        continue;
      const marker = JSON.parse(
        await readFile(join(directory, "owner.json"), "utf8"),
      );
      if (
        marker.kind !== PREFIX ||
        !Number.isSafeInteger(marker.pid) ||
        marker.pid < 1
      )
        continue;
      try {
        process.kill(marker.pid, 0);
        continue;
      } catch (error) {
        if (error.code !== "ESRCH") continue;
      }
      await rm(directory, { recursive: true, force: true });
      removed++;
    } catch {
      /* Ignore unowned/incomplete markers, never print file contents. */
    }
  }
  return removed;
}
export async function runInteractive(args = process.argv.slice(2)) {
  if (args.length === 1 && args[0] === "--cleanup-stale") {
    console.log("Removed owned stale test directories:", await cleanupStale());
    return;
  }
  requireTest(
    args.length === 3 &&
      args[0] === "--real-fictional" &&
      args[1] === "--config",
    "USAGE_REAL_FICTIONAL_CONFIG_REQUIRED",
  );
  const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const config = await readPrivateConfig(args[2], repository);
  requireTest(
    process.platform !== "linux" || !!process.env.DISPLAY,
    "INTERACTIVE_DESKTOP_REQUIRED",
  );
  let fixture,
    context,
    cancelled = false,
    restarting = false,
    closing = Promise.resolve();
  const abort = new AbortController();
  function close() {
    closing = closing.then(async () => {
      const current = context;
      context = null;
      try {
        await current?.close();
      } catch {}
      const data = fixture;
      fixture = null;
      await data?.close();
    });
    return closing;
  }
  const interrupt = () => {
    cancelled = true;
    abort.abort();
    void close();
  };
  const userWait = (promise) =>
    Promise.race([
      promise,
      new Promise((_, reject) => {
        if (abort.signal.aborted) reject(new HarnessError("USER_CANCELLED"));
        else
          abort.signal.addEventListener(
            "abort",
            () => reject(new HarnessError("USER_CANCELLED")),
            { once: true },
          );
      }),
    ]);
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  const timer = setTimeout(interrupt, 20 * 60000);
  timer.unref();
  try {
    fixture = await isolatedFixture(config);
    requireTest(!cancelled, "USER_CANCELLED");
    const executablePath =
      process.env.CHROMIUM_PATH ||
      (existsSync("/usr/bin/chromium")
        ? "/usr/bin/chromium"
        : chromium.executablePath());
    const launch = async () =>
      chromium.launchPersistentContext(fixture.profile, {
        headless: false,
        executablePath,
        viewport: { width: 1100, height: 850 },
        serviceWorkers: "block",
        args: ["--no-sandbox"],
      });
    context = await launch();
    requireTest(!cancelled, "USER_CANCELLED");
    const firstContext = context;
    context.on("close", () => {
      if (context === firstContext && !restarting) interrupt();
    });
    const controls = await attachBrowser(context, fixture, {
      report: (code) => console.log("Blocked isolated-test request:", code),
    });
    let page = context.pages()[0] || (await context.newPage());
    console.log("ISOLATED TEST: production flags and databases are untouched.");
    console.log(
      "First complete the real reCAPTCHA-only check in the opened browser. It cannot send a phone code.",
    );
    await page.goto(CENTRAL + "/__harness/recaptcha");
    await userWait(controls.captchaCompleted);
    console.log(
      "reCAPTCHA-only check passed. Authentication now uses Firebase's official fictional-number app-verification mode.",
    );
    console.log(
      "In Gather, enter First Name Firebase, Last Name Test Guest, your approved fictional number, and its configured code. Type the code ONLY in the browser.",
    );
    await page.goto(fixture.invitation);
    await page.waitForFunction(
      async () => {
        try {
          return (await (await fetch("/api/session")).json()).role === "guest";
        } catch {
          return false;
        }
      },
      {},
      { timeout: 600000 },
    );
    await showEvent(page);
    const initial = await checks(page, fixture);
    requireTest(initial.sendCount === 1, "UNEXPECTED_SEND_COUNT");
    console.log(
      "Guest matching, invitation access, two-household handoff, permissions and isolated RSVP checks passed.",
    );
    await page.reload();
    await showEvent(page);
    restarting = true;
    await context.close();
    context = await launch();
    restarting = false;
    requireTest(!cancelled, "USER_CANCELLED");
    const secondContext = context;
    context.on("close", () => {
      if (context === secondContext && !restarting) interrupt();
    });
    await attachBrowser(context, fixture, {
      report: (code) => console.log("Blocked isolated-test request:", code),
    });
    page = context.pages()[0] || (await context.newPage());
    await page.goto(fixture.records[0].origin);
    await showEvent(page);
    requireTest(
      fixture.policy.sends === initial.sendCount,
      "RESTART_REQUESTED_ANOTHER_CODE",
    );
    console.log(
      "Refresh and real browser-profile restart passed without another code request.",
    );
    const oldCookies = await context.cookies();
    const exited = await page.evaluate(async () => {
      const r = await fetch("/api/logout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      return r.status;
    });
    requireTest(exited === 200, "SIGN_OUT_FAILED");
    for (const [origin, site] of fixture.sites) {
      const old = oldCookies.find(
        (c) =>
          c.name === "__Host-events_session" &&
          c.domain === new URL(origin).hostname,
      );
      if (!old) continue;
      const r = await fetch(site.url + "/api/session", {
        headers: {
          Origin: origin,
          Cookie: "__Host-events_session=" + old.value,
        },
      });
      requireTest(!(await r.json()).role, "SESSION_REVOCATION_FAILED");
    }
    await page.reload();
    await page.waitForURL((url) => url.origin === CENTRAL);
    await page.getByLabel("First Name", { exact: true }).waitFor();
    requireTest(fixture.policy.sends === 1, "SIGN_OUT_REQUESTED_ANOTHER_CODE");
    console.log(
      "PASS: fictional Firebase verification, guest/invitation authority, multi-household sessions, persistent restart and device revocation. No production Gather data was used.",
    );
    console.log(
      "Provider fictional-user records may remain in Firebase; this runner never deletes Firebase users.",
    );
  } finally {
    clearTimeout(timer);
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    await close();
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  runInteractive().catch((error) => {
    console.error(
      "Isolated Firebase harness stopped:",
      error instanceof HarnessError ? error.code : "HARNESS_FAILED",
    );
    process.exitCode = 1;
  });
