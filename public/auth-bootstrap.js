// Capture authentication fragments once in module memory, before the application loads.
// Never put them in network URLs, DOM attributes, web storage, logs or analytics.
let fragment = location.pathname === "/signin" ? location.hash : "";
if (location.pathname === "/signin" && location.hash)
  history.replaceState(null, "", "/signin");
export function takeAuthFragment() {
  const value = fragment;
  fragment = "";
  return value;
}
