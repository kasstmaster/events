// Replacement mode is a source-level opt-in only. Neither flag is configured in production.
export const hostOnlyMode = (env = {}) =>
  env.HOST_ONLY_MODEL_ENABLED === "true" &&
  env.HOST_ONLY_MODEL_ACTIVATION_APPROVED === "true";
export function retiredGuestRoute(path) {
  return (
    /^\/api\/(?:guest(?:-access|\/|$)|firebase(?:\/|$)|recovery(?:\/|$))/.test(
      path,
    ) ||
    /^\/api\/passwordless\/(?!config$|sessions\/revoke(?:-all)?$)/.test(path) ||
    /^\/api\/public\/households\/[^/]+\/(?:login|recognize|claim-code)$/.test(
      path,
    ) ||
    /^\/api\/host\/(?:guest-matches$|guests\/[^/]+\/(?:link|unlink|private-sign-in))/.test(
      path,
    ) ||
    /^\/api\/personal\/(?:contacts|account|events|phone|username)/.test(path) ||
    /^\/api\/admin\/(?:passwordless|account(?:s|[-/]|$)|recovery|guest|central-membership|approvals)/.test(
      path,
    ) ||
    /^\/api\/(?:account-recovery|account\/self|username-recovery)(?:\/|$)/.test(
      path,
    ) ||
    /^\/api\/admin\/hosts\/[^/]+\/recover$/.test(path) ||
    /^\/api\/messaging\//.test(path)
  );
}

export const hostAuthOrigin = (origin) =>
  /^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(origin)
    ? origin
    : "https://gather.ilymmd.com";
