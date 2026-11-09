import { mergeAnyListFields } from "./anylist-merge.js";
import { createHash, timingSafeEqual } from "node:crypto";
import { fail, id, text, normalizeName } from "./model.js";
import { addressInput } from "./addresses.js";
import { identityFor, guestContact } from "./guest-identities.js";

const digest = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function integrationHousehold(store, env) {
  if (!env.MEYER_HOST_EMAIL) return null;
  const host = store.one(
    "SELECT id,household FROM users WHERE role='host' AND email=?",
    String(env.MEYER_HOST_EMAIL).trim().toLowerCase(),
  );
  if (env.MEYER_HOUSEHOLD_ID && host?.household !== env.MEYER_HOUSEHOLD_ID)
    return null;
  if (
    !host ||
    store.one(
      "SELECT household FROM household_deletions WHERE household=?",
      host.household,
    )
  )
    return null;
  return host.household;
}
export function integrationCapabilities(store, env, household) {
  if (integrationHousehold(store, env) !== household) return {};
  return {
    anylist: true,
    anylistStatus: syncStatus(store, household),
    anylistConfigured: !!(
      (env.GITHUB_TOKEN || env.EVENTS_ACTIONS_TOKEN) &&
      env.ANYLIST_IMPORT_SECRET?.length >= 32
    ),
  };
}
export function sameSecret(value, expected) {
  if (
    typeof value !== "string" ||
    typeof expected !== "string" ||
    expected.length < 32
  )
    return false;
  const a = createHash("sha256").update(value).digest(),
    b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}
function revision(store, household) {
  return digest(
    ["address", "guest"].map((kind) =>
      store
        .list(kind, household)
        .map((r) => [r.id, r.version])
        .sort((a, b) => a[0].localeCompare(b[0])),
    ),
  );
}
export function syncStatus(store, household) {
  const job = store
    .list("anylist-job", household)
    .sort((a, b) => b.started - a.started)[0];
  if (!job) return { state: "idle" };
  return {
    id: job.id,
    state:
      job.state === "running" && Date.now() > job.expires
        ? "expired"
        : job.state,
    added: job.added || 0,
    updated: job.updated || 0,
    skipped: job.skipped || 0,
  };
}
export async function startAnyListSync(store, env, household, fetcher = fetch) {
  if (integrationHousehold(store, env) !== household)
    fail(403, "This integration is unavailable.");
  if (!integrationCapabilities(store, env, household).anylistConfigured)
    fail(503, "AnyList is not configured for this household yet.");
  // Match Gatherings' operator setting names, but never dispatch its workflow.
  if (
    (env.GITHUB_WORKFLOW_REPOSITORY &&
      env.GITHUB_WORKFLOW_REPOSITORY !== "kasstmaster/events") ||
    (env.GITHUB_WORKFLOW_BRANCH && env.GITHUB_WORKFLOW_BRANCH !== "main")
  )
    fail(
      503,
      "Set GITHUB_WORKFLOW_REPOSITORY to kasstmaster/events and GITHUB_WORKFLOW_BRANCH to main on the events Worker.",
    );
  const tokenSetting = env.GITHUB_TOKEN
    ? "GITHUB_TOKEN"
    : "EVENTS_ACTIONS_TOKEN";
  const token = String(env[tokenSetting]).trim();
  if (!token || /\s|[\x22\x27]/.test(token))
    fail(
      503,
      `Save only the GitHub token value in the events Worker ${tokenSetting} secret, without Bearer, quotes or commands.`,
    );
  store.limit("anylist-sync:" + household, 6);
  const job = store.transaction(() => {
    if (syncStatus(store, household).state === "running")
      fail(409, "A contact sync is already running.");
    return store.put("anylist-job", id(), household, {
      state: "running",
      started: Math.max(
        Date.now(),
        ...store.list("anylist-job", household).map((job) => job.started + 1),
      ),
      expires: Date.now() + 15 * 60 * 1000,
      revision: revision(store, household),
    });
  });
  let dispatchStatus = 0;
  try {
    const response = await fetcher(
      "https://api.github.com/repos/kasstmaster/events/actions/workflows/sync-meyer-anylist.yml/dispatches",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer " + token,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "events-contact-sync",
        },
        body: JSON.stringify({ ref: "main", inputs: { sync_id: job.id } }),
        signal: AbortSignal.timeout(20000),
        // Cloudflare supports manual/follow only. Reject every redirect below.
        redirect: "manual",
      },
    );
    dispatchStatus = response.status;
    if (!response.ok) throw Error();
  } catch {
    store.put(
      "anylist-job",
      job.id,
      household,
      { ...job, state: "failed", dispatchStatus },
      job.version,
    );
    fail(
      503,
      dispatchStatus === 401
        ? `GitHub rejected contact sync (HTTP 401). Check the GitHub token saved in the events Worker ${tokenSetting} secret; it may be incorrect, expired or revoked.`
        : dispatchStatus === 403 || dispatchStatus === 404
          ? `GitHub denied contact sync. Give the events Worker ${tokenSetting} access to kasstmaster/events with Actions read/write; confirm the sync workflow is enabled.`
          : dispatchStatus === 422
            ? "GitHub could not dispatch contact sync. Confirm sync-meyer-anylist.yml is on Events main and accepts sync_id."
            : "Contact sync could not start. GitHub is unavailable or the request was blocked. Check sync status before trying again.",
    );
  }
  return syncStatus(store, household);
}
const personKey = (g) =>
  [g.first, g.last, g.suffix || ""].map(normalizeName).join("|");
