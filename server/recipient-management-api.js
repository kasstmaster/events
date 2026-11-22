import { randomBytes, createHash } from "node:crypto";
import { fail, id } from "./model.js";
import {
  publicInvitationsEnabled,
  recipientHouseholdID,
  groupFor,
} from "./public-invitations.js";
import { isolatedAddressBook } from "./recipient-isolation.js";
import { auditAccount } from "./account-management.js";
const hash = (value) => createHash("sha256").update(value).digest("hex");
export async function recipientManagementAPI(ctx) {
  const {
    path,
    method,
    req,
    res,
    store,
    env,
    session,
    requireRole,
    body,
    json,
    validateGuest,
  } = ctx;
  if (
    !["/api/host/recipient-access", "/api/host/contact-children"].includes(path)
  )
    return false;
  if (!publicInvitationsEnabled(env)) fail(404, "Page not found.");
  requireRole("host");
  if (!isolatedAddressBook(store, session.household))
    fail(409, "Prepare the independent Address Book first.");
  if (method !== "POST") fail(405, "Method not allowed.");
  const input = await body(req),
    household = session.household;
  if (path === "/api/host/recipient-access") {
    const current = recipientHouseholdID(store, household, input.guest);
    if (!input.operation || input.operation === "inspect") {
      json(res, {
        householdID: current.code,
        version: current.version,
        revoked: !!current.revoked,
      });
      return true;
    }
    if (
      !["revoke", "rotate"].includes(input.operation) ||
      input.confirm !== true
    )
      fail(400, "Confirm the recipient access change.");
    const result = store.transaction(() => {
      const row = store.get("invitation-household", current.id, household);
      if (row.version !== input.version)
        fail(409, "Recipient access changed. Review the current ID.");
      const old = store.get(
        "invitation-household-index",
        hash(row.code.replaceAll("-", "")),
        household,
      );
      if (old)
        store.remove(
          "invitation-household-index",
          old.id,
          household,
          old.version,
        );
      const code =
        input.operation === "rotate"
          ? randomBytes(16)
              .toString("hex")
              .toUpperCase()
              .match(/.{4}/g)
              .join("-")
          : row.code;
      const next = store.put(
        "invitation-household",
        row.id,
        household,
        {
          ...row,
          code,
          generation: row.generation + 1,
          revoked: input.operation === "revoke",
        },
        row.version,
      );
      if (!next.revoked)
        store.put(
          "invitation-household-index",
          hash(code.replaceAll("-", "")),
          household,
          { group: row.id },
        );
      auditAccount(
        store,
        session.user,
        input.guest,
        "recipient-access-" + input.operation,
        ["household-id"],
      );
      return {
        householdID: next.code,
        version: next.version,
        revoked: !!next.revoked,
      };
    });
    json(res, result);
    return true;
  }
  const address = input.address || "",
    adult = store
      .list("guest", household)
      .find(
        (person) =>
          !person.parent &&
          (address ? person.address === address : person.id === input.adult),
      );
  if (!adult || (address && !store.get("address", address, household)))
    fail(400, "Choose a shared address with an adult contact.");
  if (
    !Array.isArray(input.children) ||
    !input.children.length ||
    input.children.length > 100
  )
    fail(400, "Add between one and 100 children.");
  const result = store.transaction(() => {
    const used = new Set();
    return input.children.map((value) => {
      if (value.id && used.has(value.id)) fail(400, "Duplicate child.");
      if (value.id) used.add(value.id);
      const existing = value.id && store.get("guest", value.id, household);
      if (
        value.id &&
        (!existing?.parent ||
          groupFor(store, household, existing.id).key !==
            groupFor(store, household, adult.id).key)
      )
        fail(404, "Child unavailable.");
      const parent = existing?.parent || adult.id;
      const next = validateGuest(
        {
          ...(existing || {}),
          first: value.first,
          last: "",
          phone: "",
          suffix: value.suffix || "",
          parent,
          address,
          plusOne: existing?.plusOne === true,
        },
        store,
        household,
        existing,
      );
      return store.put(
        "guest",
        existing?.id || id(),
        household,
        next,
        existing ? value.version : undefined,
      );
    });
  });
  json(res, { children: result });
  return true;
}
