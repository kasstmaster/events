import { createHash } from "node:crypto";
import { id, fail } from "./model.js";
const digest = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const contactRevision = (store, household) =>
  digest(
    ["address", "guest"].map((kind) =>
      store
        .list(kind, household)
        .map((r) => [r.id, r.version])
        .sort((a, b) => a[0].localeCompare(b[0])),
    ),
  );
export const sourceLinkId = (kind, source) => digest([kind, source]);
const fullName = (p) =>
  [p.first, ...(p.parent ? [] : [p.last, p.suffix])].filter(Boolean).join(" ");
// The plan contains contact fields only: never notes, codes, identities or invitation data.
export function outboundPlan(store, household, remote, groupId) {
  const addresses = [],
    mappings = [],
    linkedGuests = new Set();
  let skipped = 0;
  const links = store.list("anylist-link", household);
  const guests = store.list("guest", household),
    groups = store.list("address", household).map((address) => ({
      ...address,
      people: guests.filter((g) => g.address === address.id),
    }));
  for (const adult of guests.filter((g) => !g.address && !g.parent))
    groups.push({
      id: "",
      noAddress: true,
      guest: adult.id,
      label: (fullName(adult) + " household").slice(0, 100),
      lines: "",
      people: guests.filter((g) => g.id === adult.id || g.parent === adult.id),
    });
  for (const address of groups) {
    const people = address.people;
    if (!people.length) continue;
    const link = links.find(
      (l) =>
        l.type === "address" &&
        (address.noAddress
          ? l.noAddress && l.guest === address.guest
          : !l.noAddress && l.target === address.id),
    );
    const source = link?.source || `${groupId}:${id()}`;
    const entry = {
      id: source,
      label: (address.noAddress
        ? link?.baseline?.local?.label || address.label
        : address.label
      )
        .trim()
        .replace(/\s+/g, " "),
      lines: (address.lines || "").trim().replace(/\s+/g, " "),
      people: [],
    };
    const adults = people.filter((g) => !g.parent);
    for (const adult of adults) {
      const personLink = links.find(
        (l) => l.target === adult.id && l.type === "person",
      );
      const external = personLink?.source || id();

      // Unmapped existing remote IDs are never guessed or adopted by the writer.
      const item = {
        id: external,
        first: adult.first,
        last: adult.last,
        suffix: adult.suffix || "",
        phone: adult.phone || "",
        children: [],
      };
      mappings.push({
        kind: "person",
        source: external,
        target: adult.id,
        fields: {
          first: item.first,
          last: item.last,
          suffix: item.suffix,
          phone: item.phone,
        },
      });
      linkedGuests.add(adult.id);
      for (const child of people.filter((g) => g.parent === adult.id)) {
        const childLink = links.find(
          (l) => l.target === child.id && l.type === "person",
        );
        const prior = remote
          .flatMap((a) => a.people)
          .find((p) => p.id === childLink?.source);

        const same =
          prior &&
          prior.first === child.first &&
          (prior.suffix || "") === (child.suffix || "");
        const oldLine = childLink?.source?.split(":child:")[1];
        const line =
          same && oldLine
            ? oldLine
            : [child.first, adult.last, child.suffix].filter(Boolean).join(" ");
        const childSource = external + ":child:" + line.toLowerCase();
        item.children.push({
          id: childSource,
          previousId: childLink?.source || "",
          line,
          first: child.first,
          last: child.last || "",
          suffix: child.suffix || "",
        });
        mappings.push({
          kind: "person",
          source: childSource,
          previousSource: childLink?.source,
          target: child.id,
          fields: { first: child.first, suffix: child.suffix || "", phone: "" },
        });
        linkedGuests.add(child.id);
      }
      entry.people.push(item);
    }
    if (entry.people.length) {
      addresses.push(entry);
      mappings.push({
        kind: "address",
        source,
        target: address.id,
        ...(address.noAddress ? { noAddress: true, guest: address.guest } : {}),
        fields: { label: entry.label, lines: entry.lines },
      });
    }
  }
  skipped = store
    .list("guest", household)
    .filter((g) => !linkedGuests.has(g.id)).length;
  return { addresses, mappings, skipped };
}
export function outboundPhase(store, household, input) {
  return store.transaction(() => {
    const job = store.get("anylist-job", input.syncId, household);
    if (!job || job.expires < Date.now())
      fail(409, "Contact sync has expired.");
    if (input.phase === "fail") {
      if (!["prepared", "writing"].includes(job.state))
        fail(409, "Start a new contact sync.");
      store.put(
        "anylist-job",
        job.id,
        household,
        { ...job, state: "failed", outbound: undefined },
        job.version,
      );
      return { state: "failed" };
    }
    if (input.phase === "claim") {
      if (job.state !== "prepared") fail(409, "Start a new sync.");
      if (job.revision !== contactRevision(store, household)) {
        store.put(
          "anylist-job",
          job.id,
          household,
          { ...job, state: "conflict", outbound: undefined },
          job.version,
        );
        return { state: "conflict" };
      }
      for (const mapping of job.outbound.mappings) {
        const key = sourceLinkId(mapping.kind, mapping.source),
          previous = store.get("anylist-link", key, household);
        if (
          previous &&
          (previous.target !== mapping.target ||
            (mapping.noAddress && previous.guest !== mapping.guest))
        )
          fail(409, "Contact mapping changed.");
        store.put(
          "anylist-link",
          key,
          household,
          {
            ...previous,
            type: mapping.kind,
            source: mapping.source,
            target: mapping.target,
            ...(mapping.noAddress
              ? { noAddress: true, guest: mapping.guest }
              : {}),
            reservation: job.id,
          },
          previous?.version,
        );
      }
      store.put(
        "anylist-job",
        job.id,
        household,
        { ...job, state: "writing", expires: Date.now() + 120000 },
        job.version,
      );
      return { state: "writing", addresses: job.outbound.addresses };
    }
    if (input.phase === "ack") {
      if (
        job.state !== "writing" ||
        job.revision !== contactRevision(store, household)
      )
        fail(409, "Contacts changed. Check sync status.");
      const observed = input.addresses;
      if (!Array.isArray(observed) || observed.length > 2000)
        fail(400, "Invalid sync verification.");
      for (const mapping of job.outbound.mappings) {
        const source =
          mapping.kind === "address"
            ? observed.find((a) => a.id === mapping.source)
            : observed
                .flatMap((a) => a.people || [])
                .find((p) => p.id === mapping.source);
        if (
          !source ||
          Object.entries(mapping.fields).some(
            ([k, v]) => (source[k] || "") !== v,
          )
        )
          fail(409, "AnyList verification differs. Start a fresh sync.");
      }
      for (const mapping of job.outbound.mappings) {
        const key = sourceLinkId(mapping.kind, mapping.source),
          previous = store.get("anylist-link", key, household);
        if (previous && previous.target !== mapping.target)
          fail(409, "Contact mapping changed.");
        store.put(
          "anylist-link",
          key,
          household,
          {
            type: mapping.kind,
            source: mapping.source,
            target: mapping.target,
            ...(mapping.noAddress
              ? { noAddress: true, guest: mapping.guest }
              : {}),
            baseline: {
              local: Object.fromEntries(
                Object.keys(mapping.fields).map((k) => [
                  k,
                  mapping.noAddress
                    ? mapping.fields[k]
                    : store.get(
                        mapping.kind === "person" ? "guest" : "address",
                        mapping.target,
                        household,
                      )?.[k] || "",
                ]),
              ),
              remote: mapping.fields,
            },
          },
          previous?.version,
        );
        if (
          mapping.previousSource &&
          mapping.previousSource !== mapping.source
        ) {
          const old = store.get(
            "anylist-link",
            sourceLinkId(mapping.kind, mapping.previousSource),
            household,
          );
          if (old?.target === mapping.target)
            store.remove("anylist-link", old.id, household, old.version);
        }
      }
      store.put(
        "anylist-job",
        job.id,
        household,
        {
          ...job,
          state: "complete",
          pushed: job.outbound.mappings.length,
          skipped: (job.skipped || 0) + job.outbound.skipped,
          outbound: undefined,
        },
        job.version,
      );
      return { state: "complete" };
    }
    fail(400, "Invalid contact sync phase.");
  });
}
