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
