// Three-way field reconciliation. Baselines retain both sides so an unresolved
// remote conflict cannot overwrite Gather on the next identical pull.
export function mergeAnyListFields(local, remote, baseline, keys) {
  const merged = {},
    next = { local: {}, remote: {} };
  for (const key of keys) {
    const current = local?.[key] ?? "",
      incoming = remote?.[key] ?? "";
    const known =
      baseline &&
      Object.hasOwn(baseline.local || {}, key) &&
      Object.hasOwn(baseline.remote || {}, key);
    const localChanged = known ? current !== baseline.local[key] : !!local;
    const remoteChanged = known ? incoming !== baseline.remote[key] : !local;
    merged[key] = localChanged ? current : remoteChanged ? incoming : current;
    next.local[key] = merged[key];
    next.remote[key] = incoming;
  }
  return { merged, baseline: next };
}
