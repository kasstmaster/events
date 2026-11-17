import {
  CENTRAL,
  SDK_AUTH,
  PROJECT,
  sdkShim,
  requireTest,
  HarnessError,
} from "./policy.mjs";
export function captchaDocument() {
  return '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Isolated real reCAPTCHA check</title><h1>Isolated real reCAPTCHA check</h1><p>This check cannot request a phone code. Complete the Google challenge, then return to Gather when the runner continues.</p><button id="check">Check reCAPTCHA</button><div id="captcha"></div><p id="status" role="status"></p><script type="module" src="/__harness/captcha.js"></script></html>';
}
export function captchaScript(config) {
  return `import {initializeApp} from 'https://www.gstatic.com/firebasejs/12.6.0/firebase-app.js';
import {getAuth,RecaptchaVerifier} from '${SDK_AUTH}?gather-recaptcha-only=1';
const auth=getAuth(initializeApp(${JSON.stringify({ projectId: PROJECT, apiKey: config.apiKey, authDomain: config.authDomain })},'isolated-real-captcha'));
auth.settings.appVerificationDisabledForTesting=false;
document.querySelector('#check').onclick=async()=>{try{document.querySelector('#check').disabled=true;const verifier=new RecaptchaVerifier(auth,'captcha',{size:'normal'});await verifier.verify();verifier.clear();document.querySelector('#status').textContent='Real reCAPTCHA completed. No SMS requested.';await window.__gatherCaptchaComplete();}catch{document.querySelector('#status').textContent='reCAPTCHA could not complete; no SMS requested.';document.querySelector('#check').disabled=false;}};`;
}
export async function attachBrowser(
  context,
  fixture,
  { transport, offlineSdk, report = () => {} } = {},
) {
  const { policy, sites } = fixture;
  let captchaResolve;
  const captchaCompleted = new Promise((resolve) => {
    captchaResolve = resolve;
  });
  await context.exposeBinding(
    "__gatherFictionalPermit",
    ({ frame }, phone, value) => {
      requireTest(
        new URL(frame.url()).origin === CENTRAL,
        "PERMIT_ORIGIN_INVALID",
      );
      policy.permit(phone, value);
    },
  );
  await context.exposeBinding("__gatherCaptchaComplete", ({ frame }) => {
    requireTest(
      frame.url() === CENTRAL + "/__harness/recaptcha",
      "CAPTCHA_ORIGIN_INVALID",
    );
    captchaResolve();
  });
  await context.addInitScript(() => {
    addEventListener("DOMContentLoaded", () => {
      const marker = document.createElement("div");
      marker.textContent =
        "ISOLATED GATHER TEST · temporary data · fictional numbers only";
      marker.style.cssText =
        "position:fixed;top:0;right:0;z-index:2147483647;max-width:60vw;font:11px sans-serif;background:#fff6c2;color:#111;padding:3px;pointer-events:none";
      document.body.append(marker);
    });
  });
  await context.route("**/*", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    try {
      const site = sites.get(url.origin);
      if (site) {
        if (url.origin === CENTRAL && url.pathname === "/__harness/recaptcha")
          return route.fulfill({
            contentType: "text/html",
            body: captchaDocument(),
          });
        if (url.origin === CENTRAL && url.pathname === "/__harness/captcha.js")
          return route.fulfill({
            contentType: "text/javascript",
            body: captchaScript(policy.config),
          });
        // Every Gather request is fulfilled from loopback; NEVER continue/fetch its public URL.
        const response = await fetch(site.url + url.pathname + url.search, {
          method: request.method(),
          headers: await request.allHeaders(),
          body: request.postDataBuffer() || undefined,
          redirect: "manual",
        });
        return route.fulfill({
          status: response.status,
          headers: Object.fromEntries(response.headers),
          body: Buffer.from(await response.arrayBuffer()),
        });
      }
      const frameUrl = request.frame().url();
      const captchaOnly = frameUrl.startsWith(CENTRAL + "/__harness/");
      if (
        url.origin + url.pathname === SDK_AUTH &&
        !url.searchParams.has("gather-fictional-only") &&
        !url.searchParams.has("gather-recaptcha-only")
      ) {
        requireTest(!captchaOnly, "SDK_MODE_INVALID");
        return route.fulfill({
          contentType: "text/javascript",
          headers: { "Access-Control-Allow-Origin": "*" },
          body: sdkShim(policy.config),
        });
      }
      const kind = policy.approveGoogle(
        request.url(),
        request.method(),
        request.postData(),
        captchaOnly ? "captcha" : "auth",
      );
      if (kind === "preflight")
        return route.fulfill({
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST",
            "Access-Control-Allow-Headers":
              request.headers()["access-control-request-headers"] ||
              "content-type",
          },
          body: "",
        });
      if (offlineSdk) {
        const response = await offlineSdk(request, kind);
        if (response) return route.fulfill(response);
      }
      const response = transport
        ? await transport(route, request)
        : await route.fetch({ maxRedirects: 0, timeout: 20000 });
      const status = response.status();
      requireTest(status < 300 || status >= 400, "REDIRECT_BLOCKED");
      const bytes = await response.body();
      requireTest(bytes.length <= 8000000, "PROVIDER_RESPONSE_TOO_LARGE");
      if (
        ["fictional-send", "fictional-confirm", "refresh"].includes(kind) &&
        status < 300
      ) {
        let value;
        try {
          value = JSON.parse(bytes.toString());
        } catch {
          throw new HarnessError("PROVIDER_RESPONSE_INVALID");
        }
        policy.capture(kind, value);
      }
      const headers = { ...response.headers() };
      delete headers["content-encoding"];
      delete headers["content-length"];
      return route.fulfill({ status, headers, body: bytes });
    } catch (error) {
      policy.blocked++;
      report(error instanceof HarnessError ? error.code : "NETWORK_BLOCKED");
      await route.abort("blockedbyclient");
    }
  });
  return { captchaCompleted };
}
export async function showEvent(page) {
  await page
    .locator('[data-action="open-event"], [data-action="rsvp"]')
    .first()
    .waitFor();
  const open = page.getByRole("button", { name: "View Event", exact: true });
  if (await open.count()) await open.first().click();
  await page.getByRole("button", { name: "RSVP", exact: true }).waitFor();
}
export async function checks(page, fixture) {
  const [primary, secondary] = fixture.records;
  const api = async (path, { method = "GET", data } = {}) =>
    page.evaluate(
      async ({ path, method, data }) => {
        const r = await fetch(path, {
          method,
          headers: data ? { "Content-Type": "application/json" } : {},
          body: data ? JSON.stringify(data) : undefined,
        });
        return { status: r.status, body: await r.json() };
      },
      { path, method, data },
    );
  const session = await api("/api/session");
  requireTest(session.body.role === "guest", "GUEST_MATCH_FAILED");
  requireTest((await api("/api/host")).status === 403, "HOST_PERMISSION_LEAK");
  const privateProfile = await api("/api/personal");
  requireTest(
    privateProfile.body.person.first === "Firebase" &&
      privateProfile.body.person.last === "Test Guest",
    "GUEST_MATCH_FAILED",
  );
  requireTest(
    fixture.store
      .list("person-account", "platform")
      .filter((p) => p.firebaseEnrolled).length === 1 &&
      fixture.store.get("person-account", fixture.identity, "platform")
        ?.firebaseEnrolled,
    "ACCOUNT_COUNT_INVALID",
  );
  for (const record of [primary, secondary]) {
    await page.goto(record.origin);
    await page.waitForURL((url) => url.origin === record.origin, {
      timeout: 30000,
    });
    await showEvent(page);
    requireTest(
      (await api("/api/session")).body.role === "guest",
      "HOUSEHOLD_HANDOFF_FAILED",
    );
    requireTest(
      (await api("/api/host")).status === 403,
      "HOST_PERMISSION_LEAK",
    );
  }
  await page.goto(primary.origin);
  await showEvent(page);
  const rsvp = await api("/api/guest/events/" + primary.event.id + "/rsvp", {
    method: "PUT",
    data: { version: 0, attendance: { [primary.guest.id]: "yes" }, claims: {} },
  });
  requireTest(rsvp.status === 200, "ISOLATED_RSVP_FAILED");
  requireTest(
    fixture.store.list("response", secondary.host.household).length === 0,
    "RSVP_CONTEXT_LEAK",
  );
  const cookies = await page.context().cookies();
  const primaryCookie = cookies.find(
    (c) =>
      c.name === "__Host-events_session" &&
      c.domain === new URL(primary.origin).hostname,
  );
  requireTest(
    primaryCookie?.httpOnly &&
      primaryCookie.secure &&
      primaryCookie.sameSite === "Strict" &&
      primaryCookie.expires > Date.now() / 1000 + 180 * 86400,
    "PERSISTENT_COOKIE_INVALID",
  );
  const stolen = await fetch(
    fixture.sites.get(secondary.origin).url + "/api/session",
    {
      headers: {
        Origin: secondary.origin,
        Cookie: "__Host-events_session=" + primaryCookie.value,
      },
    },
  );
  requireTest(!(await stolen.json()).role, "ORIGIN_SESSION_LEAK");
  return { primaryCookie, sendCount: fixture.policy.sends };
}
