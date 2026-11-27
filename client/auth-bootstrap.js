import { hostTransfer } from "./host-transfer.js";
// Capture authentication fragments once in module memory, before the application loads.
// Never put them in network URLs, DOM attributes, web storage, logs or analytics.
const capture =
  location.pathname === "/signin" ||
  (location.pathname === "/" && location.hash.startsWith("#recover="));
let fragment = capture ? location.hash : "";
if (capture && location.hash) history.replaceState(null, "", location.pathname);
export function takeAuthFragment() {
  const value = fragment;
  fragment = "";
  return value;
}

const hostCapture =
  ["/host-signup", "/host-recovery"].includes(location.pathname) ||
  (location.pathname === "/signin" &&
    /^#host(?:=|-)/.test(fragment || location.hash));
let hostFragment = hostCapture ? fragment || location.hash : "";
if (
  location.pathname === "/signin" &&
  /^#host-transfer(?:[=-])/.test(hostFragment)
) {
  const startupStatus = document.querySelector("#app > main > p");
  if (startupStatus) startupStatus.textContent = "Opening your household…";
}
if (hostCapture) {
  fragment = "";
  if (location.hash) history.replaceState(null, "", location.pathname);
}
export function takeHostFragment() {
  const value = hostFragment;
  hostFragment = "";
  return value;
}
// Email clients may reuse an existing signup tab, producing only a hash change.
addEventListener("hashchange", () => {
  const eligible =
    ["/host-signup", "/host-recovery"].includes(location.pathname) ||
    (location.pathname === "/signin" && /^#host(?:=|-)/.test(location.hash));
  if (!eligible || !location.hash) return;
  hostFragment = location.hash;
  history.replaceState(null, "", location.pathname);
  dispatchEvent(new Event("gather-host-fragment"));
});
let invitationFragment =
  /^\/event\/[A-Za-z0-9_-]{43}$/.test(location.pathname) &&
  location.hash.startsWith("#private=")
    ? location.hash
    : "";
if (invitationFragment) history.replaceState(null, "", location.pathname);
export function takeInvitationFragment() {
  const value = invitationFragment;
  invitationFragment = "";
  return value;
}

addEventListener("hashchange", () => {
  if (
    /^\/event\/[A-Za-z0-9_-]{43}$/.test(location.pathname) &&
    location.hash.startsWith("#private=")
  ) {
    invitationFragment = location.hash;
    history.replaceState(null, "", location.pathname);
    dispatchEvent(new Event("gather-invitation-fragment"));
  }
});

// /signin uses this small entry instead of loading the complete application at
// every browser-bound transfer hop. Ordinary pages retain parallel entry loading.
if (document.querySelector("script[data-gather-transfer]")) {
  const start = async () => {
    try {
      const result = await hostTransfer(hostFragment, {
        origin: location.origin,
        post: async (path, data) => {
          const response = await fetch(path, {
            method: "POST",
            credentials: "same-origin",
            redirect: "error",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(data),
          });
          return {
            ok: response.ok,
            status: response.status,
            body: await response.json(),
          };
        },
        home: async () => {
          const response = await fetch("/api/host-auth/home", {
            credentials: "same-origin",
            redirect: "error",
          });
          return {
            ok: response.ok,
            status: response.status,
            body: await response.json(),
          };
        },
        navigate: (url) => location.replace(url),
        replace: (path) => history.replaceState(null, "", path),
      });
      if (result.handled) return;
      if (result.redeemed || result.completed) takeHostFragment();
    } catch {
      // The full shared UI provides existing recovery/sign-in errors. Keep the
      // fragment only in module memory so authorization can resume after sign-in.
    }
    await import("/app.js");
  };
  start().catch(() => {
    const status = document.querySelector("#app > main > p");
    if (status)
      status.textContent =
        "Couldn’t open this page. Please reload and try again.";
  });
}
