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