export function importAnyList(store, env, input, validateGuest) {
  const household = integrationHousehold(store, env);
  if (!household) fail(403, "This integration is unavailable.");
  return store.transaction(() => {
    const job = store.get(
      "anylist-job",
      text(input.syncId, 100, true),
      household,
    );
    if (!job || job.expires < Date.now())
      fail(409, "Contact sync has expired.");
    if (job.state === "complete") return syncStatus(store, household);
    if (job.state !== "running") fail(409, "Start a new contact sync.");
    if (input.failed === true || job.revision !== revision(store, household)) {
      store.put(
        "anylist-job",
        job.id,
        household,
        { ...job, state: input.failed ? "failed" : "conflict" },
        job.version,
      );
      return syncStatus(store, household);
    }
    if (!Array.isArray(input.addresses) || input.addresses.length > 2000)
      fail(400, "Invalid contact import.");
    if (
      input.addresses.reduce(
        (n, a) => n + (Array.isArray(a?.people) ? a.people.length : 0),
        0,
      ) > 10000
    )
      fail(400, "Contact import is too large.");
    const sourceIds = new Set();
    let added = 0,
      updated = 0,
      skipped = 0;
    for (const source of input.addresses) {
      const sourceId = text(source.id, 200, true);
      if (
        sourceIds.has(sourceId) ||
        !Array.isArray(source.people) ||
        source.people.length > 200
      )
        fail(400, "Invalid contact import.");
      sourceIds.add(sourceId);
      const mapId = digest(["address", sourceId]),
        mapping = store.get("anylist-link", mapId, household);
      let address = mapping && store.get("address", mapping.target, household);
      const incoming = addressInput({
        label: source.label,
        lines: source.lines || "",
      });
      if (!mapping) {
        const candidates = store
          .list("address", household)
          .filter(
            (a) =>
              normalizeName(a.label) === normalizeName(incoming.label) &&
              normalizeName(a.lines) === normalizeName(incoming.lines),
          );
        if (candidates.length > 1) {
          skipped += source.people.length;
          continue;
        }
        address = candidates[0];
        if (
          address &&
          store
            .list("anylist-link", household)
            .some((link) => link.target === address.id)
        ) {
          skipped += source.people.length;
          continue;
        }
      }
      if (mapping && !address) {
        skipped += source.people.length;
        continue;
      }
      const reconciledAddress = mergeAnyListFields(
        address,
        incoming,
        mapping?.baseline,
        ["label", "lines"],
      );
      const addressFields = addressInput(reconciledAddress.merged);
      if (!address)
        address = store.put("address", id(), household, addressFields);
      else if (
        mapping &&
        ["label", "lines", "street", "city", "state", "zip"].some(
          (key) => address[key] !== addressFields[key],
        )
      ) {
        address = store.put(
          "address",
          address.id,
          household,
          {
            ...address,
            ...addressFields,
            notes: address.notes || "",
            phone: address.phone || "",
          },
          address.version,
        );
        updated++;
      }
      store.put(
        "anylist-link",
        mapId,
        household,
        { target: address.id, baseline: reconciledAddress.baseline },
        mapping?.version,
      );
      const people = new Map(),
        seen = new Set();
      // Adults precede children so the designated-adult invariant stays explicit.
      for (const person of [...source.people].sort(
        (a, b) => Number(!!a.parentId) - Number(!!b.parentId),
      )) {
        const external = text(person.id, 200, true);
        if (seen.has(external)) fail(400, "Duplicate imported contact.");
        seen.add(external);
        const parent = person.parentId ? people.get(person.parentId) : "";
        if (person.parentId && !parent) {
          skipped++;
          continue;
        }
        const linkId = digest(["person", external]),
          link = store.get("anylist-link", linkId, household);
        let guest = link && store.get("guest", link.target, household);
        const fields = {
          first: text(person.first, 80, true),
          last: text(person.last || "", 80, !person.parentId),
          suffix: text(person.suffix || "", 30),
          address: address.id,
          parent,
        };
        if (!link) {
          const matches = store
            .list("guest", household)
            .filter(
              (g) =>
                g.address === address.id &&
                (g.parent || "") === parent &&
                personKey(g) === personKey(fields),
            );
          if (matches.length > 1) {
            skipped++;
            continue;
          }
          guest = matches[0];
          if (
            guest &&
            store
              .list("anylist-link", household)
              .some((link) => link.target === guest.id)
          ) {
            skipped++;
            continue;
          }
        }
        if (
          link &&
          (!guest ||
            guest.address !== address.id ||
            (guest.parent || "") !== parent)
        ) {
          skipped++;
          continue;
        }
        const reconciled = mergeAnyListFields(guest, fields, link?.baseline, [
          "first",
          "last",
          "suffix",
        ]);
        Object.assign(fields, reconciled.merged);
        if (!guest) {
          guest = store.put(
            "guest",
            id(),
            household,
            validateGuest(fields, store, household),
          );
          identityFor(store, guest, household);
          guestContact(store, guest, household);
          added++;
        } else if (link && personKey(guest) !== personKey(fields)) {
          guest = store.put(
            "guest",
            guest.id,
            household,
            validateGuest({ ...guest, ...fields }, store, household, guest),
            guest.version,
          );
          updated++;
        }
        store.put(
          "anylist-link",
          linkId,
          household,
          { target: guest.id, baseline: reconciled.baseline },
          link?.version,
        );
        people.set(external, guest.id);
      }
    }
    store.put(
      "anylist-job",
      job.id,
      household,
      { ...job, state: "complete", added, updated, skipped },
      job.version,
    );
    return syncStatus(store, household);
  });
}
