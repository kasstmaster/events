// Historical delivery receipts only. No preparation, sending, media or retry paths.
export function processEviteStatus(store, params) {
  const providerId = params.get("MessageSid"),
    status = params.get("MessageStatus");
  if (
    !providerId ||
    !["sent", "delivered", "failed", "undelivered"].includes(status)
  )
    return;
  for (const kind of ["evite-delivery", "evite-phone"])
    for (const ref of store.all(
      "SELECT id,household FROM records WHERE kind=? AND json_extract(body,'$.providerId')=?",
      kind,
      providerId,
    )) {
      const record = store.get(kind, ref.id, ref.household);
      if (["delivered", "failed", "undelivered"].includes(record.status))
        continue;
      store.put(
        kind,
        ref.id,
        ref.household,
        { ...record, status, updated: Date.now() },
        record.version,
      );
    }
}
